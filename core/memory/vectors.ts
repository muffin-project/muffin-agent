import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { toVectorBlob, type Embedder } from './embed.js';
import { requestPredicateSql } from './schema.js';

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

const CHUNKS_SCHEMA = `
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

/**
 * Le due metà del backlog: episodi vivi e fatti non scaduti che non hanno
 * ancora un vettore **per l'embedder di adesso**.
 *
 * Una funzione e non due query copiate, perché i suoi due lettori devono per
 * forza rispondere alla stessa domanda: `indexBacklog` la usa per decidere cosa
 * embeddare, `quantiNonIndicizzati` per decidere se `doctor` può dire «in
 * sync». Il giorno in cui divergono, `doctor` torna verde su una memoria a
 * metà — che è il difetto da cui nasce l'intera slice.
 *
 * Il tenant si interpola invece di legarsi: la clausola deve **sparire** dalla
 * query globale, non diventare un `:tenant IS NULL OR …` che cambia il piano
 * anche sul percorso caldo.
 *
 * Un fatto-richiesta (`asked_to`, `asks_to`, …) non entra mai in questa metà.
 * Non è un secondo filtro di fiducia: è che un fatto del genere non ha una
 * verità che regge finché qualcuno non la corregge, come `lives_in` — ha un
 * *momento*, quello del turno che l'ha prodotto, e imbeddarlo come vettore
 * indipendente lo rende pescabile per pura somiglianza semantica da qualunque
 * turno futuro somigli abbastanza nelle parole, senza nessun limite di
 * recency: la stessa richiesta esaudita l'8/27 risale su una domanda dell'8/30
 * che non la riguarda. Il grafo (recency-capped, `EXPANSION_SLOTS` in
 * `recall.ts`) e il testo dell'episodio originale restano entrambi
 * raggiungibili — è solo l'indice vettoriale *per-fatto* a scartarla. Misurato
 * in `docs/decisions/0068-una-richiesta-ha-un-momento-non-una-fiducia.md`.
 */
function sqlBacklog(perTenant: boolean): string {
  const e = perTenant ? 'e.tenant_id = :tenant AND ' : '';
  const f = perTenant ? 'f.tenant_id = :tenant AND ' : '';
  return `SELECT 'episode' AS kind, e.id AS sourceId, e.content AS text
           FROM episodes e
          WHERE ${e}e.content IS NOT NULL AND trim(e.content) <> ''
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
          WHERE ${f}f.expired_at IS NULL
            AND NOT (${requestPredicateSql('f.predicate')})
            AND NOT EXISTS (SELECT 1 FROM chunks c
                             WHERE c.tenant_id = f.tenant_id AND c.source_kind = 'fact'
                               AND c.source_id = f.id AND c.embedding_v = :ev)`;
}

/**
 * Quante sorgenti, in tutti i tenant, aspettano ancora un vettore.
 *
 * Esiste per `doctor`, e sta **fuori** dalla classe di proposito: costruire un
 * `VectorIndex` esegue il costruttore, e il costruttore può fare DROP+DELETE.
 * Un check di salute non deve poter cancellare l'indice che sta misurando.
 *
 * Serve perché contare `chunks` contro `chunks_vec` non è la stessa domanda.
 * Misurato: 250 episodi, cambio di `dimensions`, un giro di backlog ne scrive
 * 200 (`limit = 200`) — e `doctor` diceva «200 chunks, 200 vectors, in sync»
 * con **50 episodi** che il recall semantico non vedeva. Cioè, alla lettera, il
 * «55 chunks, 55 vectors, in sync: vero e fuorviante» da cui nasce la slice,
 * riprodotto dalla manopola nuova come stato normale del dopo-cambio.
 */
export function quantiNonIndicizzati(db: Database.Database, embedderId: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM (${sqlBacklog(false)})`).get({ ev: embedderId });
  return (row as { n: number }).n;
}

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
    // Chi mantiene vera quella frase è `soloLEmbedderCorrente()` qui sotto: da
    // solo, questo DDL la manteneva a metà.
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
    this.soloLEmbedderCorrente();
  }

  /** La dimensione che il DDL sul disco dichiara, o `undefined` se la tabella non c'è. */
  private dimensioneSulDisco(): number | undefined {
    const ddl = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'`)
      .get() as { sql: string | null } | undefined;
    const trovata = /embedding\s+float\[(\d+)\]/i.exec(ddl?.sql ?? '');
    return trovata === null ? undefined : Number(trovata[1]);
  }

  /**
   * L'indice tiene i vettori di **un solo** embedder: quello di adesso.
   *
   * Girare la manopola in config.json può cambiare due cose, e finora ne era
   * gestita una sola.
   *
   * **La dimensione.** La tabella vec0 nasce con la dimensione cotta dentro il
   * DDL, e la crea un `CREATE VIRTUAL TABLE IF NOT EXISTS`: cambiare embedder
   * non la cambiava, la saltava. Il codice credeva 1536, il disco restava 1024,
   * e il primo `index()` moriva con un errore di sqlite-vec che non nomina né
   * l'embedder vecchio né quello nuovo. Misurato prima di ripararlo: costruito
   * l'indice con un embedder a 8 dimensioni e poi con uno a 16, il DDL sul
   * disco restava `float[8]`.
   *
   * **L'id.** `indexBacklog` e `alreadyIndexed` filtrano su `embedding_v`,
   * cioè sull'id dell'embedder — e l'id **non porta la dimensione**:
   * `ollama:${model}`. Qui stava scritto che il backlog «li rifà, perché filtra
   * su `embedding_v`», ed era la premessa esattamente rovesciata: filtrare su
   * `embedding_v` è ciò che *impedisce* il rifacimento quando l'id non cambia.
   * Basta correggere `dimensions` a mano in config.json — o portare
   * `text-embedding-3-small` da 1536 a 512, che dell'id non cambia una lettera
   * — e il DROP porta via i vettori mentre il backlog, che vede l'id di sempre,
   * non ha più niente da rifare. Misurato prima di ripararlo, su un episodio
   * solo: `chunks 1 · chunks_vec 1` prima, `chunks 1 · chunks_vec 0` subito
   * dopo il costruttore, backlog `[]`, `index()` scrive 0, `chunks_vec` resta
   * 0. Recall semantico spento per sempre, in silenzio, con una riga di config
   * — e `doctor` rosso in permanenza («6 chunks but 3 vectors») con un rimedio
   * che drena un backlog vuoto.
   *
   * Da qui il `DELETE FROM chunks` nella stessa transazione del DROP: dopo il
   * DROP **ogni** riga di `chunks` è orfana, qualunque sia il suo
   * `embedding_v`. È legale perché `chunks` è derivata — episodi e fatti
   * restano, e `indexBacklog` la ricostruisce da quelli. Buttarla è proprio il
   * modo in cui il backlog torna a vedere del lavoro da fare.
   *
   * Il ramo a dimensione uguale è la stessa regola con meno rumore. Non è vero
   * che i vettori di un altro modello «restano inerti»: `search()` non filtra
   * su `embedding_v`, quindi occupano il budget `k` e tornano con distanze
   * calcolate contro il vettore di query di un modello diverso. Misurato con
   * due modelli a 4 dimensioni: 2 hit, quella del modello vecchio con
   * `distance 1.414`, un numero che non vuole dire niente.
   */
  private soloLEmbedderCorrente(): void {
    const suDisco = this.dimensioneSulDisco();
    if (suDisco === undefined) return;

    if (suDisco !== this.dimensions) {
      this.db.transaction(() => {
        this.db.exec(`DROP TABLE chunks_vec`);
        this.db.exec(
          `CREATE VIRTUAL TABLE chunks_vec USING vec0(
             tenant_id TEXT PARTITION KEY,
             embedding float[${this.dimensions}]
           )`,
        );
        this.db.exec(`DELETE FROM chunks`);
      })();
      return;
    }

    // Stessa dimensione, altro modello: la tabella va bene, le righe no. Le
    // righe vec0 si tolgono una per una perché il rowid è la chiave e vec0 non
    // sa fare una DELETE con sottoquery.
    const dropVector = this.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`);
    this.db.transaction(() => {
      const vecchie = this.db.prepare(`SELECT id FROM chunks WHERE embedding_v <> ?`).all(this.embedder.id) as {
        id: number;
      }[];
      if (vecchie.length === 0) return;
      for (const row of vecchie) dropVector.run(BigInt(row.id));
      this.db.prepare(`DELETE FROM chunks WHERE embedding_v <> ?`).run(this.embedder.id);
    })();
  }

  /**
   * Moves an unpartitioned `chunks_vec` to the partitioned shape.
   *
   * The vectors are read back out and re-inserted rather than recomputed: this
   * table is derived, but "derived" is not a licence to make the owner pay for
   * an embedding run to fix a schema decision of ours. Migrations preserve data.
   *
   * La tabella nuova nasce con la dimensione che era **sul disco**, non con
   * quella dell'embedder di adesso: reinserire vettori a 8 dimensioni in una
   * tabella `float[16]` fa fallire l'insert. Misurato prima di ripararlo, su un
   * DB legacy con un embedder a 16 dimensioni: `Dimension mismatch … Expected
   * 16 … received 8`, rollback, costruttore che lancia — e
   * `agent/runtime.ts:352` lo inghiotte, quindi `vectors = undefined` a ogni
   * boot, per sempre, con `doctor` verde. Il cambio di dimensione non si perde:
   * lo raccoglie `soloLEmbedderCorrente()`, che gira subito dopo ed è il posto
   * dove buttare è la cosa giusta.
   */
  private migrateUnpartitioned(): void {
    const columns = this.db.prepare(`PRAGMA table_info(chunks_vec)`).all() as { name: string }[];
    if (columns.some((c) => c.name === 'tenant_id')) return;
    const dimensioneVecchia = this.dimensioneSulDisco() ?? this.dimensions;

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
           embedding float[${dimensioneVecchia}]
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

  /**
   * Retracts the standalone vector chunk of every request-family fact
   * (`asked_to`, `asks_to`, …) that already has one — the corpus written
   * before `sqlBacklog` learned to skip that family, on any install that has
   * been consolidating since before this existed.
   *
   * Same non-destructive shape the rest of this file uses: `forget()` drops a
   * row from the *derived* `chunks`/`chunks_vec` planes only. The fact itself,
   * in `facts`, is untouched — it stays exactly as alive, and exactly as
   * gradable by `muffin memory why`, as it always was. Only its reachability
   * through one retrieval channel — direct semantic match, with no recency
   * discipline — changes. The entity graph hop and the original episode's own
   * text stay open, both still gated by `EXPANSION_SLOTS`' recency cap where
   * the graph hop applies.
   *
   * Idempotent and cheap to call on every consolidation round: the query
   * finds nothing once an install has converged, which on a tenant with no
   * pre-existing request chunks is immediately — the common case for a fresh
   * install, since `indexBacklog` never offers one a vector to begin with.
   */
  forgetRequestFacts(tenantId: string): number {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.source_id AS id
           FROM chunks c
           JOIN facts f ON f.id = c.source_id AND f.tenant_id = c.tenant_id
          WHERE c.tenant_id = ? AND c.source_kind = 'fact' AND (${requestPredicateSql('f.predicate')})`,
      )
      .all(tenantId) as { id: number }[];
    return this.forget(
      tenantId,
      'fact',
      rows.map((r) => r.id),
    );
  }

  indexBacklog(tenantId: string, limit = 200): { kind: ChunkSource; sourceId: number; text: string }[] {
    return this.db.prepare(`${sqlBacklog(true)} LIMIT :limit`).all({
      tenant: tenantId,
      ev: this.embedder.id,
      limit,
    }) as {
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
