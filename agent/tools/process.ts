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
    effect: 'context',
    risk: 'low',
    reversible: 'yes',
    rerunnable: true,
    maxTaint: 1,
    resourceKind: 'none',
    policyArgs: [],
    hostOnly: true,
  },
  {
    id: 'sys.process.kill',
    effect: 'host',
    risk: 'high',
    reversible: 'no',
    // A pid is not a stable name. Between the call that may have landed and the
    // repeat, the number can belong to a different process — so the second
    // signal is not "the same call again", it is a new one at a new target.
    rerunnable: false,
    resourceKind: 'none',
    policyArgs: ['pid', 'signal'],
    hostOnly: true,
  },
];

const processListSpec: ToolSpec = {
  name: 'process_list',
  description:
    'List running processes (pid, user, command). Use it when you need to check what is running, find a pid to ' +
    'inspect or kill, or confirm something started or stopped — this is the tool for `ps`, not shell_run. Not for ' +
    "a process's own output or logs: those come from wherever it was started, not from this listing. Read-only. " +
    'Output is capped; filter with the optional `grep` substring instead of asking for everything. Returns one ' +
    'line per process: pid, user, command. e.g. process_list({grep: "node"}).',
  inputSchema: {
    type: 'object',
    properties: {
      grep: { type: 'string', description: 'Case-insensitive substring filter on the line' },
    },
  },
};

const processKillSpec: ToolSpec = {
  name: 'process_kill',
  description:
    'Send a signal to one process by pid (default SIGTERM). Use it when you need to stop a specific process you ' +
    'found with process_list or that you started yourself — this is the tool for `kill`, not shell_run. Not for a ' +
    'process you did not start and cannot identify with confidence: killing what you did not start usually needs ' +
    'the owner, say why in your reply when you use this. Refuses pid 0/negative (process groups) and the agent ' +
    'process itself. Returns whether the signal was sent.',
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
      // `throwTier: 0` — the only `await` that can reject (`psFn`) is wrapped in
      // its own `try`/`catch` two lines down and never escapes the handler; a
      // process-table listing (the actually risky text) leaves only through the
      // `return` at the bottom, tiered 1 there. If `psFn` ever threw uncaught it
      // would be a `ps` invocation error, not a captured line of the table.
      throwTier: 0,
      handler: async (args) => {
        const parsed = listArgs.safeParse(args);
        if (!parsed.success) {
          return { content: 'invalid arguments: grep must be a short string', isError: true, tier: 0 };
        }
        let stdout: string;
        try {
          stdout = await psFn(PS_ARGV);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { content: `ps failed: ${detail}`, isError: true, tier: 0 };
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
        // Tier 1, the same tier a skill body carries, and for the same reason:
        // this text is not the owner's words, but it is *the owner's machine
        // describing itself*. `PS_ARGV` asks for `comm` and never `args`, so
        // what comes back is the names of binaries someone had to install and
        // start here — an attacker who can choose one has already executed code
        // on the host, which is a different game and a lost one.
        //
        // Not `DISK_TIER`. The distinction is provenance, not squeamishness: a
        // file lands in `~/Downloads` because the owner clicked a link, which
        // costs an attacker nothing; a line in this listing costs them the host.
        // Deliberately below the ceiling `sys.process.list` pins (1), so the
        // typed read of the process table does not become a once-per-turn tool.
        return { content: [header, ...shown].join('\n') + cut, tier: 1 };
      },
    },
    {
      capability: 'sys.process.kill',
      spec: processKillSpec,
      // Tier 0 on every path: `process_kill` is a write. Every string it can
      // return is one this file wrote — a refusal, an errno translated, or the
      // receipt below. Nothing enters the turn, so nothing taints it.
      // `throwTier: 0` to match: `killFn` is wrapped in its own `try`/`catch`
      // below and nothing here ever reads bytes from anywhere else.
      throwTier: 0,
      handler: (args) => {
        const parsed = killArgs.safeParse(args);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return {
            content: `invalid arguments: ${issue?.path.join('.') ?? '?'} — ${issue?.message ?? 'unparseable'}`,
            isError: true,
            tier: 0,
          };
        }
        const { pid, signal } = parsed.data;
        if (pid === process.pid) {
          return { content: `refused: ${pid} is the agent process itself`, isError: true, tier: 0 };
        }
        try {
          killFn(pid, `SIG${signal}`);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ESRCH') return { content: `no process with pid ${pid}`, isError: true, tier: 0 };
          if (code === 'EPERM') {
            return {
              content: `not permitted to signal pid ${pid} (another user's process)`,
              isError: true,
              tier: 0,
            };
          }
          const detail = error instanceof Error ? error.message : String(error);
          return { content: `kill failed: ${detail}`, isError: true, tier: 0 };
        }
        // Delivery is not death: TERM can be caught or ignored. Say what was
        // done, not what we hope happened.
        return {
          content: `SIG${signal} delivered to pid ${pid} — check with process_list whether it exited`,
          tier: 0,
        };
      },
    },
  ];
}