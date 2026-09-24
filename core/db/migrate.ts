import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import DatabaseCtor from 'better-sqlite3';
import { ensurePrivateDir, tightenPrivateFile } from '../config/private-fs.js';
import { TURN_TABLE_SCHEMA } from '../turns/schema.js';

/**
 * Versioned schema lifecycle for the one SQLite file every store shares.
 *
 * This runner owns ordered, versioned upgrades for the shared SQLite file.
 * Stores still declare fresh-install DDL, and some non-turn stores retain
 * additive compatibility guards for direct CLI openers. Turn-table evolution
 * is centralized here: TurnStore constructors no longer rebuild or add
 * columns. Changes SQLite refuses to make in place need this versioned path;
 * tenure makes "reinstall" an invalid migration strategy (RETURN TO OWNER,
 * requirements-status.md §Milestone).
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
 * The ordered list of shape changes. Each upgrade is applied and stamped in
 * one transaction after a validated backup. Fresh installs are stamped at
 * HEAD and use stores' canonical create DDL.
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
const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: "jobs.kind — un job può essere uno script, e uno script non chiama il modello",
    up: (db) => {
      // La guardia che le regole qui sopra chiedono, e serve davvero: `jobs`
      // è creata da `JobStore`, che gira **dopo** questo runner. Su
      // un'installazione fresca la tabella non esiste ancora quando questa
      // migrazione viene considerata, e la creerà `SCHEMA` con la colonna già
      // dentro; su un'installazione esistente la tabella c'è e le manca la
      // colonna. Entrambi i casi finiscono nello stesso stato, per strade
      // diverse.
      const esiste = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`)
        .get() as unknown;
      if (esiste === undefined) return;

      const colonne = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
      if (colonne.some((c) => c.name === 'kind')) return;

      // Additiva, con default: le righe che esistevano prima di oggi sono
      // tutte obiettivi, e nessuna diventa eseguibile per effetto di questa
      // migrazione. È la direzione che conta — il contrario avrebbe reso
      // eseguibile del testo scritto quando "eseguibile" non era un concetto.
      db.exec(`ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'goal'`);
    },
  },
  {
    version: 3,
    description:
      "facts.pinned — un nucleo di fatti che il recall per somiglianza non deve poter far dimenticare",
    up: (db) => {
      // Same guard as migration 2, same reason: `facts` is created by
      // `MemoryStore`, which runs after this runner. A fresh install never
      // reaches this branch — `MEMORY_SCHEMA` already carries the column.
      const esiste = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'facts'`)
        .get() as unknown;
      if (esiste === undefined) return;

      const colonne = db.prepare(`PRAGMA table_info(facts)`).all() as Array<{ name: string }>;
      if (!colonne.some((c) => c.name === 'pinned')) {
        db.exec(`ALTER TABLE facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
      }

      // The one-time backfill the ALTER alone cannot do: the owner's own
      // identity facts, recorded before `pinned` existed, have to become
      // pinned too — otherwise every install that predates this migration
      // keeps the exact failure this column was written to fix (2026-08-26
      // dogfood: "Yo!" did not match the episode that carried the owner's
      // name, and nothing forced it into context).
      //
      // Recognising "the owner entity" from schema alone has no general
      // answer — `upsertEntity`/`findEntity` match on literal name, so the
      // real database this shipped against holds the owner's identity forked
      // across two rows: an entity literally named "owner" (`extract.ts`'s
      // own naming convention for the first-person speaker) and a second one
      // under the owner's real name, linked only by one fact shaped
      // `<real name> — created — owner`. Both sides of that fork are honoured
      // here, narrowly: the entity named "owner", and any entity that is the
      // subject of an (active) `created` fact whose value is "owner" — not a
      // general entity-resolution rule, which is a different, larger problem
      // this slice does not take on. `works_as`/`created` are the exact two
      // predicates the real install had recorded for that identity; the set
      // stays this small on purpose, same reasoning as
      // `DEFAULT_FUNCTIONAL_PREDICATES` — grown by audit, not by guessing,
      // because every predicate added here pins itself into every future turn.
      //
      // This UPDATE is a second write path to `pinned`, so it carries the
      // same gate as `MemoryStore.addFact` (`trust_tier = 0 AND origin =
      // 'said'`), verbatim. Without it, a group tenant's own "owner"-named
      // entity — `extract.ts` hands the literal subject "owner" to the model
      // on any tenant — would get facts pinned here that `addFact` had
      // correctly refused at write time. `tenant_id = 'host'` on the UPDATE
      // and on both subqueries is defence in depth for the same hazard: the
      // backfill exists to restore the *owner's* identity, and the owner
      // lives in the host tenant only; it must not depend on `tierOf` never
      // granting tier 0 inside a group.
      db.exec(`
        UPDATE facts SET pinned = 1
        WHERE expired_at IS NULL AND pinned = 0
          AND tenant_id = 'host'
          AND trust_tier = 0 AND origin = 'said'
          AND predicate IN ('works_as', 'created')
          AND subject_id IN (
            SELECT id FROM entities
             WHERE tenant_id = 'host' AND lower(trim(name)) = 'owner'
            UNION
            SELECT subject_id FROM facts
             WHERE tenant_id = 'host' AND predicate = 'created'
               AND lower(trim(object_value)) = 'owner' AND expired_at IS NULL
          )
      `);
    },
  },
  {
    version: 4,
    description: 'todos.due_at — un passo può avere un momento',
    up: (db) => {
      // Same guard as migrations 2 and 3, same reason: `todos` is created by
      // `TodoStore`, which runs after this runner. A fresh install never
      // reaches the ALTER — `TODO_SCHEMA` already carries the column — and an
      // existing one has the table without it.
      const esiste = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos'`)
        .get() as unknown;
      if (esiste === undefined) return;

      const colonne = db.prepare(`PRAGMA table_info(todos)`).all() as Array<{ name: string }>;
      if (!colonne.some((c) => c.name === 'due_at')) {
        // Nullable, no default, no backfill, and the direction is the point —
        // exactly as migration 2 argued for `jobs.kind`. Every row written
        // before today was written when "a step with a moment" was not a
        // concept; giving any of them a date would turn text the owner never
        // dated into something that can make Muffin speak first.
        db.exec(`ALTER TABLE todos ADD COLUMN due_at TEXT`);
      }
      // The index the scheduler's session-blind scan uses. Created here as well
      // as in `TODO_SCHEMA` because a pre-existing install reaches the store's
      // `CREATE INDEX IF NOT EXISTS` only after this runner has already handed
      // it the column — belt and braces for the boot order, not a second source
      // of truth.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(tenant, due_at) WHERE due_at IS NOT NULL`);
    },
  },
  {
    version: 5,
    description: "todos.due_tier — il momento porta il soffitto che l'ha armato",
    /**
     * A separate version from `due_at`, and the reason is a measured one rather
     * than tidiness. The two columns shipped together as a single migration 4
     * on this branch for one commit (`44dbcdf`). A database stamped by *that*
     * build has `due_at` and not `due_tier`, and the runner skips a version it
     * has already recorded — so the second column would never arrive, and the
     * first statement `TodoStore` prepares would throw `no such column:
     * due_tier` before the runtime finished booting. No released home is at
     * that stamp (the owner's is at 3, and `dev` never carried a 4), but a
     * version number is not a thing to reuse once it has run anywhere.
     */
    up: (db) => {
      const esiste = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos'`)
        .get() as unknown;
      if (esiste === undefined) return;

      const colonne = db.prepare(`PRAGMA table_info(todos)`).all() as Array<{ name: string }>;
      if (!colonne.some((c) => c.name === 'due_tier')) {
        // The ceiling that armed the date, separate from `tier` on purpose
        // (`core/turns/todo.ts`). NULL means "never dated", and `dueCommitments`
        // reads `max(tier, coalesce(due_tier, 0))` — so a NULL here can only
        // ever make the promise *less* trusted than the row already was, never
        // more. No CHECK on the ALTER path: SQLite cannot add a constrained
        // column to an existing table without a rebuild, and the writer
        // (`setDue`) is the only one there is. Fresh installs get the CHECK
        // from `TODO_SCHEMA`; this is the one asymmetry, and it is stated
        // rather than discovered.
        db.exec(`ALTER TABLE todos ADD COLUMN due_tier INTEGER`);
      }
    },
  },
  {
    version: 6,
    description:
      "jobs.per_job_usd, spend.job_id, turns.job_id — un job rotto non può più mangiarsi il mese intero (DAY-1 E1)",
    up: (db) => {
      // La stessa guardia della migrazione 2, per la stessa ragione: `jobs` e
      // `spend` sono create dai rispettivi store, che girano **dopo** questo
      // runner. Su un'installazione fresca le tabelle non esistono ancora e
      // le creeranno i loro `SCHEMA` con le colonne già dentro; su
      // un'installazione con tenure ci sono e mancano le colonne.
      const haTabella = (nome: string): boolean =>
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(nome) !== undefined;
      const haColonna = (tabella: string, colonna: string): boolean =>
        (db.prepare(`PRAGMA table_info(${tabella})`).all() as Array<{ name: string }>).some((c) => c.name === colonna);

      // Additiva e nullable: nessun job esistente acquisisce un tetto per
      // effetto di questa migrazione. La direzione conta — il contrario
      // spegnerebbe di sua iniziativa job che l'owner non ha toccato.
      if (haTabella('jobs') && !haColonna('jobs', 'per_job_usd')) {
        db.exec(`ALTER TABLE jobs ADD COLUMN per_job_usd REAL`);
      }
      // Il contatore che il tetto consuma. Le righe di spesa già scritte
      // restano `NULL`: nessuna di esse sa a quale job apparteneva, e
      // inventare un'attribuzione a posteriori è peggio che non averne — il
      // primo mese dopo l'aggiornamento un job parte da zero, che è la
      // direzione indulgente e non quella che spegne qualcosa per sbaglio.
      if (haTabella('spend') && !haColonna('spend', 'job_id')) {
        db.exec(`ALTER TABLE spend ADD COLUMN job_id TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_spend_job_month ON spend(job_id, month)`);
      }
      // E la stessa appartenenza sulla riga del turno, che è ciò che la fa
      // sopravvivere a una ripresa: `drive` ricostruisce il `TurnInput` dal
      // record, quindi senza questa colonna la spesa della seconda metà di un
      // turno di job sospeso non apparterrebbe più a nessun job.
      if (haTabella('turns') && !haColonna('turns', 'job_id')) {
        db.exec(`ALTER TABLE turns ADD COLUMN job_id TEXT`);
      }
    },
  },
  {
    version: 7,
    description: "jobs.origin_* + jobs.tier — un job creato da conversazione porta la provenance dell'intento",
    up: (db) => {
      // La stessa guardia delle migrazioni 2 e 6, per la stessa ragione: `jobs`
      // è creata da `JobStore`, che gira dopo questo runner. Su
      // un'installazione fresca la tabella non esiste ancora e la creerà
      // `SCHEMA` con le colonne già dentro.
      const haTabella = (nome: string): boolean =>
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(nome) !== undefined;
      const haColonna = (tabella: string, colonna: string): boolean =>
        (db.prepare(`PRAGMA table_info(${tabella})`).all() as Array<{ name: string }>).some((c) => c.name === colonna);
      if (!haTabella('jobs')) return;

      // Additive con default, e la direzione è il punto — come la migrazione
      // 2 per `kind` e la 6 per `per_job_usd`. Ogni riga scritta prima di oggi
      // descrive un owner al terminale, e i default dicono già così: nessuna
      // riga esistente acquisisce una provenance diversa, e nessun giro futuro
      // cambia taint per effetto di questa migrazione (`tier` 0 è ciò che il
      // vecchio codice faceva comunque).
      if (!haColonna('jobs', 'origin_tenant')) {
        db.exec(`ALTER TABLE jobs ADD COLUMN origin_tenant TEXT NOT NULL DEFAULT 'host'`);
      }
      if (!haColonna('jobs', 'origin_surface')) {
        db.exec(`ALTER TABLE jobs ADD COLUMN origin_surface TEXT NOT NULL DEFAULT 'cli'`);
      }
      if (!haColonna('jobs', 'origin_principal')) {
        db.exec(`ALTER TABLE jobs ADD COLUMN origin_principal TEXT NOT NULL DEFAULT 'owner'`);
      }
      if (!haColonna('jobs', 'origin_turn')) {
        db.exec(`ALTER TABLE jobs ADD COLUMN origin_turn TEXT`);
      }
      if (!haColonna('jobs', 'tier')) {
        db.exec(`ALTER TABLE jobs ADD COLUMN tier INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 8,
    description: 'turn schema lifecycle — migration and status CHECK under one authority',
    up: (db) => {
      const hasTable = (name: string): boolean =>
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
        undefined;
      const hasColumn = (table: string, column: string): boolean =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
          (c) => c.name === column,
        );
      const addColumn = (table: string, column: string, ddl: string): void => {
        if (hasTable(table) && !hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      };
      addColumn('turns', 'claim_token', 'claim_token TEXT');
      addColumn('turns', 'job_id', 'job_id TEXT');
      addColumn('turns', 'lease_index', 'lease_index INTEGER NOT NULL DEFAULT 0');
      addColumn('turns', 'continuable_reason', 'continuable_reason TEXT');
      addColumn('turns', 'lifetime', 'lifetime TEXT');
      addColumn('turns', 'input_text', 'input_text TEXT');
      addColumn('turn_tool_calls', 'undone_at', 'undone_at TEXT');
      addColumn('turn_tool_calls', 'effect_row', 'effect_row TEXT');
      addColumn('turn_tool_calls', 'reversible', 'reversible TEXT');
      addColumn('turn_tool_calls', 'resource', 'resource TEXT');
      addColumn('turn_tool_calls', 'decision', 'decision TEXT');
      addColumn('turn_leases', 'transport_allowance', 'transport_allowance INTEGER');

      if (!hasTable('turns')) return;
      const current = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'`)
        .get() as { sql: string } | undefined;
      if (current === undefined || current.sql.includes("'continuable'")) return;

      const createNew = TURN_TABLE_SCHEMA.replace(
        'CREATE TABLE IF NOT EXISTS turns',
        'CREATE TABLE turns_new',
      );
      if (createNew === TURN_TABLE_SCHEMA) {
        throw new Error('turn migration: canonical table DDL not found');
      }
      const columns =
        'id, principal, tenant, surface, session_id, input_text, model, messages, taint, counters, reply_to, job_id, ' +
        'status, wake_at, wait_for, claimed_by, claimed_at, claim_token, turn_outcome, delivery, ' +
        'lease_index, continuable_reason, lifetime, created_at, updated_at';
      db.exec('DROP TABLE IF EXISTS turns_new');
      db.exec(createNew);
      db.exec(`INSERT INTO turns_new (${columns}) SELECT ${columns} FROM turns`);
      db.exec('DROP TABLE turns');
      db.exec('ALTER TABLE turns_new RENAME TO turns');
      db.exec('CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status, updated_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_turns_due ON turns(status, wake_at)');
    },
  },
];

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
  stamp.run(BASELINE_VERSION, 'baseline — legacy schema before versioned migrations', now().toISOString());
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
  tightenPrivateFile(file);
  try {
    assertSnapshotOk(file);
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
  tightenPrivateFile(file);
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
  // are both at the legacy schema boundary by construction.
  db.prepare(`INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)`).run(
    BASELINE_VERSION,
    'baseline — legacy schema before versioned migrations',
    now().toISOString(),
  );
  const have = schemaVersionOf(db) ?? BASELINE_VERSION;
  if (have > target) throw new SchemaAheadError(have, target);
  const pending = migrations.filter((m) => m.version > have);
  if (pending.length === 0) return { applied: [], backup: null, version: have };

  // The backup comes BEFORE the first reshaping and never on the quiet path —
  // a boot with nothing pending costs zero. `VACUUM INTO` is synchronous,
  // atomic, valid under WAL, and refuses an existing target, which is the
  // idempotence wanted for a file whose name carries the moment. A refused
  // private parent stops the migration instead of snapshotting outside it.
  if (!ensurePrivateDir(opts.backupDir)) {
    throw new Error(`non posso scrivere il backup in ${opts.backupDir}: la directory privata non è stata stabilita (symlink sulla catena)`);
  }
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
 * the migration's transaction instead of reporting success.
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
