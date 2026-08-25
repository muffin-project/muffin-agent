import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Versioned schema lifecycle for the one SQLite file every store shares.
 *
 * Every store in this repository owns its literal DDL and applies it
 * idempotently at construction (`CREATE TABLE IF NOT EXISTS`, `ensureColumn`).
 * That additive path stays: it is what makes a fresh install and a same-shape
 * reopen free. What it cannot express is a change SQLite refuses to make in
 * place — rewriting a CHECK (`episodes.kind` is the recorded trap: a
 * five-value CHECK a new kind cannot join), reshaping columns, splitting a
 * table. Those need an ordered, versioned, run-once path — and the moment the
 * owner's installation accumulates real tenure, "reinstall" stops being a
 * migration strategy (RETURN TO OWNER, M5-BIS §Milestone).
 *
 * Shape salvaged from the old Muffin's `src/db/init.ts`, which carried 79
 * tables for four months on this pattern: a `schema_version` table stamped
 * once per applied migration, and a guard that refuses to run OLD code on a
 * NEWER database — the failure that otherwise corrupts quietly. New here: a
 * `VACUUM INTO` backup taken before the first pending migration, so the state
 * that existed before any reshaping survives it by construction.
 */
export type Migration = {
  /** Strictly increasing, starting at 2 — 1 is the baseline stamp. */
  version: number;
  description: string;
  /** Runs inside one transaction together with its version stamp. */
  up: (db: Database.Database) => void;
};

/**
 * The ordered list of shape changes. Deliberately empty today: the runner and
 * its evidence exist BEFORE the first real reshaping needs them — the first
 * entry added here after tenure begins finds the backup, the guard and the
 * rebuild recipe already proven instead of improvised during an upgrade.
 *
 * Rules for the first real entry here (judge #93 follow-ups): surface tables
 * (`telegram_updates`, `telegram_offset`, `discord_messages`) are created
 * lazily by `connectSurfaces`, strictly after this runner — an `up()` touching
 * them must guard on table existence or an install that never enabled that
 * surface fails with a raw "no such table" instead of an honest error. And
 * `core/memory/vectors.ts` already rebuilt `chunks_vec` non-additively once
 * (`migrateUnpartitioned`), so "store DDL is purely additive" is a premise to
 * re-check, not an axiom.
 */
export const MIGRATIONS: Migration[] = [];

const BASELINE_VERSION = 1;

export function currentSchemaVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.length === 0 ? BASELINE_VERSION : migrations[migrations.length - 1]!.version;
}

/** MAX(version) the database itself claims, or null before the baseline stamp. */
export function schemaVersionOf(db: Database.Database): number | null {
  try {
    const row = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number | null };
    return row.v;
  } catch {
    return null; // no such table: a database from before this runner existed
  }
}

/**
 * Old code, newer data. The one direction that must never write: a binary
 * that predates the database's shape does not know what its writes destroy.
 * Refusing loudly here is what makes a botched update recoverable — the data
 * is intact and the remedy is named.
 */
export class SchemaAheadError extends Error {
  constructor(dbVersion: number, codeVersion: number) {
    super(
      `il database è a schema v${dbVersion}, questo codice arriva a v${codeVersion}: ` +
        `stai eseguendo codice più vecchio dei dati. Aggiorna il codice (o ripristina ` +
        `un backup coevo) invece di lasciar scrivere uno schema che non conosce.`,
    );
    this.name = 'SchemaAheadError';
  }
}

/**
 * A fresh install is born at HEAD: nothing exists to reshape, so every version
 * is stamped without running its `up()` — migrations are written against
 * yesterday's populated data, not against an empty database that already has
 * today's shape by construction (`muffin init` calls this; every later boot
 * goes through `migrate()` and finds nothing pending).
 */
