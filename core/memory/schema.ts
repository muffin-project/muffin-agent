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
  extraction_v  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_episodes_tenant_time ON episodes(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_episodes_pending ON episodes(extraction_v, tenant_id);

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
  extraction_v  INTEGER NOT NULL,
  superseded_by INTEGER REFERENCES facts(id),
  CHECK ((object_id IS NULL) <> (object_value IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(tenant_id, subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(tenant_id, expired_at);

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

/** Bumped when the extraction pipeline changes in a way that warrants a replay. */
export const EXTRACTION_VERSION = 1;
