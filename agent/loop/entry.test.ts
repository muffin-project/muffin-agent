import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStore, APPROVAL_WINDOW_MS } from '../../core/approvals/store.js';
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
  type Message,
  type Provider,
  ProviderError,
} from '../providers/types.js';
import { providerMessages } from './provider-checkpoint.js';

afterEach(() => vi.restoreAllMocks());

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
  const approvals = new ApprovalStore(db);
  const capabilities = new Map();
  const deps: barrel.LoopDeps = {
    provider: new Scripted(script, durante),
    profile: CONSERVATIVE,
    model: 'test-model',
    tools: [],
    capabilities,
    approvals,
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
  return { deps, turns, sessions, approvals, home };
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
  it('provider error retryable: la lease si arrende da continuable e la correzione resta durevole', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // P0-B: l'esaurimento retryable non è più un errore terminale — la lease
    // cede da continuable con il lavoro intatto. La correzione deve comunque
    // essere salvata esattamente una volta dall'imbuto, e il testo non deve
    // esporre quello del provider.
    const coda: string[] = [];
    const w = world([new ProviderError('502 dal provider', true, 502, 'transport')], (n) => {
      // L'undicesimo tentativo è l'ultimo (`MAX_TRANSPORT_RETRIES` = 10): nessun
      // giro successivo la drena, quindi al rilascio è ancora nella porta.
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

    expect(result).toMatchObject({ stopped: 'continuable', reason: 'provider_transport' });
    expect(result.text).toContain('riprendi');
    expect(result.text).not.toContain('502 dal provider');
    expect(w.turns.get(result.turnId)?.status).toBe('continuable');
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(1);
    expect(coda).toEqual([]);
  });

  it('provider error non-retryable: resta terminale, forma sicura', async () => {
    // Una chiave morta non guarisce con una nuova lease: errore terminale,
    // testo tipizzato senza il testo del provider.
    const w = world([new ProviderError('chiave morta', false, 401, 'transport')]);
    const session = w.sessions.open('ramo-terminal');

    const result = await barrel.runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'cerca una cosa',
    });

    expect(result).toMatchObject({ stopped: 'error', reason: 'provider_error' });
    expect(result.text).toContain('HTTP 401');
    expect(result.text).not.toContain('chiave morta');
  });

  it('provider HTTP 402 reaches the owner as a payment diagnostic', async () => {
    const w = world([new ProviderError('private billing payload', false, 402, 'transport')]);
    const session = w.sessions.open('ramo-payment-required');

    const result = await barrel.runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'completa il lavoro',
    });

    expect(result).toMatchObject({ stopped: 'error', reason: 'provider_error' });
    expect(result.text).toContain('HTTP 402');
    expect(result.text).toContain('saldo');
    expect(result.text).toContain('limiti');
    expect(result.text).not.toContain('Riprova tra poco');
    expect(result.text).not.toContain('private billing payload');
  });

  it('provider HTTP 404 reaches the owner as a routing diagnostic', async () => {
    const w = world([new ProviderError('private route payload', false, 404, 'transport')]);
    const session = w.sessions.open('ramo-route-not-found');

    const result = await barrel.runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'rispondi',
    });

    expect(result).toMatchObject({ stopped: 'error', reason: 'provider_error' });
    expect(result.text).toContain('HTTP 404');
    expect(result.text).toContain('provider.routing');
    expect(result.text).not.toContain('Riprova tra poco');
    expect(result.text).not.toContain('private route payload');
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
    expect(quante(providerMessages(w.turns.get(r.turnId)!), CORREZIONE)).toBe(0);
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
          ...providerMessages(riga),
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

    // Una domanda ancora aperta su questo turno: il rifiuto terminale la
    // ritira (#742), o resterebbe `decision IS NULL` per sempre.
    const aperta = w.approvals.ask({ turnId: id, capability: 'sys.shell', resource: 'rm', prompt: 'eseguo?', taint: 0 }, NOW());

    return barrel.resumeTurn({ ...w.deps, model: 'un-altro-modello' }, id).then((esito) => {
      expect('why' in esito && esito.why).toBe('model_changed');
      expect('detail' in esito && esito.detail).toContain(CORREZIONE);
      expect(w.turns.get(id)!.status).toBe('done');
      expect(w.approvals.get(aperta)?.withdrawnAt).not.toBeNull();
      expect(w.approvals.open(id)).toBeNull();
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
    expect(w.turns.get(id)).toMatchObject({ providerLease: { model: 'model-b' }, status: 'done' });
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

describe('continueTurn rifiuta senza toccare la riga', () => {
  const grant: Message = { role: 'user', content: [{ type: 'text', text: 'riprendi' }] };
  const counters = {
    iterations: 3,
    recoveriesUsed: 5,
    transportRetriesLeft: 7,
    truncationsUsed: 0,
    toolCallsMade: 2,
    nudgedForCompletion: false,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
    activeModelMs: 0,
  };
  const reason = { class: 'provider_empty' as const, lease: 0, at: '2026-09-18T17:14:09.000Z' };

  /** Una riga continuabile pronta, costruita dalle API durevoli come un rilascio vero. */
  function continuableRow(
    w: ReturnType<typeof world>,
    over: { model?: string; contextBuilt?: boolean } = {},
  ) {
    const created = w.turns.create(
      {
        id: 'cont-1',
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 's1',
        model: over.model ?? 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'fai' }] }],
        taint: 0,
        counters: { ...counters, contextBuilt: over.contextBuilt ?? true },
      },
      4242,
    );
    expect(
      w.turns.releaseContinuable(
        'cont-1',
        {
          messages: providerMessages(created),
          taint: 0,
          counters: { ...counters, contextBuilt: over.contextBuilt ?? true },
          reason,
        },
        created.claimToken,
      ),
    ).toBe(true);
    return w.turns.get('cont-1')!;
  }

  it('not_found su id ignoto', async () => {
    const w = world([answer('ok')]);
    const r = await barrel.continueTurn(w.deps, 'nope', { message: { ...grant } });
    expect(r).toMatchObject({ turnId: 'nope', why: 'not_found' });
  });

  it('not_continuable su riga running o done, senza scriverci niente', async () => {
    const w = world([answer('ok')]);
    const running = w.turns.create(
      {
        id: 'run-1',
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 's1',
        model: 'test-model',
        messages: [],
        taint: 0,
        counters,
      },
      4242,
    );
    const r = await barrel.continueTurn(w.deps, 'run-1', { message: { ...grant } });
    expect(r).toMatchObject({ why: 'not_continuable' });
    expect(w.turns.get('run-1')?.status).toBe('running');
    expect(w.turns.leasesFor('run-1')).toHaveLength(1);
  });

  it('model_changed rifiuta e lascia la riga continuabile per il modello originale', async () => {
    const w = world([answer('ok')]);
    continuableRow(w, { model: 'other-model' });
    const r = await barrel.continueTurn(w.deps, 'cont-1', { message: { ...grant } });
    expect(r).toMatchObject({ why: 'model_changed' });
    expect(w.turns.get('cont-1')?.status).toBe('continuable');
  });

  it('unstarted rifiuta: senza preambolo non c è transcript da continuare', async () => {
    const w = world([answer('ok')]);
    continuableRow(w, { contextBuilt: false });
    const r = await barrel.continueTurn(w.deps, 'cont-1', { message: { ...grant } });
    expect(r).toMatchObject({ why: 'unstarted' });
    expect(w.turns.get('cont-1')?.status).toBe('continuable');
  });

  it('resumeTurn su riga continuable rifiuta con la strada giusta, senza consumare resume', async () => {
    const w = world([answer('ok')]);
    continuableRow(w);
    const r = await barrel.resumeTurn(w.deps, 'cont-1');
    expect(r).toMatchObject({ turnId: 'cont-1', why: 'continuable' });
    expect(w.turns.get('cont-1')?.status).toBe('continuable');
    expect(w.turns.get('cont-1')?.counters.resumes).toBe(0);
  });
});

