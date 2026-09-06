import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import {
  probeSandbox,
  isUsernsDenied,
  APPARMOR_REMEDY,
  SANDBOX_BINARIES_REMEDY,
  message,
  type SandboxProbe,
} from './probe.js';

/**
 * The one door to sandboxed execution.
 *
 * `@anthropic-ai/sandbox-runtime` is a 0.0.x pinned exact, and this module is
 * the boundary ADR-0026 requires around it: the srt config is constructed here
 * field by field — never passed through from anywhere — because srt silently
 * ignores unknown config keys (upstream #434), and a typo'd `denyWriteTypo`
 * would otherwise become an empty deny list that still reports success.
 *
 * Every guarantee this module relies on has a test that executes a real
 * containment (executor.test.ts); trusting the README instead of a probe is
 * how the previous sandbox was a no-op for two months.
 *
 * **`ensureInit` self-tests through this same door, and that is deliberate
 * (reperto 26/08/2026).** `probeSandbox` (`./probe.ts`) proves bwrap/
 * sandbox-exec exist and hold on ITS OWN narrow invocation — two `execFileSync`
 * calls, hand-rolled, five lines of bwrap flags. `SandboxManager` builds a
 * different, much larger invocation (network bridge, credential masking, and on
 * Linux a fresh `--proc` mount the probe never attempts at all). The two can
 * disagree: on a container where the outer runtime denies mounting `/proc`,
 * the probe's own legs never touch `/proc` and report `available`, while the
 * FIRST real command run through `SandboxManager` dies with `bwrap: Can't
 * mount proc on /newroot/proc: Operation not permitted` — raw, inside that
 * command's own stderr. `ensureInit` below runs one trivial contained round
 * trip through `SandboxManager` itself, right after `initialize()`, before any
 * caller's actual command ever reaches `wrapWithSandboxArgv`. If containment
 * does not hold on the real path, the caller gets the same typed `sandbox
 * unavailable: …` this module already threw for a negative `probeSandbox` —
 * fail-closed, and never a bwrap parser dump masquerading as a command result.
 * `verify()` is the read-only twin `doctor`/`muffin init` call to learn this
 * BEFORE a session ever starts, at the cost of one real init+round-trip
 * (measured in the PR, not estimated).
 */

export type ExecRequest = {
  /** The command line, run non-interactively (no PTY — upstream #419 cluster). */
  command: string;
  /** Absolute. Where the command runs; also anchors srt profile generation. */
  cwd: string;
  /** Absolute directories writable for THIS invocation only. */
  writeScope: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * The read-only lane's request, and **the point is the field that is missing**.
 *
 * `writeScope` is not optional here, it is absent: `runReadOnly` has nowhere to
 * put a workspace even if a caller wanted to hand it one, so the boundary
 * ADR-0074 §4 asks for is carried by the type rather than by a rule someone has
 * to keep obeying. Widening this lane to the workspace is not a wrong argument
 * at one call site — it is an edit to this file, which is what separates a
 * wiring from a prohibition (AGENTS.md, "un divieto non regge il cablaggio").
 */
export type ReadOnlyExecRequest = Omit<ExecRequest, 'writeScope'>;

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
};

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
/**
 * The self-test's sentinel is a file THIS process creates fresh under its own
 * scratch dir — not `/etc/hosts` (what `probe.ts`'s own narrower check reads).
 * Measured, not assumed (2026-08-26, macOS 15): `/etc` is a symlink to
 * `/private/etc`, and `SandboxManager`'s seatbelt profile denies by
 * `(subpath "/etc/hosts")` — the literal, unresolved spelling. The kernel
 * matches sandbox path filters against the RESOLVED vnode, `/private/etc/
 * hosts`, so that deny rule never fired: `cat /etc/hosts` read clean through a
 * profile that explicitly denied it, and a self-test built on that path would
 * report `contain_failed` on every macOS host — a false red, the mirror image
 * of the bug this file exists to catch. A self-owned scratch file has no
 * symlinked ancestor to launder the match through.
 */
