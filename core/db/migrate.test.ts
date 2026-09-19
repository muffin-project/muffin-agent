import DatabaseCtor from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    // `migrations: []` esplicito, e non più implicito: questa prova riguarda
    // il *runner* con niente in sospeso, non la lista reale. Quando la lista
    // reale ha smesso di essere vuota (migrazione 2, jobs.kind) questa riga è
    // diventata l'unica che dice ancora cosa il test intendeva.
    const first = migrate(db, { backupDir: backups, migrations: [] });
    const second = migrate(db, { backupDir: backups, migrations: [] });
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
    migrate(db, { backupDir: backups, migrations: [] }); // baseline, as an old install would have

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
    migrate(db, { backupDir: backups, migrations: [] });

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
    migrate(db, { backupDir: backups, migrations: [] });
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
    migrate(db, { backupDir: backups, migrations: [] });
    const res = migrate(db, { backupDir: backups, migrations: [widenKindCheck] });
    expect(() => assertSnapshotOk(res.backup!)).not.toThrow();
  });
});

/**
 * La prima migrazione vera, contro i due stati in cui il mondo si trova
 * davvero: un'installazione che ha già dei job, e una che non ha ancora
 * nessuna tabella `jobs` perché `JobStore` gira dopo questo runner.
 */
describe('migrazione 2 — jobs.kind', () => {
  it('aggiunge la colonna a un database che ha già dei job, e nessuno diventa uno script', () => {
    const { db, backups } = fileDb();
    // La forma di ieri: `jobs` senza `kind`, con dentro un obiettivo vero.
    db.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, cron TEXT NOT NULL, timezone TEXT NOT NULL, goal TEXT NOT NULL,
      channel TEXT NOT NULL, created_at TEXT NOT NULL, next_fire_at TEXT NOT NULL,
      last_run_at TEXT, active INTEGER NOT NULL DEFAULT 1)`);
    db.prepare(
      `INSERT INTO jobs (id, cron, timezone, goal, channel, created_at, next_fire_at)
       VALUES ('j1', '0 8 * * *', 'Europe/Rome', 'riassumimi la giornata', 'cli', '2026-08-01', '2026-08-02')`,
    ).run();
    migrate(db, { backupDir: backups, migrations: [] }); // baseline v1, come un'installazione vecchia

    const res = migrate(db, { backupDir: backups });

    // [2, 3, 4, 5]: this fixture has neither a `facts` nor a `todos` table, so
    // migration 3 (`slice/memoria-appuntata`) and migrations 4 and 5
    // (`slice/una-promessa-torna`) are genuine no-ops here — but `migrate()` still runs and stamps them, the
    // same way migration 2 itself no-ops (and still counts) on a database where
    // `jobs` is absent, two tests below.
    expect(res.applied).toEqual([2, 3, 4, 5, 6, 7]);
    const riga = db.prepare(`SELECT goal, kind FROM jobs WHERE id = 'j1'`).get() as {
      goal: string;
      kind: string;
    };
    // La riga sopravvive intatta, e resta un obiettivo. Il contrario — un
    // testo scritto quando "eseguibile" non era un concetto che diventa
    // eseguibile per effetto di un aggiornamento — è il difetto che il
    // default di questa colonna esiste per impedire.
    expect(riga.goal).toBe('riassumimi la giornata');
    expect(riga.kind).toBe('goal');
  });

  it('non fallisce su un database dove `jobs` non esiste ancora', () => {
    const { db, backups } = fileDb();
    // È il caso di ogni installazione fresca: `migrate()` gira in
    // `agent/runtime.ts` PRIMA che `JobStore` crei la propria tabella —
    // e prima che `MemoryStore` crei `facts` e `TodoStore` crei `todos`,
    // motivo per cui la 3 e la 4 arrivano fin qui allo stesso modo.
    expect(() => migrate(db, { backupDir: backups })).not.toThrow();
    expect(schemaVersionOf(db)).toBe(7);
  });
});

describe('migrazione 3 — facts.pinned', () => {
  /** The pre-`pinned` shape of `facts`/`entities`, old enough to predate this column. */
  function seedOldFacts(db: DatabaseCtor.Database): void {
    db.exec(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, summary TEXT, recorded_at TEXT NOT NULL, expired_at TEXT)`);
    db.exec(`
      CREATE TABLE facts (
        id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, subject_id INTEGER NOT NULL,
        predicate TEXT NOT NULL, object_id INTEGER, object_value TEXT,
        valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL, expired_at TEXT,
        episode_id INTEGER NOT NULL, speaker_id INTEGER,
        trust_tier INTEGER NOT NULL, confidence REAL NOT NULL, origin TEXT NOT NULL DEFAULT 'said',
        importance INTEGER NOT NULL DEFAULT 0, extraction_v INTEGER NOT NULL, superseded_by INTEGER)`);
    db.prepare(
      `INSERT INTO entities (id, tenant_id, kind, name, recorded_at) VALUES (?, 'host', 'person', ?, '2026-08-01T10:00:00Z')`,
    ).run(1, 'Giusto Piedimonte');
    db.prepare(
      `INSERT INTO entities (id, tenant_id, kind, name, recorded_at) VALUES (?, 'host', 'person', ?, '2026-08-01T10:00:00Z')`,
    ).run(2, 'owner');
    const addFact = db.prepare(
      `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_value, recorded_at, episode_id, trust_tier, confidence, extraction_v)
       VALUES (?, 'host', ?, ?, ?, '2026-08-11T10:00:00Z', 1, 0, 0.9, 1)`,
    );
    // The real 2026-08-26 dogfood shape: identity forked across two entities.
    addFact.run(1, 1, 'works_as', 'AI engineer'); // Giusto Piedimonte — works_as — AI engineer
    addFact.run(2, 1, 'created', 'owner'); // Giusto Piedimonte — created — owner
    addFact.run(3, 2, 'works_as', 'freelancer'); // owner — works_as — freelancer
    addFact.run(4, 2, 'interest', 'how AI memory works'); // owner — interest — … (never pinned)
  }

  it('adds the column and pins the owner identity facts real installs had recorded, leaving the rest alone', () => {
    const { db, backups } = fileDb();
    seedOldFacts(db);
    migrate(db, { backupDir: backups, migrations: [] }); // baseline v1, as an old install would have

    const res = migrate(db, { backupDir: backups });

    expect(res.applied).toEqual([2, 3, 4, 5, 6, 7]);
    const pinned = db.prepare(`SELECT id FROM facts WHERE pinned = 1 ORDER BY id`).all() as { id: number }[];
    expect(pinned.map((r) => r.id)).toEqual([1, 2, 3]);
    // Rows survive untouched — this is a backfill, not a rewrite.
    const untouched = db.prepare(`SELECT pinned FROM facts WHERE id = 4`).get() as { pinned: number };
    expect(untouched.pinned).toBe(0);
  });

  it('non appunta ciò che `addFact` aveva rifiutato: il tenant group col suo "owner", il tier non-owner, l\'inferito', () => {
    const { db, backups } = fileDb();
    seedOldFacts(db);
    // A group chat produces its own entity literally named "owner" —
    // `extract.ts` hands that subject to the model on any tenant — and its
    // facts carry the member's tier (≥2), which `addFact`'s gate refuses to
    // pin. The backfill is a second write path to the same bit: without the
    // same gate it would flip exactly these rows.
    db.prepare(
      `INSERT INTO entities (id, tenant_id, kind, name, recorded_at) VALUES (3, 'group:telegram:9', 'person', 'owner', '2026-08-12T10:00:00Z')`,
    ).run();
    const raw = db.prepare(
      `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_value, recorded_at, episode_id, trust_tier, confidence, origin, extraction_v)
       VALUES (?, ?, ?, ?, ?, '2026-08-12T10:00:00Z', 1, ?, 0.9, ?, 1)`,
    );
    raw.run(5, 'group:telegram:9', 3, 'created', 'owner', 2, 'said');
    raw.run(6, 'group:telegram:9', 3, 'works_as', 'barista', 2, 'said');
    // Host tenant but inferred, not said: tier alone is not the whole gate.
    raw.run(7, 'host', 2, 'works_as', 'painter', 0, 'inferred');
    // Host fact whose subject is ANOTHER tenant's "owner" entity. No write
    // path can produce this today (`upsertEntity`/`findEntity` resolve within
    // the tenant), so it goes in by hand — it is what makes the tenant
    // scoping on the backfill's subqueries load-bearing instead of decorative
    // (judge #122 giro 2 follow-up).
    raw.run(8, 'host', 3, 'works_as', 'plumber', 0, 'said');
    migrate(db, { backupDir: backups, migrations: [] });

    migrate(db, { backupDir: backups });

    const pinned = db.prepare(`SELECT id FROM facts WHERE pinned = 1 ORDER BY id`).all() as { id: number }[];
    expect(pinned.map((r) => r.id)).toEqual([1, 2, 3]); // the host backfill, and nothing else
    const refused = db.prepare(`SELECT id FROM facts WHERE id IN (5, 6, 7, 8) AND pinned = 0`).all() as { id: number }[];
    expect(refused.map((r) => r.id)).toEqual([5, 6, 7, 8]);
  });

  it('non fallisce su un database dove `facts` non esiste ancora', () => {
    const { db, backups } = fileDb();
    // The fresh-install case: `MemoryStore` has not run yet, so `facts` is not
    // there for this migration to touch — same guard, same reason as jobs.kind.
    expect(() => migrate(db, { backupDir: backups })).not.toThrow();
    expect(schemaVersionOf(db)).toBe(7);
  });
});

