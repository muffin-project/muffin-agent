import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type Config,
} from '../core/config/config.js';
import { cmdSurfaceDefault, cmdSurfaceList } from './surface.js';

/**
 * `surfaces.default` era una manopola senza porta.
 *
 * Il campo si dichiara da sempre come *«dove Muffin parla quando nessuno ha
 * chiesto»* — lo leggono `muffin observe` e la corsia degli impegni (ADR-0060)
 * — ma `DEFAULT_CONFIG` lo mette a `cli`, `muffin surface enable telegram` non
 * lo tocca, e nessun comando lo cambiava. Sull'installazione reale dell'owner:
 * `default: "cli"` con Telegram e Discord accesi. Sotto un supervisore quel
 * `cli` e' il journal, quindi un promemoria scaduto finiva in un log — e non
 * c'era modo di spostarlo se non aprendo `config.json` a mano.
 */

function home(surfaces: Config['surfaces']): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-surface-default-'));
  saveConfig(
    {
      ...DEFAULT_CONFIG,
      schemaVersion: CONFIG_SCHEMA_VERSION,
      provider: { kind: 'anthropic', apiKeyRef: 'secret://anthropic_api_key' },
      models: { main: 'm', light: 'l' },
      rot: { mode: 'single-user' },
      surfaces,
    } as Config,
    dir,
  );
  // `surface list` chiede alla casella di posta quante righe ha in coda, e la
  // apre in sola lettura: un file che non esiste e' un errore, non uno zero.
  new DatabaseCtor(join(dir, 'muffin.db')).close();
  return dir;
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
  return { out, err };
}

describe('muffin surface default', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sposta il canale su cui Muffin parla di sua iniziativa', () => {
    const dir = home({ default: 'cli', enabled: ['cli', 'telegram'] });
    const { out } = capture();
    const code = cmdSurfaceDefault(dir, 'telegram');
    vi.restoreAllMocks();

    expect(code).toBe(0);
    // La config, non l'output: e' il file che la corsia legge.
    expect(loadConfig(dir).surfaces.default).toBe('telegram');
    expect(out.join('')).toContain('superficie predefinita: telegram');
  });

  it('rifiuta una superficie spenta, e nomina il comando che la accende', () => {
    const dir = home({ default: 'cli', enabled: ['cli'] });
    const { err } = capture();
    const code = cmdSurfaceDefault(dir, 'telegram');
    vi.restoreAllMocks();

    expect(code).toBe(78);
    expect(err.join('')).toContain('muffin surface enable telegram');
    expect(loadConfig(dir).surfaces.default).toBe('cli');
  });

  it('`cli` si puo sempre scegliere: e la superficie di ultima istanza (L0-1)', () => {
    const dir = home({ default: 'telegram', enabled: ['telegram'] });
    capture();
    const code = cmdSurfaceDefault(dir, 'cli');
    vi.restoreAllMocks();
    expect(code).toBe(0);
    expect(loadConfig(dir).surfaces.default).toBe('cli');
  });

  it('idempotente: ridirlo non riscrive niente e non e un errore', () => {
    const dir = home({ default: 'cli', enabled: ['cli'] });
    const { out } = capture();
    const code = cmdSurfaceDefault(dir, 'cli');
    vi.restoreAllMocks();
    expect(code).toBe(0);
    expect(out.join('')).toContain('è già la superficie predefinita');
  });

  /**
   * La configurazione dell'owner, detta ad alta voce dove si va a guardare.
   * Prima di questa slice `surface list` mostrava `(default)` accanto a `cli` e
   * non diceva che cosa significasse per una superficie remota accesa.
   */
  it('`surface list` dice quando la predefinita e il terminale con una remota accesa', () => {
    const dir = home({ default: 'cli', enabled: ['cli', 'telegram'] });
    const { out } = capture();
    cmdSurfaceList(dir);
    vi.restoreAllMocks();
    const testo = out.join('');
    expect(testo).toContain('finisce nel log e nessuno lo legge');
    expect(testo).toContain('muffin surface default telegram');
  });

  it('e tace quando la predefinita e gia una superficie remota', () => {
    const dir = home({ default: 'telegram', enabled: ['cli', 'telegram'] });
    const { out } = capture();
    cmdSurfaceList(dir);
    vi.restoreAllMocks();
    expect(out.join('')).not.toContain('finisce nel log');
  });
});
