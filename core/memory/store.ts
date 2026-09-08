import { redactText } from '../tracing/redact.js';
import type Database from 'better-sqlite3';
import { IngestLock, type LockOutcome } from './ingest-lock.js';
import {
  DEFAULT_FUNCTIONAL_PREDICATES,
  EXTRACTION_VERSION,
  MEMORY_SCHEMA,
  type FactOrigin,
  type ReviewKind,
} from './schema.js';
import { ensureColumn } from '../lock/durable.js';
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
  /**
   * The turn that produced this episode — `TurnRecord.id`, which is also its
   * `traceId`. Absent when the episode does not belong to one turn (vault
   * ingestion, `observe-run`) or predates the column: NULL is an answer there,
   * not a gap to fill by guessing.
   */
  turnId?: string;
};

export type Episode = EpisodeInput & {
  id: number;
  extractionV: number;
  /** `episodes.undone_at`: when `markEpisodesUndone` marked it, or absent. */
  undoneAt?: string;
};

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
  /**
   * Requested pin. Defaults to false, and requesting it is not granting it:
   * `addFact` only honours this when `trustTier` is 0 and `origin` is `said`
   * — see its own comment. A caller here is a proposal, not an instruction,
   * because the caller can be an extractor reading someone else's words.
   */
  pinned?: boolean;
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
  /** Set only by `retireFacts`: the owner asked to forget, and this names the request. Absent on rows read by other queries. */
  retiredReason?: string | null;
  /**
   * 0 or 1 — SQLite has no boolean, and this follows `importance`'s own
   * convention of reading the CHECK-less integer bare rather than narrowing
   * it at the boundary. 1 means recall injects it into every turn's MEMORIA
   * block unconditionally, ahead of anything similarity found; see
   * `recall.ts`'s pinned-core comment for the whole mechanism.
   */
  pinned: number;
};

/**
 * One episode as recall sees it: the text, and everything needed to say where
 * it came from and to ask what surrounded it.
 *
 * `supersededAt` is on the hit rather than filtered away, because under
 * `--history` a retired episode is exactly what was asked for and the caller
 * has to be able to mark it. A row that comes back looking live when it is not
 * is worse than one that never came back.
 */
export type EpisodeHit = {
  id: number;
  content: string;
  createdAt: string;
  trustTier: TrustTier;
  connector: string;
  threadKey: string;
  supersededAt: string | null;
  /** `episodes.turn_id`: NULL for rows written before the column, and for evidence no turn produced. */
  turnId: string | null;
};

/**
 * Navigation, not relevance: which slice of the evidence a search may look at.
 *
 * This is the `(surface, date_range)` filter of `02-ontologia.md` §9, the
 * primitive that section names as missing beside recall. The tenant is
 * deliberately **not** a field here and never will be: it stays a separate,
 * required argument of every method on this class, so no caller can pass a
 * filter object that quietly widens its own scope. That is the same rule
 * `memory_search` follows by having no tenant parameter at all.
 */
