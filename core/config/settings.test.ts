import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { loadConfig, saveConfig } from './config.js';
import { describeSettableKnobs, formatSetOutcome, SETTABLE_CONFIG_KEYS, setConfigKnob } from './settings.js';

/**
 * `setConfigKnob` — la funzione sola dietro `muffin config set`, `/config set`
 * e Telegram (ADR-0062). Questi test coprono la parte che nessuna porta deve
 * poter aggirare: quali chiavi si possono scrivere, e con quale validazione.
 * Le porte stesse (CLI, comando) hanno i loro test in `cli/config.test.ts` e
 * `agent/comandi.test.ts` — qui si prova solo il cancello.
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-settings-'));
  runInit({ home: dir, apiKey: 'sk-ant-fixture' });
  return dir;
}

describe('setConfigKnob — le chiavi escluse restano escluse', () => {
  it('una chiave sconosciuta è rifiutata e nomina le alternative', () => {
    const dir = home();
    const outcome = setConfigKnob(dir, 'non.esiste', '1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('non è un\'impostazione modificabile');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rot.mode — postura di sicurezza, mai da qui', () => {
    const dir = home();
    const before = loadConfig(dir);
    const outcome = setConfigKnob(dir, 'rot.mode', 'hardened');
    expect(outcome.ok).toBe(false);
    expect(loadConfig(dir)).toEqual(before); // niente scritto
    rmSync(dir, { recursive: true, force: true });
  });

  it('provider.kind e provider.apiKeyRef — provider e segreti, mai da qui', () => {
    const dir = home();
    for (const key of ['provider.kind', 'provider.apiKeyRef', 'provider.routing.dataCollection']) {
      const outcome = setConfigKnob(dir, key, 'qualcosa');
      expect(outcome.ok, `${key} dovrebbe essere rifiutata`).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('chiavi con una porta dedicata (models.main, thinking, surfaces.default, prompt.version) non sono in questo elenco — evita una seconda scrittura divergente', () => {
    for (const key of ['models.main', 'thinking', 'surfaces.default', 'prompt.version']) {
      expect(SETTABLE_CONFIG_KEYS).not.toContain(key);
    }
  });
});

describe('setConfigKnob — traces.retentionDays', () => {
  it('scrive un intero positivo e lo si rilegge da un loadConfig fresco', () => {
    const dir = home();
    const outcome = setConfigKnob(dir, 'traces.retentionDays', '45');
    expect(outcome).toMatchObject({ ok: true, key: 'traces.retentionDays', previous: '90', next: '45' });
    expect(loadConfig(dir).traces.retentionDays).toBe(45);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rifiuta un valore non intero, senza toccare il file', () => {
    const dir = home();
    const before = loadConfig(dir);
    for (const bad of ['abc', '-3', '0', '3.5', '']) {
      const outcome = setConfigKnob(dir, 'traces.retentionDays', bad);
      expect(outcome.ok, `«${bad}» dovrebbe essere rifiutato`).toBe(false);
    }
    expect(loadConfig(dir)).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('un valore già uguale è idempotente e lo dice, senza riscrivere', () => {
    const dir = home();
    const outcome = setConfigKnob(dir, 'traces.retentionDays', '90');
    expect(outcome).toMatchObject({ ok: true, unchanged: true });
    expect(formatSetOutcome(outcome)).toContain('già');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('setConfigKnob — search.maxResults', () => {
  it('rifiuta finché la ricerca non è configurata, e spiega perché', () => {
    const dir = home();
    const outcome = setConfigKnob(dir, 'search.maxResults', '5');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('non è configurata');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scrive solo il numero quando la ricerca esiste già, senza toccare provider/chiave', () => {
    const dir = home();
    const withSearch = { ...loadConfig(dir), search: { provider: 'tavily' as const, apiKeyRef: 'secret://search_key' } };
    saveConfig(withSearch, dir);
    const outcome = setConfigKnob(dir, 'search.maxResults', '7');
    expect(outcome).toMatchObject({ ok: true, next: '7' });
    const after = loadConfig(dir);
    expect(after.search?.maxResults).toBe(7);
    expect(after.search?.provider).toBe('tavily');
    expect(after.search?.apiKeyRef).toBe('secret://search_key');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rifiuta fuori dal range 1-20', () => {
    const dir = home();
    saveConfig({ ...loadConfig(dir), search: { provider: 'tavily', apiKeyRef: 'secret://k' } }, dir);
    expect(setConfigKnob(dir, 'search.maxResults', '0').ok).toBe(false);
    expect(setConfigKnob(dir, 'search.maxResults', '21').ok).toBe(false);
    expect(setConfigKnob(dir, 'search.maxResults', '20').ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('describeSettableKnobs / formatSetOutcome', () => {
  it('elenca ogni chiave scrivibile, una riga a testa', () => {
    const testo = describeSettableKnobs();
    for (const key of SETTABLE_CONFIG_KEYS) expect(testo).toContain(key);
  });

  it('formatta un rifiuto restituendo esattamente la ragione — nessuna porta deve reinventare il testo', () => {
    const dir = home();
    const outcome = setConfigKnob(dir, 'rot.mode', 'hardened');
    expect(formatSetOutcome(outcome)).toBe((outcome as { ok: false; reason: string }).reason);
    rmSync(dir, { recursive: true, force: true });
  });
});