/**
 * #741 — con più domande aperte il turno riprende solo quando sono decise tutte.
 *
 * Un giro può chiedere più approvazioni (una per tool call che ne ha bisogno):
 * ognuna ha la sua riga in `approvals`, e un click ne decide **una**. La
 * barriera del turno è un `wait_for` solo, quindi `wake` lo riporta `runnable`
 * alla prima decisione: senza guardia il modello ripartirebbe, rifarebbe le
 * chiamate e ri-chiederebbe le domande ancora aperte — id nuovi, tastiere
 * nuove, e il turno che "riprende" quando non dovrebbe.
 *
 * L'autorità della condizione è `ApprovalStore.open(turnId)`: la prima domanda
 * ancora aperta. Finora non aveva chiamanti.
 */
describe('#741 — la ripresa aspetta tutte le domande aperte, non una', () => {
  const counters = {
    iterations: 2,
    recoveriesUsed: 0,
    transportRetriesLeft: 10,
    truncationsUsed: 0,
    toolCallsMade: 2,
    nudgedForCompletion: false,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
    activeModelMs: 0,
  };

  /** Una riga avviata, sospesa su `b`, con due domande aperte nello stesso giro. */
  function dueDomande(w: ReturnType<typeof world>): { id: string; a: string; b: string } {
    const record = w.turns.create(
      {
        id: 'c'.repeat(32),
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'multi-ask',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'due comandi' }] }],
        taint: 0,
        counters,
      },
      4242,
    );
    const a = w.approvals.ask({ turnId: record.id, capability: 'sys.shell', resource: 'echo a', prompt: 'eseguo a?', taint: 0 }, NOW());
    const b = w.approvals.ask({ turnId: record.id, capability: 'sys.shell', resource: 'echo b', prompt: 'eseguo b?', taint: 0 }, NOW());
    w.turns.suspend(
      record.id,
      {
        messages: providerMessages(record),
        taint: 0,
        counters: record.counters,
        wakeAt: new Date(NOW().getTime() + APPROVAL_WINDOW_MS).toISOString(),
        waitFor: `approval:${b}`,
      },
      record.claimToken,
    );
    return { id: record.id, a, b };
  }

  it('la prima decisione non fa partire il modello: la ripresa ri-sospende sulla domanda ancora aperta', async () => {
    const w = world([answer('non deve partire')]);
    const { id, a, b } = dueDomande(w);

    // L'owner decide la prima; la lane lo riprende.
    expect(w.approvals.decide(a, 'allow', NOW())).toBe('ok');
    expect(w.turns.wake(id, NOW())).toBe(true);

    const esito = await barrel.resumeTurn(w.deps, id);

    expect('stopped' in esito && esito.stopped).toBe('suspended');
    expect((w.deps.provider as Scripted).seen).toHaveLength(0);
    expect(w.turns.get(id)).toMatchObject({ status: 'waiting', waitFor: `approval:${b}` });
    // La decisione presa resta non consumata: vale per il tool quando riparte.
    expect(w.approvals.get(a)).toMatchObject({ decision: 'allow', consumedAt: null });
  });

  it('decisa anche la seconda, il turno riprende davvero', async () => {
    const w = world([answer('fatto')]);
    const { id, a, b } = dueDomande(w);

    w.approvals.decide(a, 'allow', NOW());
    w.turns.wake(id, NOW());
    await barrel.resumeTurn(w.deps, id); // ri-sospende su b, senza modello

    expect(w.approvals.decide(b, 'allow', NOW())).toBe('ok');
    expect(w.turns.wake(id, NOW())).toBe(true);

    const esito = await barrel.resumeTurn(w.deps, id);

    expect('stopped' in esito && esito.stopped).toBe('answered');
    expect((w.deps.provider as Scripted).seen).toHaveLength(1);
  });

  /**
   * Il braccio della scadenza: una decisione non consumata **e** una domanda
   * aperta già oltre la finestra non devono ri-sospendere — il turno riprende
   * e `wakeReport` racconta il timer. Senza questo caso il ramo
   * `scadenzaDellaDomanda > ora` sopravvive a ogni mutazione (review 2026-09-29).
   */
  it('una domanda aperta oltre la finestra non ri-sospende: il turno riprende e il timer lo racconta', async () => {
    const w = world([answer('te lo dico')]);
    const record = w.turns.create(
      {
        id: 'd'.repeat(32),
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'multi-ask-scaduta',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'due comandi' }] }],
        taint: 0,
        counters,
      },
      4242,
    );
    // A decisa, B aperta ma chiesta **oltre** la finestra: è la forma della
    // scadenza, non del click.
    const a = w.approvals.ask({ turnId: record.id, capability: 'sys.shell', resource: 'echo a', prompt: 'eseguo a?', taint: 0 }, NOW());
    const b = w.approvals.ask(
      { turnId: record.id, capability: 'sys.shell', resource: 'echo b', prompt: 'eseguo b?', taint: 0 },
      new Date(NOW().getTime() - APPROVAL_WINDOW_MS - 60_000),
    );
    w.turns.suspend(
      record.id,
      {
        messages: providerMessages(record),
        taint: 0,
        counters: record.counters,
        wakeAt: new Date(NOW().getTime() - 60_000).toISOString(),
        waitFor: `approval:${b}`,
      },
      record.claimToken,
    );
    w.approvals.decide(a, 'allow', NOW());
    expect(w.turns.wake(record.id, NOW())).toBe(true);

    const esito = await barrel.resumeTurn(w.deps, record.id);

    // Il modello riparte col referto del timer, non ri-sospende.
    expect('stopped' in esito && esito.stopped).toBe('answered');
    expect((w.deps.provider as Scripted).seen).toHaveLength(1);
  });
});

