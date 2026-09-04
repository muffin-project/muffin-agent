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
 * Il gemello di `tool-no-progress.test.ts`, per il muro invece del giro a vuoto.
 *
 * `identicalCallsDone` (`core/turns/store.ts`) guarda solo le righe **riuscite**
 * — il taglio deciso alla PR #255, perche il corpus dogfood del 30/08/2026
 * aveva 10 errori e zero ripetuti. Riverificato il 04/09/2026 su uno snapshot
 * dal vivo del `muffin.db` dell'owner: nel frattempo il corpus e cresciuto e
 * una coppia e comparsa — stesso turno, `fs_read` sullo stesso path, stesso
 * errore «no such file», sei minuti e tre chiamate di distanza. Il buco era
 * reale, non un residuo di una misura vecchia.
 *
 * `identicalFailuresDone` lo copre con due scelte diverse dal caso riuscito,
 * ed entrambe sono qui sotto messe alla prova, non solo dichiarate:
 *
 * - **nessun gate su `progress: 'idempotent_read'`** — un fallimento non
 *   atterra mai un effetto e non fa mai passare tempo utile, quindi non serve
 *   l'opt-in che il caso riuscito richiede per distinguere una capability che
 *   ripete solo informazione da una che ripete effetto o tempo;
 * - **confronta anche il contenuto**, non solo tool+argomenti — due chiamate
 *   con lo stesso `args_digest` possono aver sbattuto contro muri diversi (un
 *   timeout, poi un permesso negato), e in quel caso la seconda e
 *   informazione nuova, non un giro a vuoto.
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

/**
 * Nessun `progress` dichiarato — deliberatamente, e' il cuore della prima
 * scelta sopra: il rilevatore del fallimento deve funzionare anche qui,
 * mentre quello del successo (`giaFatte`) su questa stessa capability non
 * direbbe niente.
 */
const ROTTA: CapabilityDecl = {
  id: 'fs.broken',
  effect: 'context',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};
/** Una seconda capability, questa si' con `progress: 'idempotent_read'` dichiarato — per provare che l'esito non dipende dal gate in nessuna delle due direzioni. */
const ROTTA_DICHIARATA: CapabilityDecl = { ...ROTTA, id: 'fs.broken.decl', progress: 'idempotent_read' };