const SELFTEST_SENTINEL_NAME = '.muffin-selftest-sentinel';
/** Per leg. Two legs, so a hang here costs at most 2×. */
const SELFTEST_LEG_TIMEOUT_MS = 10_000;
/**
 * Belt-and-suspenders over the two per-leg timeouts: bounds `initialize()`
 * itself, which has no timeout of its own (it may start a network bridge).
 * "Nessun blocco eterno" — a hang here must resolve to unavailable, not hang
 * `doctor`/`muffin init`/the first `shell_run` forever.
 */
const SELFTEST_OVERALL_TIMEOUT_MS = 25_000;
/** Per stream, head+tail around a marker; matches what peers keep inline. */
const EXEC_MAX_OUTPUT_CHARS = 30_000;
/** Hard buffering cap per stream so a firehose cannot eat the process heap. */
const BUFFER_HARD_CAP = 200_000;

/** What the real self-test found wrong — same reason taxonomy `probe.ts` uses. */
type ContainmentFailure = {
  reason: 'userns_denied' | 'contain_failed';
  detail: string;
  remedy: string;
};

/**
 * `SandboxManager.initialize()`/`wrapWithSandboxArgv()` threw outright — the
 * self-test never got to run a command at all (e.g. #213's TMPDIR socket
 * path, or a dependency check failing). Classified with the same
 * `isUsernsDenied` heuristic `selfTestContainment` uses, so a userns-denied
 * failure reads the same whether it surfaces as a thrown rejection or as a
 * non-zero exit.
 */
function classifyContainmentError(error: unknown): ContainmentFailure {
  const detail = message(error);
  if (isUsernsDenied(detail)) {
    return { reason: 'userns_denied', detail, remedy: APPARMOR_REMEDY };
  }
  if (isMissingDependency(detail)) {
    // Il caso che si incontra davvero su una macchina nuova, e che finora
    // rispondeva col rimedio generico «guarda il detail». `SandboxManager`
    // controlla le sue dipendenze da sé e fallisce *prima* di invocare bwrap,
    // quindi non passa mai dal ramo `binary_missing` del probe — l'owner
    // vedeva `contain_failed` e un rimedio che non nominava il pacchetto
    // mancante. Misurato in container: con bubblewrap e socat installati e
    // ripgrep no, il messaggio è «Sandbox dependencies not available:
    // ripgrep (rg) not found».
    return { reason: 'contain_failed', detail, remedy: SANDBOX_BINARIES_REMEDY };
  }
  return {
    reason: 'contain_failed',
    detail,
    remedy:
      'the real sandbox invocation (SandboxManager) failed on this host — see detail; this is the same path the runtime uses to run commands, not the narrower probe',
  };
}

/**
 * Il messaggio dice che manca un binario, non che il contenimento ha ceduto.
 *
 * Le parole sono quelle di `@anthropic-ai/sandbox-runtime`, che controlla le
 * proprie dipendenze prima di invocare bwrap; qui si riconoscono per poter dare
 * il rimedio che le nomina tutte e tre invece di quello generico.
 */
function isMissingDependency(detail: string): boolean {
  return /dependencies not available|not found in PATH|\b(?:rg|ripgrep|socat|bwrap|bubblewrap)\b[^\n]{0,40}not found/i.test(
    detail,
  );
}