/**
 * #749 — un referto di `process_exit` non si perde per una decisione non
 * consumata.
 *
 * La guardia multi-ask (#741) ri-sospende quando c'è una decisione non
 * consumata e una domanda aperta nella finestra. Ma quella guardia esiste per
 * un risveglio **da click sulla barriera di approvazione**: se la riga
 * aspettava un processo uscito, ri-sospendere butta via il referto dell'uscita
 * — il fatto che il modello deve ricevere — e lo sostituisce con un'attesa che
 * nessuno ha chiesto. La decisione non consumata non si butta: resta per il
 * tool quando riparte (`consume`).
 */
describe('#749 — la guardia multi-ask non scavalca un referto di processo uscito', () => {
  const counters = {
    iterations: 2,
    recoveriesUsed: 0,
    transportRetriesLeft: 10,
    truncationsUsed: 0,
    toolCallsMade: 2,
    nudgedForCompletion: false,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
    activeModelMs: 0,
  };

  it('barriera `process_exit` con pid uscito: il turno riprende col referto, non ri-sospende', async () => {
    const w = world([answer('riparto')]);
    const record = w.turns.create(
      {
        id: 'e'.repeat(32),
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'multi-ask-exit',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'due comandi' }] }],
        taint: 0,
        counters,
      },
      4242,
    );
    // A decisa (non consumata), B aperta: la firma di un risveglio da click.
    const a = w.approvals.ask({ turnId: record.id, capability: 'sys.shell', resource: 'echo a', prompt: 'eseguo a?', taint: 0 }, NOW());
    w.approvals.ask({ turnId: record.id, capability: 'sys.shell', resource: 'echo b', prompt: 'eseguo b?', taint: 0 }, NOW());
    // Ma la barriera della riga è un processo uscito: l'ultima attesa del giro
    // ha vinto (`wait_for` è uno solo). Il pid non esiste — è uscito.
    const morto = 999_999_999;
    w.turns.suspend(
      record.id,
      {
        messages: providerMessages(record),
        taint: 0,
        counters: record.counters,
        wakeAt: new Date(NOW().getTime() + APPROVAL_WINDOW_MS).toISOString(),
        waitFor: `process_exit:${morto}`,
      },
      record.claimToken,
    );
    w.approvals.decide(a, 'allow', NOW());
    expect(w.turns.wake(record.id, NOW())).toBe(true);

    const esito = await barrel.resumeTurn(w.deps, record.id);

    // Il modello riparte col referto dell'uscita, non ri-sospende su B.
    expect('stopped' in esito && esito.stopped).toBe('answered');
    expect((w.deps.provider as Scripted).seen).toHaveLength(1);
    expect(JSON.stringify((w.deps.provider as Scripted).seen[0])).toContain(`il processo ${morto} è uscito`);
  });
});

