import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './open.js';

/**
 * Judge #90, follow-up 2. `cli/surface.ts` opened the database bare from the
 * three entrypoints that run a connector, so a second live process could take
 * `SQLITE_BUSY` immediately instead of waiting — with `muffin repl` started
 * next to a running gateway being the ordinary case, not an exotic one.
 */
describe('openDb — le due pragma che rendono possibili due processi vivi', () => {
  it('imposta WAL e un busy_timeout non nullo', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'muffin-open-')), 'muffin.db'));
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(db.pragma('busy_timeout', { simple: true }))).toBeGreaterThan(0);
    db.close();
  });

  it('una seconda connessione allo stesso file attende invece di rifiutare subito', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'muffin-open-')), 'muffin.db');
    const first = openDb(file);
    first.exec('CREATE TABLE t (v TEXT)');
    const second = openDb(file);

    // Il timeout è per connessione e non si eredita: è esattamente il valore
    // che la connessione nuda non aveva.
    expect(Number(second.pragma('busy_timeout', { simple: true }))).toBeGreaterThan(0);
    // E la seconda connessione vede lo schema della prima: stesso file, WAL.
    expect(() => second.prepare('SELECT v FROM t').all()).not.toThrow();

    first.close();
    second.close();
  });
});