function harness(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-failrepeat-'));
  const db = new DatabaseCtor(':memory:');
  const provider = new Scripted(script);
  const capabilities = new Map([
    [ROTTA.id, ROTTA],
    [ROTTA_DICHIARATA.id, ROTTA_DICHIARATA],
  ]);
  let chiamateRompi = 0;
  let chiamateEsplode = 0;
  // Ogni test riempie questi array: il contenuto restituito alla chiamata
  // N-esima e' `erroriRompi[N-1]` (o un errore generico se il test non lo ha
  // scritto), cosi un test puo far tornare lo stesso muro due volte o due
  // muri diversi sugli stessi argomenti, a piacere.
  const erroriRompi: string[] = [];
  const erroriDichiarata: string[] = [];
  const tools: RegisteredTool[] = [
    {
      capability: ROTTA.id,
      spec: { name: 'rompi', description: 'r', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: (args) => {
        const content = erroriRompi[chiamateRompi] ?? `errore generico ${chiamateRompi}`;
        chiamateRompi += 1;
        return { content, isError: true, tier: 0 as const };
      },
    },
    {
      capability: ROTTA_DICHIARATA.id,
      spec: { name: 'rompi_dichiarata', description: 'rd', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: (args) => {
        const content = erroriDichiarata[chiamateEsplode] ?? `errore generico ${chiamateEsplode}`;
        chiamateEsplode += 1;
        return { content, isError: true, tier: 0 as const };
      },
    },
    {
      capability: ROTTA.id,
      spec: { name: 'esplode', description: 'e', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: (): never => {
        throw new Error('crash: connessione rifiutata');
      },
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
  return { deps, turns, provider, db, chiamateRompi: () => chiamateRompi, erroriRompi, erroriDichiarata };
}

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const turno = (h: ReturnType<typeof harness>, text = 'prova due volte') => ({
  principal: owner,
  tenant: 'host',
  surface: 'cli',
  session: h.deps.sessions.open('s1'),
  text,
});

const avvisatiFallimento = (h: ReturnType<typeof harness>): string[] =>
  h.provider.visti.filter((v) => v.includes('hai gia avuto'));

describe('il muro ripetuto — quel che l avviso fa', () => {
  it('la seconda chiamata fallita identica arriva al modello con l avviso attaccato', async () => {
    const h = harness([
      chiama('c1', 'rompi', { path: 'a.md' }),
      chiama('c2', 'rompi', { path: 'a.md' }),
      answer('ok'),
    ]);
    h.erroriRompi.push('no such file: a.md', 'no such file: a.md');
    await runTurn(h.deps, turno(h));

    const avvisi = avvisatiFallimento(h);
    expect(avvisi).toHaveLength(1);
    expect(avvisi[0]).toContain('una volta');
    // Il vero errore c e' ancora: l avviso si aggiunge, non lo sostituisce.
    expect(avvisi[0]).toContain('no such file: a.md');
  });

  it('conta, invece di dire soltanto «di nuovo»', async () => {
    const h = harness([
      chiama('c1', 'rompi', { path: 'a.md' }),
      chiama('c2', 'rompi', { path: 'a.md' }),
      chiama('c3', 'rompi', { path: 'a.md' }),
      answer('ok'),
    ]);
    h.erroriRompi.push('no such file: a.md', 'no such file: a.md', 'no such file: a.md');
    await runTurn(h.deps, turno(h));
    expect(avvisatiFallimento(h).at(-1)).toContain('2 volte');
  });

  it('non nega e non salta la chiamata: il tool gira comunque, e resta un errore', async () => {
    const h = harness([
      chiama('c1', 'rompi', { path: 'a.md' }),
      chiama('c2', 'rompi', { path: 'a.md' }),
      answer('ok'),
    ]);
    h.erroriRompi.push('no such file: a.md', 'no such file: a.md');
    const esito = await runTurn(h.deps, turno(h));
    expect(h.chiamateRompi()).toBe(2);
    expect(esito.stopped).toBe('answered');
  });

  it('nessun gate: una capability senza `progress` dichiarato viene comunque avvisata sul fallimento', async () => {
    // `ROTTA` non dichiara `progress: 'idempotent_read'` — sul caso riuscito
    // (`giaFatte`) questo l avrebbe azzerata a zero. Qui no, per costruzione:
    // il fallimento non aspetta l opt-in del successo.
    const h = harness([
      chiama('c1', 'rompi', { path: 'a.md' }),
      chiama('c2', 'rompi', { path: 'a.md' }),
      answer('ok'),
    ]);
    h.erroriRompi.push('permesso negato', 'permesso negato');
    await runTurn(h.deps, turno(h));
    expect(avvisatiFallimento(h)).toHaveLength(1);
  });

  it('funziona anche su una capability che dichiara `progress: idempotent_read`', async () => {
    // Simmetria: il gate del successo non deve *impedire* l avviso del
    // fallimento su una capability che lo dichiara, tanto quanto non deve
    // *richiederlo* su una che non lo dichiara (test sopra).
    const h = harness([
      chiama('c1', 'rompi_dichiarata', { path: 'a.md' }),
      chiama('c2', 'rompi_dichiarata', { path: 'a.md' }),
      answer('ok'),
    ]);
    h.erroriDichiarata.push('permesso negato', 'permesso negato');
    await runTurn(h.deps, turno(h));
    expect(avvisatiFallimento(h)).toHaveLength(1);
  });

  it('copre anche il ramo che lancia (throw), non solo quello che ritorna isError', async () => {
    const h = harness([
      chiama('c1', 'esplode', { host: 'x' }),
      chiama('c2', 'esplode', { host: 'x' }),
      answer('ok'),
    ]);
    await runTurn(h.deps, turno(h));
    const avvisi = avvisatiFallimento(h);
    expect(avvisi).toHaveLength(1);
    expect(avvisi[0]).toContain('crash: connessione rifiutata');
  });
});

describe('il muro ripetuto — il falso positivo misurato', () => {
  it('argomenti diversi non sono una ripetizione, anche se l errore e uguale', async () => {
    const h = harness([
      chiama('c1', 'rompi', { path: 'a.md' }),
      chiama('c2', 'rompi', { path: 'b.md' }),
      answer('ok'),
    ]);
    h.erroriRompi.push('no such file', 'no such file');
    await runTurn(h.deps, turno(h));
    expect(avvisatiFallimento(h)).toHaveLength(0);
  });

  it('stessi argomenti ma cause diverse non sono una ripetizione — il muro non e lo stesso', async () => {
    // Il caso che il caso riuscito non ha: due fallimenti con lo stesso
    // `args_digest` possono venire da due muri diversi (qui: un timeout e poi
    // un permesso negato). La seconda risposta e' informazione nuova, non un
    // giro a vuoto, e non deve essere avvisata come tale.
    const h = harness([
      chiama('c1', 'rompi', { path: 'a.md' }),
      chiama('c2', 'rompi', { path: 'a.md' }),
      answer('ok'),
    ]);
    h.erroriRompi.push('timeout dopo 5000ms', 'permesso negato');
    await runTurn(h.deps, turno(h));
    expect(avvisatiFallimento(h)).toHaveLength(0);
  });

  it('la stessa chiamata fallita in un altro turno riparte da zero', async () => {
    const h = harness([
      chiama('c1', 'rompi', { path: 'a.md' }),
      answer('ok'),
      chiama('c2', 'rompi', { path: 'a.md' }),
      answer('ok'),
    ]);
    h.erroriRompi.push('no such file', 'no such file');
    await runTurn(h.deps, turno(h));
    await runTurn(h.deps, turno(h, 'e riprova'));
    expect(avvisatiFallimento(h)).toHaveLength(0);
  });
});

describe('il muro ripetuto — il registro durevole resta onesto', () => {
  it('turn_tool_calls conserva l errore vero del tool, senza l avviso dentro', async () => {
    const h = harness([
      chiama('c1', 'rompi', { path: 'a.md' }),
      chiama('c2', 'rompi', { path: 'a.md' }),
      answer('ok'),
    ]);
    h.erroriRompi.push('no such file', 'no such file');
    const esito = await runTurn(h.deps, turno(h));

    expect(avvisatiFallimento(h)).toHaveLength(1);
    const righe = h.db
      .prepare(`SELECT content, is_error FROM turn_tool_calls WHERE turn_id = ? ORDER BY started_at`)
      .all(esito.turnId) as { content: string | null; is_error: number }[];
    expect(righe).toHaveLength(2);
    for (const r of righe) {
      expect(r.is_error).toBe(1);
      expect(r.content ?? '').not.toContain('hai gia avuto');
    }
  });

  it('il conteggio e durevole, quindi sopravvive a una ripresa', async () => {
    const h = harness([chiama('c1', 'rompi', { path: 'a.md' }), answer('ok')]);
    h.erroriRompi.push('no such file');
    const finto = 'un-turno-di-prima';
    h.turns.startToolCall(finto, {
      callId: 'vecchia',
      tool: 'rompi',
      capability: ROTTA.id,
      rerunnable: true,
      args: { path: 'a.md' },
    });
    h.turns.endToolCall(finto, 'vecchia', { content: 'no such file', isError: true, tier: 0 });
    expect(h.turns.identicalFailuresDone(finto, 'rompi', { path: 'a.md' }, 'no such file')).toBe(1);
    // Contenuto diverso, stesso tool e argomenti: non e' lo stesso muro.
    expect(h.turns.identicalFailuresDone(finto, 'rompi', { path: 'a.md' }, 'permesso negato')).toBe(0);
    // Un turno diverso riparte da zero.
    expect(h.turns.identicalFailuresDone('un-altro', 'rompi', { path: 'a.md' }, 'no such file')).toBe(0);
    // Una riga riuscita non conta come fallimento, qualunque sia il contenuto.
    h.turns.startToolCall(finto, {
      callId: 'buona',
      tool: 'rompi',
      capability: ROTTA.id,
      rerunnable: true,
      args: { path: 'b.md' },
    });
    h.turns.endToolCall(finto, 'buona', { content: 'no such file', isError: false, tier: 0 });
    expect(h.turns.identicalFailuresDone(finto, 'rompi', { path: 'b.md' }, 'no such file')).toBe(0);
  });
});
