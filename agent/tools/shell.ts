import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { CapabilityDecl, TrustTier } from '../../core/policy/types.js';
import {
  annotateSandboxFailures,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_TIMEOUT_MS,
  type ExecResult,
  type SandboxExecutor,
} from '../../core/sandbox/executor.js';
import type { RegisteredTool } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';
import { DISK_TIER, fenceDisk } from './fs.js';

/**
 * The two contained command lanes — `shell_run` and `shell_run_write`.
 *
 * Muffin is not a coding agent: it reads code (fs_read) and runs scripts, and
 * this is where scripts run, inside the sandbox. Until ADR-0074 there was one
 * lane and it always asked, and the live register said what that cost: **all
 * 35 approvals ever requested on the owner's installation were `sys.shell`**,
 * 32 yes and 3 no. A gate granted nine times out of ten is a reflex, not a
 * decision — and the commands behind it were `ls`, `lsof`, `sqlite3`, `env`
 * (`docs/evidence/tool-use-2026-09-06.md`).
 *
 * The split still follows the line the ADR draws, `ask` ⇔ irreversible — and
 * since the 2026-09-22 Linux measurement (#645, ADR-0091) both lanes stand on
 * the asking side of it:
 *
 *  - **`shell_run` / `sys.shell`** — the sandbox confines writes to session
 *    scratch and disables direct IP networking (`SandboxExecutor.runReadOnly`).
 *    On Linux a contained command cannot open Unix-domain sockets at all (the
 *    filter is requested and verified); the Muffin gateway socket is
 *    additionally deny-listed. Reads cover the whole host minus a
 *    finite deny-list (recorded in SECURITY's “Shell read scope and sandbox
 *    patch posture” section, measured on Linux 2026-09-22): stdout reaches
 *    the model and disclosure has no undo.
 *    `reversible: 'no'`, `risk: 'high'`, and the kernel asks every time
 *    (ADR-0091 plus the AF_UNIX recovery correction below).
 *  - **`shell_run_write` / `sys.shell.write`** — writes into the workspace,
 *    exactly as the single lane always did. `reversible: 'no'`, `risk: 'high'`,
 *    and it asks every time.
 *
 * **Two tools rather than one tool with a `write: true` parameter**, and the
 * reason is structural rather than stylistic. `RegisteredTool.capability` is
 * one string resolved before the handler runs (`agent/loop/tool-call.ts`), so
 * a mode parameter would mean the kernel deciding on `sys.shell` and the
 * handler then choosing how much authority to use — the guarantee would live
 * in a branch inside the handler instead of in the wiring, and the kernel
 * would be gating a capability that is not the one being exercised. With two
 * tools the read-only door is a different capability, decided by the kernel
 * before anything runs, and its handler *has no way* to reach the workspace:
 * `runReadOnly` takes a `ReadOnlyExecRequest`, which has no `writeScope` field
 * at all. The second-order benefit is the one the ADR asks for out loud — the
 * model picks by name from two descriptions rather than by remembering to
 * leave a boolean alone.
 *
 * **Where the sandbox cannot prove containment, neither lane runs.**
 * `agent/runtime.ts` registers both only on a positive `probeSandbox`, and the
 * executor re-checks on every call (`ensureInit`): a host whose real invocation
 * cannot hold may list the tools and refuses every command. The read-only lane
 * never degrades to the writing one: absent containment, absent run, and the
 * answer says to use a dedicated tool or to run it by hand (ADR-0018 rule 5,
 * ADR-0074 punto 4). v1 stays strict by construction — there is no unsandboxed
 * retry.
 */