/**
 * **No network, and the one place that says so.**
 *
 * Every config this module builds — session, per-call, self-test — reads its
 * `network` block from here, so "the sandbox has no network" is one function
 * to check and one function to break. That matters more since ADR-0074 §4:
 * `sys.shell` (the read-only lane) declares `reversible: 'yes'` and never asks,
 * and the claim behind `'yes'` is exactly this — a command that cannot open a
 * socket cannot have sent anything that would need undoing.
 *
 * **What actually does the work, measured in `@anthropic-ai/sandbox-runtime`
 * 0.0.71, not assumed from the field names.** `allowedDomains` being *defined*
 * — empty is still defined — is what sets srt's `needsNetworkRestriction`
 * (`dist/sandbox/sandbox-manager.js`, `hasNetworkConfig`). On Linux that flag
 * is what pushes `--unshare-net` into the bwrap argv
 * (`dist/sandbox/linux-sandbox-utils.js`); on macOS it is what makes the
 * seatbelt profile omit `(allow network*)` (`dist/sandbox/macos-sandbox-utils.js`).
 * Delete the key and both disappear silently — the whole host network comes
 * back with nothing going red. That is the mutation the containment test
 * `core/sandbox/confine-sola-lettura.test.ts` is written to catch.
 *
 * `deniedDomains: ['*']` is the second lock, on the proxy rather than the
 * kernel: srt checks the deny list *first* and refuses unconditionally, where
 * an empty allowlist alone refuses only because no `SandboxAskCallback` is
 * registered (its own `NetworkRestrictionConfig` docstring says so). Nothing
 * registers one today; this stops the day something does from being a silent
 * widening.
 *
 * **Declared residual: AF_UNIX on Linux.** `allowAllUnixSockets` skips srt's
 * seccomp layer, which is the only thing that blocks `socket(AF_UNIX, …)` —
 * v1 keeps it on because two open upstream bugs (#428, #429) break seccomp on
 * Ubuntu 24.04. `--unshare-net` does not cover Unix sockets: they are
 * filesystem objects, and `connect()` to one is not a write, so a socket
 * reachable under the read-only bind is reachable from the read-only lane too.
 * The read-only lane therefore promises *no IP network and no writes outside
 * the scratch* — not "no side effects reachable by any means". Written down in
 * `docs/SECURITY.md` §9 rather than left as a gap between what the code does
 * and what the capability declares.
 */
function networkOff(): SandboxRuntimeConfig['network'] {
  return {
    allowedDomains: [],
    deniedDomains: ['*'],
    ...(process.platform === 'linux' ? { allowAllUnixSockets: true } : {}),
  };
}

/** Paths the sandbox must never touch, whatever the per-call scope says. */
export type ExecGuards = {
  /** RoT, config, secrets — denied in write always (threat model §3-bis). */
  denyWrite: readonly string[];
  /** Secrets — denied in read: a child that reads the key has already won. */
  denyRead: readonly string[];
};

/**
 * How many directory levels under a write root get walked looking for a
 * nested checkout's `.git/hooks`. Matches `@anthropic-ai/sandbox-runtime`'s
 * own default (`DEFAULT_MANDATORY_DENY_SEARCH_DEPTH` in its Linux
 * implementation) — a checkout nested deeper than this is rare enough that
 * the traversal cost is not worth paying on every command.
 */
const NESTED_GIT_HOOKS_SEARCH_DEPTH = 3;

/**
 * `ExecGuards.denyWrite`'s `.git/hooks` entry (`core/rot/guards.ts`,
 * `mandatoryGuards`) names only the TOP of `cwd`, computed once per turn. A
 * coding flow's `git clone`/`git worktree add` puts a second, independently
 * executable `.git/hooks` anywhere under the write scope, possibly created
 * by an earlier command in the SAME turn — after that literal was computed.
 *
 * `@anthropic-ai/sandbox-runtime` ships its own "nested repos" protection
 * (`macGetMandatoryDenyPatterns` / `linuxGetMandatoryDenyPaths`) and it does
 * not cover this either: measured 2026-09-04, both implementations resolve
 * paths against `process.cwd()` — the `SandboxManager` HOST process's own
 * directory — never the `cwd` a caller passes to `wrapWithSandboxArgv`. A
 * real round trip through the PRE-fix `run()` confirmed it: with a nested
 * checkout already sitting under the write scope, a write to its
 * `.git/hooks/pre-commit` still succeeded — srt was protecting the daemon's
 * own repo, not the turn's workspace. The mandatory-guards literal above it
 * (`join(cwd, '.git', 'hooks')`) is therefore NOT decorative — it is the
 * only thing that was ever real here, and it only reached the top level.
 *
 * So this walk happens HERE, fresh on every `run()` — not folded into
 * `mandatoryGuards` and cached for the turn — so a checkout created by
 * command N is denied by command N+1 of the same turn (measured: fixed).
 * Only concrete, resolved paths go into `denyWrite`, never a glob: srt's own
 * `stripWriteGlobs` silently DROPS any `filesystem.denyWrite` entry that
 * contains glob characters on Linux, so a `**\/.git/hooks` pattern would
 * compile clean here and protect nothing on the platform Muffin actually
 * runs on (a VPS) — the same shape of silent-empty-deny-list this module's
 * own docstring already warns about for a typo'd config key.
 *
 * **Declared limit, not silently left open**: a checkout created and
 * written to inside ONE `shell_run` call (e.g. `git clone x && echo evil >
 * x/.git/hooks/pre-commit`) still gets through — this walk runs once,
 * before the whole compound command is spawned, and a filesystem profile
 * compiled ahead of time cannot see a directory the command itself creates
 * mid-execution. `agent/tools/fs.ts`'s structural check
 * (`isNestedGitHooksPath`) has no such gap for the `fs_write` tool, because
 * it inspects the actual resolved path of each call rather than a
 * pre-computed list — but `shell_run`'s containment is srt's ahead-of-time
 * profile, which has no equivalent live check.
 */
