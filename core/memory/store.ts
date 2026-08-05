import type Database from 'better-sqlite3';
import { DEFAULT_FUNCTIONAL_PREDICATES, MEMORY_SCHEMA } from './schema.js';
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
};

export class MemoryStore {
  constructor(private readonly db: Database.Database) {
    db.exec(MEMORY_SCHEMA);
    const seed = db.prepare(
      `INSERT OR IGNORE INTO functional_predicates (predicate, declared_at) VALUES (?, datetime('now'))`,
    );
    for (const p of DEFAULT_FUNCTIONAL_PREDICATES) seed.run(p);
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

  markExtracted(episodeIds: number[], extractionV: number): void {
    if (episodeIds.length === 0) return;
    const stmt = this.db.prepare(`UPDATE episodes SET extraction_v = ? WHERE id = ?`);
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(extractionV, id);
    });
    tx(episodeIds);
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

  upsertEntity(tenantId: string, name: string, kind: string, recordedAt: string): number {
    const existing = this.findEntity(tenantId, name, kind);
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
                            trust_tier, confidence, extraction_v)
         VALUES (@tenantId, @subjectId, @predicate, @objectId, @objectValue,
                 @validFrom, @validTo, @recordedAt, @episodeId, @speakerId,
                 @trustTier, @confidence, @extractionV)`,
      )
      .run({
        ...input,
        objectId: input.objectId ?? null,
        objectValue: input.objectValue ?? null,
        // Never invented: a fact with no stated time keeps NULL.
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        speakerId: input.speakerId ?? null,
      });
    return Number(info.lastInsertRowid);
  }

  /**
   * Retires a fact in favour of a newer one. Both times are closed: `valid_to`
   * says when it stopped being true out there, `expired_at` when we stopped
   * believing it. Nothing is deleted, so "what did I think in May" stays
   * answerable.
   */
  supersede(oldFactId: number, newFactId: number, at: string, validTo?: string): void {
    this.db
      .prepare(
        `UPDATE facts SET expired_at = ?, superseded_by = ?, valid_to = COALESCE(valid_to, ?)
         WHERE id = ? AND expired_at IS NULL`,
      )
      .run(at, newFactId, validTo ?? at, oldFactId);
  }

  /** Current beliefs about a subject+predicate. A set unless declared functional. */
  activeFacts(tenantId: string, subjectId: number, predicate?: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.tenant_id = ? AND f.subject_id = ? AND f.expired_at IS NULL
           AND (? IS NULL OR f.predicate = ?)
         ORDER BY f.recorded_at DESC`,
      )
      .all(tenantId, subjectId, predicate ?? null, predicate ?? null) as Fact[];
  }

  /** Includes retired beliefs, for "what did I think then" questions. */
  factHistory(tenantId: string, subjectId: number, predicate: string): Fact[] {
    return this.db
      .prepare(
        `SELECT f.id, f.subject_id AS subjectId, s.name AS subjectName, f.predicate,
                f.object_value AS objectValue, f.object_id AS objectId, o.name AS objectName,
                f.valid_from AS validFrom, f.valid_to AS validTo, f.recorded_at AS recordedAt,
                f.expired_at AS expiredAt, f.episode_id AS episodeId,
                f.trust_tier AS trustTier, f.confidence
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
         WHERE episodes_fts MATCH ? AND e.tenant_id = ?
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
}
