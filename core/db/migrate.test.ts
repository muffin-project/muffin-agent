import DatabaseCtor from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  currentSchemaVersion,
  migrate,
  rebuildTable,
  SchemaAheadError,
  schemaVersionOf,
  assertSnapshotOk,
  stampFresh,
  type Migration,
} from './migrate.js';

/**
 * `slice/schema-lifecycle` (RETURN S2, A6+A7). The claims under test:
 *
 *  1. a populated pre-change database reaches HEAD through ordered, versioned,
 *     run-once migrations, with its rows intact;
 *  2. old code refuses a newer database instead of writing into it;
 *  3. a backup exists BEFORE the first reshaping, and a failing migration
 *     leaves neither its reshaping nor its stamp;
 *  4. the CHECK-constraint rebuild recipe (A7's recorded trap) preserves rows
 *     and enforces the new constraint — and aborts rather than lose rows.
 *
 * Real better-sqlite3 databases on disk (`VACUUM INTO` needs a file path),
 * never `:memory:`.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'muffin-migrate-'));

function fileDb() {
  const d = dir();
  const db = new DatabaseCtor(join(d, 'muffin.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return { db, d, backups: join(d, 'backups') };
}

/** A populated old-shape table: the five-value CHECK trap in miniature. */
function seedOldShape(db: DatabaseCtor.Database): void {
  db.exec(`CREATE TABLE things (
    id   INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('a','b')),
    body TEXT
  )`);
  db.prepare(`INSERT INTO things (kind, body) VALUES (?, ?)`).run('a', 'uno');
  db.prepare(`INSERT INTO things (kind, body) VALUES (?, ?)`).run('b', 'due');
}

const widenKindCheck: Migration = {
  version: 2,
  description: "things.kind accetta anche 'c' (rebuild: SQLite non altera un CHECK)",
  up: (db) => {
    rebuildTable(
      db,
      'things',
      `CREATE TABLE {T} (
        id   INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('a','b','c')),
        body TEXT
      )`,
      { indexes: [`CREATE INDEX IF NOT EXISTS idx_things_kind ON things(kind)`] },
    );
  },
};

describe('migrate — baseline and idempotence', () => {
  it('stamps the baseline on a fresh database and is a no-op to run twice', () => {
    const { db, backups } = fileDb();
    const first = migrate(db, { backupDir: backups });
    const second = migrate(db, { backupDir: backups });
    expect(first).toEqual({ applied: [], backup: null, version: 1 });
    expect(second).toEqual({ applied: [], backup: null, version: 1 });
    expect(schemaVersionOf(db)).toBe(1);
    expect(existsSync(backups)).toBe(false); // no pending → no backup dir, no cost
  });

  it('rejects a migration list that is not strictly increasing from 2', () => {
    const { db, backups } = fileDb();
    const bad = [{ version: 2, description: 'x', up: () => {} }, { version: 2, description: 'y', up: () => {} }];
    expect(() => migrate(db, { backupDir: backups, migrations: bad })).toThrow(/strettamente crescenti/);
    const alsoBad = [{ version: 1, description: 'x', up: () => {} }];
    expect(() => migrate(db, { backupDir: backups, migrations: alsoBad })).toThrow(/strettamente crescenti/);
  });
});