export const shellCapability: CapabilityDecl = {
  id: 'sys.shell',
  // Still `host`, and deliberately not `context` — which is where the ceiling
  // and the unattended-floor would be 3/3 and this lane would be as free as
  // `fs_read`. Residuals keep it here, all declared in `docs/architecture/SECURITY.md`
  // §9: reads cover the whole host filesystem minus a finite deny-list (not
  // just the project — measured on Linux 2026-09-22, #645); writes stay in
  // scratch and direct IP networking is disabled. On Linux the AF_UNIX
  // seccomp filter is requested and behaviorally verified before any
  // contained command runs (a host where it cannot hold refuses every
  // invocation). The Muffin
  // gateway socket and pointer are additionally deny-listed (#638, macOS).
  // Commands also spend
  // host CPU and file descriptors. Whole-host output can disclose data, so
  // ADR-0091 makes every call ask the owner.
  effect: 'host',
  // Risk still governs safe mode and the budget, not the ask (ADR-0074 point
  // 1). A contained command reads a broad host filesystem and spends host
  // resources; filesystem writes stay in scratch and direct IP networking is
  // disabled, and on Linux Unix sockets are refused by the verified seccomp
  // filter. High risk keeps this capability unavailable in safe mode and
  // subject to budget limits. ADR-0091 made the read disclosure itself
  // irreversible.
  risk: 'high',
  reversible: 'no',
  // A contained command can still affect the host outside the filesystem
  // (signals to same-UID processes, resource spend). If the outcome row is
  // missing after a crash, recovery must report “maybe done” instead of
  // issuing the command again.
  rerunnable: false,
  // NOT `progress: 'idempotent_read'`. That flag says a second identical call
  // returns what the model already has, and it is exactly wrong here: `ps`,
  // `lsof`, `df`, `tail` are the commands this lane exists for, and every one
  // of them answers differently a second later. `fs.read` may declare it; a
  // shell may not.
  resourceKind: 'none',
  policyArgs: ['command'],
  hostOnly: true,
  timeoutMs: EXEC_MAX_TIMEOUT_MS,
};

export const shellWriteCapability: CapabilityDecl = {
  id: 'sys.shell.write',
  effect: 'host',
  risk: 'high',
  reversible: 'no',
  // A command is an arbitrary program: it may have sent something, moved
  // something, or charged something. The sandbox bounds where it can write, not
  // whether running it twice means doing it twice.
  rerunnable: false,
  resourceKind: 'none',
  policyArgs: ['command'],
  hostOnly: true,
  timeoutMs: EXEC_MAX_TIMEOUT_MS,
  // The pin that used to live here is gone, and nothing about this capability
  // changed: `maxTaint: 2` was the owner's 2026-08-16 decision (ADR-0044
  // §revisione) transcribed onto one declaration, and `effect: 'host'` above
  // now says the same thing where the whole row can read it — "ALLOW per
  // classe · ASK · DENY", the cell the threat model already printed. The
  // difference is that `fs.write` and `sys.process.kill` sit on that row too
  // and never got the transcription, which is the drift ADR-0053 repairs. The
  // hardened auto-allow still requires `taint === 0`, so a read still ends the
  // silent path and leaves only the ask; taint 3 is still out of reach.
};

/** Shared by both specs: the half of the schema that does not depend on the lane. */
const commonProperties = {
  command: { type: 'string', description: 'The command line to execute' },
  cwd: {
    type: 'string',
    description: 'Working directory, relative to the project root. Default: the root.',
  },
  timeout_ms: {
    type: 'number',
    description: `Kill timeout in ms. Default ${EXEC_DEFAULT_TIMEOUT_MS}, max ${EXEC_MAX_TIMEOUT_MS}.`,
  },
} as const;

/** Shared by both specs: the owner-facing sentence shown above an approval. */
const descriptionProperty = {
  description: {
    type: 'string',
    description:
      'One plain sentence for the owner, in their language: what this command does and why you are running it. ' +
      'It is shown above the command when the owner is asked to approve it.',
  },
} as const;

