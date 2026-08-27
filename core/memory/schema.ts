/**
 * Memory schema — three planes.
 *
 *   evidence   episodes, append-only, the only source of truth
 *   graph      entities / identities / facts, bi-temporal, every row carrying
 *              where it came from and how much that source is trusted
 *   derived    profiles, digests — always reconstructible, never authoritative
 *
 * The invariant that makes the rest work: drop every derived table, replay the
 * episodes, and you are back where you were. Which is also how migration works
 * (02 §8) and why compaction can be lossy without being dangerous.
 *
 * Two decisions here are the scar tissue of the previous system:
 *
 *  - facts are **set-valued by default**. The old schema treated every
 *    predicate as single-valued and silently expired the previous belief on
 *    each new mention; an audit found 27 of 28 `interest` rows and 21 of 22
 *    `preference` rows expired by accident. Accumulating wrongly is visible and
 *    repairable; deleting wrongly is neither.
 *  - `valid_from` is never guessed. A fact whose time was not stated keeps NULL
 *    rather than inheriting today's date, because a fabricated timestamp is
 *    indistinguishable from a real one a month later.
 */

export const MEMORY_SCHEMA = `
-- ---------- plane 1: evidence ------------------------------------------------
CREATE TABLE IF NOT EXISTS episodes (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  connector     TEXT    NOT NULL,
  thread_key    TEXT    NOT NULL,
  actor_id      INTEGER REFERENCES identities(id),
  role          TEXT    NOT NULL CHECK (role IN ('user','agent','tool','system')),
  kind          TEXT    NOT NULL CHECK (kind IN ('message','tool_result','document','web','media')),
  content       TEXT,
  vault_path    TEXT,
  media_meta    TEXT,
  trust_tier    INTEGER NOT NULL CHECK (trust_tier BETWEEN 0 AND 3),
  created_at    TEXT    NOT NULL,
  extraction_v  INTEGER NOT NULL DEFAULT 0,
  -- Evidence is append-only, so nothing here is ever deleted. But a file in the
  -- vault can be edited and a message can be withdrawn, and the old text should
  -- stop coming back in recall while remaining on record. This is that line: it
  -- retires an episode without pretending it never existed.
  superseded_at TEXT,
  -- Il turno che ha prodotto questa riga, quando c'è stato un turno.
  --
  -- Nullable e senza foreign key, perché le due tabelle stanno in due database
  -- (muffin.db ha \`turns\`; la memoria è la stessa connessione oggi ma il
  -- confine è dichiarato) e perché la maggior parte delle scritture di memoria
  -- non viene da un turno: un import, il consolidatore, una nota del vault.
  --
  -- Esiste per una sola giunzione, ed è quella che mancava a D11: dopo
  -- \`muffin undo\` il record del turno smetteva di dire «ho scritto», ma
  -- l'episodio dell'agente — la **stessa frase**, indicizzata in FTS e pescata
  -- dal recall del giro dopo — continuava ad arrivare al modello nudo, due
  -- blocchi più in basso nella stessa \`ChatCall\`. Marcare la cronologia di
  -- sessione e lasciare la memoria nuda è marcare una copia su due.
  turn_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_tenant_time ON episodes(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_episodes_pending ON episodes(extraction_v, tenant_id);
CREATE INDEX IF NOT EXISTS idx_episodes_vault ON episodes(tenant_id, vault_path);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  content,
  content='episodes',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

-- ---------- plane 2: graph ---------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  summary       TEXT,
  recorded_at   TEXT    NOT NULL,
  expired_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_tenant_name ON entities(tenant_id, name);

-- One person seen from two connectors is two identities until someone confirms
-- otherwise. Automatic merging is the failure that cannot be noticed later.
CREATE TABLE IF NOT EXISTS identities (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  connector     TEXT    NOT NULL,
  external_id   TEXT    NOT NULL,
  handle        TEXT,
  entity_id     INTEGER REFERENCES entities(id),
  link_status   TEXT    NOT NULL DEFAULT 'unlinked'
                CHECK (link_status IN ('unlinked','proposed','confirmed')),
  link_evidence INTEGER REFERENCES episodes(id),
  UNIQUE(connector, external_id)
);

CREATE TABLE IF NOT EXISTS facts (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  subject_id    INTEGER NOT NULL REFERENCES entities(id),
  predicate     TEXT    NOT NULL,
  object_id     INTEGER REFERENCES entities(id),
  object_value  TEXT,
  -- world time: when it was true out there. NULL means nobody said.
  valid_from    TEXT,
  valid_to      TEXT,
  -- system time: when we learned it, and when we retired it. Never deleted.
  recorded_at   TEXT    NOT NULL,
  expired_at    TEXT,
  -- provenance: the primitive the field does not have
  episode_id    INTEGER NOT NULL REFERENCES episodes(id),
  speaker_id    INTEGER REFERENCES identities(id),
  trust_tier    INTEGER NOT NULL CHECK (trust_tier BETWEEN 0 AND 3),
  confidence    REAL    NOT NULL,
  -- How we came to believe it, which is a different axis from who said it.
  -- A verbatim web quote is (tier 3, said); an inference of ours about the
  -- owner is (tier 0, inferred). Collapsing the two into one number destroys
  -- both. Named "origin" and not "source_kind" on purpose: chunks.source_kind
  -- already exists two files away and means which *table* a chunk came from.
  origin        TEXT    NOT NULL DEFAULT 'said'
                CHECK (origin IN ('said','inferred','imported')),
  -- Intensity, never frequency: one charged event outranks a thousand routine
  -- ones. Ordinal and short by design — LLM raters compress toward the middle
  -- and systematically under-predict the top of a range, which is precisely
  -- where the charged event lives, so a continuous score would be false
  -- precision. Assigned by forced choice at extraction, not by a 1-10 rating.
  importance    INTEGER NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 2),
  extraction_v  INTEGER NOT NULL,
  superseded_by INTEGER REFERENCES facts(id),
  -- The nucleus (slice/memoria-appuntata): a pinned fact enters the MEMORIA
  -- block of every turn unconditionally, before the similarity search even
  -- runs — the fix for "Yo!" not matching the episode where the owner's name
  -- was given. Deliberately not a tier alongside trust_tier/importance: those
  -- two answer "how much to trust it" and "how much it would hurt to forget
  -- it"; this answers only "is it in context right now, or does something
  -- have to go looking for it". addFact() is the one place allowed to set it
  -- to 1 (see its own comment) — a row written directly, or by anything that
  -- skips that gate, stays 0 by default, which is the safe direction.
  pinned        INTEGER NOT NULL DEFAULT 0,
  CHECK ((object_id IS NULL) <> (object_value IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(tenant_id, subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(tenant_id, expired_at);

-- ---------- graph addendum: the judge's "ask a human" outcome ---------------
-- Not plane 3: this is not reconstructible from the episodes, so it is not
-- droppable the way profiles/digests are. It is the durable home for the two
-- things that used to go only to process.stderr and vanish — the judge's
-- review verdict (judge.ts) and any error the pipeline could not act on.
-- Append-only like the rest of the store: no resolved_at, no status column.
-- A register that tracked whether a human had looked yet would be the
-- workflow engine this was explicitly asked not to become.
CREATE TABLE IF NOT EXISTS memory_review (
  id                INTEGER PRIMARY KEY,
  tenant_id         TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('contradiction','error')),
  subject           TEXT,
  predicate         TEXT,
  existing_fact_id  INTEGER REFERENCES facts(id),
  incoming_fact_id  INTEGER REFERENCES facts(id),
  detail            TEXT    NOT NULL,
  created_at        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_review_tenant ON memory_review(tenant_id, created_at);

-- ---------- plane 3: derived (droppable) -------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  entity_id     INTEGER PRIMARY KEY REFERENCES entities(id),
  tenant_id     TEXT    NOT NULL,
  text          TEXT    NOT NULL,
  generated_at  TEXT    NOT NULL,
  extraction_v  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS digests (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  scope         TEXT    NOT NULL,
  text          TEXT    NOT NULL,
  covers_from   TEXT    NOT NULL,
  covers_to     TEXT    NOT NULL,
  generated_at  TEXT    NOT NULL
);

-- Which predicates hold exactly one current value. Everything else is a set:
-- the default is deliberately the safe direction.
CREATE TABLE IF NOT EXISTS functional_predicates (
  predicate     TEXT PRIMARY KEY,
  declared_at   TEXT NOT NULL
);
`;

