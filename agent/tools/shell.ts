import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolSpec } from '../providers/types.js';
import {
  annotateSandboxFailures,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_TIMEOUT_MS,
  type ExecResult,
  type SandboxExecutor,
} from '../../core/sandbox/executor.js';
import type { RegisteredTool } from '../loop.js';

/**
 * sys.shell — the first hand of M3.
 *
 * Declared `high` risk: in hardened mode the kernel allows it for the owner at
 * taint 0, in single-user mode it is ALWAYS an ask — that is threat model §g
 * falling out of decide()'s high branch, not a special case written here.
 *
 * v1 is strict by construction: there is no unsandboxed retry path. When the
 * sandbox blocks a command, the model explains what was blocked and the owner
 * runs it in their own terminal if they want it run. The escape hatch inside
 * the permission flow (ADR-0018) arrives with an explicit always-ask
 * capability, not as a parameter that softens this one.
 */
export const shellCapability: CapabilityDecl = {
  id: 'sys.shell',
  risk: 'high',
  reversible: 'no',
  resourceKind: 'none',
  policyArgs: ['command'],
  hostOnly: true,
  timeoutMs: EXEC_MAX_TIMEOUT_MS,
};

export const shellSpec: ToolSpec = {
  name: 'shell_run',
  description:
    'Run a non-interactive shell command inside the sandbox. Writes are confined to the ' +
    'working directory and a scratch TMPDIR; there is no network access. The working ' +
    'directory does NOT persist between calls — pass cwd each time. Output over ~30k ' +
    'characters is cut head-and-tail with an explicit marker. If the sandbox blocks the ' +
    'command, say so and tell the owner what to run themselves; there is no unsandboxed retry.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      cwd: {
        type: 'string',
        description: 'Working directory, relative to the workspace root. Default: the root.',
      },
      timeout_ms: {
        type: 'number',
        description: `Kill timeout in ms. Default ${EXEC_DEFAULT_TIMEOUT_MS}, max ${EXEC_MAX_TIMEOUT_MS}.`,
      },
    },
    required: ['command'],
  },
};

/** Parse at the boundary: the model's JSON is external data (practice §4). */
const shellArgs = z.object({
  command: z.string().min(1, 'command must not be empty'),
  cwd: z.string().optional(),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(EXEC_MAX_TIMEOUT_MS)
    .optional(),
});

export type ShellScope = {
  /** Absolute. The workspace this session may write into. */
  root: string;
};

/** What the tool actually needs — a fake with just run() is a valid executor. */
type Exec = Pick<SandboxExecutor, 'run'>;

export function makeShellTool(executor: Exec, scope: ShellScope): RegisteredTool {
  return {
    capability: shellCapability.id,
    spec: shellSpec,
    handler: async (args) => {
      const parsed = shellArgs.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          content: `invalid arguments: ${issue?.path.join('.') ?? '?'} — ${issue?.message ?? 'unparseable'}`,
          isError: true,
        };
      }

      // cwd stays inside the workspace. This bounds where the process *starts*,
      // not what it can write — writes are the sandbox's job — but a cwd outside
      // the root would also anchor srt's profile generation somewhere we did not
      // mean (upstream #432 made that mistake load-bearing).
      const cwd = resolve(scope.root, parsed.data.cwd ?? '.');
      const escape = relative(scope.root, cwd);
      if (escape === '..' || escape.startsWith(`..`) || isAbsolute(escape)) {
        return { content: `cwd escapes the workspace: ${parsed.data.cwd}`, isError: true };
      }

      const result = await executor.run({
        command: parsed.data.command,
        cwd,
        writeScope: [scope.root],
        ...(parsed.data.timeout_ms !== undefined ? { timeoutMs: parsed.data.timeout_ms } : {}),
      });

      return formatExecOutcome(parsed.data.command, result);
    },
  };
}

/** Shared by every tool that runs contained commands (shell, dev). */
export function formatExecOutcome(
  command: string,
  result: ExecResult,
): { content: string; isError?: true } {
  const stderr = annotateSandboxFailures(command, result.stderr);
  const header = result.timedOut
    ? `killed at ${result.durationMs}ms: the command did not complete — nothing after this ran`
    : `exit ${result.code ?? '?'} · ${result.durationMs}ms`;
  const parts = [header];
  if (result.stdout.length > 0) parts.push(result.stdout);
  if (stderr.length > 0) parts.push(`--- stderr ---\n${stderr}`);
  return {
    content: parts.join('\n'),
    ...(result.code !== 0 || result.timedOut ? { isError: true as const } : {}),
  };
}
