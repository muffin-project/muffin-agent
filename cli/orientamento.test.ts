import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnStore } from '../core/turns/store.js';
import { cmdOrientamento } from './orientamento.js';

/**
 * `muffin orientamento` — la misura ripetibile di
 * `docs/evidence/orizzonte-del-turno-2026-09-03.md` Parte 0. Qui si prova il
 * comando stesso, non solo il motore in `core/turns/orientamento-report.ts`:
 * `--db` è obbligatorio, il file è aperto in sola lettura, e senza database
 * niente viene letto — la garanzia "mai la home dell'owner di default".
 */

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureDb(rows: readonly { turnId: string; tool: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-orientamento-'));
  dirs.push(dir);
  const file = join(dir, 'muffin.db');
  const db = new DatabaseCtor(file);
  const store = new TurnStore(db);
  rows.forEach((r, i) =>
    store.startToolCall(r.turnId, {
      callId: `c${i}`,
      tool: r.tool,
      capability: 'test.cap',
      rerunnable: true,
      args: { i },
    }),
  );
  db.close();
  return file;
}

function captureStdout(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

describe('muffin orientamento', () => {
  it('senza --db stampa l uso ed esce 78, senza toccare niente', () => {
    const out = captureStdout();
    expect(cmdOrientamento([])).toBe(78);
    expect(out.join('')).toContain('usage: muffin orientamento --db <path>');
  });

  it('un percorso che non esiste esce 78', () => {
    const out = captureStdout();
    expect(cmdOrientamento(['--db', '/non/esiste/muffin.db'])).toBe(78);
    expect(out.join('')).toContain('nessun database');
  });

  it('un database senza chiamate dice "nessuna chiamata", non NaN', () => {
    const db = fixtureDb([]);
    const out = captureStdout();
    expect(cmdOrientamento(['--db', db])).toBe(0);
    expect(out.join('')).toContain('nessuna chiamata registrata');
  });

  it('legge la quota reale dalla fixture, con --cap applicato', () => {
    const db = fixtureDb([
      { turnId: 't1', tool: 'fs_list' },
      { turnId: 't1', tool: 'shell_run' },
      { turnId: 't2', tool: 'sys_inspect' },
      { turnId: 't2', tool: 'fs_read' },
      { turnId: 't2', tool: 'fs_search' },
    ]);
    const out = captureStdout();
    expect(cmdOrientamento(['--db', db, '--cap', '3'])).toBe(0);
    const testo = out.join('');
    expect(testo).toContain('5 chiamate registrate.');
    // fs_list + fs_read + fs_search + sys_inspect = 4/5
    expect(testo).toContain('orientamento (fs_list, fs_read, fs_search, sys_inspect): 4/5 — 80.0%');
    // t2 ha 3 chiamate: tocca il tetto di 3
    expect(testo).toContain('al tetto di 3 o oltre: 1');
  });

  it('apre il file in sola lettura: non lo modifica', () => {
    const db = fixtureDb([{ turnId: 't1', tool: 'fs_list' }]);
    const before = new DatabaseCtor(db, { readonly: true }).prepare('SELECT COUNT(*) AS n FROM turn_tool_calls').get() as {
      n: number;
    };
    captureStdout();
    cmdOrientamento(['--db', db]);
    const after = new DatabaseCtor(db, { readonly: true }).prepare('SELECT COUNT(*) AS n FROM turn_tool_calls').get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
  });
});
