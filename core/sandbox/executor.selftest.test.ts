import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { SandboxExecutor } from './executor.js';
import type { SandboxProbe } from './probe.js';

/**
 * The reperto this file exists for (26/08/2026): `probeSandbox` ran its own
 * narrow bwrap invocation, reported `available: true`, and the FIRST real
 * command through `SandboxManager` — the door `SandboxExecutor.run` actually
 * uses — died with `bwrap: Can't mount proc on /newroot/proc: Operation not
 * permitted`, raw, inside a job's own exit. `executor.test.ts` proves the
 * happy path on a real host; this file proves the unhappy ones a real host
 * cannot be coaxed into on demand — a probe that lied, an `initialize()` that
 * throws, a mechanism broken on both legs — by mocking `SandboxManager`
 * itself and driving `SandboxExecutor` (mocked probe injected, per the
 * pattern `executor.test.ts`'s own "when the sandbox is unavailable" describe
 * block already uses) through each one.
 *
 * The mock never re-implements bwrap/seatbelt argv: `wrapWithSandboxArgv` is
 * replaced with a thin, denyRead-aware stand-in, and the argv it returns is
 * really spawned by `spawnCollect` (unmocked) — so each test asserts the same
 * observable outcome `SandboxExecutor` would produce against the real
 * vendored package, without needing bwrap/sandbox-exec installed on the
 * machine running the suite.
 *
 * Where the stand-in forwards the caller's command it runs it under
 * `/bin/bash`, not `/bin/sh` — the same shell the real `wrapWithSandboxArgv`
 * uses in production. Since ADR-0087 every command arrives with the
 * `set -eo pipefail` preamble, which dash (CI's `/bin/sh`) rejects with
 * `Illegal option -o pipefail` and exit 2: a stand-in running `sh` would fail
 * for the runner, not for the command, and the failure would be Linux-only
 * (macOS `/bin/sh` is bash). `BROKEN_INVOCATION` below stays on `/bin/sh` on
 * purpose — it never forwards caller text, it models bwrap's own death
 * rattle.
 */

const initialize = vi.fn<(config: SandboxRuntimeConfig) => Promise<void>>();
const wrapWithSandboxArgv = vi.fn<
  (
    command: string,
    binShell: string | undefined,
    customConfig: Partial<SandboxRuntimeConfig> | undefined,
    signal: AbortSignal | undefined,
    cwd: string,
  ) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>();
const reset = vi.fn<() => Promise<void>>();

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    initialize: (...args: Parameters<typeof initialize>) => initialize(...args),
    wrapWithSandboxArgv: (...args: Parameters<typeof wrapWithSandboxArgv>) => wrapWithSandboxArgv(...args),
    reset: (...args: Parameters<typeof reset>) => reset(...args),
    cleanupAfterCommand: vi.fn(),
    annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
  },
}));

const available = (): SandboxProbe => ({ available: true, mechanism: 'bubblewrap' });

const denyReadOf = (customConfig: Partial<SandboxRuntimeConfig> | undefined): readonly string[] =>
  customConfig?.filesystem?.denyRead ?? [];

/** What bwrap actually printed in the reperto — both legs die the same way. */
const BROKEN_INVOCATION = [
  '/bin/sh',
  '-c',
  "echo \"bwrap: Can't mount proc on /newroot/proc: Operation not permitted\" >&2; exit 1",
];

function mktempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'muffin-selftest-ws-'));
}

