import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolSpec } from '../providers/types.js';
import type { RegisteredTool } from '../loop.js';

const execFileAsync = promisify(execFile);

/**
 * sys.process — typed process primitives.
 *
 * These are deliberately not shell commands: a fixed binary with fixed argv has
 * no injection surface, the kernel can inspect the pid being killed, and the
 * dangerous edges (kill 0, kill -1, kill self) are unrepresentable instead of
 * discovered. Shell remains the long tail; this is the structured case.
 *
 * Both are host-only. The matrix row for host processes denies everything at
 * taint ≥2, so the list capability narrows its ceiling explicitly — `low` risk
 * would otherwise default to 3.
 */
export const processCapabilities: CapabilityDecl[] = [
  {
    id: 'sys.process.list',
    risk: 'low',
    reversible: 'yes',
    maxTaint: 1,
    resourceKind: 'none',
    policyArgs: [],
    hostOnly: true,
  },
  {
    id: 'sys.process.kill',
    risk: 'high',
    reversible: 'no',
    resourceKind: 'none',
    policyArgs: ['pid', 'signal'],
    hostOnly: true,
  },
];

export const processListSpec: ToolSpec = {
  name: 'process_list',
  description:
    'List running processes (pid, user, command). Read-only. Output is capped; ' +
    'filter with the optional `grep` substring instead of asking for everything.',
  inputSchema: {
    type: 'object',
    properties: {
      grep: { type: 'string', description: 'Case-insensitive substring filter on the line' },
    },
  },
};

export const processKillSpec: ToolSpec = {
  name: 'process_kill',
  description:
    'Send a signal to one process by pid (default SIGTERM). Refuses pid 0/negative ' +
    '(process groups) and the agent process itself. Killing what you did not start ' +
    'usually needs the owner: say why in your reply when you use this.',
  inputSchema: {
    type: 'object',
    properties: {
      pid: { type: 'number', description: 'Process id, > 1' },
      signal: { type: 'string', enum: ['TERM', 'INT', 'HUP', 'KILL'], description: 'Default TERM' },
    },
    required: ['pid'],
  },
};

const listArgs = z.object({ grep: z.string().min(1).max(200).optional() });

/**
 * pid > 1 keeps init out of reach; excluding our own pid keeps "clean up the
 * stray processes" from becoming an unintentional shutdown. Groups (0, -n) are
 * rejected by the schema shape itself, not by a check that could be skipped.
 */
const killArgs = z.object({
  pid: z.number().int().gt(1),
  signal: z.enum(['TERM', 'INT', 'HUP', 'KILL']).default('TERM'),
});

const LIST_MAX_LINES = 200;

/**
 * `pid,user,comm` and never `args`: another process's argv can carry secrets
 * (tokens passed as flags, connection strings), and a listing that reprints
 * them into the model's context is an exfiltration path wearing a ps costume.
 * `comm` names the binary, which is what "what is running?" actually asks.
 */
const PS_ARGV = ['-eo', 'pid,user,comm'] as const;

/** Injectable so the wiring — that we ask ps for comm, never args — is testable. */
export type ProcessDeps = {
  psFn?: (argv: readonly string[]) => Promise<string>;
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
};

export function makeProcessTools(deps: ProcessDeps = {}): RegisteredTool[] {
  const psFn =
    deps.psFn ?? (async (argv) => (await execFileAsync('ps', [...argv], { timeout: 5_000 })).stdout);
  const killFn = deps.killFn ?? ((pid, signal) => process.kill(pid, signal));

  return [
    {
      capability: 'sys.process.list',
      spec: processListSpec,
      handler: async (args) => {
        const parsed = listArgs.safeParse(args);
        if (!parsed.success) {
          return { content: 'invalid arguments: grep must be a short string', isError: true };
        }
        let stdout: string;
        try {
          stdout = await psFn(PS_ARGV);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { content: `ps failed: ${detail}`, isError: true };
        }
        const needle = parsed.data.grep?.toLowerCase();
        const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
        const header = lines[0] ?? 'PID USER COMMAND';
        const body = lines.slice(1);
        const matched = needle ? body.filter((l) => l.toLowerCase().includes(needle)) : body;
        const shown = matched.slice(0, LIST_MAX_LINES);
        const cut =
          matched.length > shown.length
            ? `\n…[${matched.length - shown.length} processi omessi — restringi con grep]`
            : '';
        return { content: [header, ...shown].join('\n') + cut };
      },
    },
    {
      capability: 'sys.process.kill',
      spec: processKillSpec,
      handler: (args) => {
        const parsed = killArgs.safeParse(args);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return {
            content: `invalid arguments: ${issue?.path.join('.') ?? '?'} — ${issue?.message ?? 'unparseable'}`,
            isError: true,
          };
        }
        const { pid, signal } = parsed.data;
        if (pid === process.pid) {
          return { content: `refused: ${pid} is the agent process itself`, isError: true };
        }
        try {
          killFn(pid, `SIG${signal}`);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ESRCH') return { content: `no process with pid ${pid}`, isError: true };
          if (code === 'EPERM') {
            return { content: `not permitted to signal pid ${pid} (another user's process)`, isError: true };
          }
          const detail = error instanceof Error ? error.message : String(error);
          return { content: `kill failed: ${detail}`, isError: true };
        }
        // Delivery is not death: TERM can be caught or ignored. Say what was
        // done, not what we hope happened.
        return { content: `SIG${signal} delivered to pid ${pid} — check with process_list whether it exited` };
      },
    },
  ];
}