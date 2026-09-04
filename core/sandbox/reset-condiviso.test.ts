import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { SandboxExecutor } from './executor.js';
import type { SandboxProbe } from './probe.js';

/**
 * `SandboxManager` non e' per istanza: e' stato di modulo, uno per processo.
 * Su Linux la sua `reset()` ammazza i due `socat` del bridge di rete e fa
 * `fs.rmSync` sui loro socket. Quindi `SandboxExecutor.close()` — che e'
 * un'operazione **per istanza** — smontava la rete di ogni altro esecutore
 * vivo nello stesso processo, e quelli restavano con `initPromise` risolto,
 * convinti di essere inizializzati, fino al comando dopo:
 *
 *   contain_failed — Linux HTTP bridge socket does not exist:
 *   /tmp/claude-http-<hex>.sock. The bridge process may have died.
 *
 * Misurato il 04/09/2026 nella CI locale (job `verifica`, container
 * ubuntu:24.04): `evals/system/acceptance.test.ts` tiene un runtime di lunga
 * vita accanto a runtime usa-e-getta chiusi nel `finally` di ogni caso, e il
 * primo moriva per mano dei secondi. Il probe della stessa corsa diceva
 * `{"available": true}` pochi secondi prima — cioe' il meccanismo funzionava
 * e il risultato era comunque sbagliato.
 *
 * Su macOS non si vedeva **e non si poteva vedere**: senza bridge Linux
 * quella `reset()` non ha niente da smontare. Per questo la prova qui e' sul
 * **contratto** (chi chiama `reset`, e quando) e non sull'effetto: un test che
 * chiede a un vero bridge di morire proverebbe solo la macchina su cui gira.
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

/** Contenimento che regge: la gamba con deny rifiuta, quella di controllo passa. */
function contieneDavvero(): void {
  wrapWithSandboxArgv.mockImplementation(async (command, _binShell, customConfig) => ({
    argv: denyReadOf(customConfig).length > 0 ? ['/bin/sh', '-c', 'exit 1'] : ['/bin/sh', '-c', command],
    env: {},
  }));
}

async function esecutoreVivo(): Promise<SandboxExecutor> {
  const e = new SandboxExecutor({ denyWrite: [], denyRead: [] }, available);
  const stato = await e.verify();
  expect(stato.available).toBe(true);
  return e;
}

describe('la reset del manager e del processo, non dell istanza', () => {
  beforeEach(() => {
    initialize.mockReset().mockResolvedValue(undefined);
    wrapWithSandboxArgv.mockReset();
    reset.mockReset().mockResolvedValue(undefined);
    contieneDavvero();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('chiudere un esecutore mentre un altro lavora non resetta niente', async () => {
    const lungaVita = await esecutoreVivo();
    const usaEGetta = await esecutoreVivo();

    await usaEGetta.close();
    expect(reset).not.toHaveBeenCalled();

    // Bilancia il conteggio: e' stato di processo, e un test che lo lascia
    // sopra lo zero fa passare il prossimo per la ragione sbagliata.
    await lungaVita.close();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("l'ultimo che se ne va resetta, una volta sola", async () => {
    const a = await esecutoreVivo();
    const b = await esecutoreVivo();
    const c = await esecutoreVivo();

    await a.close();
    await b.close();
    expect(reset).not.toHaveBeenCalled();

    await c.close();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('un esecutore solo si comporta come prima: chiude e resetta', async () => {
    const solo = await esecutoreVivo();
    await solo.close();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('chiudere due volte non resetta due volte, e non manda il conteggio sotto zero', async () => {
    const solo = await esecutoreVivo();
    await solo.close();
    await solo.close();
    expect(reset).toHaveBeenCalledTimes(1);

    // La prova che il conteggio non e' andato a -1: un esecutore nuovo che
    // apre e chiude deve resettare di nuovo. Con un conteggio negativo il suo
    // `close()` lo riporterebbe a zero senza mai arrivarci.
    const dopo = await esecutoreVivo();
    await dopo.close();
    expect(reset).toHaveBeenCalledTimes(2);
  });
});
