import type Database from 'better-sqlite3';
import { IngestLock, type LockOutcome } from './ingest-lock.js';
import {
  DEFAULT_FUNCTIONAL_PREDICATES,
  EXTRACTION_VERSION,
  MEMORY_SCHEMA,
  type FactOrigin,
  type ReviewKind,
} from './schema.js';
import type { TrustTier } from '../policy/types.js';

/**
 * Typed access to memory, with tenant scoping enforced here rather than
 * remembered at every call site.
 *
 * Every method takes the tenant explicitly and every statement filters on it.
 * That is not belt-and-braces: the isolation guarantee is only as good as the
 * least careful query, and a batch job that forgets the filter is exactly how
 * a group's fact ends up answering a question about the owner's life.
 */

export type EpisodeInput = {
  tenantId: string;
  connector: string;
  threadKey: string;
  role: 'user' | 'agent' | 'tool' | 'system';
  kind: 'message' | 'tool_result' | 'document' | 'web' | 'media';
  content: string | null;
  trustTier: TrustTier;
  actorId?: number;
  vaultPath?: string;
  mediaMeta?: Record<string, unknown>;
  createdAt: string;
};

export type Episode = EpisodeInput & { id: number; extractionV: number };

export type FactInput = {
  tenantId: string;
  subjectId: number;
  predicate: string;
  objectId?: number;
  objectValue?: string;
  validFrom?: string | null;
  validTo?: string | null;
  episodeId: number;
  speakerId?: number;
  trustTier: TrustTier;
  confidence: number;
  /** Defaults to `said`: the only path that existed before inference did. */
  origin?: FactOrigin;
  /** 0 routine · 1 notable · 2 charged. Defaults to routine. */
  importance?: number;
  extractionV: number;
  recordedAt: string;
};

export type Fact = {
  id: number;
  subjectId: number;
  subjectName: string;
  predicate: string;
  objectValue: string | null;
  objectId: number | null;
  objectName: string | null;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  expiredAt: string | null;
  episodeId: number;
  trustTier: TrustTier;
  confidence: number;
  /** Said, inferred or imported — how we got here, not who said it. */
  origin: FactOrigin;
  /** 0 routine · 1 notable · 2 charged. Never evidence: see schema.ts. */
  importance: number;
  /** The fact that replaced this one, if any. Recall shows it; `why` follows it. */
  supersededBy: number | null;
};

export type ReviewItemInput = {
  tenantId: string;
  kind: ReviewKind;
  /** Absent for a `kind: 'error'` row that is not about one subject/predicate. */
  subject?: string | null;
  predicate?: string | null;
  existingFactId?: number | null;
  incomingFactId?: number | null;
  /** The judge's reasoning, or the error message. Human-readable either way. */
  detail: string;
  createdAt: string;
};

export type ReviewItem = {
  id: number;
  tenantId: string;
  kind: ReviewKind;
  subject: string | null;
  predicate: string | null;
  existingFactId: number | null;
  incomingFactId: number | null;
  detail: string;
  createdAt: string;
};

/**
 * What makes a contradiction *open*, written once.
 *
 * Two readers need it and they cannot share a code path: this class hydrates
 * the rows, and `muffin doctor` opens the database **readonly** so it can never
 * be the thing that creates or migrates a table — which rules out constructing
 * a `MemoryStore` at all, because the constructor runs DDL. Two hand-copied
 * joins would be the shape this repo keeps paying for, so the join is the
 * shared thing and only the SELECT list differs. One bind parameter: the tenant.
 */
export const OPEN_CONTRADICTION_FROM = `FROM memory_review r
         JOIN facts e ON e.id = r.existing_fact_id AND e.tenant_id = r.tenant_id
         JOIN facts i ON i.id = r.incoming_fact_id AND i.tenant_id = r.tenant_id
        WHERE r.tenant_id = ? AND r.kind = 'contradiction'
          AND e.expired_at IS NULL AND i.expired_at IS NULL`;

export class MemoryStore {
  private readonly ingestLock: IngestLock;

