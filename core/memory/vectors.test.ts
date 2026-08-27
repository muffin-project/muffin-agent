import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { VectorIndex } from './vectors.js';
import type { Embedder } from './embed.js';

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

const ddlDi = (db: DatabaseCtor.Database): string =>
  ((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'chunks_vec'`).get() as { sql: string }).sql ?? '')
    .replace(/\s+/g, ' ');

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

  it('non si rifà quando la dimensione è la stessa, anche cambiando modello', async () => {
    // Due modelli diversi con la stessa dimensione non giustificano di buttare
    // l'indice: `pendingFor` filtra già su `embedding_v`, quindi i vecchi
    // restano inerti e i nuovi si accumulano accanto. Rifare la tabella qui
    // costerebbe una reindicizzazione senza comprare niente.
    //
    // La prova è un **vettore vero che sopravvive**, non il conteggio delle
    // tabelle in `sqlite_master`: un DROP seguito da CREATE lascia quel
    // conteggio identico, quindi la versione che lo guardava non uccideva la
    // mutazione «rifai sempre» — misurato, sopravviveva a 4 test su 4.
    db = new DatabaseCtor(':memory:');
    const vecchio = new VectorIndex(db, finto('a', 8));
    await vecchio.index('host', [{ kind: 'episode', sourceId: 1, text: 'una frase' }], '2026-08-27');
    const prima = (db.prepare(`SELECT count(*) AS n FROM chunks_vec`).get() as { n: number }).n;
    expect(prima).toBe(1);

    new VectorIndex(db, finto('b', 8));
    const dopo = (db.prepare(`SELECT count(*) AS n FROM chunks_vec`).get() as { n: number }).n;
    expect(ddlDi(db)).toContain('float[8]');
    expect(dopo).toBe(prima);
  });

  it('dopo il cambio, indicizzare funziona invece di morire sulla dimensione', async () => {
    // La metà che rende il test sopra una prova e non un controllo sul DDL: è
    // l'inserimento che falliva, ed è l'inserimento che deve riuscire.
    db = new DatabaseCtor(':memory:');
    new VectorIndex(db, finto('a', 8));
    const nuovo = new VectorIndex(db, finto('b', 16));
    const quanti = await nuovo.index('host', [{ kind: 'episode', sourceId: 1, text: 'una frase' }], '2026-08-27');
    expect(quanti).toBe(1);
  });
});