describe('migrate — a populated old-shape database reaches HEAD', () => {
  it('applies pending migrations in order, stamps each, and keeps the rows', () => {
    const { db, backups } = fileDb();
    seedOldShape(db);
    migrate(db, { backupDir: backups }); // baseline, as an old install would have

    const res = migrate(db, { backupDir: backups, migrations: [widenKindCheck] });

    expect(res.applied).toEqual([2]);
    expect(res.version).toBe(2);
    expect(schemaVersionOf(db)).toBe(2);
    const rows = db.prepare(`SELECT kind, body FROM things ORDER BY id`).all();
    expect(rows).toEqual([
      { kind: 'a', body: 'uno' },
      { kind: 'b', body: 'due' },
    ]);
    // The new shape is real: 'c' now enters, 'd' still cannot.
    expect(() => db.prepare(`INSERT INTO things (kind, body) VALUES ('c','tre')`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO things (kind, body) VALUES ('d','no')`).run()).toThrow();
  });

  it('refuses OLD code on a NEWER database before touching anything', () => {
    const { db, backups } = fileDb();
    seedOldShape(db);
    migrate(db, { backupDir: backups, migrations: [widenKindCheck] }); // db now v2
    // Old code = a shorter list whose current version is 1.
    expect(() => migrate(db, { backupDir: backups, migrations: [] })).toThrow(SchemaAheadError);
    expect(schemaVersionOf(db)).toBe(2); // untouched
  });
});

describe('migrate — the backup precedes the reshaping, and failure is atomic', () => {
  it('writes a validated pre-migrate backup before running the first pending migration', () => {
    const { db, backups } = fileDb();
    seedOldShape(db);
    migrate(db, { backupDir: backups });

    const res = migrate(db, { backupDir: backups, migrations: [widenKindCheck] });

    expect(res.backup).not.toBeNull();
    expect(existsSync(res.backup!)).toBe(true);
    const snap = new DatabaseCtor(res.backup!, { readonly: true });
    // The backup is the OLD shape with the OLD rows — proof it preceded the reshaping.
    expect(snap.prepare(`SELECT count(*) AS n FROM things`).get()).toEqual({ n: 2 });
    expect(schemaVersionOf(snap)).toBe(1);
    snap.close();
  });

  it('a migration that throws leaves no stamp, no reshaping, and the backup on disk', () => {
    const { db, backups } = fileDb();
    seedOldShape(db);
    migrate(db, { backupDir: backups });
    const boom: Migration = {
      version: 2,
      description: 'esplode a metà',
      up: (d) => {
        d.exec(`DELETE FROM things WHERE kind = 'a'`); // damage that MUST roll back
        throw new Error('boom');
      },
    };

    expect(() => migrate(db, { backupDir: backups, migrations: [boom] })).toThrow('boom');

    expect(schemaVersionOf(db)).toBe(1); // no stamp
    expect(db.prepare(`SELECT count(*) AS n FROM things`).get()).toEqual({ n: 2 }); // rolled back
    expect(readdirSync(backups).some((f) => f.startsWith('pre-migrate-v1-'))).toBe(true); // backup stayed
  });
});

describe('rebuildTable — the recipe itself refuses to lose rows', () => {
  it('aborts when the copy would drop rows (narrower CHECK than the data)', () => {
    const { db } = fileDb();
    seedOldShape(db);
    expect(() =>
      rebuildTable(
        db,
        'things',
        `CREATE TABLE {T} (
          id   INTEGER PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('a')),
          body TEXT
        )`,
      ),
    ).toThrow(); // the INSERT itself violates the narrower CHECK — nothing is lost silently
    expect(db.prepare(`SELECT count(*) AS n FROM things`).get()).toEqual({ n: 2 });
  });

  it('requires the {T} placeholder so the target shape is stated whole', () => {
    const { db } = fileDb();
    seedOldShape(db);
    expect(() => rebuildTable(db, 'things', `CREATE TABLE wrong (id INTEGER)`)).toThrow(/\{T\}/);
  });
});

describe('currentSchemaVersion', () => {
  it('is the baseline with no migrations and the last version with some', () => {
    expect(currentSchemaVersion([])).toBe(1);
    expect(currentSchemaVersion([widenKindCheck])).toBe(2);
  });
});

describe('stampFresh — a fresh install is born at HEAD', () => {
  it('stamps every version without running any up(), and the next migrate() is a no-op', () => {
    const { db, backups } = fileDb();
    let ran = 0;
    const list: Migration[] = [{ version: 2, description: 'reshape del passato', up: () => void ran++ }];

    stampFresh(db, list);

    expect(ran).toBe(0); // nothing to reshape on an empty database
    expect(schemaVersionOf(db)).toBe(2);
    const res = migrate(db, { backupDir: backups, migrations: list });
    expect(res).toEqual({ applied: [], backup: null, version: 2 });
    expect(ran).toBe(0);
  });
});

describe('snapshotTo/assertSnapshotOk — a snapshot is validated or it is not a backup', () => {
  it('rejects a file that is not a database', () => {
    const d = dir();
    const garbage = join(d, 'garbage.db');
    writeFileSync(garbage, 'non sono un database');
    expect(() => assertSnapshotOk(garbage)).toThrow();
  });

  it('the automatic pre-migrate backup passes the shared validation (judge #93, blocking finding 2)', () => {
    const { db, backups } = fileDb();
    seedOldShape(db);
    migrate(db, { backupDir: backups });
    const res = migrate(db, { backupDir: backups, migrations: [widenKindCheck] });
    expect(() => assertSnapshotOk(res.backup!)).not.toThrow();
  });
});
