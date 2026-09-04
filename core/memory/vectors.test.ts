import DatabaseCtor from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, describe, expect, it } from 'vitest';
import { VectorIndex } from './vectors.js';
import { MEMORY_SCHEMA } from './schema.js';
import { makeEmbedder, toVectorBlob, type Embedder } from './embed.js';
import { MemoryStore } from './store.js';

/**
 * Cambiare embedder cambia la dimensione dei vettori, e la dimensione è
 * **cotta nel DDL** della tabella vec0.
 *
 * Il commento nel costruttore prometteva «mai una mescolanza silenziosa di
 * vettori incompatibili», e la promessa era mantenuta a metà: la tabella si crea
 * con `CREATE VIRTUAL TABLE IF NOT EXISTS`, quindi al cambio di embedder non
 * cambiava — veniva saltata. Il codice credeva 1536, il disco restava 1024, e il
 * primo `index()` moriva con un errore di sqlite-vec che non nomina nessuno dei
 * due embedder.
 *
 * Misurato prima di ripararlo, costruendo l'indice con un embedder a 8
 * dimensioni e poi con uno a 16: il DDL sul disco restava `float[8]`.
 *
 * Questo file esiste perché rendere l'embedder configurabile senza chiudere
 * quel buco significherebbe spedire una manopola che rompe il recall di chi la
 * gira.
 */
const finto = (id: string, dimensions: number): Embedder => ({
  id,
  dimensions,
  embed: async (texts) => texts.map(() => new Float32Array(dimensions).fill(0.1)),
});

/** Un embedder che punta in una direzione sua: due modelli così non si somigliano. */
const versoStorto = (id: string, dimensions: number, asse: number): Embedder => ({
  id,
  dimensions,
  embed: async (texts) =>
    texts.map(() => Float32Array.from(Array.from({ length: dimensions }, (_v, j) => (j === asse ? 1 : 0)))),
});

const ddlDi = (db: DatabaseCtor.Database): string =>
  ((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'chunks_vec'`).get() as { sql: string }).sql ?? '')
    .replace(/\s+/g, ' ');

const conta = (db: DatabaseCtor.Database, tabella: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${tabella}`).get() as { n: number }).n;

