import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { cmdConfigSet } from '../../cli/config.js';
import { eseguiComando, type ContestoComandi } from '../../agent/comandi.js';
import { loadConfig } from './config.js';
import { formatSetOutcome, setConfigKnob } from './settings.js';

/**
 * "Una funzione sola, la stessa risposta per tutte le porte" (ADR-0062),
 * provato confrontando le porte fra loro — non ciascuna contro se stessa, che
 * è ciò che `cli/config.test.ts` e `agent/comandi.test.ts` già fanno.
 *
 * Una mutazione che facesse divergere una porta da `setConfigKnob` — per
 * esempio `cmdConfigSet` che tornasse a scrivere `saveConfig` di suo invece di
 * chiamare la funzione condivisa — non è garantito che rompa il test
 * per-porta di quel file (potrebbe riscrivere una logica quasi identica): è
 * garantito che rompa **questo**, perché questo confronta il testo e il file
 * risultante letteralmente fra le due porte, non ciascuno contro un valore
 * atteso scritto a mano due volte.
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-settings-ports-'));
  runInit({ home: dir, apiKey: 'sk-ant-fixture' });
  return dir;
}

function contesto(home: string): ContestoComandi {
  return {
    home,
    config: loadConfig(home),
    profilo: { name: 'test', thinking: 'unset' },
    budget: { status: () => ({ monthUsd: 0, monthlyCapUsd: 1, exhausted: false }), tenantTodayUsd: () => 0 },
    sessionId: 's',
    verbosity: 'normale',
    puoiUscire: false,
    model: async () => undefined,
  };
}

function captureStdout(fn: () => number): { out: string; code: number } {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    const code = fn();
    return { out, code };
  } finally {
    spy.mockRestore();
  }
}

function captureStderr(fn: () => number): { err: string; code: number } {
  let err = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  try {
    const code = fn();
    return { err, code };
  } finally {
    spy.mockRestore();
  }
}

describe('le tre porte convergono sulla stessa funzione (ADR-0062)', () => {
  it('una scrittura riuscita: CLI e /config producono lo stesso valore scritto e lo stesso testo', async () => {
    const dirCli = home();
    const dirComando = home();

    const { out: outCli, code } = captureStdout(() => cmdConfigSet(dirCli, ['traces.retentionDays', '17']));
    expect(code).toBe(0);
    const esito = await eseguiComando('/config set traces.retentionDays 17', contesto(dirComando));

    // Lo stesso numero, in due home indipendenti — non una copia dello stesso file.
    expect(loadConfig(dirCli).traces.retentionDays).toBe(17);
    expect(loadConfig(dirComando).traces.retentionDays).toBe(17);
    // E lo stesso testo, carattere per carattere: una porta che formattasse la
    // sua propria frase di successo divergerebbe qui anche se scrivesse il
    // valore giusto.
    expect(outCli.trim()).toBe(esito.testo.trim());

    rmSync(dirCli, { recursive: true, force: true });
    rmSync(dirComando, { recursive: true, force: true });
  });

  it('un rifiuto (chiave esclusa): CLI e /config rifiutano con esattamente la stessa ragione', async () => {
    const dirCli = home();
    const dirComando = home();

    const { err, code } = captureStderr(() => cmdConfigSet(dirCli, ['rot.mode', 'hardened']));
    const esito = await eseguiComando('/config set rot.mode hardened', contesto(dirComando));

    expect(code).toBe(78);
    expect(err.trim()).toBe(esito.testo.trim());
    // Nessuna delle due ha scritto niente.
    expect(loadConfig(dirCli).rot.mode).toBe('single-user');
    expect(loadConfig(dirComando).rot.mode).toBe('single-user');

    rmSync(dirCli, { recursive: true, force: true });
    rmSync(dirComando, { recursive: true, force: true });
  });

  it('entrambe le porte producono esattamente formatSetOutcome(setConfigKnob(...)) — non un testo proprio', async () => {
    const dirCli = home();
    const dirComando = home();
    const dirOracolo = home();
    const atteso = formatSetOutcome(setConfigKnob(dirOracolo, 'traces.retentionDays', '5'));

    const { out } = captureStdout(() => cmdConfigSet(dirCli, ['traces.retentionDays', '5']));
    const esito = await eseguiComando('/config set traces.retentionDays 5', contesto(dirComando));

    expect(out.trim()).toBe(atteso);
    expect(esito.testo.trim()).toBe(atteso);

    rmSync(dirCli, { recursive: true, force: true });
    rmSync(dirComando, { recursive: true, force: true });
    rmSync(dirOracolo, { recursive: true, force: true });
  });
});