function nestedGitHooksDirs(root: string, depth: number = NESTED_GIT_HOOKS_SEARCH_DEPTH): string[] {
  const found: string[] = [];
  const walk = (dir: string, remaining: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // gone or unreadable between listing and here — nothing to protect there
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue; // the one directory guaranteed to dwarf everything else
      const full = join(dir, entry.name);
      if (entry.name === '.git') {
        found.push(join(full, 'hooks'));
        continue; // hooks cannot nest inside hooks
      }
      if (remaining > 0) walk(full, remaining - 1);
    }
  };
  walk(root, depth);
  return found;
}

/**
 * Quanti esecutori hanno inizializzato `SandboxManager` e non si sono ancora
 * chiusi.
 *
 * Esiste perche' `SandboxManager` **non e' per istanza**: e' stato di modulo,
 * uno per processo. Su Linux la sua `reset()` ammazza i due processi `socat`
 * del bridge di rete e fa `fs.rmSync` sui loro socket
 * (`sandbox-manager.js`, ramo `managerContext.linuxBridge`). Quindi un
 * `close()` — che e' un'operazione **per istanza** — smontava la rete di
 * *tutti* gli esecutori vivi nello stesso processo, e quelli restavano con il
 * loro `initPromise` risolto, convinti di essere inizializzati, fino al
 * comando dopo:
 *
 *   contain_failed — Linux HTTP bridge socket does not exist:
 *   /tmp/claude-http-<hex>.sock. The bridge process may have died.
 *
 * Misurato il 04/09/2026 nella CI locale, job `verifica`: in
 * `evals/system/acceptance.test.ts` un runtime di lunga vita convive con
 * runtime usa-e-getta che si chiudono nel `finally` di ogni caso, e il primo
 * moriva per mano dei secondi. Su macOS non si vedeva **e non si poteva
 * vedere**: senza bridge Linux, quella `reset()` non ha niente da smontare.
 *
 * Il conteggio sta qui e non nell'istanza per la stessa ragione per cui il
 * guasto stava li': la risorsa e' del processo, non dell'oggetto.
 */
let esecutoriVivi = 0;

/**
 * `reset()` solo quando l'ultimo se ne va — altrimenti si smonta la rete a chi
 * sta ancora lavorando. Non lasciarla mai a un `catch` muto: se il conteggio
 * scendesse senza reset resterebbero due `socat` orfani per processo.
 */
async function rilascia(): Promise<void> {
  esecutoriVivi = Math.max(0, esecutoriVivi - 1);
  if (esecutoriVivi === 0) await SandboxManager.reset();
}

export class SandboxExecutor {
  private initPromise: Promise<void> | null = null;
  private cachedProbe: SandboxProbe | null = null;
  private scratchDir: string | null = null;

  constructor(
    private readonly guards: ExecGuards,
    /** Injectable so a test can exercise the unavailable path on any machine. */
    private readonly probe: () => SandboxProbe = probeSandbox,
  ) {}

