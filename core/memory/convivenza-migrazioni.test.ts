import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { VectorIndex } from './vectors.js';
import { MemoryStore } from './store.js';
import { MEMORY_SCHEMA } from './schema.js';
import type { Embedder } from './embed.js';

const finto = (id: string, dimensions: number): Embedder => ({
  id,
  dimensions,
  embed: async (texts) => texts.map(() => new Float32Array(dimensions).fill(0.1)),
});

const conta = (db: DatabaseCtor.Database, t: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;

const colonne = (db: DatabaseCtor.Database, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);

/** Un DB **vecchio**: schema senza `turn_id`, episodi veri, chunks + chunks_vec a 8 dimensioni. */
function dbVecchio(): DatabaseCtor.Database {
  const db = new DatabaseCtor(':memory:');
  // MEMORY_SCHEMA di oggi porta turn_id: lo tolgo per simulare il disco di ieri.
  db.exec(MEMORY_SCHEMA);
  db.exec(`ALTER TABLE episodes DROP COLUMN turn_id`);
  const ins = db.prepare(
    `INSERT INTO episodes (tenant_id, connector, thread_key, role, kind, content, trust_tier, created_at, extraction_v)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 5; i += 1)
    ins.run('host', 'cli', 't1', i % 2 === 0 ? 'user' : 'agent', 'message', `frase ${i}`, 0, '2026-08-27', 0);
  // Indice vettoriale a 8 dimensioni, popolato, come lo lascerebbe l'embedder di ieri.
  new VectorIndex(db, finto('vecchio', 8));
  return db;
}

/**
 * Due migrazioni additive sullo stesso `memory.db`, arrivate da due slice
 * diverse nella stessa settimana, e nessuna delle due sa dell'altra.
 *
 * `VectorIndex` (embedder configurabile) fa `DROP TABLE chunks_vec` +
 * `DELETE FROM chunks` quando la dimensione sul disco non è più quella
 * dell'embedder di adesso. `MemoryStore` (giunzione turno→episodio) fa
 * `ALTER TABLE episodes ADD COLUMN turn_id`. Girano entrambe in un
 * costruttore, su un database che l'owner ha già popolato, e l'ordine fra le
 * due non è dichiarato da nessuna parte: dipende da quale store il chiamante
 * apre per primo.
 *
 * La domanda che questo file tiene aperta non è se compilino insieme, ma se
 * il reset dell'indice porti via qualcosa che la colonna nuova ha appena
 * scritto — o viceversa. Le due tabelle non hanno vincoli fra loro, quindi la
 * risposta *dovrebbe* essere no; ma «dovrebbe» non è una misura, e il costo di
 * sbagliarsi è la memoria dell'owner.
 */
describe('convivenza fra il reset dell indice vettoriale e la colonna episodes.turn_id', () => {
  it('vettori prima, colonna poi: gli episodi restano, turn_id arriva, chunks_vec e chunks si azzerano', async () => {
    const db = dbVecchio();
    const idx8 = new VectorIndex(db, finto('vecchio', 8));
    await idx8.index('host', idx8.indexBacklog('host'), '2026-08-27');
    const episodiPrima = conta(db, 'episodes');
    const chunksPrima = conta(db, 'chunks');
    const vecPrima = conta(db, 'chunks_vec');
    expect(colonne(db, 'episodes')).not.toContain('turn_id');
    expect(chunksPrima).toBeGreaterThan(0);
    expect(vecPrima).toBeGreaterThan(0);

    // #185 gira per primo: DROP chunks_vec + DELETE chunks.
    new VectorIndex(db, finto('nuovo', 16));
    // poi il costruttore di questa slice: ALTER TABLE episodes ADD turn_id.
    new MemoryStore(db);

    expect(conta(db, 'episodes')).toBe(episodiPrima);
    expect(colonne(db, 'episodes')).toContain('turn_id');
    // eslint-disable-next-line no-console
    console.log(
      `ORDINE A · episodes ${episodiPrima}->${conta(db, 'episodes')} · chunks ${chunksPrima}->${conta(db, 'chunks')} · chunks_vec ${vecPrima}->${conta(db, 'chunks_vec')}`,
    );
    db.close();
  });

  it('colonna prima, vettori poi: stesso esito, e i turn_id scritti sopravvivono al DROP+DELETE', async () => {
    const db = dbVecchio();
    const idx8 = new VectorIndex(db, finto('vecchio', 8));
    await idx8.index('host', idx8.indexBacklog('host'), '2026-08-27');
    const chunksPrima = conta(db, 'chunks');
    const vecPrima = conta(db, 'chunks_vec');

    // questa slice per prima
    new MemoryStore(db);
    db.prepare(`UPDATE episodes SET turn_id = 'T-42' WHERE id % 2 = 1`).run();
    const conTurno = (db.prepare(`SELECT count(*) AS n FROM episodes WHERE turn_id = 'T-42'`).get() as { n: number })
      .n;
    expect(conTurno).toBeGreaterThan(0);

    // poi #185
    new VectorIndex(db, finto('nuovo', 16));

    const dopo = (db.prepare(`SELECT count(*) AS n FROM episodes WHERE turn_id = 'T-42'`).get() as { n: number }).n;
    expect(dopo).toBe(conTurno);
    expect(conta(db, 'episodes')).toBe(5);
    // eslint-disable-next-line no-console
    console.log(
      `ORDINE B · episodes 5->${conta(db, 'episodes')} · turn_id='T-42' ${conTurno}->${dopo} · chunks ${chunksPrima}->${conta(db, 'chunks')} · chunks_vec ${vecPrima}->${conta(db, 'chunks_vec')}`,
    );
    db.close();
  });

  it('dopo i due reset il backlog riparte e reindicizza tutti gli episodi, turn_id compreso', async () => {
    const db = dbVecchio();
    const idx8 = new VectorIndex(db, finto('vecchio', 8));
    await idx8.index('host', idx8.indexBacklog('host'), '2026-08-27');
    new MemoryStore(db);
    db.prepare(`UPDATE episodes SET turn_id = 'T-42' WHERE id % 2 = 1`).run();
    const idx16 = new VectorIndex(db, finto('nuovo', 16));
    const scritti = await idx16.index('host', idx16.indexBacklog('host'), '2026-08-27');
    // eslint-disable-next-line no-console
    console.log(
      `RIPARTENZA · index() ha scritto ${scritti} · chunks ${conta(db, 'chunks')} · chunks_vec ${conta(db, 'chunks_vec')} · episodes ${conta(db, 'episodes')}`,
    );
    expect(scritti).toBe(5);
    expect(conta(db, 'chunks_vec')).toBe(5);
    db.close();
  });

  it('ensureColumn su turn_id non salta se un altro processo ha già fatto l ALTER fra la PRAGMA e l ALTER', () => {
    const db = dbVecchio();
    // simula la gara: la colonna compare fra le due istruzioni di ensureColumn
    db.exec(`ALTER TABLE episodes ADD COLUMN turn_id TEXT`);
    expect(() => new MemoryStore(db)).not.toThrow();
    expect(colonne(db, 'episodes')).toContain('turn_id');
    db.close();
  });
});
