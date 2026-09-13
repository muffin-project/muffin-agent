import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnStore } from '../core/turns/store.js';
import { cmdEffects } from './effects.js';
import { runInit } from './init.js';

/**
 * `muffin effects` — la porta da **operatore** sul registro degli effetti.
 *
 * Quello che si prova qui è ciò che non si vede da `readEffects`: che questo
 * comando intenda per «oggi» la stessa giornata che intende `sys_effects`, e
 * che un argomento sbagliato esca con un codice invece che con uno stack
 * trace. La prima è la metà che la revisione indipendente di D15 ha trovato
 * rotta: entrambe le porte riempivano il parametro del fuso con quello del
 * proprio processo, quindi una funzione sola dava due risposte.
 */

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Una home vera — `runInit` sigilla il fallback neutro `UTC` in `rot/budgets.json`. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-effects-cli-'));
  dirs.push(dir);
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

function scrivi(file: string, at: string): void {
  const db = new DatabaseCtor(file);
  const store = new TurnStore(db, () => new Date(at));
  store.startToolCall('t1', {
    callId: 'c1',
    tool: 'fs_write',
    capability: 'fs.write',
    rerunnable: true,
    args: {},
    effect: {
      row: 'host',
      reversible: 'undoable',
      resource: '/ws/diario-di-oggi.md',
      decision: 'allow',
    },
  });
  db.close();
}

function cattura(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  return { out, err };
}

describe('muffin effects', () => {
  it("«oggi» è la giornata dell'owner sigillata, non quella del processo", () => {
    // Le 23:30 UTC del 7 sono ancora il 07 nel RoT (`UTC`) ma l'08 a Roma.
    // Il fuso del processo è forzato su Europe/Rome, quindi i due non possono
    // essere d'accordo, a qualunque ora giri la suite.
    const dir = home();
    const file = join(dir, 'registro.db');
    scrivi(file, '2026-09-07T23:30:00.000Z');
    const fusoProcesso = process.env['TZ'];
    const homeProcesso = process.env['MUFFIN_HOME'];
    process.env['TZ'] = 'Europe/Rome';
    process.env['MUFFIN_HOME'] = dir;
    try {
      const { out } = cattura();
      const code = cmdEffects(['--db', file], () => new Date('2026-09-07T23:30:00.000Z'));
      expect(code).toBe(0);
      const testo = out.join('');
      expect(testo).toContain('giornata 2026-09-07');
      expect(testo).not.toContain('giornata 2026-09-08');
      expect(testo).toContain('diario-di-oggi.md');
    } finally {
      if (fusoProcesso === undefined) delete process.env['TZ'];
      else process.env['TZ'] = fusoProcesso;
      if (homeProcesso === undefined) delete process.env['MUFFIN_HOME'];
      else process.env['MUFFIN_HOME'] = homeProcesso;
    }
  });

  it('una data non valida esce 78 con una frase, non con uno stack trace', () => {
    // `dayBounds` lancia, e `cli/main.ts` non cattura: prima che il filtro
    // venisse costruito dentro il try, quel lancio usciva da `cmdEffects` e
    // l'owner vedeva un errore di Node al posto dell'uso del comando.
    const dir = home();
    const file = join(dir, 'registro.db');
    scrivi(file, '2026-09-07T10:00:00.000Z');
    const { err } = cattura();
    expect(cmdEffects(['--db', file, '--day', 'ieri'])).toBe(78);
    expect(err.join('')).toContain('data non valida');
  });

  it('--turn e --day insieme sono due domande diverse', () => {
    const dir = home();
    const file = join(dir, 'registro.db');
    scrivi(file, '2026-09-07T10:00:00.000Z');
    const { err } = cattura();
    expect(cmdEffects(['--db', file, '--turn', 't1', '--day', '2026-09-07'])).toBe(78);
    expect(err.join('')).toContain('scegline una');
  });
});
