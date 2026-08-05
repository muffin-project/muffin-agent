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
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${this.dimensions}])`);
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
    const insertVector = this.db.prepare(`INSERT INTO chunks_vec(rowid, embedding) VALUES (:id, :emb)`);

    const tx = this.db.transaction(() => {
      for (const [i, entry] of fresh.entries()) {
        const info = insertChunk.run(tenantId, entry.kind, entry.sourceId, entry.text, this.embedder.id, now);
        // BigInt, not Number: vec0 rejects the latter outright.
        insertVector.run({ id: BigInt(info.lastInsertRowid), emb: toVectorBlob(vectors[i]!) });
      }
    });
    tx();
    return fresh.length;
  }

  /** k-nearest neighbours, then filtered to the tenant. Never across tenants. */
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
         WHERE v.embedding MATCH :emb AND k = :k AND c.tenant_id = :tenant
         ORDER BY v.distance`,
      )
      .all({ emb: toVectorBlob(vector), k: limit * 4, tenant: tenantId }) as {
      chunkId: number;
      kind: ChunkSource;
      sourceId: number;
      text: string;
      distance: number;
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