/**
 * #762 — il referto di risveglio non mente sul perché, il trade è
 * esplicito, e anche il click differito lascia la sua span.
 *
 * (a) Un click sveglia la riga a prescindere dalla sua barriera: con un
 * `process_exit` vivo e la scadenza nel futuro, il referto deve nominare la
 * risposta, non affermare una scadenza che nessuno ha osservato.
 *
 * (b) Ripartendo su `process_exit` con una decisione presa e una domanda
 * aperta, il referto nomina entrambi gli stati: la decisione non consumata
 * resta per il tool, la domanda aperta verrà ritirata se il turno chiude.
 *
 * (c) La ri-sospensione su click differito emette la sua span `muffin.turn`:
 * prima ritornava prima che la span nascesse.
 */
describe('#762 — il referto di risveglio dice il vero', () => {
  const counters762 = {
    iterations: 2,
    recoveriesUsed: 0,
    transportRetriesLeft: 10,
    truncationsUsed: 0,
    toolCallsMade: 2,
    nudgedForCompletion: false,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
    activeModelMs: 0,
  };

  /** Riga sospesa su `process_exit`, con una decisione non consumata e una domanda aperta. */
  function attesaProcesso(
    w: ReturnType<typeof world>,
    waitFor: string,
    wakeAt: string,
  ): { id: string; a: string } {
    const record = w.turns.create(
      {
        id: 'f'.repeat(32),
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'wake-762',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'aspetta il processo' }] }],
        taint: 0,
        counters: counters762,
      },
      4242,
    );
    const a = w.approvals.ask(
      { turnId: record.id, capability: 'sys.shell', resource: 'echo a', prompt: 'eseguo a?', taint: 0 },
      NOW(),
    );
    w.approvals.ask(
      { turnId: record.id, capability: 'sys.shell', resource: 'echo b', prompt: 'eseguo b?', taint: 0 },
      NOW(),
    );
    w.turns.suspend(
      record.id,
      {
        messages: providerMessages(record),
        taint: 0,
        counters: record.counters,
        wakeAt,
        waitFor,
      },
      record.claimToken,
    );
    return { id: record.id, a };
  }

  it('(a) barriera viva e scadenza futura: il referto nomina la risposta, non la scadenza', async () => {
    const w = world([answer('riparto dalla risposta')]);
    // Questo processo è vivo per definizione: la barriera non si è aperta.
    const { id, a } = attesaProcesso(
      w,
      `process_exit:${process.pid}`,
      new Date(NOW().getTime() + APPROVAL_WINDOW_MS).toISOString(),
    );
    // Il click decide A e sveglia la riga — la stessa sequenza di `handleCallback`.
    w.approvals.decide(a, 'allow', NOW());
    expect(w.turns.wake(id, NOW())).toBe(true);

    const esito = await barrel.resumeTurn(w.deps, id);

    expect('stopped' in esito && esito.stopped).toBe('answered');
    expect((w.deps.provider as Scripted).seen).toHaveLength(1);
    const testo = JSON.stringify((w.deps.provider as Scripted).seen[0]);
    expect(testo).toMatch(/risposta/);
    expect(testo).not.toMatch(/scadut/);
  });

  it('(b) ripresa su `process_exit`: il referto nomina decisione e domanda aperta', async () => {
    const w = world([answer('ho capito il trade')]);
    const morto = 999_999_999;
    const { id, a } = attesaProcesso(
      w,
      `process_exit:${morto}`,
      new Date(NOW().getTime() + APPROVAL_WINDOW_MS).toISOString(),
    );
    w.approvals.decide(a, 'allow', NOW());
    expect(w.turns.wake(id, NOW())).toBe(true);

    const esito = await barrel.resumeTurn(w.deps, id);

    expect('stopped' in esito && esito.stopped).toBe('answered');
    const testo = JSON.stringify((w.deps.provider as Scripted).seen[0]);
    expect(testo).toContain(`il processo ${morto} è uscito`);
    expect(testo).toMatch(/non ancora usata/);
    expect(testo).toMatch(/ritirata/);
  });

  it('(c) il click differito lascia la sua span nel trace', async () => {
    const w = world([answer('non deve partire')]);
    // Due domande aperte, barriera sull'ultima: la forma del click differito.
    const record = w.turns.create(
      {
        id: 'c'.repeat(32),
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'differito-762',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'due comandi' }] }],
        taint: 0,
        counters: counters762,
      },
      4242,
    );
    const a = w.approvals.ask(
      { turnId: record.id, capability: 'sys.shell', resource: 'echo a', prompt: 'eseguo a?', taint: 0 },
      NOW(),
    );
    const b = w.approvals.ask(
      { turnId: record.id, capability: 'sys.shell', resource: 'echo b', prompt: 'eseguo b?', taint: 0 },
      NOW(),
    );
    w.turns.suspend(
      record.id,
      {
        messages: providerMessages(record),
        taint: 0,
        counters: record.counters,
        wakeAt: new Date(NOW().getTime() + APPROVAL_WINDOW_MS).toISOString(),
        waitFor: `approval:${b}`,
      },
      record.claimToken,
    );
    const id = record.id;

    // L'owner decide la prima; la lane lo riprende; la guardia ri-sospende su b.
    expect(w.approvals.decide(a, 'allow', NOW())).toBe('ok');
    expect(w.turns.wake(id, NOW())).toBe(true);

    const esito = await barrel.resumeTurn(w.deps, id);

    expect('stopped' in esito && esito.stopped).toBe('suspended');
    expect((w.deps.provider as Scripted).seen).toHaveLength(0);
    const righe = readdirSync(join(w.home, 'traces'))
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) =>
        readFileSync(join(w.home, 'traces', f), 'utf8')
          .split('\n')
          .filter((r) => r.trim() !== '')
          .map((r) => JSON.parse(r) as { name: string; attributes: Record<string, unknown> }),
      );
    const span = righe.find(
      (s) => s.name === 'muffin.turn' && s.attributes?.['muffin.turn.id'] === id,
    );
    expect(span).toBeDefined();
  });
});