describe('the real self-test — SandboxManager mocked, spawnCollect real', () => {
  let toClose: SandboxExecutor | null;

  beforeEach(() => {
    initialize.mockReset().mockResolvedValue(undefined);
    wrapWithSandboxArgv.mockReset();
    reset.mockReset().mockResolvedValue(undefined);
    toClose = null;
  });

  afterEach(async () => {
    if (toClose) await toClose.close();
  });

  it('a real invocation that genuinely contains: verify() says available, and a first run() does not pay initialize() twice', async () => {
    // `command` arrives as `cat <sentinelPath>`, reused verbatim on the allow
    // leg so it really reads the sentinel `selfTestContainment` wrote to
    // disk; the deny leg ignores it and always refuses — exactly what a held
    // deny through the real door looks like from the outside.
    wrapWithSandboxArgv.mockImplementation(async (command, _binShell, customConfig) => ({
      argv: denyReadOf(customConfig).length > 0 ? ['/bin/sh', '-c', 'exit 1'] : ['/bin/bash', '-c', command],
      env: {},
    }));

    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
    toClose = executor;

    const status = await executor.verify();
    expect(status).toEqual({ available: true, mechanism: 'bubblewrap' });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();

    const dir = mktempWorkspace();
    const r = await executor.run({ command: 'true', cwd: dir, writeScope: [dir] });
    expect(r.code).toBe(0);
    // ensureInit() is memoised: the self-test's own initialize() is the ONLY one.
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("the reperto itself: the real invocation cannot even run an unrestricted command (bwrap dies on /proc) — contain_failed, and run() never reaches the caller's command", async () => {
    wrapWithSandboxArgv.mockImplementation(async () => ({ argv: BROKEN_INVOCATION, env: {} }));

    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
    toClose = executor;

    const status = await executor.verify();
    expect(status.available).toBe(false);
    if (status.available) return;
    expect(status.reason).toBe('contain_failed');
    expect(status.detail).toMatch(/unrestricted contained command/);
    expect(reset).toHaveBeenCalledTimes(1);

    const dir = mktempWorkspace();
    const witness = join(dir, 'it-ran.txt');
    await expect(executor.run({ command: `echo ran > '${witness}'`, cwd: dir, writeScope: [dir] })).rejects.toThrow(
      /sandbox unavailable: contain_failed/,
    );
    // Not just refused in words — the caller's actual command never executed.
    expect(existsSync(witness)).toBe(false);
  });

  it('a deny-configured leg that still reads (the real door is not containing anything): contain_failed, the control leg never runs', async () => {
    wrapWithSandboxArgv.mockImplementation(async (command) => ({ argv: ['/bin/bash', '-c', command], env: {} }));

    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
    toClose = executor;

    const status = await executor.verify();
    expect(status.available).toBe(false);
    if (status.available) return;
    expect(status.reason).toBe('contain_failed');
    expect(status.detail).toMatch(/still let a process read/);
    // Same asymmetry probe.ts's own "deny succeeds" test asserts: a deny that
    // did not deny is already the answer, so the allow/control leg never runs.
    expect(wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
  });

  it('`SandboxManager.initialize()` itself throws with a userns-denied signature: classified userns_denied, not the generic reason', async () => {
    initialize.mockReset().mockRejectedValue(new Error('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'));

    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
    toClose = executor;

    const status = await executor.verify();
    expect(status.available).toBe(false);
    if (status.available) return;
    expect(status.reason).toBe('userns_denied');
    expect(status.remedy).toMatch(/apparmor/i);
    // Never got far enough to run a leg.
    expect(wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it('`SandboxManager.initialize()` dice che manca ripgrep: classificato col rimedio dei tre binari, non quello generico', async () => {
    // La forma reale, misurata in container il 27/08: bubblewrap e socat
    // installati, ripgrep no. `SandboxManager` controlla le proprie dipendenze
    // e fallisce PRIMA di invocare bwrap, quindi non passa mai dal ramo
    // `binary_missing` del probe più stretto — l'owner vedeva `contain_failed`
    // col rimedio generico «guarda il detail», che non nomina il pacchetto.
    initialize.mockReset().mockRejectedValue(new Error('Sandbox dependencies not available: ripgrep (rg) not found'));

    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
    toClose = executor;

    const status = await executor.verify();
    expect(status.available).toBe(false);
    if (status.available) return;
    expect(status.reason).toBe('contain_failed');
    expect(status.remedy).toContain('ripgrep');
    expect(status.remedy).toContain('bubblewrap');
    expect(status.remedy).toContain('socat');
    expect(wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it('a cheap probe that already says unavailable short-circuits: SandboxManager.initialize() is never called', async () => {
    const negative = (): SandboxProbe => ({
      available: false,
      mechanism: 'bubblewrap',
      reason: 'userns_denied',
      detail: 'probe says no',
      remedy: 'fix the host',
    });
    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, negative);
    toClose = executor;

    const status = await executor.verify();
    expect(status).toEqual(negative());
    expect(initialize).not.toHaveBeenCalled();
    expect(wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  // I due casi che il judge di #129 ha verificato trascrivendo a mano il flusso
  // di controllo, perché rete non ce n'era: il riuso dell'esecutore DOPO un
  // fallimento, e due chiamate sovrapposte mentre il self-test è in volo.
  // Senza questi, la riscrittura del single-flight che chiude il primo
  // follow-up di quel judge sarebbe un cambio non provato proprio sul percorso
  // che decide se un comando gira contenuto o non gira affatto.
  it('dopo un self-test fallito ogni chiamata successiva rifiuta ancora, e il self-test costoso non si ripaga', async () => {
    wrapWithSandboxArgv.mockImplementation(async () => ({ argv: BROKEN_INVOCATION, env: {} }));
    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
    toClose = executor;
    const dir = mktempWorkspace();

    const first = await executor.verify();
    expect(first.available).toBe(false);
    const legsAfterFirst = wrapWithSandboxArgv.mock.calls.length;
    const initsAfterFirst = initialize.mock.calls.length;

    await expect(executor.run({ command: 'true', cwd: dir, writeScope: [dir] })).rejects.toThrow(
      /sandbox unavailable: contain_failed/,
    );
    await expect(executor.run({ command: 'true', cwd: dir, writeScope: [dir] })).rejects.toThrow(
      /sandbox unavailable: contain_failed/,
    );
    const again = await executor.verify();
    expect(again.available).toBe(false);

    // Fail-closed ogni volta, e il verdetto arriva dal probe ormai negativo:
    // né `initialize()` né una gamba del self-test vengono ripagate.
    expect(initialize.mock.calls.length).toBe(initsAfterFirst);
    expect(wrapWithSandboxArgv.mock.calls.length).toBe(legsAfterFirst);
  });

  it('due chiamate sovrapposte mentre il self-test è in volo condividono un solo giro', async () => {
    wrapWithSandboxArgv.mockImplementation(async (command, _shell, customConfig) => ({
      argv: denyReadOf(customConfig).length > 0 ? BROKEN_INVOCATION : ['/bin/bash', '-c', command],
      env: {},
    }));
    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
    toClose = executor;

    const [a, b] = await Promise.all([executor.verify(), executor.verify()]);
    expect(a.available).toBe(b.available);
    // Un solo initialize() per due chiamate concorrenti: il single-flight
    // regge anche quando la seconda arriva prima che la prima abbia risposto.
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  /**
   * Il 04/09/2026 la CI locale e' stata rossa per un'ora su un messaggio che
   * diceva `contain_failed` e un rimedio generico il cui testo e', alla
   * lettera, *«see detail»*. Il `detail` — «Linux HTTP bridge socket does not
   * exist … The bridge process may have died» — c'era in `cachedProbe` e lo
   * stampa `cli/doctor.ts`, e mancava nell'unico posto dove serviva: l'errore
   * che vede chi ha lanciato il comando. Per leggerlo e' servito modificare
   * `executor.ts` a mano dentro il container.
   *
   * Questo test non prova il contenimento: prova che il messaggio porta la
   * causa. Se torna a portare solo il rimedio, diventa rosso.
   */
  it('il messaggio dell errore porta il detail dell init fallito', async () => {
    initialize.mockImplementation(async () => {
      throw new Error('il ponte HTTP non esiste: /tmp/finto.sock');
    });
    const executor = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
    toClose = executor;
    const dir = mktempWorkspace();

    const errore = await executor
      .run({ command: 'true', cwd: dir, writeScope: [dir] })
      .then(() => null)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

    expect(errore).not.toBeNull();
    expect(errore).toContain('sandbox unavailable:');
    // La riga che conta: senza questa asserzione il messaggio puo' tornare a
    // essere `reason — remedy` e nessuno se ne accorge finche' non serve.
    expect(errore, `il messaggio non porta la causa: ${errore}`).toContain('il ponte HTTP non esiste');
  });
});