/** Seeded once; the list stays short on purpose and is visible to the owner. */
export const DEFAULT_FUNCTIONAL_PREDICATES = [
  'date_of_birth',
  'place_of_birth',
  'legal_name',
  'tax_id',
] as const;

/**
 * How a belief was arrived at. Orthogonal to `trust_tier`, which says who the
 * source was — this says how we got from the source to the belief.
 *
 * `imported` exists from the start because the CHECK is enforced by SQLite and
 * SQLite cannot alter a CHECK without rebuilding the table: the cost of the
 * third value now is one word, and later it is a migration.
 *
 * The behaviour that makes the field worth its column: a `said` fact may be
 * asserted, an `inferred` one is carried as a hypothesis and hedged. That is
 * the structural antidote to the old system's vague "I noticed…" firehose —
 * the shape of the sentence is forced by provenance, not by prompt discipline.
 */
const FACT_ORIGINS = ['said', 'inferred', 'imported'] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];

/**
 * Intensity, in three steps. Not a scale to be averaged: the levels are
 * decided by two yes/no questions at extraction (see `extract.ts`), because a
 * forced choice cannot pile up in the middle the way a rating does.
 *
 * The hard rule that goes with it: **importance never feeds `confidence` or
 * `trust_tier`.** Emotional intensity raises how accurate a memory *feels*
 * without raising how accurate it *is* (Talarico & Rubin 2003) — so treating a
 * charged fact as a better-evidenced one would be the same error the "trust
 * never rises" invariant already exists to prevent.
 */
export const IMPORTANCE_ROUTINE = 0;
export const IMPORTANCE_NOTABLE = 1;
export const IMPORTANCE_CHARGED = 2;

/** Bumped when the extraction pipeline changes in a way that warrants a replay. */
export const EXTRACTION_VERSION = 1;

/**
 * `contradiction` is the judge's own `review` verdict (judge.ts): two facts
 * looked like they might conflict and the judge would not guess. `error` is
 * everything the pipeline could not act on — a failed extraction, a judge
 * that returned nothing usable, an embedder that is down. Both used to be
 * strings on `IngestReport`, printed to stderr by the one caller that existed
 * and lost the moment a second caller (a scheduler) did not print them.
 */
const REVIEW_KINDS = ['contradiction', 'error'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