  /** Cached: the answer cannot change while the process runs. */
  status(): SandboxProbe {
    this.cachedProbe ??= this.probe();
    return this.cachedProbe;
  }

  /**
   * Session scratch space: writable in every invocation, survives across
   * commands of the same session so `cmd1 > f && cmd2 < f` workflows hold.
   */
  private scratch(): string {
    this.scratchDir ??= mkdtempSync(join(tmpdir(), 'muffin-exec-'));
    return this.scratchDir;
  }

  /**
   * Single-flight, and the reset that lets a later call try again lives HERE —
   * in one place, after the await, where it is actually reached.
   *
   * It used to be two resets inside the body below, and the first of them was
   * dead code (judge #129, follow-up, proven with a repro): the synchronous
   * `!status.available` branch runs while the right-hand side of `??=` is
   * still being evaluated, so the assignment overwrote the `null` a moment
   * later and that branch memoised a rejected promise instead of clearing it.
   * Harmless in effect — every later call still rejected, fail-closed — but
   * the two branches behaved differently while looking identical, which is
   * the kind of thing the next edit builds on and gets wrong.
   */
  private async ensureInit(): Promise<void> {
    this.initPromise ??= this.initOnce();
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  private async initOnce(): Promise<void> {
    {
      const status = this.status();
      if (!status.available) {
        throw new Error(`sandbox unavailable: ${status.reason} — ${status.remedy}`);
      }

      // The claim this block exists to make true: `available` means a
      // contained command actually ran through the SAME door a real caller's
      // command will use — not that `probeSandbox`'s own narrower invocation
      // happened to hold. `initialize()` and the round trip share one deadline
      // so neither can hang `doctor`/`init`/the first `shell_run` forever.
      //
      // The timer backing that deadline is captured and cleared once the race
      // settles — measured, not assumed (2026-08-26): `Promise.race` does not
      // cancel the losing side, so an uncleared `setTimeout(…, 25_000)` here
      // kept `doctor`/`init`'s *process* alive for the full 25s after `verify()`
      // had already resolved in under 100ms, because Node will not exit while a
      // referenced timer is still pending — a self-inflicted cost so close in
      // shape to the reperto (a healthy answer, paid for with a silent hang on
      // the real path) that it would have shipped as this file's own instance
      // of it.
      let overallTimer: NodeJS.Timeout | undefined;
      let failure: ContainmentFailure | null;
      try {
        failure = await Promise.race([
          (async () => {
            await SandboxManager.initialize(this.baseConfig());
            return this.selfTestContainment();
          })(),
          new Promise<ContainmentFailure>((resolve) => {
            overallTimer = setTimeout(
              () =>
                resolve({
                  reason: 'contain_failed',
                  detail: `the real containment self-test did not finish within ${SELFTEST_OVERALL_TIMEOUT_MS}ms`,
                  remedy: 'the sandbox mechanism (bwrap/sandbox-exec) may be hanging on this host — check for stuck processes',
                }),
              SELFTEST_OVERALL_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (error) {
        failure = classifyContainmentError(error);
      } finally {
        clearTimeout(overallTimer);
      }

      if (failure) {
        // A throwaway/failed init leaves no live session worth keeping —
        // reset() before handing back control, same as `close()` would. Ma
        // solo se non c'e' nessun altro dentro: questo esecutore non e' mai
        // entrato nel conteggio, e resettare qui con altri vivi e' proprio il
        // guasto che `esecutoriVivi` esiste per chiudere.
        if (esecutoriVivi === 0) await SandboxManager.reset().catch(() => {});
        this.cachedProbe = { available: false, mechanism: status.mechanism, ...failure };
        // Il `detail` entra nel messaggio, non solo nella sonda in cache.
        //
        // Fino al 04/09/2026 qui usciva `reason — remedy`, e il rimedio del
        // caso generico dice testualmente *«see detail»* — cioe' rimandava a
        // una cosa che non mostrava. Misurato quel giorno dentro il container
        // della CI locale: la causa vera era *«Linux HTTP bridge socket does
        // not exist … The bridge process may have died»*, e per leggerla e'
        // servito modificare questa riga a mano. `cli/doctor.ts` il `detail`
        // lo stampa gia (righe ~1053 e ~1091): era **solo** il percorso di
        // esecuzione — quello che vedono il modello e l'owner quando un
        // comando fallisce davvero — a perderlo.
        //
        // Conta anche perche' `classifyContainmentError` fa cadere su
        // `contain_failed` tutto cio' che non riconosce: un banale TypeError
        // dentro l'init si presentava come «il sandbox non contiene su questo
        // host», con un rimedio su AppArmor che non c'entrava niente.
        throw new Error(`sandbox unavailable: ${failure.reason} — ${failure.detail} — ${failure.remedy}`);
      }

      // Da qui il manager globale e' inizializzato **per conto di questo
      // esecutore**: entra nel conteggio, e ne esce solo in `close()`. Fuori
      // dal ramo di guasto di proposito — un init fallito non lascia niente da
      // rilasciare, e contarlo lascerebbe il conteggio sopra lo zero per
      // sempre, cioe' due `socat` orfani a fine processo.
      esecutoriVivi += 1;
    }
  }

  /**
   * One trivial deny/allow round trip, through `SandboxManager.
   * wrapWithSandboxArgv` — the exact call `run()` below makes — rather than
   * through this file's own bwrap/sandbox-exec flags. Assumes `SandboxManager.
   * initialize()` already succeeded; this only asks "does a REAL wrapped
   * command actually get contained".
   *
   * Same two-legged shape `probe.ts` uses, for the same reason its own
   * comments document twice over: a single deny leg cannot tell "containment
   * held" apart from "the mechanism is broken and everything fails" — the
   * exact ambiguity that produced this file's incident (the deny leg failing
   * on `Can't mount proc` looks identical to a held deny unless a control run
   * is also required to succeed).
   */
  private async selfTestContainment(): Promise<ContainmentFailure | null> {
    const cwd = this.scratch();
    const sentinelPath = join(cwd, SELFTEST_SENTINEL_NAME);
    writeFileSync(sentinelPath, 'muffin sandbox self-test — this line must be unreadable during the deny leg\n');

    const runLeg = async (denyRead: string[]): Promise<ExecResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SELFTEST_LEG_TIMEOUT_MS);
      try {
        const legConfig: Partial<SandboxRuntimeConfig> = {
          network: networkOff(),
          // `allowWrite: [cwd]` on both legs even though the command only
          // reads: `run()` below always includes the scratch dir in
          // allowWrite, and a self-test that omits it is one more gratuitous
          // difference from the real invocation — exactly the shape of gap
          // that let this file's own bug hide from the old probe.
          filesystem: { denyRead, allowWrite: [cwd], denyWrite: [] },
        };
        const wrapped = await SandboxManager.wrapWithSandboxArgv(
          `cat ${sentinelPath}`,
          undefined,
          legConfig,
          controller.signal,
          cwd,
        );
        return await this.spawnCollect(
          wrapped.argv,
          this.childEnv(wrapped.env, cwd),
          { command: `cat ${sentinelPath}`, cwd, writeScope: [cwd], signal: controller.signal },
          SELFTEST_LEG_TIMEOUT_MS,
          Date.now(),
        );
      } finally {
        clearTimeout(timer);
      }
    };

    const deny = await runLeg([sentinelPath]);
    if (deny.timedOut) {
      // A hang is not a held deny: without this, a stuck bwrap/sandbox-exec
      // process on the deny leg would read as "denied" and the allow leg below
      // could then report the sandbox available on a mechanism that never
      // actually answered.
      return {
        reason: 'contain_failed',
        detail: `the denied read of the self-test sentinel through SandboxManager did not exit within ${SELFTEST_LEG_TIMEOUT_MS}ms — a hang is not evidence of a held deny`,
        remedy: 'the real sandbox invocation may be hanging on this host — check for stuck bwrap/sandbox-exec processes',
      };
    }
    if (deny.code === 0) {
      return {
        reason: 'contain_failed',
        detail:
          `a real sandboxed invocation through SandboxManager still let a process read ` +
          `a file with it explicitly denied — the runtime's own execution path is not containing anything`,
        remedy: 'check whether the sandbox actually engages for real commands, not only for a narrower probe invocation',
      };
    }

    const allow = await runLeg([]);
    if (allow.code !== 0) {
      const detail = allow.stderr.trim() || allow.stdout.trim() || `exit ${allow.code}`;
      if (isUsernsDenied(detail)) {
        return { reason: 'userns_denied', detail, remedy: APPARMOR_REMEDY };
      }
      return {
        reason: 'contain_failed',
        detail: `SandboxManager could not run even an unrestricted contained command (${detail}) — the denied read failing above is not evidence of containment when this unrestricted one fails too`,
        remedy: 'the real sandbox invocation is broken independent of any deny policy — check the mechanism against this kernel/OS/container',
      };
    }
    if (!allow.stdout.includes('muffin sandbox self-test')) {
      // Exit 0 with the wrong (or empty) content is not yet "read succeeded":
      // it would also be the signature of `cat` racing a not-yet-flushed
      // write, or of some other command silently swallowed on this host.
      return {
        reason: 'contain_failed',
        detail: `the unrestricted leg exited 0 but did not read the sentinel's content back (stdout: ${JSON.stringify(allow.stdout.slice(0, 200))})`,
        remedy: 'the real sandbox invocation is not behaving as a plain read on this host — check the mechanism against this kernel/OS/container',
      };
    }

    return null;
  }

  /**
   * The read-only twin of `run()`: pays the same real self-test `ensureInit`
   * does, through the same door, but reports the outcome instead of
   * committing to run a caller's command. `doctor` and `muffin init` call
   * this — they want the truth about this host before a session starts, not
   * an attempted execution.
   */
  async verify(): Promise<SandboxProbe> {
    try {
      await this.ensureInit();
    } catch {
      // ensureInit() already downgraded cachedProbe to the honest negative
      // result before throwing this same information as an Error; status()
      // below reads the cached value back instead of re-parsing the message.
    }
    return this.status();
  }

  /**
   * Base config. Explicit keys only, and the guards are repeated in every
   * per-call config below: srt merges customConfig per-field, and relying on
   * that merge to preserve a deny list is one ambiguity too many for the part
   * that holds the Root of Trust.
   */
  private baseConfig(): SandboxRuntimeConfig {
    return {
      network: networkOff(),
      filesystem: {
        denyRead: [...this.guards.denyRead],
        allowWrite: [],
        denyWrite: [...this.guards.denyWrite],
      },
    };
  }

  /**
   * **The read-only lane** (`sys.shell`, ADR-0074 §4).
   *
   * Writes land in the session scratch and nowhere else — not the workspace,
   * not the home, not the caller's cwd — and the network is off. That pair is
   * the whole reason the capability may declare `reversible: 'yes'` and never
   * ask: a command that can only touch a directory this process created under
   * `tmpdir()` and deletes in `close()` has nothing to undo, and a command with
   * no socket has sent nothing.
   *
   * `cwd` is still the caller's: reading is the point, and `--ro-bind / /`
   * makes the whole filesystem readable minus `guards.denyRead` either way.
   * What changes between the lanes is `allowWrite`, and `ReadOnlyExecRequest`
   * is the type that makes it unchangeable from outside.
   */
  async runReadOnly(req: ReadOnlyExecRequest): Promise<ExecResult> {
    return this.execute({ ...req, writeScope: [] });
  }

  /** **The writing lane** (`sys.shell.write`): `req.writeScope`, and an ask. */
  async run(req: ExecRequest): Promise<ExecResult> {
    return this.execute(req);
  }

  private async execute(req: ExecRequest): Promise<ExecResult> {
    await this.ensureInit();
    const scratch = this.scratch();
    const timeoutMs = Math.min(req.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS);

    const perCall: Partial<SandboxRuntimeConfig> = {
      network: networkOff(),
      filesystem: {
        denyRead: [...this.guards.denyRead],
        // The scratch is in both lanes, and it is the *only* entry the
        // read-only lane has: `runReadOnly` passes `writeScope: []`, so this
        // spread contributes nothing there. `cmd1 > f && cmd2 < f` keeps
        // working in both, because the scratch survives the session.
        allowWrite: [...req.writeScope, scratch],
        // `nestedGitHooksDirs` walks every writable root fresh, THIS call —
        // see its docstring for why neither `this.guards.denyWrite` (fixed
        // once per turn) nor srt's own nested-repo protection (anchored to
        // its own process, not `req.cwd`) cover a checkout cloned mid-turn.
        denyWrite: [
          ...this.guards.denyWrite,
          ...new Set([req.cwd, ...req.writeScope].flatMap((root) => nestedGitHooksDirs(root))),
        ],
      },
    };

    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      req.command,
      undefined,
      perCall,
      req.signal,
      req.cwd,
    );

    const started = Date.now();
    try {
      return await this.spawnCollect(wrapped.argv, this.childEnv(wrapped.env, scratch), req, timeoutMs, started);
    } finally {
      // Linux leaves ghost mount-point files for deny paths that did not exist;
      // upstream documents this as the embedder's job after every command.
      SandboxManager.cleanupAfterCommand();
    }
  }

  /**
   * The child's environment is rebuilt, not inherited: the host process holds
   * the model API key in env, and a deny-read on the secrets *file* protects
   * nothing if the key rides in via environ. Keep a small base allowlist plus
   * whatever srt added or changed (its proxy plumbing) — a secret already in
   * the host env is by definition unchanged, so it never crosses.
   */
  private childEnv(srtEnv: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ']) {
      if (process.env[key] !== undefined) out[key] = process.env[key];
    }
    for (const [key, value] of Object.entries(srtEnv)) {
      if (value !== undefined && process.env[key] !== value) out[key] = value;
    }
    out['TMPDIR'] = scratch;
    return out;
  }

  private spawnCollect(
    argv: string[],
    env: NodeJS.ProcessEnv,
    req: ExecRequest,
    timeoutMs: number,
    started: number,
  ): Promise<ExecResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: req.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        ...(req.signal ? { signal: req.signal } : {}),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < BUFFER_HARD_CAP) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < BUFFER_HARD_CAP) stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => rejectPromise(error));
      child.on('close', (code, signal) => {
        const durationMs = Date.now() - started;
        const timedOut = signal === 'SIGKILL' && durationMs >= timeoutMs;
        const so = clip(stdout);
        const se = clip(stderr);
        resolvePromise({
          code,
          stdout: so.text,
          stderr: se.text,
          truncated: so.truncated || se.truncated,
          timedOut,
          durationMs,
        });
      });
    });
  }

  /** Best effort, safe to call more than once. */
  async close(): Promise<void> {
    if (this.scratchDir) {
      try {
        rmSync(this.scratchDir, { recursive: true, force: true });
      } catch {
        // scratch under tmpdir: the OS reclaims it if we could not
      }
      this.scratchDir = null;
    }
    if (this.initPromise) {
      this.initPromise = null;
      await rilascia();
    }
  }
}

/**
 * Head-and-tail, weighted toward the tail: errors and results live at the end
 * of output, and a cut that keeps only the beginning hides exactly the part
 * the model needs. The cut is announced in the text — an unannounced cut reads
 * as a complete result, which is this project's canonical failure.
 */
function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= EXEC_MAX_OUTPUT_CHARS) return { text, truncated: false };
  const head = text.slice(0, 10_000);
  const tail = text.slice(-20_000);
  const omitted = text.length - head.length - tail.length;
  return {
    text: `${head}\n…[output troncato: ~${omitted} caratteri omessi]…\n${tail}`,
    truncated: true,
  };
}

/** Exposed for the shell tool: srt annotates denials so the model sees why. */
export function annotateSandboxFailures(command: string, stderr: string): string {
  try {
    return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
  } catch {
    return stderr;
  }
}
