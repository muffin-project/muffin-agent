import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * Il giro a vuoto: rifare la stessa lettura e riavere la stessa risposta.
 *
 * Misurato sul `muffin.db` dell'owner il 30/08/2026. Il turno a747ae67, del
 * 28/08, ha chiamato `fs_read` con gli stessi argomenti e ha riavuto risultati
 * **byte-identici** — lunghezze 32850, 25537, 46795, 36162, due o tre volte
 * ciascuna. Cinque letture ridondanti, ~141 KB reiniettati nel contesto, 72
 * secondi, e 14 chiamate su un tetto di 15: il turno ha speso quasi tutto il
 * proprio budget per rileggere cio che aveva gia davanti.
 *
 * Cosa NON e stato osservato, e quindi non viene costruito: la ripetizione di
 * una chiamata **fallita**. In tutto il corpus ci sono 10 errori e nessuno
 * ripetuto. Resta un follow-up, non una riga di codice.
 *
 * L'avviso e solo un avviso: non nega, non approva, non tocca il taint.
 */

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });
const chiama = (id: string, name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  /** Ogni blocco che il modello ha visto, in ordine. */
  visti: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; text?: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_result' && b.content) this.visti.push(b.content);
      }
    }
    return this.script[this.i++] ?? answer('fine');
  }
}

/** Una lettura idempotente e una che non dichiara niente, per il confronto. */
const LETTURA: CapabilityDecl = {
  id: 'fs.read',
  effect: 'context',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  progress: 'idempotent_read',
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};
// Senza la chiave, non con la chiave a `undefined`: `exactOptionalPropertyTypes`
// distingue le due, e «non dichiarato» e l assenza.
const { progress: _omesso, ...SENZA } = LETTURA;
const NON_DICHIARATA: CapabilityDecl = { ...SENZA, id: 'fs.list' };

