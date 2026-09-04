import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import type { Embedder } from '../core/memory/embed.js';
import { MEMORY_SCHEMA } from '../core/memory/schema.js';
import { MemoryStore } from '../core/memory/store.js';
import { VectorIndex } from '../core/memory/vectors.js';
import { recall, type RecallDeps } from '../core/memory/recall.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * Il lineage degli episodi: `episodes.turn_id`.
 *
 * Il difetto misurato sul database dell'owner il 29/08/2026: la history
 * limitata riporta lo scambio corrente **e** il recall automatico lo ripesca,
 * quindi il modello rilegge cio che ha appena scritto come se una fonte
 * indipendente lo confermasse. `excludeEpisodeId` copriva una riga sola —
 * quella dell'owner appena scritta — e non l'episodio dell'agente dello stesso
 * turno, ne gli scambi precedenti che la finestra riporta.
 *
 * Le due proprieta che devono valere insieme, e che rendono questo un test e
 * non due:
 *
 *   uno scambio **corrente** compare una volta sola;
 *   uno scambio **vecchio** e pertinente puo ancora entrare, via memoria.
 *
 * Si esclude per lineage, mai per testo: due frasi identiche in due turni
 * diversi sono due prove diverse.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  /** Ogni prompt, separato — non concatenato: «una volta sola» e una domanda per prompt. */
  prompts: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; text?: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    const pezzi: string[] = [];
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) pezzi.push(b.text);
        if (b.type === 'tool_result' && b.content) pezzi.push(b.content);
      }
    }
    this.prompts.push(pezzi.join('\n'));
    return this.script[this.i++] ?? answer('fine');
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const decls: CapabilityDecl[] = [];
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

/**
 * Ogni testo sullo stesso vettore: qualunque domanda somiglia a qualunque
 * episodio. Non e realismo, e uno strumento — serve a far entrare una riga
 * dalla porta **semantica** quando quella testuale non la troverebbe, che e
 * l unico modo di provare che le due rispettano la stessa esclusione.
 */
class TuttoUguale implements Embedder {
  readonly id = 'tutto-uguale:v1';
  readonly dimensions = 2;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0]));
  }
}

function harness(script: ChatResult[], conVettori = false) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-lineage-'));
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const vectors = conVettori ? new VectorIndex(db, new TuttoUguale()) : undefined;
  const recallDeps: RecallDeps = { store, ...(vectors ? { vectors } : {}) };
  const provider = new Scripted(script);
  const sessions = new SessionStore(home);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools: [],
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    capabilities: new Map(decls.map((d) => [d.id, d])),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    memory: { store, recall: recallDeps },
  };
  return { deps, store, provider, sessions, recallDeps, vectors };
}

const turno = (h: ReturnType<typeof harness>, text: string, session = 's1') => ({
  principal: owner,
  tenant: 'host',
  surface: 'cli',
  session: h.sessions.open(session),
  text,
});

/** Quante volte una stringa compare in un testo. */
function volte(testo: string, ago: string): number {
  return testo.split(ago).length - 1;
}