export type EpisodeFilter = {
  /** Retired evidence too. Off by default: recall answers about now. */
  includeSuperseded?: boolean;
  /** The connector it was learned on — 'telegram', 'cli', 'vault'. */
  surface?: string | undefined;
  /** ISO bounds on `created_at`, inclusive. */
  since?: string | undefined;
  until?: string | undefined;
  /**
   * Turni gia davanti al modello, da non ripescare.
   *
   * Filtra **dentro la query**, non dopo: una riga esclusa che passa la porta e
   * viene tolta a valle ha comunque consumato uno slot di `LIMIT` e ha comunque
   * pesato nella fusione. Il posto giusto e qui.
   *
   * `turn_id IS NULL` non e mai escluso: una riga senza lineage non e provato
   * che sia in history, e togliere per non-sapere e la parte che
   * `docs/knowledge/` chiama inventare precisione all'indietro.
   */
  excludeTurnIds?: readonly string[] | undefined;
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
    ensureColumn(db, 'episodes', 'superseded_at', 'superseded_at TEXT');
    // Both carry a non-null default so the existing rows migrate in place: an
    // ALTER that adds NOT NULL without one is rejected outright. `said` is the
    // honest backfill rather than a convenient one — extraction has never been
    // allowed to infer (extract.ts rule 2), so every fact recorded before this
    // column existed did come from something someone actually said.
    ensureColumn(
      db,
      'facts',
      'origin',
      `origin TEXT NOT NULL DEFAULT 'said' CHECK (origin IN ('said','inferred','imported'))`,
    );
    ensureColumn(
      db,
      'facts',
      'importance',
      'importance INTEGER NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 2)',
    );
    // Same net, for the same reason, for the column `slice/memoria-appuntata`
    // adds: `migrate()` carries this forward for anyone who boots through it
    // (migration 3), but `cli/memory.ts` and other direct openers construct a
    // `MemoryStore` straight from a file, exactly the gap `jobs.kind`'s own
    // `ensureColumn` call exists to close (judge #106 giro 2).
    ensureColumn(db, 'facts', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
    // Why a belief was retired without a successor — «dimentica X» from the
    // owner (`ingest.ts#retireBeliefs`), never the judge's `supersede`, which
    // records its reason as `superseded_by`. NULL on every historical row.
    ensureColumn(db, 'facts', 'retired_reason', 'retired_reason TEXT');
    // Nullable e senza default: un database esistente guadagna la colonna e non
    // perde una riga, e nessuna riga storica riceve un turno che non ha avuto.
    ensureColumn(db, 'episodes', 'turn_id', 'turn_id TEXT');
    // D11's memory half. Additive next to `turn_id` for the same reason:
    // nullable, no default, no row loses or gains a fact it never had.
    ensureColumn(db, 'episodes', 'undone_at', 'undone_at TEXT');
    // The pinned lookup runs on every recall call — every turn with memory
    // enabled — so it earns the same treatment `idx_facts_active` gives
    // `expired_at`. Placed after `ensureColumn`, never before: on a database
    // still missing the column this would fail with "no such column: pinned".
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_pinned ON facts(tenant_id, pinned)`);
    const seed = db.prepare(
      `INSERT OR IGNORE INTO functional_predicates (predicate, declared_at) VALUES (?, datetime('now'))`,
    );
    for (const p of DEFAULT_FUNCTIONAL_PREDICATES) seed.run(p);
  }

  // ---- evidence -------------------------------------------------------------

  /**
   * **Il floor sulle credenziali sta qui, non nei chiamanti.**
   *
   * `redactText` esisteva già, prendeva cinque forme di credenziale su cinque, e
   * al 04/09/2026 era cablata a **una** frontiera di scrittura su sei:
   * `agent/loop.ts` la chiamava sul risultato di un tool e su nient'altro.
   * Quindi una `sk-ant-…` che l'**owner stesso** digita non passava da nessun
   * filtro e atterrava in `episodes.content` in chiaro, da dove il richiamo la
   * rimette in un prompt mesi dopo. È la forma di guasto che `AGENTS.md` nomina
   * per prima — un meccanismo che esiste e che la produzione non raggiunge.
   *
   * Sta dentro `addEpisode` e non nei quattro chiamanti (`agent/loop.ts` ×2,
   * `core/vault/vault.ts`, `agent/observe-run.ts`) perché una difesa che ogni
   * nuovo chiamante deve ricordarsi di invocare è già rotta: il quinto nascerà
   * scoperto. Questa è la porta unica per cui ogni episodio passa.
   *
   * **Costa zero, misurato sul corpus vivo dell'owner** (04/09): 1.321 righe,
   * 168.715 caratteri, **0 toccate**. Non c'è un compromesso fra questa difesa
   * e la fedeltà di ciò che Muffin ricorda.
   *
   * Il limite, detto invece che nascosto: un filtro a forma non sopravvive a
   * una Base64. Chiude l'eco **accidentale** di una credenziale, mai
   * un'esfiltrazione deliberata — per quella la difesa è la provenienza.
   */
  addEpisode(input: EpisodeInput): number {
    const stmt = this.db.prepare(
      `INSERT INTO episodes (tenant_id, connector, thread_key, actor_id, role, kind, content,
                             vault_path, media_meta, trust_tier, created_at, extraction_v, turn_id)
       VALUES (@tenantId, @connector, @threadKey, @actorId, @role, @kind, @content,
               @vaultPath, @mediaMeta, @trustTier, @createdAt, 0, @turnId)`,
    );
    const info = stmt.run({
      ...input,
      content: input.content === null ? null : redactText(input.content),
      actorId: input.actorId ?? null,
      vaultPath: input.vaultPath ?? null,
      turnId: input.turnId ?? null,
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
                created_at AS createdAt, extraction_v AS extractionV, turn_id AS turnId
         FROM episodes
         WHERE tenant_id = ? AND extraction_v < ? AND content IS NOT NULL
         ORDER BY created_at LIMIT ?`,
      )
      .all(tenantId, extractionV, limit)
      .map((riga) => {
        // La colonna torna NULL da SQLite; il tipo dice assente — la stessa
        // conversione che `episodeById` fa per `actor_id` e `vault_path`.
        const { turnId, ...resto } = riga as Episode & { turnId: string | null };
        return { ...resto, ...(turnId === null ? {} : { turnId }) };
      }) as Episode[];
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

  /**
   * The one gate for `pinned`, and it lives here rather than in the extractor
   * or the CLI, on purpose: **the model can be wrong**. `extract.ts` asks for
   * a pin on a strict, narrow vocabulary, but it reads whatever text arrived —
   * a group chat, a forwarded message, a web page — and "remember this
   * forever" is exactly the sentence a prompt injection wants to plant,
   * because a pinned fact reaches every future turn unconditionally, with no
   * similarity check standing between it and the model. Restricting the
   * *request* to `trustTier === 0` (owner-tier evidence) and `origin ===
   * 'said'` (something someone actually said, never an inference) at the one
   * place every fact write passes through means a caller proposing `pinned`
   * on tainted input is silently corrected here, not trusted to have checked
   * already. `muffin memory pin` does not go through this path — it calls
   * `setPinned` directly on an existing row, which is the CLI's own,
   * always-honoured channel: typing at a terminal on the owner's own machine
   * *is* the trust tier this gate is checking for.
   */
  addFact(input: FactInput): number {
    const pinned = input.pinned === true && input.trustTier === 0 && (input.origin ?? 'said') === 'said';
    const info = this.db
      .prepare(
        `INSERT INTO facts (tenant_id, subject_id, predicate, object_id, object_value,
                            valid_from, valid_to, recorded_at, episode_id, speaker_id,
                            trust_tier, confidence, origin, importance, pinned, extraction_v)
         VALUES (@tenantId, @subjectId, @predicate, @objectId, @objectValue,
                 @validFrom, @validTo, @recordedAt, @episodeId, @speakerId,
                 @trustTier, @confidence, @origin, @importance, @pinned, @extractionV)`,
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
        // better-sqlite3 cannot bind a JS boolean; SQLite has no boolean type
        // to bind it to either, which is the same fact `Fact.pinned` reading
        // back as 0/1 rather than `boolean` is documenting.
        pinned: pinned ? 1 : 0,
      });
    return Number(info.lastInsertRowid);
  }

  /**
   * The CLI's own channel, always honoured — no trust-tier gate, because
   * typing `muffin memory pin <id>` at a terminal on the owner's own machine
   * is what `addFact`'s gate is checking *for*: there is no more-trusted
   * source than that to defer to. Also how a pinned fact's status is meant to
   * carry forward onto its successor when the owner corrects a pinned belief
   * (`ingest.ts`'s `reconcile`, gated there on the *new* fact's own trust tier
   * before calling this — this method itself does not re-check, the same
   * division of labour `supersede` already has with its callers).
   *
   * Returns whether a row actually changed, the same `changes`-based shape
   * `JobStore.disable` uses, so a caller can tell "no such fact for this
   * tenant" from "already in that state".
   */
  setPinned(tenantId: string, factId: number, pinned: boolean): boolean {
    const info = this.db
      .prepare(`UPDATE facts SET pinned = ? WHERE id = ? AND tenant_id = ?`)
      .run(pinned ? 1 : 0, factId, tenantId);
    return info.changes > 0;
  }

  /**
   * The nucleus: active, pinned facts for this tenant, newest first — the
   * same ordering `activeFacts` uses, for the same reason (recall's budget
   * cut keeps the most recent when there are more than it can show).
   *
   * `expired_at IS NULL` is not an afterthought: a fact that was pinned and
   * has since been superseded or retired must not keep reaching every future
   * turn just because nobody unpinned it by hand first — otherwise correcting
   * a pinned belief (a new name, a new preference) would leave the *old* one
   * cemented in context forever, the opposite of what recall already does for
   * every other fact. `recall.ts` is the one caller, and it is the only
   * caller allowed to skip a relevance check against this list.
   */
  pinnedFacts(tenantId: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.pinned = 1 AND f.expired_at IS NULL
         ORDER BY f.recorded_at DESC`,
      )
      .all(tenantId) as Fact[];
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
   * Retire beliefs **without** a successor — the owner said «dimentica X».
   *
   * Same columns `supersede` closes (`expired_at`, `valid_to`), no
   * `superseded_by`, and `retired_reason` says which request did it, so
   * `muffin memory why` and `--history` can show a retirement instead of a
   * fact that silently stopped being true. Nothing is deleted: the row, its
   * episode and its provenance stay (ADR-0051, #481). Only active facts of
   * this tenant move; the ids that actually changed come back, so a caller
   * cannot confirm a retirement that did not happen.
   */
  retireFacts(tenantId: string, factIds: number[], at: string, reason: string): number[] {
    const stmt = this.db.prepare(
      `UPDATE facts SET expired_at = ?, valid_to = COALESCE(valid_to, ?), retired_reason = ?
       WHERE id = ? AND tenant_id = ? AND expired_at IS NULL`,
    );
    const retired: number[] = [];
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) {
        if (stmt.run(at, at, reason, id, tenantId).changes > 0) retired.push(id);
      }
    });
    tx(factIds);
    return retired;
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
   * spinge*. See `docs/evidence/memory-salience-and-fusion.md` and
   * `knowledge/01-understanding.md`.
   */
  activeFacts(tenantId: string, subjectId: number, predicate?: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
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
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
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
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
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

  /**
   * The facts that were in force at one instant — the graph as it stood then.
   *
   * `activeFacts` has a hardcoded "now" in it: `expired_at IS NULL` means "as
   * of this moment". This method is that same query with the moment made a
   * parameter, which is the whole of what `asOf` is: not a new kind of query,
   * the removal of a constant nobody could reach.
   *
   * A fact has two windows and only one of them is total:
   *
   *   belief  [recorded_at, expired_at)   `recorded_at` is NOT NULL, so this
   *                                        window is always decidable
   *   world   [valid_from, valid_to)       both nullable, and NULL means
   *                                        **nobody said**, never ±infinity
   *
   * A fact is returned when either window contains `at`. The second disjunct
   * requires **at least one stated bound**, and that requirement is the whole
   * defence: without it every fact with two NULL world bounds would match every
   * instant in history, and "who was my contact in May" would answer with
   * today's contact — which is the exact defect this exists to fix, arriving by
   * a different door.
   *
   * What the second disjunct buys, concretely. The owner says in June "Anna is
   * my contact", and in August "now it's Bruno". `supersede` closes Anna's
   * world time at August. Asked about May:
   *
   *   Anna   believed June→August, so the belief window misses May; but the
   *          world window is (unknown, August) and August > May, so she is
   *          returned — we do not know when she started, and we do know she had
   *          not stopped.
   *   Bruno  believed from August (misses May) and no stated world bound at
   *          all, so neither disjunct fires. He is not the answer to May, and
   *          answering "Bruno" is precisely the silent wrong answer.
   *
   * Anna's inclusion is an inference — one bound is unknown — but it is bounded
   * by a `valid_to` that was really recorded, never by a timestamp invented
   * here. `schema.ts` forbids guessing `valid_from`; this does not guess it, it
   * declines to let an unknown bound exclude.
   *
   * Ordered newest-first like `activeFacts`, so `selectForExpansion`'s
   * assumption holds for whichever of the three methods recall passes it.
   */
  factsAsOf(tenantId: string, subjectId: number, at: string, predicate?: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.subject_id = ?
           AND (? IS NULL OR f.predicate = ?)
           AND (
             (f.recorded_at <= ? AND (f.expired_at IS NULL OR f.expired_at > ?))
             OR (
               (f.valid_from IS NOT NULL OR f.valid_to IS NOT NULL)
               AND (f.valid_from IS NULL OR f.valid_from <= ?)
               AND (f.valid_to   IS NULL OR f.valid_to   >  ?)
             )
           )
         ORDER BY f.recorded_at DESC`,
      )
      .all(tenantId, subjectId, predicate ?? null, predicate ?? null, at, at, at, at) as Fact[];
  }

  /**
   * The nearest thing the graph has to an answer at `at`, when it has none.
   *
   * Read only after `factsAsOf` came back empty for an entity recall had
   * matched. Returning nothing at all would leave the caller unable to tell
   * "this entity is unknown" from "this entity is known and the question is
   * outside everything on record", and only the second one has an honest
   * sentence to say: *the earliest I have is from June*.
   */
  nearestFactTo(tenantId: string, subjectId: number, at: string): Fact | null {
    const row = this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.subject_id = ?
         ORDER BY abs(julianday(f.recorded_at) - julianday(?)) LIMIT 1`,
      )
      .get(tenantId, subjectId, at) as Fact | undefined;
    return row ?? null;
  }

  /** Includes retired beliefs, for "what did I think then" questions. */
  factHistory(tenantId: string, subjectId: number, predicate: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.subject_id = ? AND f.predicate = ?
         ORDER BY f.recorded_at`,
      )
      .all(tenantId, subjectId, predicate) as Fact[];
  }

  /**
   * Where an episode was learned and when — everything but its text.
   *
   * `connector` and `threadKey` come back because recall needs them for two
   * things it could not do without them: label a hit with the surface it came
   * from, and ask for its neighbourhood, which is scoped to its own thread.
   */
  episodeWindow(tenantId: string, episodeId: number): { connector: string; threadKey: string; createdAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT connector, thread_key AS threadKey, created_at AS createdAt
         FROM episodes WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, episodeId) as { connector: string; threadKey: string; createdAt: string } | undefined;
    return row ?? null;
  }

  /** Full-text over evidence. Never crosses a tenant, whatever the query says. */
  searchEpisodes(
    tenantId: string,
    query: string,
    limit = 10,
    filter: EpisodeFilter = {},
  ): EpisodeHit[] {
    const cleaned = query.replace(/["'()]/g, ' ').trim();
    if (cleaned === '') return [];
    // Interpolato e non legato perche SQLite non lega una lista: i valori
    // restano parametri (`?`), solo il *numero* di segnaposto entra nel testo.
    const esclusi = filter.excludeTurnIds ?? [];
    const buco = esclusi.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT e.id, e.content, e.created_at AS createdAt, e.trust_tier AS trustTier,
                e.connector, e.thread_key AS threadKey, e.superseded_at AS supersededAt,
                e.turn_id AS turnId
         FROM episodes_fts f
         JOIN episodes e ON e.id = f.rowid
         WHERE episodes_fts MATCH ? AND e.tenant_id = ?
           ${esclusi.length === 0 ? '' : `AND (e.turn_id IS NULL OR e.turn_id NOT IN (${buco}))`}
           -- The other half of the history mode, and the one still missing.
           -- A vault note edited in June and a message withdrawn keep their old
           -- text on record precisely so "what did that note say in May" stays
           -- answerable -- and this filter, unconditional until now, was the
           -- reason no path could ever ask it. Retiring evidence stopped it
           -- being recalled by default, which is right; it must not also make
           -- it unreachable, which is a delete wearing a different word.
           AND (? = 1 OR e.superseded_at IS NULL)
           AND (? IS NULL OR e.connector = ?)
           AND (? IS NULL OR e.created_at >= ?)
           AND (? IS NULL OR e.created_at <= ?)
         ORDER BY rank LIMIT ?`,
      )
      .all(
        cleaned.split(/\s+/).map((t) => `"${t}"`).join(' OR '),
        tenantId,
        ...esclusi,
        filter.includeSuperseded ? 1 : 0,
        filter.surface ?? null,
        filter.surface ?? null,
        filter.since ?? null,
        filter.since ?? null,
        filter.until ?? null,
        filter.until ?? null,
        limit,
      ) as EpisodeHit[];
  }

  /**
   * The K episodes before and the K after one episode, inside its own thread.
   *
   * The second navigation primitive of `02-ontologia.md` §9, and the argument
   * there is why it is not a convenience: *"senza intorno, un episodio ripescato
   * è una frase tagliata, e ciò che un modello fa più facilmente con una frase
   * tagliata è completarne il contesto da sé"*. The fence tells the model to use
   * a recalled line if it is relevant; nothing tells it that the line had a
   * before and an after that were withheld.
   *
   * Scoped to `(connector, thread_key)` and never to the whole tenant: the
   * episodes adjacent *in time* across every surface at once are not a context,
   * they are an interleaving of unrelated conversations.
   *
   * Each row keeps its own `trust_tier`, which is what makes the taint rule of
   * that section hold without a special case here — the caller turns every
   * neighbour into an item of its own and `recallTaint` already takes the
   * maximum, so a window that reaches into a group raises the turn's taint to
   * the group's tier. Collapsing the window into the anchor's tier is the
   * defect that rule exists to name.
   */
  episodeNeighbourhood(
    tenantId: string,
    episodeId: number,
    k: number,
    includeSuperseded = false,
    excludeTurnIds: readonly string[] = [],
  ): EpisodeHit[] {
    if (k <= 0) return [];
    const anchor = this.episodeWindow(tenantId, episodeId);
    if (!anchor) return [];
    // Dentro la query e non a valle, per la stessa ragione della porta
    // testuale: `k` righe escluse dopo sono `k` vicini che non arrivano.
    const buco = excludeTurnIds.map(() => '?').join(',');
    const sql = (comparison: string, order: string): string =>
      `SELECT e.id, e.content, e.created_at AS createdAt, e.trust_tier AS trustTier,
              e.connector, e.thread_key AS threadKey, e.superseded_at AS supersededAt,
              e.turn_id AS turnId
       FROM episodes e
       WHERE e.tenant_id = ? AND e.connector = ? AND e.thread_key = ?
         AND e.content IS NOT NULL
         AND (? = 1 OR e.superseded_at IS NULL)
         ${excludeTurnIds.length === 0 ? '' : `AND (e.turn_id IS NULL OR e.turn_id NOT IN (${buco}))`}
         -- Ordered by (created_at, id) rather than created_at alone: several
         -- episodes of one turn share a timestamp to the second, and a tie
         -- broken arbitrarily would let the same row land on both sides of the
         -- anchor, or on neither.
         AND (e.created_at, e.id) ${comparison} (?, ?)
       ORDER BY e.created_at ${order}, e.id ${order} LIMIT ?`;
    const bind = (comparison: string, order: string): EpisodeHit[] =>
      this.db
        .prepare(sql(comparison, order))
        .all(
          tenantId,
          anchor.connector,
          anchor.threadKey,
          includeSuperseded ? 1 : 0,
          ...excludeTurnIds,
          anchor.createdAt,
          episodeId,
          k,
        ) as EpisodeHit[];
    // Read outward from the anchor in both directions, then handed back in
    // reading order — the point of a neighbourhood is that it reads as the
    // conversation it was.
    return [...bind('<', 'DESC').reverse(), ...bind('>', 'ASC')];
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
   *
   * `connector` and `supersededAt` exist for the same reason `trust_tier` does:
   * the semantic half is the other place a retired episode can surface, and
   * before these two fields it had no way to know it was retired at all — a
   * withdrawn message or an edited vault note, once embedded, kept matching by
   * meaning forever, unmarked, in the one recall path `--history` was never
   * wired to. `searchEpisodes` (the text half) always had `superseded_at` to
   * read; the vector half had nothing, which is the same "declared and
   * connected to nothing" shape as the tier bug this method already fixed once.
   */
  provenanceOf(
    tenantId: string,
    kind: 'episode' | 'fact',
    sourceId: number,
  ): {
    trustTier: TrustTier;
    createdAt: string;
    origin?: FactOrigin;
    connector?: string;
    supersededAt?: string | null;
    /**
     * Presente solo per un episodio. La meta semantica del recall legge da qui
     * o da nessuna parte: l'indice vettoriale tiene testo e un id sorgente, e
     * senza questa colonna la porta vettoriale non puo rispettare un'esclusione
     * che quella testuale rispetta — cioe una garanzia che si legge assoluta e
     * vale per una via su due.
     */
    turnId?: string | null;
  } | null {
    const row =
      kind === 'episode'
        ? (this.db
            .prepare(
              `SELECT trust_tier AS trustTier, created_at AS createdAt, connector,
                      superseded_at AS supersededAt, turn_id AS turnId
               FROM episodes WHERE tenant_id = ? AND id = ?`,
            )
            .get(tenantId, sourceId) as
            | {
                trustTier: TrustTier;
                createdAt: string;
                connector: string;
                supersededAt: string | null;
                turnId: string | null;
              }
            | undefined)
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
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
                f.superseded_by AS supersededBy, f.retired_reason AS retiredReason
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
                created_at AS createdAt, extraction_v AS extractionV, turn_id AS turnId,
                undone_at AS undoneAt
         FROM episodes WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, id) as
      | (Episode & { actorId: number | null; vaultPath: string | null; turnId: string | null; undoneAt: string | null })
      | undefined;
    if (!row) return null;
    // The optional columns come back NULL from SQLite; the type says absent.
    const { actorId, vaultPath, turnId, undoneAt, ...rest } = row;
    return {
      ...rest,
      ...(actorId === null ? {} : { actorId }),
      ...(vaultPath === null ? {} : { vaultPath }),
      ...(turnId === null ? {} : { turnId }),
      ...(undoneAt === null ? {} : { undoneAt }),
    };
  }

  /**
   * D11's memory half: the same instant the calling turn's `undo_at` and
   * `episodes.undone_at` mark, applied to every un-undone `role: 'agent'`
   * episode this turn produced.
   *
   * `role: 'agent'` only — see the field's own comment on `RecallItem` in
   * `recall.ts`: marking the owner's own request as undone would be a lie in
   * the other direction, and a `tool`/`system` episode is not a claim anyone
   * could act on. `undone_at IS NULL` in the `WHERE` makes a second undo of
   * the same turn (unreachable today — `cli/undo.ts` forgets the journal
   * entry on success — but not a call this method should assume) a no-op
   * instead of overwriting the first timestamp.
   *
   * Returns how many rows it actually marked, so the caller can tell "this
   * turn wrote no memory" from "the marking silently missed".
   */
  markEpisodesUndone(tenantId: string, turnId: string, at: string): number {
    const info = this.db
      .prepare(
        `UPDATE episodes SET undone_at = @at
         WHERE tenant_id = @tenantId AND turn_id = @turnId AND role = 'agent' AND undone_at IS NULL`,
      )
      .run({ tenantId, turnId, at });
    return info.changes;
  }

  /** Which facts a given episode produced — the other direction of provenance. */
  factsFromEpisode(tenantId: string, episodeId: number): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.episode_id = ?
         ORDER BY f.id`,
      )
      .all(tenantId, episodeId) as Fact[];
  }

  /**
   * The other direction of `supersededBy`: which facts this one replaced.
   *
   * Moved out of `cli/memory.ts`'s `cmdMemoryWhy`, where it was a raw
   * `db.prepare` call reaching past the store — the one query in that
   * function that was not tenant-scoped through a method here, which is
   * exactly the shape this file's own docstring (`WHERE` filtered "at the
   * least careful query") warns about. `agent/tools/memory.ts`'s `memory_why`
   * needs the identical rows and would otherwise have had to repeat the same
   * raw SQL a second time, on a `Database` handle it does not hold.
   */
  factsSupersededBy(tenantId: string, factId: number): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence, f.origin, f.importance, f.pinned,
                f.superseded_by AS supersededBy
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.superseded_by = ?
         ORDER BY f.id`,
      )
      .all(tenantId, factId) as Fact[];
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
