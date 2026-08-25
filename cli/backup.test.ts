import DatabaseCtor from 'better-sqlite3';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupNow, restoreFrom, RestoreRefused } from './backup.js';
import { schemaVersionOf } from '../core/db/migrate.js';

/**
 * RETURN S2, A8-minimo: an online backup that is valid while a resident
 * process writes, and a restore that refuses the unsafe cases and never
 * becomes the only copy of anything.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'muffin-backup-'));

function liveDb(d: string) {
  const dbPath = join(d, 'muffin.db');
  const db = new DatabaseCtor(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
  db.prepare(`INSERT INTO notes (body) VALUES (?)`).run('prima');
  return { dbPath, db };
}

describe('backupNow — online, validated, self-contained', () => {
  it('produces a quick_checked snapshot with the same rows, while the source stays open', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);

    const { file, bytes } = backupNow(dbPath, join(d, 'backups'));

    expect(bytes).toBeGreaterThan(0);
    const snap = new DatabaseCtor(file, { readonly: true });
    expect(snap.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 1 });
    snap.close();
    // The source connection was never closed: the backup is online by construction.
    db.prepare(`INSERT INTO notes (body) VALUES (?)`).run('dopo');
    expect(db.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 2 });
  });

  it('a backup taken under concurrent writes is still a consistent snapshot', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    const writer = new DatabaseCtor(dbPath);
    writer.pragma('busy_timeout = 5000');
    for (let i = 0; i < 50; i++) writer.prepare(`INSERT INTO notes (body) VALUES (?)`).run(`w${i}`);

    const { file } = backupNow(dbPath, join(d, 'backups'));

    const snap = new DatabaseCtor(file, { readonly: true });
    const n = (snap.prepare(`SELECT count(*) AS n FROM notes`).get() as { n: number }).n;
    expect(n).toBeGreaterThanOrEqual(51);
    expect(snap.pragma('quick_check', { simple: true })).toBe('ok');
    snap.close();
    writer.close();
    db.close();
  });
});

describe('restoreFrom — refusals first, escape hatch always', () => {
  it('roundtrip: backup, mutate, restore → the mutation is gone and the old db is set aside', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    const { file } = backupNow(dbPath, join(d, 'backups'));
    db.prepare(`INSERT INTO notes (body) VALUES (?)`).run('da-perdere');
    db.close();

    const { asideCopy, applied } = restoreFrom(dbPath, file, { backupDir: join(d, 'backups') });

    expect(asideCopy).not.toBeNull();
    expect(existsSync(asideCopy!)).toBe(true);
    const restored = new DatabaseCtor(dbPath, { readonly: true });
    expect(restored.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 1 });
    expect(schemaVersionOf(restored)).toBe(1); // migrate() ran and stamped the baseline
    restored.close();
    const aside = new DatabaseCtor(asideCopy!, { readonly: true });
    expect(aside.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 2 }); // nothing destroyed
    aside.close();
    expect(applied).toEqual([]);
  });

  it('refuses while the gateway is alive', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    const { file } = backupNow(dbPath, join(d, 'backups'));
    // The lock row exactly as `readGateway` reads it, held by THIS live pid.
    db.exec(`CREATE TABLE gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER, taken_at TEXT, since TEXT, status TEXT)`);
    db.prepare(`INSERT INTO gateway_lock (id, pid, taken_at, since, status) VALUES (1, ?, ?, ?, 'serving')`).run(
      process.pid,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();

    expect(() => restoreFrom(dbPath, file, { backupDir: join(d, 'backups') })).toThrow(RestoreRefused);
    expect(() => restoreFrom(dbPath, file, { backupDir: join(d, 'backups') })).toThrow(/gateway/);
  });

  it('refuses a backup stamped newer than this code, before any byte moves', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    const { file } = backupNow(dbPath, join(d, 'backups'));
    const snap = new DatabaseCtor(file);
    snap.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    snap.prepare(`INSERT INTO schema_version (version, description, applied_at) VALUES (99, 'dal futuro', ?)`).run(
      new Date().toISOString(),
    );
    snap.close();
    db.prepare(`INSERT INTO notes (body) VALUES (?)`).run('resta');
    db.close();

    expect(() => restoreFrom(dbPath, file, { backupDir: join(d, 'backups') })).toThrow(/v99/);
    const untouched = new DatabaseCtor(dbPath, { readonly: true });
    expect(untouched.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 2 }); // nothing moved
    untouched.close();
  });

  it('refuses a missing or corrupt backup file', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    db.close();
    expect(() => restoreFrom(dbPath, join(d, 'niente.db'), { backupDir: join(d, 'backups') })).toThrow(
      RestoreRefused,
    );
  });
});