describe('episodes.turn_id — la scrittura', () => {
  it('l episodio dell owner e quello finale dell agente portano lo stesso record.id', async () => {
    const h = harness([answer('ricevuto')]);
    const esito = await runTurn(h.deps, turno(h, 'il codice del deposito è ZK-4417'));

    const righe = h.store.pendingEpisodes('host', 1, 10);
    expect(righe.map((e) => e.role).sort()).toEqual(['agent', 'user']);
    for (const riga of righe) expect(riga.turnId).toBe(esito.turnId);
  });

  it('due turni diversi lasciano due lineage diversi, anche a parita di testo', async () => {
    // La ragione per cui l esclusione non puo essere una dedup sul testo: la
    // stessa frase in due turni e due prove, non una ripetuta.
    const h = harness([answer('ok'), answer('ok')]);
    const primo = await runTurn(h.deps, turno(h, 'la stessa identica frase'));
    const secondo = await runTurn(h.deps, turno(h, 'la stessa identica frase', 's2'));

    const lineage = h.store.pendingEpisodes('host', 1, 10)
      .filter((e) => e.role === 'user')
      .map((e) => e.turnId);
    expect(new Set(lineage).size).toBe(2);
    expect(lineage).toContain(primo.turnId);
    expect(lineage).toContain(secondo.turnId);
  });

  it('una riga scritta senza turno resta NULL, e nessuno gliene attribuisce uno', async () => {
    // Quel che il vault ingerisce e quel che `observe-run` osserva non nasce da
    // un turno. NULL e la risposta giusta, e resta ripescabile.
    const h = harness([]);
    h.store.addEpisode({
      tenantId: 'host',
      connector: 'vault',
      threadKey: 'note',
      role: 'user',
      kind: 'document',
      content: 'una nota vecchia sul deposito',
      trustTier: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const riga = h.store.pendingEpisodes('host', 1, 10)[0];
    expect(riga?.turnId).toBeUndefined();

    const trovata = await recall(h.recallDeps, 'host', 'deposito', {
      excludeTurnIds: ['un-turno-qualunque'],
    });
    expect(trovata.items.some((i) => i.kind === 'episode')).toBe(true);
  });
});

describe('recall — l esclusione per lineage', () => {
  it('non ripesca l episodio appena scritto per questo turno', async () => {
    const h = harness([answer('ricevuto')]);
    await runTurn(h.deps, turno(h, 'il codice del deposito è ZK-4417'));

    const prompt = h.provider.prompts[0] ?? '';
    // La frase dell owner e nel prompt una volta sola: come domanda. Non
    // anche dentro MEMORIA_, che e dove la ripescherebbe il recall.
    expect(volte(prompt, 'ZK-4417')).toBe(1);
  });

  it('non ripesca lo scambio del turno precedente quando la history lo riporta gia', async () => {
    const h = harness([answer('ok'), answer('è ZK-4417')]);
    await runTurn(h.deps, turno(h, 'il codice del deposito è ZK-4417'));
    await runTurn(h.deps, turno(h, 'qual era il codice del deposito?'));

    const secondo = h.provider.prompts[1] ?? '';
    // Una volta: nella history. Non due, una in history e una in MEMORIA_.
    expect(volte(secondo, 'ZK-4417')).toBe(1);
  });

  it('non ripesca nemmeno la **risposta** dell agente dello stesso scambio', async () => {
    // L altra meta dello scambio, e quella che `excludeEpisodeId` non copriva:
    // l episodio finale dell agente. Qui la domanda del secondo turno pesca
    // parole che stanno solo nella risposta del primo, non nella domanda —
    // quindi se il lineage dell agente non c e, la frase rientra da MEMORIA_.
    const h = harness([answer('il magazzino si trova a Sestu'), answer('a Sestu')]);
    await runTurn(h.deps, turno(h, 'una domanda qualunque'));
    await runTurn(h.deps, turno(h, 'dove si trova il magazzino?'));

    const secondo = h.provider.prompts[1] ?? '';
    // Una volta: nella history, come risposta dell assistente. Non due.
    expect(volte(secondo, 'il magazzino si trova a Sestu')).toBe(1);
  });

  it('uno scambio piu vecchio della finestra torna, e torna via memoria', async () => {
    // La meta che l esclusione non deve mangiare. La finestra reinietta gli
    // ultimi 40 messaggi (`MAX_HISTORY_TURNS`), cioe venti scambi: il primo
    // scambio ne esce, e da li in poi l unica via che resta e il recall.
    const h = harness(Array.from({ length: 40 }, () => answer('ok')));
    await runTurn(h.deps, turno(h, 'il codice del deposito è ZK-4417'));
    for (let i = 0; i < 21; i++) {
      await runTurn(h.deps, turno(h, `un messaggio di riempimento numero ${i}`));
    }
    await runTurn(h.deps, turno(h, 'qual era il codice del deposito?'));

    const ultimo = h.provider.prompts.at(-1) ?? '';
    expect(ultimo).toContain('ZK-4417');
    expect(ultimo).toContain('MEMORIA_');
    // Ancora una volta sola: uscito dalla finestra, rientra dalla memoria.
    expect(volte(ultimo, 'ZK-4417')).toBe(1);
  }, 60_000);
});

describe('recall — cosa l esclusione non deve toccare', () => {
  it('la porta testuale esclude dentro la query, non dopo', async () => {
    // Se il filtro fosse a valle, la riga esclusa avrebbe comunque consumato
    // uno slot di `LIMIT`: con `limit` righe escluse davanti, la riga buona non
    // arriverebbe. Questo test muore se il filtro torna a essere un post-filtro.
    const h = harness([]);
    for (let i = 0; i < 8; i++) {
      h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 's1', role: 'user', kind: 'message',
        content: `deposito rumore ${i}`, trustTier: 0,
        createdAt: `2026-08-0${i + 1}T10:00:00.000Z`, turnId: 'turno-in-history',
      });
    }
    h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 's1', role: 'user', kind: 'message',
      content: 'deposito la riga buona', trustTier: 0,
      createdAt: '2026-08-09T10:00:00.000Z', turnId: 'un-altro-turno',
    });

    const esito = await recall(h.recallDeps, 'host', 'deposito', {
      limit: 2,
      excludeTurnIds: ['turno-in-history'],
    });
    expect(esito.items.some((i) => i.text === 'deposito la riga buona')).toBe(true);
    expect(esito.items.some((i) => i.text.includes('rumore'))).toBe(false);
  });

  it('un episodio escluso non viene usato nemmeno come anchor del vicinato', async () => {
    const h = harness([]);
    // Tre righe nello stesso thread: la centrale sarebbe l anchor, le altre due
    // il suo intorno. Se l anchor viene escluso, il suo intorno non deve
    // entrare per suo tramite.
    for (const [i, testo] of ['prima riga', 'deposito la centrale', 'terza riga'].entries()) {
      h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 's1', role: 'user', kind: 'message',
        content: testo, trustTier: 0,
        createdAt: `2026-08-0${i + 1}T10:00:00.000Z`, turnId: 'turno-in-history',
      });
    }
    const esito = await recall(h.recallDeps, 'host', 'deposito', {
      neighbours: 2,
      excludeTurnIds: ['turno-in-history'],
    });
    expect(esito.items).toHaveLength(0);
  });

  it('anche la porta semantica rispetta l esclusione', async () => {
    // La porta testuale e quella vettoriale sono due vie sulla stessa lista:
    // una garanzia onorata da una sola delle due si legge assoluta e vale a
    // meta. Qui la domanda non contiene nessuna parola dell episodio, quindi
    // FTS non lo trova: se arriva, arriva dai vettori.
    const h = harness([], true);
    const escluso = h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 's1', role: 'user', kind: 'message',
      content: 'una frase che la domanda non nomina', trustTier: 0,
      createdAt: '2026-08-01T10:00:00.000Z', turnId: 'turno-in-history',
    });
    const tenuto = h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 's1', role: 'user', kind: 'message',
      content: 'un altra frase che la domanda non nomina', trustTier: 0,
      createdAt: '2026-08-02T10:00:00.000Z', turnId: 'un-altro-turno',
    });
    await h.vectors!.index('host', [
      { kind: 'episode', sourceId: escluso, text: 'una frase che la domanda non nomina' },
      { kind: 'episode', sourceId: tenuto, text: 'un altra frase che la domanda non nomina' },
    ], '2026-08-03T10:00:00.000Z');

    const esito = await recall(h.recallDeps, 'host', 'zzzz', {
      excludeTurnIds: ['turno-in-history'],
    });
    expect(esito.strategies).toContain('vector');
    const ids = esito.items.filter((i) => i.kind === 'episode').map((i) => i.id);
    expect(ids).toContain(tenuto);
    expect(ids).not.toContain(escluso);
  });

  it('un vicino di un turno escluso non arriva, nemmeno da un anchor legittimo', async () => {
    // La riga che questo test tiene viva: l esclusione passata a
    // `episodeNeighbourhood`. Il filtro dopo la fusione non la copre — gli
    // anchor si scelgono da `kept`, quindi un anchor **non** escluso puo
    // trascinare dentro i propri vicini, che escluso lo sono. E il caso vero di
    // una sessione lunga: un episodio fuori finestra fa da anchor e i suoi
    // vicini in avanti sono la finestra corrente.
    const h = harness([]);
    const righe: [string, string][] = [
      ['deposito, la riga vecchia', 'turno-vecchio'],
      ['il vicino in avanti', 'turno-in-history'],
      ['e il vicino dopo ancora', 'turno-in-history'],
    ];
    for (const [i, [contenuto, turnId]] of righe.entries()) {
      h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 's1', role: 'user', kind: 'message',
        content: contenuto, trustTier: 0,
        createdAt: `2026-08-0${i + 1}T10:00:00.000Z`, turnId,
      });
    }
    const esito = await recall(h.recallDeps, 'host', 'deposito', {
      neighbours: 2,
      excludeTurnIds: ['turno-in-history'],
    });
    // L anchor c e: e di un turno che nessuno ha escluso.
    expect(esito.items.map((i) => i.text)).toContain('deposito, la riga vecchia');
    // I suoi vicini no: sono del turno che il modello ha gia davanti.
    expect(esito.items.some((i) => i.neighbourOf !== undefined)).toBe(false);
  });

  it('un fatto derivato da un episodio escluso resta ripescabile', async () => {
    // Un fatto e una credenza, non la copia di un messaggio: vive in un altro
    // posto del prompt e non e cio che la history riporta.
    const h = harness([]);
    const episodio = h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 's1', role: 'user', kind: 'message',
      content: 'il mio commercialista è Marco, deposito', trustTier: 0,
      createdAt: '2026-08-01T10:00:00.000Z', turnId: 'turno-in-history',
    });
    // Il salto sul grafo parte dai nomi propri della domanda
    // (`extractCandidateNames`), quindi il soggetto e Marco e la domanda lo nomina.
    const soggetto = h.store.upsertEntity('host', 'Marco', 'person', '2026-08-01T10:00:00.000Z');
    h.store.addFact({
      tenantId: 'host', subjectId: soggetto, predicate: 'ruolo',
      objectValue: 'commercialista', episodeId: episodio, trustTier: 0, confidence: 0.9,
      recordedAt: '2026-08-01T10:00:00.000Z', origin: 'said', extractionV: 1,
    });

    const esito = await recall(h.recallDeps, 'host', 'Marco', {
      excludeTurnIds: ['turno-in-history'],
    });
    expect(esito.items.some((i) => i.kind === 'episode')).toBe(false);
    expect(esito.items.some((i) => i.kind === 'fact')).toBe(true);
  });

  it('lo stesso testo in un altro turno non viene escluso', async () => {
    const h = harness([]);
    for (const turnId of ['turno-in-history', 'un-altro-turno']) {
      h.store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 's1', role: 'user', kind: 'message',
        content: 'il codice del deposito è ZK-4417', trustTier: 0,
        createdAt: '2026-08-01T10:00:00.000Z', turnId,
      });
    }
    const esito = await recall(h.recallDeps, 'host', 'deposito', {
      excludeTurnIds: ['turno-in-history'],
    });
    const episodi = esito.items.filter((i) => i.kind === 'episode');
    expect(episodi).toHaveLength(1);
    expect(episodi[0]?.turnId).toBe('un-altro-turno');
  });
});