/** Una memoria con episodi veri, che è l'unico stato in cui il backlog ha qualcosa da dire. */
const conEpisodi = (db: DatabaseCtor.Database, quanti: number): void => {
  db.exec(MEMORY_SCHEMA);
  const ins = db.prepare(
    `INSERT INTO episodes (tenant_id, connector, thread_key, role, kind, content, trust_tier, created_at, extraction_v)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < quanti; i += 1) ins.run('host', 'cli', 't1', 'user', 'message', `frase ${i}`, 0, '2026-08-27', 0);
};

describe('la tabella vettoriale segue l\'embedder', () => {
  let db: DatabaseCtor.Database | undefined;
  afterEach(() => db?.close());

  it('nasce con le dimensioni del suo embedder', () => {
    db = new DatabaseCtor(':memory:');
    new VectorIndex(db, finto('a', 8));
    expect(ddlDi(db)).toContain('float[8]');
  });

  it('si rifà quando l\'embedder cambia dimensione', () => {
    db = new DatabaseCtor(':memory:');
    new VectorIndex(db, finto('a', 8));
    new VectorIndex(db, finto('b', 16));
    expect(ddlDi(db)).toContain('float[16]');
  });

  it('cambiare solo `dimensions`, a id invariato, non spegne il recall per sempre', async () => {
    // Il guasto che questa manopola introduceva, e che nessun test a DB vuoto
    // può vedere. `OllamaEmbedder.id` è `ollama:${model}`: **la dimensione non
    // entra nell'id**. Correggere `dimensions` in config.json — o portare
    // `text-embedding-3-small` da 1536 a 512, che è l'uso canonico della
    // manopola — lascia l'id identico. Il DROP portava via i vettori, e
    // `indexBacklog`, che filtra proprio su `embedding_v`, non vedeva più
    // niente da rifare.
    //
    // Misurato prima di ripararlo, con questo stesso setup: `chunks 1 ·
    // chunks_vec 1` prima, `chunks 1 · chunks_vec 0` dopo il costruttore,
    // backlog `[]`, `index()` scrive 0, `chunks_vec` finale 0. Recall
    // semantico spento in permanenza, e nessun comando nel prodotto che
    // ripulisca le righe orfane.
    db = new DatabaseCtor(':memory:');
    conEpisodi(db, 1);

    const prima = makeEmbedder({ kind: 'ollama' }, () => 'sk-never-called');
    const dopo = makeEmbedder({ kind: 'ollama', dimensions: 768 }, () => 'sk-never-called');
    expect(dopo.id).toBe(prima.id); // l'id non porta la dimensione: è tutto il problema
    expect(dopo.dimensions).not.toBe(prima.dimensions);

    const vecchio = new VectorIndex(db, finto(prima.id, prima.dimensions));
    await vecchio.index('host', vecchio.indexBacklog('host'), '2026-08-27');
    expect(conta(db, 'chunks')).toBe(1);
    expect(conta(db, 'chunks_vec')).toBe(1);

    const nuovo = new VectorIndex(db, finto(dopo.id, dopo.dimensions));
    const backlog = nuovo.indexBacklog('host');
    expect(backlog).toHaveLength(1); // il backlog torna a vedere del lavoro
    await nuovo.index('host', backlog, '2026-08-27');

    expect(conta(db, 'chunks')).toBe(conta(db, 'chunks_vec'));
    expect(conta(db, 'chunks_vec')).toBe(1);
    expect(nuovo.indexBacklog('host')).toEqual([]);
  });

  it('e non lascia righe orfane, che è ciò che teneva `doctor` rosso per sempre', async () => {
    // La migrazione pubblicizzata dalla slice: ollama 1024 → openai-compat
    // 1536. Il rebuild riusciva e il recall funzionava, ma le righe `chunks`
    // del vecchio embedder restavano sul disco senza vettore. Misurato prima di
    // ripararlo: `chunks=3 vec=3` prima, `chunks=3 vec=0` dopo il costruttore,
    // `chunks=6 vec=3` dopo il drenaggio — e `doctor` che diceva «6 chunks but
    // 3 vectors: the index is out of sync», in permanenza, su
    // un'installazione sana, con il rimedio «run `muffin memory extract`» su un
    // backlog vuoto. Ogni cambio successivo aggiungeva uno strato.
    db = new DatabaseCtor(':memory:');
    conEpisodi(db, 3);

    const vecchio = new VectorIndex(db, finto('ollama:qwen3-embedding:0.6b', 1024));
    await vecchio.index('host', vecchio.indexBacklog('host'), '2026-08-27');
    expect(conta(db, 'chunks')).toBe(3);

    const nuovo = new VectorIndex(db, finto('openai-compat:text-embedding-3-small', 1536));
    await nuovo.index('host', nuovo.indexBacklog('host'), '2026-08-27');

    expect(conta(db, 'chunks')).toBe(3);
    expect(conta(db, 'chunks_vec')).toBe(3);
    expect(nuovo.indexBacklog('host')).toEqual([]);
  });

  it('a dimensione uguale butta comunque i vettori dell\'altro modello', async () => {
    // Qui stava scritto che due modelli alla stessa dimensione non
    // giustificavano di buttare l'indice, perché i vecchi «restano inerti».
    // Non restano inerti: `search()` non filtra su `embedding_v`, quindi
    // occupano il budget `k` e tornano con distanze calcolate contro il vettore
    // di query di un altro modello. Misurato con questi due embedder a 4
    // dimensioni, prima di ripararlo: 2 hit, quella del modello vecchio con
    // `distance 1.414` — un numero che non vuole dire niente.
    //
    // La reindicizzazione non è un costo nuovo: il backlog rifaceva comunque
    // ogni chunk, perché l'id era cambiato. Ciò che cambia è che le righe
    // vecchie se ne vanno invece di accumularsi accanto.
    db = new DatabaseCtor(':memory:');
    conEpisodi(db, 1);

    const a = new VectorIndex(db, versoStorto('ollama:modello-a', 4, 0));
    await a.index('host', a.indexBacklog('host'), '2026-08-27');

    const b = new VectorIndex(db, versoStorto('ollama:modello-b', 4, 1));
    await b.index('host', b.indexBacklog('host'), '2026-08-27');

    expect(ddlDi(db)).toContain('float[4]'); // la tabella non aveva motivo di cambiare
    const hits = await b.search('host', 'frase 0');
    expect(hits).toHaveLength(1);
    expect(conta(db, 'chunks')).toBe(1);
    expect(
      db.prepare(`SELECT DISTINCT embedding_v AS v FROM chunks`).all() as { v: string }[],
    ).toEqual([{ v: 'ollama:modello-b' }]);
  });

  it('dopo il cambio, indicizzare funziona invece di morire sulla dimensione', async () => {
    // La metà che rende i test sopra una prova e non un controllo sul DDL: è
    // l'inserimento che falliva, ed è l'inserimento che deve riuscire.
    db = new DatabaseCtor(':memory:');
    new VectorIndex(db, finto('a', 8));
    const nuovo = new VectorIndex(db, finto('b', 16));
    const quanti = await nuovo.index('host', [{ kind: 'episode', sourceId: 1, text: 'una frase' }], '2026-08-27');
    expect(quanti).toBe(1);
  });

  it('un DB legacy non partizionato sopravvive al cambio di dimensione', async () => {
    // Le due migrazioni si pestavano i piedi: quella non partizionata gira per
    // prima e reinseriva i vettori vecchi in una tabella creata con la
    // dimensione **nuova**. Misurato prima di ripararlo, con un embedder a 16
    // su un DB legacy a 8: `Dimension mismatch … Expected 16 … received 8`,
    // rollback, costruttore che lancia — e `agent/runtime.ts:352` lo inghiotte,
    // quindi `vectors = undefined` a ogni boot, per sempre, con `doctor` verde.
    db = new DatabaseCtor(':memory:');
    conEpisodi(db, 1);
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, source_kind TEXT NOT NULL,
        source_id INTEGER NOT NULL, text TEXT NOT NULL, embedding_v TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[8]);
    `);
    db.prepare(
      `INSERT INTO chunks (id, tenant_id, source_kind, source_id, text, embedding_v, created_at)
       VALUES (1,'host','episode',1,'frase 0','ollama:vecchio','2026-08-27')`,
    ).run();
    db.prepare(`INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)`).run(
      BigInt(1),
      toVectorBlob(new Float32Array(8).fill(0.1)),
    );

    const nuovo = new VectorIndex(db, finto('ollama:nuovo', 16));
    expect(ddlDi(db)).toContain('float[16]');
    await nuovo.index('host', nuovo.indexBacklog('host'), '2026-08-27');
    expect(conta(db, 'chunks')).toBe(conta(db, 'chunks_vec'));
    expect(conta(db, 'chunks_vec')).toBe(1);
  });
});

/**
 * A request-fact never gets its own vector.
 *
 * Measured on the owner's real database (docs/decisions/0067,
 * §"La misura, riprodotta"): 12 distinct already-answered requests from
 * 08/27–08/30 resurfaced through this exact channel — direct semantic match
 * on a standalone fact vector, with no recency discipline at all — across 9
 * of 15 representative "today" queries that shared nothing but vocabulary
 * with them. The entity graph hop (`recall.ts`, `EXPANSION_SLOTS`) already
 * caps by recency; this half of recall never did, because a fact's chunk is
 * indexed and searched with no notion of "how many other facts this subject
 * has gained since".
 */
describe('un fatto-richiesta non entra mai nell\'indice semantico', () => {
  let db: DatabaseCtor.Database | undefined;
  afterEach(() => db?.close());

  const conFatti = (): { store: MemoryStore; askId: number; lawId: number } => {
    db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const owner = store.upsertEntity('host', 'owner', 'person', '2026-08-27');
    const ep = store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'elenca i file .md della cartella corrente', trustTier: 0, createdAt: '2026-08-27',
    });
    const askId = store.addFact({
      tenantId: 'host', subjectId: owner, predicate: 'asked_to',
      objectValue: 'elenca i file .md della cartella corrente', episodeId: ep,
      trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: '2026-08-27',
    });
    const lawId = store.addFact({
      tenantId: 'host', subjectId: owner, predicate: 'lives_in', objectValue: 'Cagliari',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: '2026-08-27',
    });
    return { store, askId, lawId };
  };

  it('indexBacklog skips a request-family predicate and keeps an ordinary one', () => {
    conFatti();
    const vectors = new VectorIndex(db!, finto('fake', 4));
    const backlog = vectors.indexBacklog('host');
    const factRows = backlog.filter((b) => b.kind === 'fact');
    // Two facts on the entity, one episode: one fact-shaped candidate, not two.
    expect(factRows).toHaveLength(1);
    expect(factRows[0]!.text).toContain('lives_in');
  });

  it('every compound on the same stem is skipped too, not only the exact predicates', () => {
    conFatti();
    const store = new MemoryStore(db!);
    const owner = store.entitiesByName('host', 'owner')[0]!.id;
    const ep = store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'un saluto', trustTier: 0, createdAt: '2026-08-27',
    });
    store.addFact({
      tenantId: 'host', subjectId: owner, predicate: 'asks_to_greet', objectValue: 'salutare',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: '2026-08-27',
    });
    const vectors = new VectorIndex(db!, finto('fake', 4));
    const backlog = vectors.indexBacklog('host');
    expect(backlog.filter((b) => b.kind === 'fact' && b.text.includes('asks_to_greet'))).toHaveLength(0);
  });

  it('forgetRequestFacts retracts a chunk embedded before this policy existed, and only that one', async () => {
    const { askId, lawId } = conFatti();
    // Simulates a corpus that consolidated before `sqlBacklog` learned to skip
    // this family: both facts already have a standalone vector.
    const vectors = new VectorIndex(db!, finto('fake', 4));
    await vectors.index('host', [
      { kind: 'fact', sourceId: askId, text: 'owner asked_to elenca i file .md della cartella corrente' },
      { kind: 'fact', sourceId: lawId, text: 'owner lives_in Cagliari' },
    ], '2026-08-27');
    expect(conta(db!, 'chunks')).toBe(2);

    const removed = vectors.forgetRequestFacts('host');
    expect(removed).toBe(1);
    expect(conta(db!, 'chunks')).toBe(1);
    expect(conta(db!, 'chunks_vec')).toBe(1);
    expect(
      (db!.prepare(`SELECT source_id FROM chunks`).get() as { source_id: number }).source_id,
    ).toBe(lawId);

    // Idempotent: nothing left to retract the second time.
    expect(vectors.forgetRequestFacts('host')).toBe(0);
  });
});
