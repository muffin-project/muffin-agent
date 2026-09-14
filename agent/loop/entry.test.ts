import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import * as barrel from '../loop.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import {
  type ChatCall,
  type ChatResult,
  type Provider,
  ProviderError,
} from '../providers/types.js';

/**
 * Slice 9 (Fase A, §3) takes the ways in — `enqueueTurn`, `runTurn`,
 * `resumeTurn`, the terminal refusals and the funnel `drive()` — out of
 * `agent/loop.ts` and into `agent/loop/entry.ts`, leaving the barrel behind.
 *
 * Two properties of that split are load-bearing, and both are measured here
 * rather than described:
 *
 *  1. **The barrel still is one.** Every one of the 35 modules that import from
 *     `agent/loop.js` sees the same five values it saw before (§4 inv. 8), and
 *     the file itself declares nothing — a function that grew back in here
 *     would be a tenth of the decomposition undone in silence.
 *  2. **The `/steer` drain lives on the two roads out of `drive()`, and
 *     nowhere else.** The throw road writes the correction into the session;
 *     the return road writes it once and only once; the `aborted` road empties
 *     the door and deliberately throws the correction away, because the owner
 *     said `/stop`. `finish()` must **not** drain — it is one of the engine's
 *     return paths, so a drain there either steals the correction from the
 *     funnel or writes it against the owner's `/stop`.
 */

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const NOW = () => new Date('2026-09-05T10:00:00.000Z');
const CORREZIONE = 'no, fermati e dimmi solo il titolo';

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage,
  model: 'test-model',
});

/** Registra ogni chiamata e lascia agire l'owner *durante* la n-esima. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private i = 0;
  constructor(
    private readonly script: (ChatResult | Error)[],
    private readonly durante: (n: number) => void = () => {},
  ) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push(request);
    this.durante(this.seen.length);
    const next = this.script[this.i++] ?? this.script.at(-1);
    if (next === undefined) throw new Error('lo script è finito');
    if (next instanceof Error) throw next;
    return next;
  }
}

function world(script: (ChatResult | Error)[], durante: (n: number) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-loop-entry-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const sessions = new SessionStore(home);
  const capabilities = new Map();
  const deps: barrel.LoopDeps = {
    provider: new Scripted(script, durante),
    profile: CONSERVATIVE,
    model: 'test-model',
    tools: [],
    capabilities,
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities,
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    now: NOW,
  };
  return { deps, turns, sessions };
}

/** Quante volte esattamente quel testo compare, come stringa JSON esatta. */
const quante = (haystack: unknown, testo: string): number =>
  JSON.stringify(haystack).split(JSON.stringify(testo)).length - 1;

describe('agent/loop.ts è un barile, e niente altro', () => {
  it('espone i cinque valori pubblici che i 35 importatori vedevano prima', () => {
    expect(typeof barrel.MAX_RESUMES).toBe('number');
    expect(typeof barrel.enqueueTurn).toBe('function');
    expect(typeof barrel.denyText).toBe('function');
    expect(typeof barrel.runTurn).toBe('function');
    expect(typeof barrel.resumeTurn).toBe('function');
  });

  it('non dichiara più niente da sé: solo commento e ri-esportazioni', () => {
    const testo = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'loop.ts'),
      'utf8',
    );
    const dichiarazioni = testo
      .split('\n')
      .filter((riga) =>
        /^(export )?(async )?(function|class|const|let|var|type|interface) /.test(riga),
      );
    expect(dichiarazioni).toEqual([]);
    // Il tetto che la fetta dichiara. Non è estetica: una riga di logica qui
    // è una riga che nessuno dei nove moduli possiede.
    expect(testo.split('\n').length).toBeLessThan(100);
  });
});

describe('l imbuto: il drain sta su drive(), non su finish()', () => {
  it('provider error terminale: la correzione resta durevole e l’errore ha forma sicura', async () => {
    // L'errore terminale passa da `finish`; la correzione deve comunque essere
    // salvata esattamente una volta e non deve esporre il testo del provider.
    const coda: string[] = [];
    const w = world([new ProviderError('502 dal provider', true, 502, 'transport')], (n) => {
      // L'undicesimo tentativo è l'ultimo (`MAX_TRANSPORT_RETRIES` = 10): nessun
      // giro successivo la drena, quindi al `throw` è ancora nella porta.
      if (n === 11) coda.push(CORREZIONE);
    });
    const session = w.sessions.open('ramo-throw');

    const result = await barrel.runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'cerca una cosa',
      steer: () => coda.splice(0),
    });

    expect(result).toMatchObject({ stopped: 'error', reason: 'provider_error' });
    expect(result.text).toContain('HTTP 502');
    expect(result.text).not.toContain('502 dal provider');
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(1);
    expect(coda).toEqual([]);
  });

  it('ramo di ritorno: una volta sola, e nessun secondo scrittore', async () => {
    const coda: string[] = [];
    const w = world([answer('ecco')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    const session = w.sessions.open('ramo-ritorno');
    const r = await barrel.runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'dimmi',
      steer: () => coda.splice(0),
    });
    expect(r.stopped).toBe('answered');
    // Uno. Un drain dentro `finish()` che svuotasse la porta senza scrivere
    // porterebbe questo a zero; l'imbuto è l'unico scrittore.
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(1);
    expect(coda).toEqual([]);
  });

  it('ramo aborted: la porta si svuota e la correzione si butta, perché l owner ha detto /stop', async () => {
    // L'unica eccezione deliberata dell'imbuto, ed è anche il rosso di un
    // drain dentro `finish()`: `finish` è la strada di ritorno di `aborted`,
    // quindi una scrittura là metterebbe in conversazione proprio la frase
    // che l'owner ha appena interrotto.
    const coda: string[] = [CORREZIONE];
    const controller = new AbortController();
    // `/stop` arrivato prima che la corsia prendesse la riga, con una
    // correzione ancora nella porta del connettore: il giro lo vede al suo
    // primo checkpoint e chiude con `finish(scope, 'aborted', …)`.
    controller.abort();
    const w = world([answer('non arriverà mai')]);
    const session = w.sessions.open('ramo-aborted');
    const r = await barrel.runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'parti',
      signal: controller.signal,
      steer: () => coda.splice(0),
    });
    expect(r.stopped).toBe('aborted');
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(0);
    expect(quante(w.turns.get(r.turnId)!.messages, CORREZIONE)).toBe(0);
    expect(coda).toEqual([]);
  });
});

