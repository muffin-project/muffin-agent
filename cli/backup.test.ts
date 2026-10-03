import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { currentSchemaVersion, schemaVersionOf } from '../core/db/migrate.js';
import { openDb } from '../core/db/open.js';
import { backupNow, RestoreRefused, restoreFrom } from './backup.js';

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

  it('refuses a backup dir beneath an ancestor symlink without outside mutation (#639)', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    const root = mkdtempSync(join(tmpdir(), 'muffin-backup-esc-'));
    try {
      const outside = join(root, 'outside');
      mkdirSync(outside, { recursive: true });
      chmodSync(outside, 0o755);
      const before = statSync(outside).mode & 0o777;
      symlinkSync(outside, join(root, 'link'));
      expect(() => backupNow(dbPath, join(root, 'link', 'backups'))).toThrow(/directory privata/);
      expect(existsSync(join(outside, 'backups'))).toBe(false);
      expect(statSync(outside).mode & 0o777).toBe(before);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
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
    // `migrate()` ha girato dopo il ripristino, e ha portato il backup fino
    // alla forma del codice corrente — non l'ha lasciato alla versione che
    // aveva quando è stato preso. È la proprietà che rende un backup vecchio
    // utilizzabile da un binario nuovo, e prima che esistesse una migrazione
    // vera questa riga non poteva distinguerla da "non è successo niente".
    expect(schemaVersionOf(restored)).toBe(currentSchemaVersion());
    restored.close();
    const aside = new DatabaseCtor(asideCopy!, { readonly: true });
    expect(aside.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 2 }); // nothing destroyed
    aside.close();
    // [2, 3, 4, 5, 6, 7, 8, 9]: this fixture has neither `facts` nor `todos` nor `jobs`
    // nor `spend`, so migrations 3 (`slice/memoria-appuntata`), 4 and 5
    // (`slice/una-promessa-torna`), 6 (`slice/e1-budget-per-job`), 7 (job
    // provenance), and 8 (canonical turn schema) no-op here the same way
    // migration 2 itself no-ops on a database with no `jobs` — all seven still
    // run and stamp.
    expect(applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('refuses while the gateway is alive', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    const { file } = backupNow(dbPath, join(d, 'backups'));
    // The lock row exactly as `readGateway` reads it, held by THIS live pid.
    db.exec(
      `CREATE TABLE gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER, taken_at TEXT, since TEXT, status TEXT)`,
    );
    db.prepare(
      `INSERT INTO gateway_lock (id, pid, taken_at, since, status) VALUES (1, ?, ?, ?, 'serving')`,
    ).run(process.pid, new Date().toISOString(), new Date().toISOString());
    db.close();

    expect(() => restoreFrom(dbPath, file, { backupDir: join(d, 'backups') })).toThrow(
      RestoreRefused,
    );
    expect(() => restoreFrom(dbPath, file, { backupDir: join(d, 'backups') })).toThrow(/gateway/);
  });

  it('refuses a backup stamped newer than this code, before any byte moves', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    const { file } = backupNow(dbPath, join(d, 'backups'));
    const snap = new DatabaseCtor(file);
    snap.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)`,
    );
    snap
      .prepare(
        `INSERT INTO schema_version (version, description, applied_at) VALUES (99, 'dal futuro', ?)`,
      )
      .run(new Date().toISOString());
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
    expect(() =>
      restoreFrom(dbPath, join(d, 'niente.db'), { backupDir: join(d, 'backups') }),
    ).toThrow(RestoreRefused);
  });
});

describe('restoreFrom — the aside copy is WAL-safe (judge #93, blocking finding 1)', () => {
  it('preserves a row that only ever lived in the WAL of a SIGKILLed writer', () => {
    const d = dir();
    const { dbPath, db } = liveDb(d);
    db.close(); // clean close: baseline row checkpointed into the main file
    const { file } = backupNow(dbPath, join(d, 'backups')); // snapshot of the baseline

    // A writer that commits and dies without closing: autocheckpoint off, so
    // the committed row exists ONLY in `-wal` — the normal state after any
    // kill -9 / OOM / power loss. This is the row the old raw file copy lost
    // while deleting the only other place it existed.
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `const D = require('better-sqlite3');
         const db = new D(process.argv[1]);
         db.pragma('journal_mode = WAL');
         db.pragma('wal_autocheckpoint = 0');
         db.prepare('INSERT INTO notes (body) VALUES (?)').run('solo-nel-wal');
         process.kill(process.pid, 'SIGKILL');`,
        dbPath,
      ],
      { encoding: 'utf8' },
    );
    expect(child.signal).toBe('SIGKILL');
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const { asideCopy } = restoreFrom(dbPath, file, { backupDir: join(d, 'backups') });

    const aside = new DatabaseCtor(asideCopy!, { readonly: true });
    const bodies = (
      aside.prepare(`SELECT body FROM notes ORDER BY id`).all() as { body: string }[]
    ).map((r) => r.body);
    aside.close();
    expect(bodies).toEqual(['prima', 'solo-nel-wal']); // nothing lost, ever
    const restored = new DatabaseCtor(dbPath, { readonly: true });
    expect(restored.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 1 }); // the backup's state
    restored.close();
  });
});

/**
 * #766 (A6/A8) — the hot-backup matrix under load.
 *
 * The backups above are online (source connection open) but no writer commits
 * while they run. This block closes the recorded residue: a populated database
 * opened the production way (`openDb`: WAL + `busy_timeout`), a second process
 * committing one-row transactions as fast as it can — `wal_autocheckpoint = 0`
 * so the newest commits live ONLY in `-wal`, the state after any kill -9 —
 * and `backupNow` (the exact function `muffin backup` and `runUpdate` call)
 * running while the writer is still alive.
 *
 * The fixture home lives under a dot directory because the real one does
 * (`~/.muffin` — the 03/09 lesson in `docs/development/ORCHESTRATION.md`).
 *
 * What would falsify it: a backup taken without the VACUUM INTO discipline
 * (a raw file copy of the main db, the pre-#93 behaviour) misses every row
 * that only ever lived in the WAL — the count assertion below goes red — or
 * tears mid-write and fails `quick_check`. The contiguity assertion pins the
 * other half: every snapshot must be a transaction-consistent prefix
 * (ids 1..n with no gaps), never a mix of two moments.
 */
describe('backupNow — hot matrix: populated DB while another process writes (#766)', () => {
  const SEED_ROWS = 200;
  const WRITE_ROWS = 1200;
  const READY_AFTER = 50;

  function hotHome(): { root: string; d: string; dbPath: string; db: DatabaseCtor.Database } {
    const root = mkdtempSync(join(tmpdir(), '.muffin-766-hot-'));
    const d = join(root, 'home');
    mkdirSync(d, { recursive: true });
    const dbPath = join(d, 'muffin.db');
    const db = openDb(dbPath);
    db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
    const ins = db.prepare(`INSERT INTO notes (body) VALUES (?)`);
    for (let i = 0; i < SEED_ROWS; i += 1) ins.run(`riga-${i}`);
    return { root, d, dbPath, db };
  }

  function dump(db: DatabaseCtor.Database): string {
    return JSON.stringify(db.prepare(`SELECT id, body FROM notes ORDER BY id`).all());
  }

  function expectConsistentSnapshot(snap: DatabaseCtor.Database, label: string): { n: number; json: string } {
    expect(snap.pragma('quick_check', { simple: true }), `${label}: quick_check`).toBe('ok');
    const rows = snap.prepare(`SELECT id, body FROM notes ORDER BY id`).all() as Array<{
      id: number;
      body: string;
    }>;
    expect(rows.length, `${label}: rows within the writer's run`).toBeGreaterThanOrEqual(SEED_ROWS + READY_AFTER);
    expect(rows.length, `${label}: rows within the writer's run`).toBeLessThanOrEqual(SEED_ROWS + WRITE_ROWS);
    rows.forEach((r, i) => {
      expect(r.id, `${label}: id prefix without gaps`).toBe(i + 1);
      expect(r.body.startsWith('riga-') || r.body.startsWith('w-'), `${label}: well-formed body`).toBe(true);
    });
    return { n: rows.length, json: JSON.stringify(rows) };
  }

  it('snapshots taken while another process commits stay consistent and restorable', async () => {
    const { root, d, dbPath, db } = hotHome();
    // The writer stays open for the whole run; only its own commits interleave
    // with the backups below, exactly like a gateway writing while `muffin
    // backup` runs. Kept open deliberately: closing it would checkpoint and
    // end the load the test exists to prove against.
    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn(
        process.execPath,
        [
          '-e',
          `const D = require('better-sqlite3');
           const db = new D(process.argv[1]);
           db.pragma('journal_mode = WAL');
           db.pragma('wal_autocheckpoint = 0');
           db.pragma('busy_timeout = 5000');
           const ins = db.prepare('INSERT INTO notes (body) VALUES (?)');
           for (let i = 0; i < ${WRITE_ROWS}; i++) {
             ins.run('w-' + i);
             if (i === ${READY_AFTER - 1}) process.stdout.write('READY\\n');
           }
           db.close();`,
          dbPath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const stderr: Buffer[] = [];
      child.stderr?.on('data', (c: Buffer) => stderr.push(Buffer.from(c)));
      let readyResolve: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      child.stdout?.on('data', (c: Buffer) => {
        if (c.toString().includes('READY')) readyResolve();
      });
      const exited = new Promise<number | null>((resolve) => child?.on('exit', resolve));
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('writer never signalled READY — fixture broken')), 15_000).unref();
      });
      await Promise.race([ready, timeout, exited.then(() => timeout)]);

      // The overlap is asserted, not assumed: if the writer already finished,
      // this would be a sequential test wearing a concurrent name.
      expect(child.exitCode, 'the writer must still be running when the first backup starts').toBeNull();

      // Distinct production `now` values: three VACUUM INTO runs land
      // milliseconds apart and the filename carries the moment.
      const base = Date.now();
      const snaps: Array<{ file: string; n: number; json: string }> = [];
      for (let i = 0; i < 3; i += 1) {
        const { file } = backupNow(dbPath, join(d, 'backups'), () => new Date(base + i * 1000));
        const snap = new DatabaseCtor(file, { readonly: true });
        try {
          snaps.push({ file, ...expectConsistentSnapshot(snap, `backup ${i}`) });
        } finally {
          snap.close();
        }
        // At least the first backup must land while the writer is alive; the
        // later ones may or may not, which is fine — they are still validated.
        if (i === 0) {
          expect(child.exitCode, 'the writer must still be running after the first backup').toBeNull();
        }
      }

      const code = await exited;
      expect(Buffer.concat(stderr).toString(), 'writer stderr').toBe('');
      expect(code, 'writer exit').toBe(0);
      db.close();
      // Closed promptly: a leaked read handle pins `-shm` and the
      // read-write opener inside `restoreFrom` below would throw
      // `database is locked` on its `journal_mode` pragma.
      const finalCount = new DatabaseCtor(dbPath, { readonly: true });
      try {
        expect((finalCount.prepare(`SELECT count(*) AS n FROM notes`).get() as { n: number }).n).toBe(
          SEED_ROWS + WRITE_ROWS,
        );
      } finally {
        finalCount.close();
      }

      // The middle snapshot restores: a row written after it is gone, every
      // row it carried is back byte-identical, and the old backup migrates
      // forward through the same path as a boot.
      const losing = new DatabaseCtor(dbPath);
      losing.prepare(`INSERT INTO notes (body) VALUES (?)`).run('da-perdere');
      losing.close();

      const { asideCopy } = restoreFrom(dbPath, snaps[1]!.file, { backupDir: join(d, 'backups') });
      expect(asideCopy).not.toBeNull();
      const restored = new DatabaseCtor(dbPath, { readonly: true });
      try {
        expect(dump(restored), 'restored content equals the snapshot').toBe(snaps[1]!.json);
        expect(restored.prepare(`SELECT count(*) AS n FROM notes WHERE body = 'da-perdere'`).get()).toEqual({ n: 0 });
        expect(schemaVersionOf(restored)).toBe(currentSchemaVersion());
      } finally {
        restored.close();
      }
    } finally {
      if (child !== null && child.exitCode === null) child.kill('SIGKILL');
      try {
        db.close();
      } catch {
        /* already closed on the happy path */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
