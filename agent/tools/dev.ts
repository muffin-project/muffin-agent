import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolSpec } from '../providers/types.js';
import { EXEC_MAX_TIMEOUT_MS, type SandboxExecutor } from '../../core/sandbox/executor.js';
import { classifySource, devRoot, resolveWorkspace } from '../../core/dev/workspace.js';
import { formatExecOutcome } from './shell.js';
import type { RegisteredTool } from '../loop.js';

/**
 * The dev capability — "Muffin builds Muffin", level (a) of ADR-0015.
 *
 * Two tools, both contained: clone a repo into a dedicated workspace, and run
 * a command inside one. Everything the agent does to code happens here, in a
 * clone under `~/.muffin/dev/`, never the owner's working tree — and every
 * command runs in the same sandbox as shell.
 *
 * What is deliberately NOT here: merge, and pushing to a remote. Opening a PR
 * is the agent's output but the merge is the owner's, always (ADR-0015) — and
 * a push is outward, which belongs to the outward module's gate, not to a code
 * tool. v1's honest boundary: the agent prepares a branch with commits in the
 * workspace and reports it; the owner reviews and pushes. The first bootstrap
 * assignment needs none of this — it reads the agent's own traces.
 *
 * `dev` is host-only and pinned to taint 0: a turn carrying any untrusted
 * content cannot touch the repo capability at all (threat model §d — a
 * stranger's "improve yourself" can only ever reach a review queue).
 */
export const devCapability: CapabilityDecl = {
  id: 'dev',
  risk: 'medium',
  reversible: 'yes',
  maxTaint: 0,
  resourceKind: 'none',
  policyArgs: ['workspace'],
  hostOnly: true,
};

const cloneArgs = z.object({
  workspace: z.string().min(1),
  source: z.string().min(1),
});

const runArgs = z.object({
  workspace: z.string().min(1),
  command: z.string().min(1),
  timeout_ms: z.number().int().min(1_000).max(EXEC_MAX_TIMEOUT_MS).optional(),
});

const cloneSpec: ToolSpec = {
  name: 'dev_clone',
  description:
    'Clone a repository into a dedicated workspace under the agent home (never the owner working tree). ' +
    'source is a local path or a URL; a URL host is allowlisted only for the clone. Idempotent: an ' +
    'existing workspace is left as is.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace: { type: 'string', description: 'Workspace name (lowercase, digits, - _)' },
      source: { type: 'string', description: 'Local path or clone URL' },
    },
    required: ['workspace', 'source'],
  },
};

const runSpec: ToolSpec = {
  name: 'dev_run',
  description:
    'Run a command inside a dev workspace, sandboxed: writes confined to the workspace, no network. ' +
    'Use for build, tests, and local git (branch, commit). No push — the owner reviews and pushes.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace: { type: 'string', description: 'An existing workspace name' },
      command: { type: 'string', description: 'The command line' },
      timeout_ms: { type: 'number', description: `Default 120000, max ${EXEC_MAX_TIMEOUT_MS}` },
    },
    required: ['workspace', 'command'],
  },
};

type Exec = Pick<SandboxExecutor, 'run'>;

export function makeDevTools(executor: Exec, home: string): RegisteredTool[] {
  const clone: RegisteredTool = {
    capability: devCapability.id,
    spec: cloneSpec,
    handler: async (args) => {
      const parsed = cloneArgs.safeParse(args);
      if (!parsed.success) {
        return { content: 'invalid arguments: workspace and source are required', isError: true };
      }
      const ws = resolveWorkspace(home, parsed.data.workspace);
      if (!ws.ok) return { content: ws.reason, isError: true };
      if (ws.exists) return { content: `workspace ${parsed.data.workspace} già presente in ${ws.path}` };

      const src = classifySource(parsed.data.source);
      if ('error' in src) return { content: src.error, isError: true };

      const root = devRoot(home);
      mkdirSync(root, { recursive: true });

      // Clone runs contained: it may write the new workspace under the dev root,
      // and reach exactly the forge host for a remote (read egress), nothing else.
      const sourceArg = src.kind === 'local' ? src.path : src.url;
      const result = await executor.run({
        command: `git clone --depth 1 ${shellQuote(sourceArg)} ${shellQuote(ws.path)}`,
        cwd: root,
        writeScope: [root],
        ...(src.kind === 'remote' ? { allowHosts: [src.host] } : {}),
        timeoutMs: EXEC_MAX_TIMEOUT_MS,
      });
      if (result.code !== 0 || result.timedOut) {
        return { ...formatExecOutcome('git clone', result), isError: true };
      }
      return { content: `clonato in ${ws.path}\n${result.stdout}`.trim() };
    },
  };

  const run: RegisteredTool = {
    capability: devCapability.id,
    spec: runSpec,
    handler: async (args) => {
      const parsed = runArgs.safeParse(args);
      if (!parsed.success) {
        return { content: 'invalid arguments: workspace and command are required', isError: true };
      }
      const ws = resolveWorkspace(home, parsed.data.workspace);
      if (!ws.ok) return { content: ws.reason, isError: true };
      if (!ws.exists) {
        return { content: `workspace ${parsed.data.workspace} non esiste: usa dev_clone`, isError: true };
      }
      const result = await executor.run({
        command: parsed.data.command,
        cwd: ws.path,
        writeScope: [ws.path],
        ...(parsed.data.timeout_ms !== undefined ? { timeoutMs: parsed.data.timeout_ms } : {}),
      });
      return formatExecOutcome(parsed.data.command, result);
    },
  };

  return [clone, run];
}

/** Single-quote for the shell, escaping embedded quotes. Paths only, no model text. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