  constructor(private readonly db: Database.Database) {
    db.exec(MEMORY_SCHEMA);
    this.ingestLock = new IngestLock(db);
    // `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
    // so a new column in the schema above would never reach an existing
    // database. Columns added after the first release go here as well as there.
    this.ensureColumn('episodes', 'superseded_at', 'superseded_at TEXT');
    // Both carry a non-null default so the existing rows migrate in place: an
    // ALTER that adds NOT NULL without one is rejected outright. `said` is the
    // honest backfill rather than a convenient one — extraction has never been
    // allowed to infer (extract.ts rule 2), so every fact recorded before this
    // column existed did come from something someone actually said.
    this.ensureColumn(
      'facts',
      'origin',
      `origin TEXT NOT NULL DEFAULT 'said' CHECK (origin IN ('said','inferred','imported'))`,
    );
    this.ensureColumn(
      'facts',
      'importance',
      'importance INTEGER NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 2)',
    );
    const seed = db.prepare(
      `INSERT OR IGNORE INTO functional_predicates (predicate, declared_at) VALUES (?, datetime('now'))`,
    );
    for (const p of DEFAULT_FUNCTIONAL_PREDICATES) seed.run(p);
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  // ---- evidence -------------------------------------------------------------

  addEpisode(input: EpisodeInput): number {
    const stmt = this.db.prepare(
      `INSERT INTO episodes (tenant_id, connector, thread_key, actor_id, role, kind, content,
                             vault_path, media_meta, trust_tier, created_at, extraction_v)
       VALUES (@tenantId, @connector, @threadKey, @actorId, @role, @kind, @content,
               @vaultPath, @mediaMeta, @trustTier, @createdAt, 0)`,
    );
    const info = stmt.run({
      ...input,
      actorId: input.actorId ?? null,
      vaultPath: input.vaultPath ?? null,
      mediaMeta: input.mediaMeta ? JSON.stringify(input.mediaMeta) : null,
    });
    return Number(info.lastInsertRowid);
  }

  /** Episodes not yet processed by the current pipeline version, oldest first. */
  pendingEpisodes(tenantId: string, extractionV: number, limit = 50): Episode[] {
    return this.db
      .prepare(
        `SELECT id, tenant_id AS tenantId, connector, thread_key AS threadKey, actor_id AS actorId,
                role, kind, content, vault_path AS vaultPath, trust_tier AS trustTier,
                created_at AS createdAt, extraction_v AS extractionV
         FROM episodes
         WHERE tenant_id = ? AND extraction_v < ? AND content IS NOT NULL
         ORDER BY created_at LIMIT ?`,
      )
      .all(tenantId, extractionV, limit) as Episode[];
  }

  /**
   * The tenant is required even though the ids came from a tenant-scoped read.
   * Isolation held here by convention, and convention is what the next caller
   * does not know about — three write paths in this class filtered on the id
   * alone while the class docstring promised every statement filtered on tenant.
   */
  markExtracted(tenantId: string, episodeIds: number[], extractionV: number): void {
    if (episodeIds.length === 0) return;
    const stmt = this.db.prepare(`UPDATE episodes SET extraction_v = ? WHERE id = ? AND tenant_id = ?`);
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(extractionV, id, tenantId);
    });
    tx(episodeIds);
  }

  // ---- coordination -----------------------------------------------------------

  /**
   * One extractor at a time. See `ingest-lock.ts` for why a single lane lock
   * is the whole mechanism rather than a per-episode claim.
   */
  acquireIngestLock(now: Date, pid: number = process.pid): LockOutcome {
    return this.ingestLock.acquire(now, pid);
  }

  releaseIngestLock(pid: number = process.pid): void {
    this.ingestLock.release(pid);
  }

  // ---- entities -------------------------------------------------------------

  /**
   * Deterministic fast path only: exact match on normalised name within the
   * same tenant. The LLM fallback for ambiguous cases lives in the extraction
   * pipeline — never here, so a lookup can never quietly merge two people.
   */
  findEntity(tenantId: string, name: string, kind?: string): number | null {
    const row = this.db
      .prepare(
        `SELECT id FROM entities
         WHERE tenant_id = ? AND expired_at IS NULL AND lower(name) = lower(?)
           AND (? IS NULL OR kind = ?)
         ORDER BY id LIMIT 1`,
      )
      .get(tenantId, name.trim(), kind ?? null, kind ?? null) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /**
   * Looked up by name **alone** — `kind` is not passed to `findEntity` here,
   * on purpose. It used to be, and the fork it caused was silent: `kind` is a
   * per-mention guess from the extractor, not a stable identity property, so
   * the same person extracted once as `person` and once as `thing` (a plural
   * pronoun, an ambiguous sentence, anything that nudges the model's guess)
   * produced two entities instead of one. Fact dedup and the judge are both
   * scoped to a single `subjectId` and never look across entities, so the two
   * forks did not just duplicate the entity — they duplicated every fact
   * recorded against it, with no judge call, because each fork's fact history
   * started empty. The kind recorded here is therefore the first one seen; a
   * later mention that guesses differently still resolves to the same row and
   * does not overwrite it. `findEntity`'s own docstring already describes
   * exact-name matching as the fast path — this was the one caller not taking
   * it.
   */
  upsertEntity(tenantId: string, name: string, kind: string, recordedAt: string): number {
    const existing = this.findEntity(tenantId, name);
    if (existing !== null) return existing;
    const info = this.db
      .prepare(`INSERT INTO entities (tenant_id, kind, name, recorded_at) VALUES (?, ?, ?, ?)`)
      .run(tenantId, kind, name.trim(), recordedAt);
    return Number(info.lastInsertRowid);
  }

  // ---- facts ----------------------------------------------------------------

  isFunctional(predicate: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM functional_predicates WHERE predicate = ?`).get(predicate) !== undefined
    );
  }

  addFact(input: FactInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO facts (tenant_id, subject_id, predicate, object_id, object_value,
                            valid_from, valid_to, recorded_at, episode_id, speaker_id,
                            trust_tier, confidence, origin, importance, extraction_v)
         VALUES (@tenantId, @subjectId, @predicate, @objectId, @objectValue,
                 @validFrom, @validTo, @recordedAt, @episodeId, @speakerId,
                 @trustTier, @confidence, @origin, @importance, @extractionV)`,
      )
      .run({
        ...input,
        objectId: input.objectId ?? null,
        objectValue: input.objectValue ?? null,
        // Never invented: a fact with no stated time keeps NULL.
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        speakerId: input.speakerId ?? null,
        origin: input.origin ?? 'said',
        importance: input.importance ?? 0,
      });
    return Number(info.lastInsertRowid);
  }

  /**
   * Retires a fact in favour of a newer one. Both times are closed: `valid_to`
   * says when it stopped being true out there, `expired_at` when we stopped
   * believing it. Nothing is deleted, so "what did I think in May" stays
   * answerable.
   *
   * `validTo` has three states and the third one is not decoration:
   *
   *   a date     the judge said when it stopped being true (`temporal_scope`)
   *   omitted    nobody said, so world time closes when system time did
   *   **null**   **do not touch world time at all**
   *
   * That last state exists for the maintenance sweep. Retiring an exact
   * *duplicate* is not a claim that anything stopped being true out there — the
   * duplicate was never a separate truth — so writing today's date into
   * `valid_to` would invent a world-time boundary that never happened. This
   * schema's own rule is that `valid_from` is never guessed, *"because a
   * fabricated timestamp is indistinguishable from a real one a month later"*,
   * and the same argument applies to the closing end. Bound as SQL NULL, which
   * `COALESCE(valid_to, NULL)` leaves as it found it.
   */
  supersede(
    tenantId: string,
    oldFactId: number,
    newFactId: number,
    at: string,
    validTo?: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE facts SET expired_at = ?, superseded_by = ?, valid_to = COALESCE(valid_to, ?)
         WHERE id = ? AND tenant_id = ? AND expired_at IS NULL`,
      )
      .run(at, newFactId, validTo === null ? null : (validTo ?? at), oldFactId, tenantId);
  }

  /**
   * Current beliefs about a subject+predicate. A set unless declared functional.
   *
   * Ordered by recency, and **only** by recency. Importance is deliberately not
   * in this ORDER BY, and the reason is a defect this method used to have.
   *
   * It was `ORDER BY importance DESC, recorded_at DESC`, on the theory that the
   * ordering only decided which facts survive recall's six-fact cut. That was
   * wrong twice. Recall passes each fact's *position in this list* to the fusion
   * as its rank, and RRF turns rank into score — so importance was setting the
   * RRF contribution directly, worth 0.001242, which is 73% of the threshold at
   * which our own research says the fused ranking silently becomes
   * "sorted by importance". The guarantee written here said the opposite of what
   * the code did. And because `charged` is defined at extraction as a singular
   * past event, importance-first also evicted current-state facts: a 2024
   * separation kept its slot while `works_at` was cut, permanently, for every
   * query.
   *
   * Importance now acts where it belongs — on **membership**, bounded, in
   * `recall.ts` — never on rank. That is the shape the research and the
   * cognitive corpus independently arrived at: *l'importanza protegge, non
   * spinge*. See `docs/blueprint/research/memory-salience-and-fusion.md` and
   * `knowledge/01-understanding.md`.
   */
  activeFacts(tenantId: string, subjectId: number, predicate?: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.subject_id = ? AND f.expired_at IS NULL
           AND (? IS NULL OR f.predicate = ?)
         ORDER BY f.recorded_at DESC`,
      )
      .all(tenantId, subjectId, predicate ?? null, predicate ?? null) as Fact[];
  }

  /**
   * `activeFacts`, without the `expired_at IS NULL` filter — every fact ever
   * recorded for a subject, retired ones included. Ordered by recency like
   * `activeFacts`, so `selectForExpansion`'s assumption (facts arrive newest
   * first) holds for either method a caller passes it.
   *
   * The counterpart to `factHistory`: that one pins a single predicate and
   * reads oldest-first for a "what did I think then" narrative; this one
   * mirrors `activeFacts`' own shape (predicate optional, newest-first) for
   * `recall`'s graph expansion, which does not know a predicate in advance.
   */
  allFacts(tenantId: string, subjectId: number, predicate?: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.subject_id = ?
           AND (? IS NULL OR f.predicate = ?)
         ORDER BY f.recorded_at DESC`,
      )
      .all(tenantId, subjectId, predicate ?? null, predicate ?? null) as Fact[];
  }

  /**
   * Every (subject, predicate) that currently holds **more than one** belief.
   *
   * The whole input of the maintenance sweep, and it is deliberately shaped as
   * "the groups that could contain a duplicate" rather than "all active facts".
   * Two reasons, and only the second is about speed:
   *
   *  - A group of one cannot contain a duplicate, so a sweep that read every
   *    active fact would be doing arithmetic to rediscover that. ⬤ On the old
   *    system's four-month graph this filter cut the input from **308 active
   *    facts to 5** — the two multi-valued groups it held, both of which were
   *    duplicates.
   *  - Set-valued predicates are the norm here by design (`schema.ts`: the old
   *    schema treated every predicate as single-valued and expired 27 of 28
   *    `interest` rows by accident). So a multi-valued group is *legal* and
   *    common, and this method must not be read as finding a problem. It finds
   *    the only place a duplicate can hide.
   *
   * Ordered so a group arrives together and its rows arrive newest-first, which
   * is the order the sweep's survivor rule wants — but the sweep re-sorts
   * anyway, because a guarantee that lives in an ORDER BY two files away is the
   * kind that changes without its caller noticing (see `activeFacts`, where
   * exactly that happened).
   */
  multiValuedActiveFacts(tenantId: string): { subjectId: number; predicate: string; facts: Fact[] }[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.expired_at IS NULL
           AND (f.subject_id, f.predicate) IN (
             SELECT subject_id, predicate FROM facts
             WHERE tenant_id = ? AND expired_at IS NULL
             GROUP BY subject_id, predicate HAVING count(*) > 1
           )
         ORDER BY f.subject_id, f.predicate, f.recorded_at DESC, f.id DESC`,
      )
      .all(tenantId, tenantId) as Fact[];

    const groups: { subjectId: number; predicate: string; facts: Fact[] }[] = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (last && last.subjectId === row.subjectId && last.predicate === row.predicate) {
        last.facts.push(row);
      } else {
        groups.push({ subjectId: row.subjectId, predicate: row.predicate, facts: [row] });
      }
    }
    return groups;
  }

  /** Includes retired beliefs, for "what did I think then" questions. */
  factHistory(tenantId: string, subjectId: number, predicate: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.subject_id = ? AND f.predicate = ?
         ORDER BY f.recorded_at`,
      )
      .all(tenantId, subjectId, predicate) as Fact[];
  }

  /** Full-text over evidence. Never crosses a tenant, whatever the query says. */
  searchEpisodes(tenantId: string, query: string, limit = 10): { id: number; content: string; createdAt: string; trustTier: TrustTier }[] {
    const cleaned = query.replace(/["'()]/g, ' ').trim();
    if (cleaned === '') return [];
    return this.db
      .prepare(
        `SELECT e.id, e.content, e.created_at AS createdAt, e.trust_tier AS trustTier
         FROM episodes_fts f
         JOIN episodes e ON e.id = f.rowid
         WHERE episodes_fts MATCH ? AND e.tenant_id = ? AND e.superseded_at IS NULL
         ORDER BY rank LIMIT ?`,
      )
      .all(cleaned.split(/\s+/).map((t) => `"${t}"`).join(' OR '), tenantId, limit) as {
      id: number;
      content: string;
      createdAt: string;
      trustTier: TrustTier;
    }[];
  }

  entitiesByName(tenantId: string, name: string, limit = 5): { id: number; name: string; kind: string }[] {
    return this.db
      .prepare(
        `SELECT id, name, kind FROM entities
         WHERE tenant_id = ? AND expired_at IS NULL AND lower(name) LIKE lower(?)
         ORDER BY length(name) LIMIT ?`,
      )
      .all(tenantId, `%${name.trim()}%`, limit) as { id: number; name: string; kind: string }[];
  }

  // ---- review -----------------------------------------------------------------

  /**
   * Durable home for the judge's `review` verdict and any error the pipeline
   * could not act on — both used to go only to `process.stderr` from
   * `cli/memory.ts`, which is fine for a human running the command by hand and
   * loses everything the moment the caller is a scheduler instead.
   *
   * Append-only, like the rest of the store: no resolution state. Reading it
   * back is `pendingReview`.
   */
  recordReview(input: ReviewItemInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO memory_review (tenant_id, kind, subject, predicate, existing_fact_id,
                                     incoming_fact_id, detail, created_at)
         VALUES (@tenantId, @kind, @subject, @predicate, @existingFactId, @incomingFactId, @detail, @createdAt)`,
      )
      .run({
        ...input,
        subject: input.subject ?? null,
        predicate: input.predicate ?? null,
        existingFactId: input.existingFactId ?? null,
        incomingFactId: input.incomingFactId ?? null,
      });
    return Number(info.lastInsertRowid);
  }

  /**
   * The contradictions still waiting for a human, and **only** those.
   *
   * "Open" is a join, not a column. `memory_review` has no `resolved_at` and is
   * not getting one — the schema says why: a register that tracked whether a
   * human had looked yet would be the workflow engine this was explicitly asked
   * not to become. So a contradiction is open exactly while both of its facts
   * are still active, which means the question closes itself the moment the
   * conversation supersedes either one, with nothing written anywhere.
   *
   * The filter lives in SQL rather than in the caller because the caller that
   * existed did not have it: `pendingReview` returns every row ever recorded,
   * and the only number this register ever surfaced was that total. On an
   * append-only table a total only grows, which is how a number stops being
   * read.
   */
  openContradictions(
    tenantId: string,
    limit = 50,
  ): { id: number; createdAt: string; detail: string; existingFactId: number; incomingFactId: number }[] {
    return this.db
      .prepare(
        `SELECT r.id, r.created_at AS createdAt, r.detail,
                r.existing_fact_id AS existingFactId, r.incoming_fact_id AS incomingFactId
         ${OPEN_CONTRADICTION_FROM}
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(tenantId, limit) as {
      id: number;
      createdAt: string;
      detail: string;
      existingFactId: number;
      incomingFactId: number;
    }[];
  }

  /** Everything recorded for this tenant, most recent first. */
  pendingReview(tenantId: string, limit = 50): ReviewItem[] {
    return this.db
      .prepare(
        `SELECT id, tenant_id AS tenantId, kind, subject, predicate,
                existing_fact_id AS existingFactId, incoming_fact_id AS incomingFactId,
                detail, created_at AS createdAt
         FROM memory_review WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(tenantId, limit) as ReviewItem[];
  }

  // ---- vault ----------------------------------------------------------------

  /** Live episodes for one vault file, in chunk order. */
  episodesForVaultPath(tenantId: string, vaultPath: string): { id: number; mediaMeta: string | null }[] {
    return this.db
      .prepare(
        `SELECT id, media_meta AS mediaMeta FROM episodes
         WHERE tenant_id = ? AND vault_path = ? AND superseded_at IS NULL ORDER BY id`,
      )
      .all(tenantId, vaultPath) as { id: number; mediaMeta: string | null }[];
  }

  /**
   * Every vault path that still has live evidence behind it, each carrying the
   * tier of its **least-trusted** chunk.
   *
   * The maximum, for the same reason as `maxTierForContent`: a lower number
   * means more trusted, so a document is worth its worst chunk and not its
   * best. `min()` here read as the opposite — one owner-grade chunk beside a
   * web import displayed the whole file as tier 0 — and a tier that rises
   * because of how a file happened to be split is not a tier.
   *
   * Chunks of one live path usually agree, since `reindex` writes them in a
   * single pass with one tier. Usually is not a guarantee: the new chunks are
   * written inside the loop and the old ones superseded only after it, so an
   * interrupted reindex leaves two generations live under the same path. The
   * aggregate that survives that has to be the pessimistic one.
   */
  vaultPaths(tenantId: string): { vaultPath: string; chunks: number; trustTier: TrustTier }[] {
    return this.db
      .prepare(
        `SELECT vault_path AS vaultPath, count(*) AS chunks, max(trust_tier) AS trustTier
         FROM episodes
         WHERE tenant_id = ? AND vault_path IS NOT NULL AND superseded_at IS NULL
         GROUP BY vault_path ORDER BY vault_path`,
      )
      .all(tenantId) as { vaultPath: string; chunks: number; trustTier: TrustTier }[];
  }

  /**
   * The least-trusted tier ever recorded for this exact content, anywhere.
   *
   * Trust follows the bytes, not the filename. Inheriting by path meant a `mv`
   * laundered a tier-3 import into owner-grade evidence: the new path was
   * unknown, so the default applied. Superseded rows count — a tier that was
   * once true of this content stays true of it — and the maximum is taken
   * because a lower number means more trusted.
   */
  maxTierForContent(tenantId: string, hash: string): TrustTier | null {
    const row = this.db
      .prepare(
        `SELECT max(trust_tier) AS tier FROM episodes
         WHERE tenant_id = ? AND json_extract(media_meta, '$.hash') = ?`,
      )
      .get(tenantId, hash) as { tier: TrustTier | null };
    return row.tier;
  }

  /**
   * Retires evidence without deleting it. Used when a vault file changes: the
   * old text stops being recalled but stays answerable for "what did that note
   * say in May".
   */
  supersedeEpisodes(tenantId: string, episodeIds: number[], at: string): void {
    if (episodeIds.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE episodes SET superseded_at = ? WHERE id = ? AND tenant_id = ? AND superseded_at IS NULL`,
    );
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(at, id, tenantId);
    });
    tx(episodeIds);
  }

  // ---- provenance -----------------------------------------------------------

  /**
   * Where a recalled chunk came from and how much it is worth.
   *
   * The vector index stores text and a source id, not a tier — so without this
   * the fusion had nothing to read and used a constant, which turned every
   * semantic hit into owner-grade evidence regardless of who wrote it.
   */
  provenanceOf(
    tenantId: string,
    kind: 'episode' | 'fact',
    sourceId: number,
  ): { trustTier: TrustTier; createdAt: string; origin?: FactOrigin } | null {
    const row =
      kind === 'episode'
        ? (this.db
            .prepare(
              `SELECT trust_tier AS trustTier, created_at AS createdAt FROM episodes WHERE tenant_id = ? AND id = ?`,
            )
            .get(tenantId, sourceId) as { trustTier: TrustTier; createdAt: string } | undefined)
        : // `origin` comes back here for the same reason `trust_tier` does: the
          // vector index stores text and a source id, so the semantic half of
          // recall has nothing else to read it from. Without it an inferred
          // fact retrieved by paraphrase arrived unmarked and was asserted as
          // something the owner had said — the identical shape as the tier bug
          // this method was written to fix.
          (this.db
            .prepare(
              `SELECT trust_tier AS trustTier, recorded_at AS createdAt, origin FROM facts WHERE tenant_id = ? AND id = ?`,
            )
            .get(tenantId, sourceId) as
            | { trustTier: TrustTier; createdAt: string; origin: FactOrigin }
            | undefined);
    return row ?? null;
  }

  /** One fact by id, tenant-scoped. The entry point of `muffin memory why`. */
  factById(tenantId: string, id: number): Fact | null {
    const row = this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.id = ?`,
      )
      .get(tenantId, id) as Fact | undefined;
    return row ?? null;
  }

  /**
   * The episode a fact came from. This is the whole answer to "why do you think
   * that": not a rationalisation generated after the fact, but the sentence that
   * was actually said, with its time and its tier.
   */
  episodeById(tenantId: string, id: number): Episode | null {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id AS tenantId, connector, thread_key AS threadKey, actor_id AS actorId,
                role, kind, content, vault_path AS vaultPath, trust_tier AS trustTier,
                created_at AS createdAt, extraction_v AS extractionV
         FROM episodes WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, id) as (Episode & { actorId: number | null; vaultPath: string | null }) | undefined;
    if (!row) return null;
    // The optional columns come back NULL from SQLite; the type says absent.
    const { actorId, vaultPath, ...rest } = row;
    return {
      ...rest,
      ...(actorId === null ? {} : { actorId }),
      ...(vaultPath === null ? {} : { vaultPath }),
    };
  }

  /** Which facts a given episode produced — the other direction of provenance. */
  factsFromEpisode(tenantId: string, episodeId: number): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.episode_id = ?
         ORDER BY f.id`,
      )
      .all(tenantId, episodeId) as Fact[];
  }

  stats(tenantId: string): MemoryStats {
    const one = <T>(sql: string, ...params: unknown[]): T =>
      (this.db.prepare(sql).get(...params) as { v: T }).v;
    return {
      episodes: one<number>(`SELECT count(*) AS v FROM episodes WHERE tenant_id = ?`, tenantId),
      // Deliberately the exact complement of `pendingEpisodes` — same three
      // conditions, same version constant. It used to diverge on all three, and
      // each divergence undercounted in a way that only bites once the lane runs
      // unattended: `role = 'user'` ignored every agent-role episode the lane
      // will in fact extract; `extraction_v = 0` would miss rows left at an
      // older non-zero version the day `EXTRACTION_VERSION` is bumped, which is
      // the one moment a backlog appears out of nowhere; and no `content IS NOT
      // NULL` counted rows the fetch can never return, so the number could not
      // reach zero. A pending count that a human reads to decide "is it caught
      // up?" has to answer for the fetch, not for a similar-sounding question.
      pending: one<number>(
        `SELECT count(*) AS v FROM episodes
          WHERE tenant_id = ? AND extraction_v < ? AND content IS NOT NULL`,
        tenantId,
        EXTRACTION_VERSION,
      ),
      entities: one<number>(
        `SELECT count(*) AS v FROM entities WHERE tenant_id = ? AND expired_at IS NULL`,
        tenantId,
      ),
      activeFacts: one<number>(
        `SELECT count(*) AS v FROM facts WHERE tenant_id = ? AND expired_at IS NULL`,
        tenantId,
      ),
      retiredFacts: one<number>(
        `SELECT count(*) AS v FROM facts WHERE tenant_id = ? AND expired_at IS NOT NULL`,
        tenantId,
      ),
      needsReview: one<number>(
        `SELECT count(*) AS v FROM memory_review WHERE tenant_id = ?`,
        tenantId,
      ),
      predicates: one<number>(
        `SELECT count(DISTINCT predicate) AS v FROM facts WHERE tenant_id = ?`,
        tenantId,
      ),
      topPredicates: this.db
        .prepare(
          `SELECT predicate, count(*) AS n FROM facts
           WHERE tenant_id = ? AND expired_at IS NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
        )
        .all(tenantId) as { predicate: string; n: number }[],
      span: this.db
        .prepare(
          `SELECT min(created_at) AS from_, max(created_at) AS to_ FROM episodes WHERE tenant_id = ?`,
        )
        .get(tenantId) as { from_: string | null; to_: string | null },
    };
  }
}

export type MemoryStats = {
  episodes: number;
  /** Owner messages not yet through extraction. */
  pending: number;
  entities: number;
  activeFacts: number;
  retiredFacts: number;
  /** Judge `review` verdicts plus pipeline errors, durable — see `memory_review`. */
  needsReview: number;
  predicates: number;
  topPredicates: { predicate: string; n: number }[];
  span: { from_: string | null; to_: string | null };
};