const shellSpec: ToolSpec = {
  name: 'shell_run',
  description:
    'Run a non-interactive shell command in the contained read lane. ' +
    'It asks the owner every time: what a command reads on this machine reaches the conversation and cannot be ' +
    'taken back. The whole host filesystem is readable except for a finite deny-read list; writes stay in a ' +
    'temporary scratch directory, direct IP networking is disabled, and on Linux Unix-domain sockets are blocked ' +
    'by the sandbox. This lane is treated as high risk and is not replayed after an ' +
    'uncertain crash. Muffin gateway socket paths are deny-listed. Prefer project-relative reads; ' +
    'an absolute path outside the project reads the owner\u2019s machine, ' +
    'and its output reaches the model. Use it when you need to observe something no ' +
    'dedicated tool wraps: `ls`, `lsof`, `sqlite3 -readonly`, `env`, `ps`, `df`, `du`, `git status`, `git log`, ' +
    '`wc`, `find`, a dry run. Not for what a dedicated tool answers better than parsed text — `cat`/`ls` of a ' +
    'known file (fs_read, fs_list), a search in the files (fs_search), `ps` (process_list), a question about this ' +
    'instance (sys_inspect), an indexed document (document_read), what you already know (memory_search), a URL or ' +
    'a search (http_get, web_search) — and not for anything that WRITES: a command that changes a file fails here ' +
    'with a permission error, which is the boundary working, not a bug. A command that writes belongs to ' +
    'shell_run_write. The working directory does NOT persist ' +
    'between calls — pass cwd each time. Returns the exit code, stdout and stderr; output over ~30k characters is ' +
    'cut head-and-tail with an explicit marker. An unhandled failure anywhere fails the whole call — a pipeline ' +
    'fails if any stage fails, and a sequence stops at the first failing command. A failure you handle in the ' +
    'command itself (`cmd || fallback`, `if cmd`, `! cmd`) may still succeed.',
  inputSchema: {
    type: 'object',
    properties: { ...commonProperties, ...descriptionProperty },
    // Both lanes produce an ASK since ADR-0091, so both declare the summary
    // line the owner reads above the command. JSON-required for the model;
    // zod keeps it optional below, because a provider that drops a field must
    // not turn a pending approval into a failed command.
    required: ['command', 'description'],
  },
};

const shellWriteSpec: ToolSpec = {
  name: 'shell_run_write',
  description:
    'Run a non-interactive shell command that CHANGES something — the last resort, and it asks the owner every ' +
    'time. Use shell_run instead whenever the command only reads (`ls`, `lsof`, `sqlite3 -readonly`, `env`, ' +
    '`grep`, `git status`): that one confines filesystem writes and, on Linux, cannot open Unix-domain sockets ' +
    'either; it asks too and is not replayed after an uncertain crash. ' +
    'Not for `echo … >` a single file (fs_write), ' +
    '`kill` (process_kill), or a URL you already have a tool for (http_get, web_search). Use it when the task ' +
    'genuinely needs a program none of the above wraps — a build, a test suite, an install, a one-off script that ' +
    'writes. Writes are confined to the working directory and a scratch TMPDIR; direct IP networking is disabled, ' +
    'and on Linux Unix-domain sockets are blocked by the verified sandbox filter as well. ' +
    'The working directory does NOT persist between calls — pass cwd each time. Returns the exit code, stdout and ' +
    'stderr; output over ~30k characters is cut head-and-tail with an explicit marker. An unhandled failure ' +
    'anywhere fails the whole call — a pipeline fails if any stage fails, and a sequence stops at the first ' +
    'failing command, so check the effect happened instead of reading on past it. A failure you handle in the ' +
    'command itself (`cmd || fallback`, `if cmd`, `! cmd`) may still succeed. If the sandbox blocks the ' +
    'command, say so and tell the owner what to run themselves; there is no unsandboxed retry.',
  inputSchema: {
    type: 'object',
    properties: { ...commonProperties, ...descriptionProperty },
    // `description` is required of the model — the schema is what it reads —
    // and tolerated missing at parse time below: a scripted call in a test,
    // or a provider that drops a field, must not turn into a failed command.
    // The ASK simply has no summary line then (`ApprovalRequest.description`).
    // Since ADR-0091 the read-only lane declares it too: it asks as well.
    required: ['command', 'description'],
  },
};