describe('la colonna su un database che esisteva prima', () => {
  it('la aggiunge nullable, senza perdere una riga e senza inventarne il turno', () => {
    // La migrazione, provata sul percorso vero: un database scritto prima che
    // la colonna esistesse, riaperto dal costruttore di `MemoryStore`.
    const db = new DatabaseCtor(':memory:');
    // Lo schema di ieri: lo stesso di oggi meno la riga della colonna.
    db.exec(MEMORY_SCHEMA.replace(/^\s*turn_id\s+TEXT,\s*$/m, ''));
    db.prepare(
      `INSERT INTO episodes (tenant_id, connector, thread_key, role, kind, content, trust_tier, created_at, extraction_v)
       VALUES ('host', 'cli', 's1', 'user', 'message', 'una riga di ieri', 0, '2026-01-01T00:00:00.000Z', 0)`,
    ).run();
    expect(
      (db.prepare(`SELECT count(*) AS n FROM pragma_table_info('episodes') WHERE name = 'turn_id'`).get() as { n: number }).n,
    ).toBe(0);

    const store = new MemoryStore(db);

    const righe = store.pendingEpisodes('host', 1, 10);
    expect(righe).toHaveLength(1);
    expect(righe[0]?.content).toBe('una riga di ieri');
    // NULL, non un turno dedotto per vicinanza di timestamp: quella riga un
    // turno esatto non l ha mai avuto, e non lo avra mai.
    expect(righe[0]?.turnId).toBeUndefined();
    // E resta ripescabile: NULL non e mai escluso.
    expect(store.searchEpisodes('host', 'riga', 10, { excludeTurnIds: ['un-turno'] })).toHaveLength(1);
  });
});