export function stampFresh(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version     INTEGER PRIMARY KEY,
       description TEXT    NOT NULL,
       applied_at  TEXT    NOT NULL
     )`,
  );
  const stamp = db.prepare(
    `INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)`,
  );
  stamp.run(BASELINE_VERSION, 'baseline — store-owned idempotent DDL', now().toISOString());
  for (const m of migrations) {
    stamp.run(m.version, `${m.description} (fresh install — born at this shape)`, now().toISOString());
  }
}


/** A snapshot nobody has ever validated is a hope, not a backup (judge #93). */
export function assertSnapshotOk(file: string): void {
  const check = new DatabaseCtor(file, { readonly: true });
  try {
    const verdict = check.pragma('quick_check', { simple: true });
    if (verdict !== 'ok') throw new Error(`quick_check su ${file}: ${String(verdict)}`);
  } finally {
    check.close();
  }
}

/**
 * The one way a snapshot is taken anywhere in this lifecycle: `VACUUM INTO`
 * (synchronous, atomic, WAL-safe — committed rows still sitting in the WAL are
 * included, which a raw file copy of the main db silently is not; judge #93,
 * blocking finding 1) followed by `quick_check` on the produced file, which is
 * discarded when the check fails so a bad snapshot cannot be mistaken for a
 * safety net.
 */
export function snapshotTo(db: Database.Database, file: string): void {
  db.prepare(`VACUUM INTO ?`).run(file);
  try {
    assertSnapshotOk(file);
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
}

export type MigrateResult = { applied: number[]; backup: string | null; version: number };

export function migrate(
  db: Database.Database,
  opts: { backupDir: string; migrations?: readonly Migration[]; now?: () => Date },
): MigrateResult {
  const migrations = opts.migrations ?? MIGRATIONS;
  // Validated as a LIST, not against the database: a wrong list is a
  // programming error and must fail every environment identically.
  let prev = BASELINE_VERSION;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= prev) {
      throw new Error(
        `migrazioni non strettamente crescenti da ${BASELINE_VERSION + 1}: trovata v${m.version} dopo v${prev}`,
      );
    }
    prev = m.version;
  }
  const target = currentSchemaVersion(migrations);
  const now = opts.now ?? (() => new Date());

  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version     INTEGER PRIMARY KEY,
       description TEXT    NOT NULL,
       applied_at  TEXT    NOT NULL
     )`,
  );
  // The baseline is a stamp, not DDL: a fresh install and a pre-runner install
  // are both already at the baseline by construction (store-owned DDL).
  db.prepare(`INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)`).run(
    BASELINE_VERSION,
    'baseline — store-owned idempotent DDL',
    now().toISOString(),
  );
  const have = schemaVersionOf(db) ?? BASELINE_VERSION;
  if (have > target) throw new SchemaAheadError(have, target);
  const pending = migrations.filter((m) => m.version > have);
  if (pending.length === 0) return { applied: [], backup: null, version: have };

  // The backup comes BEFORE the first reshaping and never on the quiet path —
  // a boot with nothing pending costs zero. `VACUUM INTO` is synchronous,
  // atomic, valid under WAL, and refuses an existing target, which is the
  // idempotence wanted for a file whose name carries the moment.
  mkdirSync(opts.backupDir, { recursive: true });
  const backup = join(
    opts.backupDir,
    `pre-migrate-v${have}-${now().toISOString().replace(/[:.]/g, '-')}.db`,
  );
  snapshotTo(db, backup);

  const stamp = db.prepare(`INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)`);
  const applied: number[] = [];
  for (const m of pending) {
    // One transaction per migration, stamp included: SQLite DDL is
    // transactional, so a migration that throws leaves neither its reshaping
    // nor its stamp — "not done", never "half done".
    db.transaction(() => {
      m.up(db);
      stamp.run(m.version, m.description, now().toISOString());
    })();
    applied.push(m.version);
  }
  return { applied, backup, version: target };
}

/**
 * The CHECK-constraint escape hatch (A7's recorded trap).
 *
 * SQLite cannot ALTER a CHECK in place; the honest path is the documented
 * rebuild recipe: create the new shape under a scratch name, copy, verify,
 * drop, rename, recreate indexes. `createSql` writes the target DDL with `{T}`
 * where the table name goes, so the caller states the whole new shape and
 * cannot half-describe it.
 *
 * Copies the intersection of old and new columns unless `copyColumns` names
 * them, and asserts the row count survived: a rebuild that loses rows aborts
 * the migration's transaction instead of reporting success — this is the seam
 * `slice/schema-lifecycle`'s mutation evidence removes.
 *
 * No `PRAGMA foreign_keys` dance on purpose: production connections never turn
 * that pragma on (`cli/init.ts` and `agent/runtime.ts` set only WAL and
 * busy_timeout), so REFERENCES clauses are not enforced today. Turning them on
 * is its own decision with its own evidence, not a side effect of a rebuild.
 */
export function rebuildTable(
  db: Database.Database,
  table: string,
  createSql: string,
  opts: { copyColumns?: string[]; indexes?: string[] } = {},
): void {
  if (!createSql.includes('{T}')) throw new Error(`createSql deve contenere {T} come nome tabella`);
  const scratch = `${table}__rebuild`;
  const cols = (t: string): string[] =>
    (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[]).map((r) => r.name);
  const before = (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
  db.exec(`DROP TABLE IF EXISTS "${scratch}"`);
  db.exec(createSql.replaceAll('{T}', scratch));
  const newCols = cols(scratch);
  const shared = opts.copyColumns ?? cols(table).filter((c) => newCols.includes(c));
  const list = shared.map((c) => `"${c}"`).join(', ');
  db.exec(`INSERT INTO "${scratch}" (${list}) SELECT ${list} FROM "${table}"`);
  const after = (db.prepare(`SELECT count(*) AS n FROM "${scratch}"`).get() as { n: number }).n;
  if (after !== before) {
    throw new Error(`rebuild di ${table}: ${before} righe prima, ${after} dopo — abortito`);
  }
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${scratch}" RENAME TO "${table}"`);
  for (const idx of opts.indexes ?? []) db.exec(idx);
}