/** Parse at the boundary: the model's JSON is external data (practice §4). */
const shellArgs = z.object({
  command: z.string().min(1, 'command must not be empty'),
  description: z.string().optional(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().min(1_000).max(EXEC_MAX_TIMEOUT_MS).optional(),
});

export type ShellScope = {
  /** Absolute. The project directory this session may write into. */
  root: string;
};

/**
 * What each tool actually needs — and they need *different* methods, which is
 * the point. A fake with only `runReadOnly` is a valid executor for the
 * read-only tool and cannot satisfy the writing one, so a test cannot
 * accidentally give the read-only lane a door it does not have.
 */
type ReadOnlyExec = Pick<SandboxExecutor, 'runReadOnly'>;
type WriteExec = Pick<SandboxExecutor, 'run'>;

/**
 * `throwTier: 0`, verified rather than assumed (judge round-1 named this tool
 * specifically). `SandboxExecutor.spawnCollect` (`core/sandbox/executor.ts`)
 * never REJECTS with stdout/stderr — every exit, including a non-zero one,
 * resolves through the `child.on('close', …)` branch into a normal
 * `ExecResult`, which is what `formatExecOutcome` tiers at `DISK_TIER` on the
 * *return* path. The only reject path is `child.on('error', …)`, Node's own
 * spawn-failure text (e.g. ENOENT on the binary), and `ensureInit()`'s
 * `sandbox unavailable: …` message — both ours, neither the command's output.
 */
const THROW_TIER = 0 satisfies TrustTier;

/**
 * Everything the two lanes share: parse, keep the cwd inside the project, hand
 * the command to whichever executor door the caller passed, format the result.
 *
 * The lane is the `esegui` closure and nothing else — one function per tool,
 * captured at construction, never a branch on an argument the model wrote.
 */
function makeLane(
  spec: ToolSpec,
  capability: CapabilityDecl,
  scope: ShellScope,
  esegui: (req: { command: string; cwd: string; timeoutMs?: number }) => Promise<ExecResult>,
): RegisteredTool {
  return {
    capability: capability.id,
    spec,
    throwTier: THROW_TIER,
    handler: async (args) => {
      const parsed = shellArgs.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          content: `invalid arguments: ${issue?.path.join('.') ?? '?'} — ${issue?.message ?? 'unparseable'}`,
          isError: true,
          // Nothing ran, so nothing came back. The command never reached the
          // sandbox and this string is ours.
          tier: 0,
        };
      }

      // cwd stays inside the project. This bounds where the process *starts*,
      // not what it can write — writes are the sandbox's job — but a cwd outside
      // the root would also anchor srt's profile generation somewhere we did not
      // mean (upstream #432 made that mistake load-bearing).
      const cwd = resolve(scope.root, parsed.data.cwd ?? '.');
      const escape = relative(scope.root, cwd);
      if (escape === '..' || escape.startsWith('..') || isAbsolute(escape)) {
        return { content: `cwd escapes the project: ${parsed.data.cwd}`, isError: true, tier: 0 };
      }

      let result: ExecResult;
      try {
        result = await esegui({
          command: parsed.data.command,
          cwd,
          ...(parsed.data.timeout_ms !== undefined ? { timeoutMs: parsed.data.timeout_ms } : {}),
        });
      } catch (error) {
        // `ensureInit()` throws `sandbox unavailable: …` when containment
        // cannot be proved on this host — the case ADR-0074 punto 4 names by hand:
        // *«dove il sandbox non può garantire il confine, la shell in sola
        // lettura non esiste: non degrada in silenzio a `sys.shell.write`»*.
        // The answer is a refusal in Muffin's own voice, and there is no other
        // branch here to fall into: the closure captured one door at
        // construction and cannot reach the other one.
        return {
          content: sandboxAssente(spec.name, error),
          isError: true,
          // Ours: `ensureInit`'s own message plus this sentence. See THROW_TIER.
          tier: 0,
        };
      }

      return formatExecOutcome(parsed.data.command, result);
    },
  };
}

/** `shell_run` — the read-only lane. Never reaches `executor.run`. */
export function makeShellTool(executor: ReadOnlyExec, scope: ShellScope): RegisteredTool {
  return makeLane(shellSpec, shellCapability, scope, (req) => executor.runReadOnly(req));
}

/** `shell_run_write` — the writing lane, with the workspace as its write scope. */
export function makeShellWriteTool(executor: WriteExec, scope: ShellScope): RegisteredTool {
  return makeLane(shellWriteSpec, shellWriteCapability, scope, (req) =>
    executor.run({ ...req, writeScope: [scope.root] }),
  );
}

/**
 * Il sandbox non c'è, e questa è la frase che lo dice — in italiano, perché la
 * legge l'owner attraverso il modello, e senza offrire una scorciatoia.
 *
 * Non nomina l'altra corsia come rimedio: se il contenimento non si prova,
 * *nessuna* delle due esiste, e suggerire «riprova con shell_run_write» sarebbe
 * la degradazione silenziosa scritta a parole.
 */
