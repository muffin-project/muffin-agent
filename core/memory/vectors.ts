import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { toVectorBlob, type Embedder } from './embed.js';

/**
 * The vector side of recall.
 *
 * One detail here is load-bearing and cost the previous system weeks of silent
 * damage: **vec0 requires a BigInt rowid**. Passing a plain JavaScript number
 * throws on insert, and if that throw is swallowed anywhere the vector tables
 * stay empty while every other part of the system reports success — recall just
 * quietly gets worse. `indexedCount()` exists so a health check can assert the
 * rows are actually there, and the tests assert it too.
 */

export type ChunkSource = 'episode' | 'fact';

export const CHUNKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT    NOT NULL,
  source_kind   TEXT    NOT NULL CHECK (source_kind IN ('episode','fact')),
  source_id     INTEGER NOT NULL,
  text          TEXT    NOT NULL,
  embedding_v   TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  UNIQUE(tenant_id, source_kind, source_id, embedding_v)
);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON chunks(tenant_id, source_kind);
`;

export class VectorIndex {
  private readonly dimensions: number;

  constructor(
    private readonly db: Database.Database,
    private readonly embedder: Embedder,
  ) {
    sqliteVec.load(db);
    this.dimensions = embedder.dimensions;
    db.exec(CHUNKS_SCHEMA);
    // The dimension is baked into the table, so a change of embedder means a
    // new version and a re-index — never a silent mix of incompatible vectors.
    //
    // `tenant_id` is a **partition key**, which is the whole point: it moves the
    // tenant filter inside the index. Before this the search took k nearest
    // neighbours globally and filtered afterwards, so a tenant with more chunks
    // near the query pushed the others out of the k window entirely — and the
    // owner's semantic recall returned nothing while reporting no error. It did
    // not need an attacker, only a talkative group.
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
         tenant_id TEXT PARTITION KEY,
         embedding float[${this.dimensions}]
       )`,
    );
    this.migrateUnpartitioned();
  }

  /**
   * Moves an unpartitioned `chunks_vec` to the partitioned shape.
   *
   * The vectors are read back out and re-inserted rather than recomputed: this
   * table is derived, but "derived" is not a licence to make the owner pay for
   * an embedding run to fix a schema decision of ours. Migrations preserve data.
   */
  private migrateUnpartitioned(): void {
    const columns = this.db.prepare(`PRAGMA table_info(chunks_vec)`).all() as { name: string }[];
    if (columns.some((c) => c.name === 'tenant_id')) return;

    const rows = this.db.prepare(`SELECT rowid, embedding FROM chunks_vec`).all() as {
      rowid: number;
      embedding: Buffer;
    }[];
    const tenantOf = this.db.prepare(`SELECT tenant_id AS t FROM chunks WHERE id = ?`);

    // Drop, then create — verified, and not the obvious order. `ALTER TABLE
    // ... RENAME` on a vec0 table renames *only* the main table and leaves its
    // shadow tables (`chunks_vec_info`, `_chunks`, `_rowids`, …) under the old
    // name; creating the new table then collides with them, and dropping the
    // renamed one fails outright with "SQL logic error". `DROP` while the name
    // still matches its shadows removes all of them cleanly. The vectors are
    // already in hand at this point, so there is nothing to lose in between.
    const tx = this.db.transaction(() => {
      this.db.exec(`DROP TABLE chunks_vec`);
      this.db.exec(
        `CREATE VIRTUAL TABLE chunks_vec USING vec0(
           tenant_id TEXT PARTITION KEY,
           embedding float[${this.dimensions}]
         )`,
      );
      const insert = this.db.prepare(
        `INSERT INTO chunks_vec(rowid, tenant_id, embedding) VALUES (:id, :tenant, :emb)`,
      );
      for (const row of rows) {
        const owner = tenantOf.get(row.rowid) as { t: string } | undefined;
        // A vector whose chunk is gone has nothing to belong to; the backlog
        // will rebuild anything genuinely missing.
        if (!owner) continue;
        insert.run({ id: BigInt(row.rowid), tenant: owner.t, emb: row.embedding });
      }
    });
    tx();
  }

  async index(
    tenantId: string,
    entries: { kind: ChunkSource; sourceId: number; text: string }[],
    now: string,
  ): Promise<number> {
    const fresh = entries.filter((e) => e.text.trim().length > 0 && !this.alreadyIndexed(tenantId, e));
    if (fresh.length === 0) return 0;

    const vectors = await this.embedder.embed(fresh.map((e) => e.text));

    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (tenant_id, source_kind, source_id, text, embedding_v, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertVector = this.db.prepare(
      `INSERT INTO chunks_vec(rowid, tenant_id, embedding) VALUES (:id, :tenant, :emb)`,
    );

    const tx = this.db.transaction(() => {
      for (const [i, entry] of fresh.entries()) {
        const info = insertChunk.run(tenantId, entry.kind, entry.sourceId, entry.text, this.embedder.id, now);
        // BigInt, not Number: vec0 rejects the latter outright.
        insertVector.run({
          id: BigInt(info.lastInsertRowid),
          tenant: tenantId,
          emb: toVectorBlob(vectors[i]!),
        });
      }
    });
    tx();
    return fresh.length;
  }

  /**
   * k-nearest neighbours **within the tenant's partition**.
   *
   * The filter is a condition on the partition key, so `k` now means "k of this
   * tenant's chunks" rather than "k overall, some of which may be this
   * tenant's". That difference is the whole fix: with a post-filter, a tenant
   * holding more chunks near the query displaced the others out of the k window
   * and their semantic recall silently returned nothing.
   *
   * `k = limit * 2` rather than `* 4`: the window no longer has to be padded
   * against losses to other tenants, because there are none.
   */
  async search(
    tenantId: string,
    query: string,
    limit = 10,
  ): Promise<{ chunkId: number; kind: ChunkSource; sourceId: number; text: string; distance: number }[]> {
    const [vector] = await this.embedder.embed([query]);
    if (!vector) return [];
    return this.db
      .prepare(
        `SELECT c.id AS chunkId, c.source_kind AS kind, c.source_id AS sourceId, c.text, v.distance
         FROM chunks_vec v
         JOIN chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH :emb AND k = :k AND v.tenant_id = :tenant
         ORDER BY v.distance`,
      )
      .all({ emb: toVectorBlob(vector), k: limit * 2, tenant: tenantId }) as {
      chunkId: number;
      kind: ChunkSource;
      sourceId: number;
      text: string;
      distance: number;
    }[];
  }

  /**
   * Everything with no vector yet for the *current* embedder.
   *
   * Derived and rebuildable is only true if something can rebuild it: this is
   * that something. It is idempotent, so a failed embedding run costs a retry
   * rather than a permanently unsearchable episode, and changing embedder makes
   * the whole corpus pending again instead of silently mixing dimensions.
   *
   * Agent output is included. It is never mined for facts, but "cosa mi hai
   * detto ieri" is a real question and the answer is evidence like any other.
   */
  /**
   * Drops the vectors for one source. Legal because this table is derived: the
   * episode itself is never deleted, only its place in an index that can be
   * rebuilt from scratch at any time.
   */
  forget(tenantId: string, kind: ChunkSource, sourceIds: number[]): number {
    if (sourceIds.length === 0) return 0;
    const select = this.db.prepare(
      `SELECT id FROM chunks WHERE tenant_id = ? AND source_kind = ? AND source_id = ?`,
    );
    const dropVector = this.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`);
    const dropChunk = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    let removed = 0;
    const tx = this.db.transaction((ids: number[]) => {
      for (const sourceId of ids) {
        for (const row of select.all(tenantId, kind, sourceId) as { id: number }[]) {
          dropVector.run(BigInt(row.id));
          dropChunk.run(row.id);
          removed += 1;
        }
      }
    });
    tx(sourceIds);
    return removed;
  }

  indexBacklog(tenantId: string, limit = 200): { kind: ChunkSource; sourceId: number; text: string }[] {
    return this.db
      .prepare(
        `SELECT 'episode' AS kind, e.id AS sourceId, e.content AS text
           FROM episodes e
          WHERE e.tenant_id = :tenant AND e.content IS NOT NULL AND trim(e.content) <> ''
            AND e.superseded_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM chunks c
                             WHERE c.tenant_id = e.tenant_id AND c.source_kind = 'episode'
                               AND c.source_id = e.id AND c.embedding_v = :ev)
         UNION ALL
         SELECT 'fact' AS kind, f.id AS sourceId,
                s.name || ' ' || f.predicate || ' ' || COALESCE(f.object_value, o.name, '') AS text
           FROM facts f
           JOIN entities s ON s.id = f.subject_id
           LEFT JOIN entities o ON o.id = f.object_id
          WHERE f.tenant_id = :tenant AND f.expired_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM chunks c
                             WHERE c.tenant_id = f.tenant_id AND c.source_kind = 'fact'
                               AND c.source_id = f.id AND c.embedding_v = :ev)
         LIMIT :limit`,
      )
      .all({ tenant: tenantId, ev: this.embedder.id, limit }) as {
      kind: ChunkSource;
      sourceId: number;
      text: string;
    }[];
  }

  /** A health check can assert this is not zero — the failure that hides itself. */
  indexedCount(tenantId?: string): number {
    const row = tenantId
      ? this.db.prepare(`SELECT count(*) AS n FROM chunks WHERE tenant_id = ?`).get(tenantId)
      : this.db.prepare(`SELECT count(*) AS n FROM chunks_vec`).get();
    return (row as { n: number }).n;
  }

  private alreadyIndexed(tenantId: string, entry: { kind: ChunkSource; sourceId: number }): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM chunks WHERE tenant_id = ? AND source_kind = ? AND source_id = ? AND embedding_v = ?`,
        )
        .get(tenantId, entry.kind, entry.sourceId, this.embedder.id) !== undefined
    );
  }
}