describe('migrazioni 4 e 5 — todos.due_at, poi todos.due_tier', () => {
  /** The pre-ADR-0060 shape of `todos`: a plan step with no moment. */
  function seedOldTodos(db: DatabaseCtor.Database): void {
    db.exec(`
      CREATE TABLE todos (
        tenant TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        key TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, note TEXT,
        tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant, session_id, key))`);
    const raw = db.prepare(
      `INSERT INTO todos (tenant, session_id, seq, key, text, state, tier, created_at, updated_at)
       VALUES ('host', 's1', ?, ?, ?, 'pending', 0, '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z')`,
    );
    for (let i = 1; i <= 200; i += 1) raw.run(i, `k${i}`, `passo ${i}`);
  }

  it('porta un todos popolato fino a HEAD con le righe intatte, e l\'indice che lo scanner usa', () => {
    const { db, backups } = fileDb();
    seedOldTodos(db);
    migrate(db, { backupDir: backups, migrations: [] }); // baseline v1, un'installazione vecchia

    const res = migrate(db, { backupDir: backups });

    expect(res.applied).toEqual([2, 3, 4, 5, 6, 7]);
    const colonne = (db.prepare(`PRAGMA table_info(todos)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(colonne).toContain('due_at');
    expect(colonne).toContain('due_tier');
    const righe = db.prepare(`SELECT count(*) AS n FROM todos`).get() as { n: number };
    expect(righe.n).toBe(200);
    // Nessuna riga scritta prima di oggi acquista un momento per effetto di un
    // aggiornamento: sarebbe testo che l'owner non ha mai datato, e che da
    // domani può far parlare Muffin per primo.
    const datate = db.prepare(`SELECT count(*) AS n FROM todos WHERE due_at IS NOT NULL`).get() as { n: number };
    expect(datate.n).toBe(0);
    const piano = db
      .prepare(`EXPLAIN QUERY PLAN SELECT key FROM todos WHERE tenant = 'host' AND due_at > '' AND due_at < 'z'`)
      .all() as Array<{ detail: string }>;
    expect(piano.map((r) => r.detail).join(' ')).toContain('idx_todos_due');
  });

  /**
   * Il reperto del secondo giudice, e il solo motivo per cui `due_tier` è una
   * versione a sé.
   *
   * Le due colonne sono state una sola migrazione 4 per un commit di questo
   * ramo (`44dbcdf`). Un database timbrato da *quella* build ha `due_at` e non
   * `due_tier`, e il runner salta una versione che ha già registrato: la
   * seconda colonna non sarebbe mai arrivata, e la prima query che `TodoStore`
   * prepara moriva con `no such column: due_tier` prima che il runtime finisse
   * di partire. Nessuna casa rilasciata è a quel timbro — quella dell'owner è
   * alla 3, misurata — ma un numero di versione già girato non si riusa.
   */
  it('una casa timbrata dal primo v4 — due_at senza due_tier — riceve la colonna mancante e parte', () => {
    const { db, backups } = fileDb();
    seedOldTodos(db);
    db.exec(`ALTER TABLE todos ADD COLUMN due_at TEXT`);
    // Timbrata fino alla 4 inclusa, esattamente come l'avrebbe lasciata `44dbcdf`.
    migrate(db, { backupDir: backups, migrations: [] });
    const timbra = db.prepare(
      `INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, '2026-09-03T00:00:00Z')`,
    );
    for (const v of [2, 3, 4]) timbra.run(v, `girata da 44dbcdf (${v})`);
    expect(schemaVersionOf(db)).toBe(4);

    const res = migrate(db, { backupDir: backups });

    expect(res.applied).toEqual([5, 6, 7]);
    const colonne = (db.prepare(`PRAGMA table_info(todos)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(colonne).toContain('due_tier');
    // La query che moriva: è questa a rendere l'asserzione un comportamento e
    // non un `PRAGMA` soddisfatto di sé.
    expect(() =>
      db.prepare(`SELECT max(tier, coalesce(due_tier, 0)) AS tier FROM todos WHERE tenant = 'host'`).get(),
    ).not.toThrow();
    const righe = db.prepare(`SELECT count(*) AS n FROM todos`).get() as { n: number };
    expect(righe.n).toBe(200);
  });
});

/**
 * Migrazione 6 — il tetto per-job su una casa con tenure (DAY-1 E1).
 *
 * Non «la migrazione gira»: che una casa scritta con lo schema **vecchio** —
 * `jobs` senza `per_job_usd`, `spend` senza `job_id`, `turns` senza `job_id`,
 * con dentro righe vere — arrivi dall'altra parte con le colonne, **senza
 * perdere una riga** e senza che nessun job acquisti un tetto che l'owner non
 * ha chiesto.
 */
describe('migrazione 6 — jobs.per_job_usd, spend.job_id, turns.job_id', () => {
  it('aggiunge le tre colonne a una casa con tenure, e non tocca le righe che ci sono', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-migrate-6-'));
    const db = new DatabaseCtor(join(dir, 'muffin.db'));
    try {
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, cron TEXT NOT NULL, timezone TEXT NOT NULL, goal TEXT NOT NULL,
          channel TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'goal', created_at TEXT NOT NULL,
          next_fire_at TEXT NOT NULL, last_run_at TEXT, active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE spend (
          id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, capability TEXT NOT NULL, model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, usd REAL NOT NULL,
          day TEXT NOT NULL, month TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE turns (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
        INSERT INTO jobs (id, cron, timezone, goal, channel, kind, created_at, next_fire_at, active)
          VALUES ('j1', '0 8 * * *', 'Europe/Rome', 'brief', 'cli', 'goal', '2026-06-01', '2026-06-15', 1);
        INSERT INTO spend (tenant, capability, model, input_tokens, output_tokens, usd, day, month, created_at)
          VALUES ('host', 'llm.chat', 'test', 1, 1, 2.5, '2026-06-01', '2026-06', '2026-06-01');
        INSERT INTO turns (id, created_at) VALUES ('t1', '2026-06-01');
      `);

      const res = migrate(db, { backupDir: join(dir, 'backups') });
      expect(res.applied).toContain(6);

      const colonne = (t: string) =>
        (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(colonne('jobs')).toContain('per_job_usd');
      expect(colonne('spend')).toContain('job_id');
      expect(colonne('turns')).toContain('job_id');

      // Nessuna riga persa, nessun tetto inventato, nessuna spesa riscritta.
      expect(db.prepare(`SELECT per_job_usd FROM jobs WHERE id = 'j1'`).get()).toEqual({ per_job_usd: null });
      expect(db.prepare(`SELECT usd, job_id FROM spend`).get()).toEqual({ usd: 2.5, job_id: null });
      expect(db.prepare(`SELECT job_id FROM turns WHERE id = 't1'`).get()).toEqual({ job_id: null });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Migrazione 7 — la provenance dell'intento su una casa con tenure.
 *
 * Non «la migrazione gira»: che una casa con job scritti dallo schema
 * **vecchio** — senza `origin_*`, senza `tier`, con dentro righe vere —
 * arrivi dall'altra parte con le colonne, senza perdere una riga e senza che
 * nessun giro futuro cambi taint per effetto dell'aggiornamento (tier 0 è ciò
 * che il vecchio codice faceva comunque).
 */
describe('migrazione 7 — jobs.origin_*, jobs.tier', () => {
  it('aggiunge le cinque colonne a una casa con tenure, e le righe restano owner-a-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-migrate-7-'));
    const db = new DatabaseCtor(join(dir, 'muffin.db'));
    try {
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, cron TEXT NOT NULL, timezone TEXT NOT NULL, goal TEXT NOT NULL,
          channel TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'goal', per_job_usd REAL,
          created_at TEXT NOT NULL, next_fire_at TEXT NOT NULL, last_run_at TEXT,
          active INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO jobs (id, cron, timezone, goal, channel, kind, created_at, next_fire_at, active)
          VALUES ('j1', '0 8 * * *', 'Europe/Rome', 'brief', 'cli', 'goal', '2026-06-01', '2026-06-15', 1);
      `);
      migrate(db, { backupDir: join(dir, 'backups'), migrations: [] }); // baseline v1, come un'installazione vecchia

      const res = migrate(db, { backupDir: join(dir, 'backups') });
      expect(res.applied).toContain(7);

      const colonne = (db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>).map((c) => c.name);
      for (const colonna of ['origin_tenant', 'origin_surface', 'origin_principal', 'origin_turn', 'tier']) {
        expect(colonne).toContain(colonna);
      }
      // La riga sopravvive e descrive un owner al terminale a taint 0 — i
      // default, non un'attribuzione inventata. Il contrario — un taint
      // diverso da zero su una riga che nessuno ha scritto così — cambierebbe
      // da solo cosa il giro futuro può fare.
      expect(db.prepare(`SELECT origin_tenant, origin_surface, origin_principal, origin_turn, tier FROM jobs WHERE id = 'j1'`).get()).toEqual({
        origin_tenant: 'host',
        origin_surface: 'cli',
        origin_principal: 'owner',
        origin_turn: null,
        tier: 0,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