function harness(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-noprogress-'));
  const db = new DatabaseCtor(':memory:');
  const provider = new Scripted(script);
  const capabilities = new Map([
    [LETTURA.id, LETTURA],
    [NON_DICHIARATA.id, NON_DICHIARATA],
  ]);
  let letture = 0;
  const tools: RegisteredTool[] = [
    {
      capability: LETTURA.id,
      spec: { name: 'leggi', description: 'l', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: (args) => {
        letture += 1;
        return { content: `contenuto di ${JSON.stringify(args)}`, tier: 0 as const };
      },
    },
    {
      capability: NON_DICHIARATA.id,
      spec: { name: 'elenca', description: 'e', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: () => ({ content: 'un elenco', tier: 0 as const }),
    },
  ];
  const turns = new TurnStore(db);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
  };
  return { deps, turns, provider, db, letture: () => letture };
}

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const turno = (h: ReturnType<typeof harness>, text = 'leggi due volte') => ({
  principal: owner,
  tenant: 'host',
  surface: 'cli',
  session: h.deps.sessions.open('s1'),
  text,
});

const avvisati = (h: ReturnType<typeof harness>): string[] =>
  h.provider.visti.filter((v) => v.includes('hai gia chiamato'));

describe('il giro a vuoto — quel che l avviso fa', () => {
  it('la seconda lettura identica arriva al modello con l avviso attaccato', async () => {
    const h = harness([
      chiama('c1', 'leggi', { path: 'a.md' }),
      chiama('c2', 'leggi', { path: 'a.md' }),
      answer('ok'),
    ]);
    await runTurn(h.deps, turno(h));

    const avvisi = avvisati(h);
    expect(avvisi).toHaveLength(1);
    expect(avvisi[0]).toContain('una volta');
    // Il risultato vero c e ancora: l avviso si aggiunge, non sostituisce.
    expect(avvisi[0]).toContain('contenuto di');
  });

  it('conta, invece di dire soltanto «di nuovo»', async () => {
    const h = harness([
      chiama('c1', 'leggi', { path: 'a.md' }),
      chiama('c2', 'leggi', { path: 'a.md' }),
      chiama('c3', 'leggi', { path: 'a.md' }),
      answer('ok'),
    ]);
    await runTurn(h.deps, turno(h));
    expect(avvisati(h).at(-1)).toContain('2 volte');
  });

  it('non nega e non salta la chiamata: il tool gira comunque', async () => {
    // Warning-only, ed e la meta che rende questa slice sicura. Il guardrail
    // non puo diventare un rifiuto senza che questo test muoia.
    const h = harness([
      chiama('c1', 'leggi', { path: 'a.md' }),
      chiama('c2', 'leggi', { path: 'a.md' }),
      answer('ok'),
    ]);
    await runTurn(h.deps, turno(h));
    expect(h.letture()).toBe(2);
  });
});

describe('il giro a vuoto — quel che l avviso non deve fare', () => {
  it('argomenti diversi non sono una ripetizione — la misura del 28/08', async () => {
    // Sette `memory_search` con sette query diverse stampavano sette righe
    // identiche e sembravano un giro a vuoto. Non lo erano, e questo e il test
    // che impedisce di ricreare quell errore dall altro lato.
    const h = harness([
      chiama('c1', 'leggi', { path: 'a.md' }),
      chiama('c2', 'leggi', { path: 'b.md' }),
      chiama('c3', 'leggi', { path: 'c.md' }),
      answer('ok'),
    ]);
    await runTurn(h.deps, turno(h));
    expect(avvisati(h)).toHaveLength(0);
  });

  it('una capability che non lo dichiara non viene avvisata', async () => {
    // Opt-in, mai dedotto: `sys.wait` e `fs.write` sono entrambi
    // `rerunnable: true`, e su quelli una ripetizione identica e progresso o
    // effetto, non un giro a vuoto.
    const h = harness([
      chiama('c1', 'elenca', { dir: '.' }),
      chiama('c2', 'elenca', { dir: '.' }),
      answer('ok'),
    ]);
    await runTurn(h.deps, turno(h));
    expect(avvisati(h)).toHaveLength(0);
  });

  it('la stessa lettura in un altro turno riparte da zero', async () => {
    const h = harness([
      chiama('c1', 'leggi', { path: 'a.md' }),
      answer('ok'),
      chiama('c2', 'leggi', { path: 'a.md' }),
      answer('ok'),
    ]);
    await runTurn(h.deps, turno(h));
    await runTurn(h.deps, turno(h, 'e adesso rileggi'));
    // Due turni, due letture: un turno non eredita il giro a vuoto di un altro.
    expect(avvisati(h)).toHaveLength(0);
  });
});

describe('il giro a vuoto — il registro durevole resta onesto', () => {
  it('turn_tool_calls conserva quel che il tool ha detto, senza l avviso', async () => {
    const h = harness([
      chiama('c1', 'leggi', { path: 'a.md' }),
      chiama('c2', 'leggi', { path: 'a.md' }),
      answer('ok'),
    ]);
    const esito = await runTurn(h.deps, turno(h));

    // Il modello l avviso l ha visto.
    expect(avvisati(h)).toHaveLength(1);
    // La riga durevole no: e il registro di cosa il tool ha prodotto, e
    // l avviso il tool non l ha prodotto.
    const righe = h.db
      .prepare(`SELECT content FROM turn_tool_calls WHERE turn_id = ? ORDER BY started_at`)
      .all(esito.turnId) as { content: string | null }[];
    expect(righe).toHaveLength(2);
    for (const r of righe) expect(r.content ?? '').not.toContain('hai gia chiamato');
  });

  it('il conteggio e durevole, quindi sopravvive a una ripresa', async () => {
    // La ragione per cui il rilevatore legge le righe del turno invece di
    // contare in memoria attorno all invocazione: un contatore in memoria si
    // azzera alla ripresa, e un turno che si sospende in mezzo al proprio giro
    // a vuoto ricomincerebbe a contare da capo — cioe proprio dove il giro a
    // vuoto e piu lungo. Qui la prima chiamata e scritta a mano come la
    // scriverebbe un turno precedente, e la seconda deve accorgersene.
    const h = harness([chiama('c1', 'leggi', { path: 'a.md' }), answer('ok')]);
    const finto = 'un-turno-di-prima';
    h.turns.startToolCall(finto, {
      callId: 'vecchia',
      tool: 'leggi',
      capability: LETTURA.id,
      rerunnable: true,
      args: { path: 'a.md' },
    });
    h.turns.endToolCall(finto, 'vecchia', { content: 'contenuto di ieri', isError: false, tier: 0 });
    expect(h.turns.identicalCallsDone(finto, 'leggi', { path: 'a.md' })).toBe(1);
    // E lo stesso conteggio, per un turno diverso, resta zero.
    expect(h.turns.identicalCallsDone('un-altro', 'leggi', { path: 'a.md' })).toBe(0);
  });
});