function sandboxAssente(tool: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    `Non ho eseguito niente: su questa macchina il sandbox non riesce a garantire il confine, ` +
    `quindi "${tool}" non è utilizzabile e non esiste una versione non contenuta a cui ripiegare. ` +
    `Usa uno strumento dedicato se ce n'è uno per quello che serve, oppure esegui il comando a mano. ` +
    `Dettaglio: ${detail}`
  );
}

/**
 * Turn a contained run into a model-facing result: header, stdout, annotated
 * stderr.
 *
 * **`fenceDisk`, the same fence `fs_read` uses, and for the same reason as the
 * tier below.** A command's stdout can contain host-file bytes;
 * `cat ~/Downloads/nota.md` is
 * `fs_read` through a different door, and a door that tiered but did not fence
 * was a door around the marking that the other one now does.
 *
 * **`DISK_TIER`, the same constant `fs_read` uses, and not a coincidence.**
 * `shell_run` has no direct IP networking and its Unix-domain sockets are
 * blocked (verified on Linux, never allowed by Seatbelt); stdout still carries
 * host-file bytes. `cat ~/Downloads/nota.md` is `fs_read` with a different door, and
 * a door that did not taint was a door around the one that did. The tier is on
 * the output, not on the act: the command the model chose is not the danger,
 * the bytes coming back are.
 *
 * **The cost, as it stands after the owner's decision (ADR-0044 §Revisione
 * 2026-08-16), not the verdict that decision replaced.** `sys.shell` sits on
 * the `host` effect row, whose ceiling is 2 (ADR-0053; it was a `maxTaint: 2`
 * pinned on this declaration alone until then), so one read (`DISK_TIER` = 2) downgrades
 * `shell_run` to an **`ask`**, not the flat `deny/taint_exceeded` this file
 * used to describe — that is what keeps *"leggi il file e poi lancia i
 * test"* completable with the owner's yes. The floor stays real: the hardened
 * auto-allow still requires `taint === 0` (`core/policy/decide.ts`), which a
 * turn that has read anything never reaches at a ceiling of 2 any more than at
 * 1, and a turn at taint 3 — a web/search/mcp result, the one case that still
 * reaches the ceiling — is still a flat `deny/taint_exceeded`: this widened
 * the ceiling by exactly one step, not to the top of the scale. Asserted as a
 * cost, not just a non-regression, in `agent/tools/shell.test.ts` §"the cost,
 * stated as a test".
 */
function formatExecOutcome(
  command: string,
  result: ExecResult,
): { content: string; isError?: true; tier: TrustTier } {
  const stderr = annotateSandboxFailures(command, result.stderr);
  // Three exits, three sentences. A signal kill (`code: null`, not a timeout)
  // used to read `exit ?` — a truthful character and a misleading sentence,
  // inviting the model to treat an interruption as an ambiguous result. The
  // command behind it runs under `set -eo pipefail` (see `STRICT_SHELL_PREFIX`
  // in `core/sandbox/executor.ts`), so any other non-zero code already means
  // an unhandled failure somewhere in the sequence, not just in the last
  // process.
  const header = result.timedOut
    ? `killed at ${result.durationMs}ms: the command did not complete — nothing after this ran`
    : result.code === null
      ? `killed by a signal after ${result.durationMs}ms: the command did not complete — nothing after this ran`
      : `exit ${result.code} · ${result.durationMs}ms`;
  const parts: string[] = [];
  if (result.stdout.length > 0) parts.push(result.stdout);
  if (stderr.length > 0) parts.push(`--- stderr ---\n${stderr}`);
  return {
    // Header outside, output inside — the same shape `http.ts` uses, where the
    // status line stays above the fence and the body goes in it. And the fence
    // is unconditional: a command that printed nothing still produces an empty
    // one, so there is a single shape rather than a branch an attacker can aim
    // at by arranging for no output. `annotateSandboxFailures`' own sentence
    // ends up inside too, which marks Muffin's own text as less trusted than it
    // is — the direction that fails closed, unlike letting a byte out.
    content: [header, fenceDisk(parts.join('\n'), `output di \`${command}\``)].join('\n'),
    ...(result.code !== 0 || result.timedOut ? { isError: true as const } : {}),
    tier: DISK_TIER,
  };
}