describe('i rifiuti terminali restano con le porte d ingresso', () => {
  it('un resume su un modello diverso chiude la riga e rende le parole mai viste', () => {
    const w = world([answer('mai chiamato')]);
    const session = w.sessions.open('modello-cambiato');
    const id = barrel.enqueueTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'la domanda',
    });
    // Una riga che ha già parlato col modello, e una correzione arrivata dopo:
    // è `codaMaiVista` che deve restituirla all'owner dentro il rifiuto.
    const riga = w.turns.get(id)!;
    const reclamata = w.turns.claim(id, process.pid, NOW())!;
    // Sospesa con una scadenza già passata: è la forma in cui la corsia
    // ritrova davvero un turno da riprendere, e la correzione `/steer` che
    // `suspendHere` ha parcheggiato nei `messages` è là dentro.
    w.turns.suspend(
      id,
      {
        messages: [
          ...riga.messages,
          { role: 'assistant', content: [{ type: 'text', text: 'una risposta' }] },
          { role: 'user', content: [{ type: 'text', text: CORREZIONE }] },
        ],
        taint: riga.taint,
        counters: riga.counters,
        wakeAt: new Date('2026-09-05T09:00:00.000Z').toISOString(),
        waitFor: null,
      },
      reclamata.claimToken,
    );

    return barrel.resumeTurn({ ...w.deps, model: 'un-altro-modello' }, id).then((esito) => {
      expect('why' in esito && esito.why).toBe('model_changed');
      expect('detail' in esito && esito.detail).toContain(CORREZIONE);
      expect(w.turns.get(id)!.status).toBe('done');
    });
  });
});

describe('a live model switch is atomic at the turn boundary', () => {
  it('moves a never-started queued turn to the model selected before its first attempt', async () => {
    const providerA = new Scripted([answer('risposta A')]);
    const providerB = new Scripted([answer('risposta B')]);
    const w = world([]);
    w.deps.provider = providerA;
    w.deps.model = 'model-a';
    const session = w.sessions.open('queued-model-switch');
    const id = barrel.enqueueTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'domanda accodata',
    });

    // Simula il cambio config persistito tra enqueue e il primo tick della lane.
    w.deps.prepareTurn = () => {
      w.deps.model = 'model-b';
      w.deps.provider = providerB;
    };

    const result = await barrel.resumeTurn(w.deps, id);

    expect('stopped' in result && result.stopped).toBe('answered');
    expect(w.turns.get(id)).toMatchObject({ model: 'model-b', status: 'done' });
    expect(providerB.seen).toHaveLength(1);
    expect(providerA.seen).toHaveLength(0);
  });

  it('a turn already inside provider A keeps provider, model and profile A for its retry', async () => {
    const providerB = new Scripted([answer('risposta B')]);
    let w!: ReturnType<typeof world>;

    w = world(
      [new ProviderError('output malformato', true, 400, 'output'), answer('risposta A')],
      (n) => {
        if (n !== 1) return;

        w.deps.provider = providerB;
        w.deps.model = 'model-b';
        w.deps.profile = {
          ...CONSERVATIVE,
          name: 'profile-b',
          sampling: 'model-default',
        };
      },
    );

    const providerA = w.deps.provider as Scripted;
    const session = w.sessions.open('turn-boundary-model');

    const result = await barrel.runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'resta sul modello con cui hai iniziato',
    });

    expect(result.stopped).toBe('answered');
    expect(result.text).toBe('risposta A');

    expect(providerA.seen).toHaveLength(2);
    expect(providerA.seen.map((call) => call.model)).toEqual(['test-model', 'test-model']);

    expect(providerA.seen[1]?.temperature).toBe(0);
    expect(providerB.seen).toHaveLength(0);
  });
});
