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
import { makeWaitTool, waitCapability } from './tools/wait.js';
import { resumeTurn, runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

/**
 * `/steer` mentre il turno sta per sospendersi (ADR-0054 §2, emendamento
 * 03/09b).
 *
 * Un turno sospeso **non è finito**: gli è dovuto un risveglio. La correzione
 * deve quindi viaggiare nei `messages` che `suspend` persiste ed essere
 * consegnata a *quel* turno quando si sveglia — non alla sessione per il turno
 * dopo, e mai due volte.
 */

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const NOW = () => new Date('2026-09-03T10:00:00.000Z');

const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test-model' });
const call = (name: string, args: unknown = {}, id = 'c1'): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage,
  model: 'test-model',
});

/** Registra ogni chiamata (per copia) e lascia scrivere l'owner *durante* la n-esima. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private i = 0;
  constructor(
    private readonly script: ChatResult[],
    private readonly durante: (n: number) => void = () => {},
  ) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push({ ...request, messages: JSON.parse(JSON.stringify(request.messages)) as ChatCall['messages'] });
    this.durante(this.seen.length);
    const next = this.script[this.i++];
    if (!next) throw new Error('lo script è finito');
    return next;
  }
}

const webCapability: CapabilityDecl = {
  id: 'net.http',
  effect: 'context',
  maxTaint: 1,
  risk: 'medium',
  reversible: 'yes',
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

function world(script: ChatResult[], durante: (n: number) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-steer-sospeso-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const provider = new Scripted(script, durante);
  const sessions = new SessionStore(home);
  const decls = [waitCapability, webCapability];
  const tools: RegisteredTool[] = [
    makeWaitTool(turns, NOW),
    {
      capability: webCapability.id,
      spec: { name: 'http_get', description: 'fetch', inputSchema: { type: 'object', properties: {} } },
      throwTier: 0,
      handler: () => ({ content: 'la pagina dice X', tier: 3 as const }),
    },
  ];
  const capabilities = new Map(decls.map((d) => [d.id, d]));
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test-model',
    tools,
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    now: NOW,
  };
  return { deps, turns, provider, sessions };
}

/** Ogni testo che il modello ha ricevuto in una richiesta. */
const prompt = (c: ChatCall | undefined): string =>
  (c?.messages ?? [])
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
    .join('\n');

/** Quante volte esattamente quel testo compare come messaggio dell'owner. */
const quante = (haystack: unknown, testo: string): number =>
  JSON.stringify(haystack).split(JSON.stringify(testo)).length - 1;

const CORREZIONE = 'no, aspetta meno e dimmi subito cosa hai trovato';

describe('una correzione pendente quando il turno si sospende', () => {
  it('viaggia nei messaggi persistiti del turno e arriva alla prima chiamata del risveglio', async () => {
    // La correzione arriva **durante** il giro che poi chiede `wait`: il giro
    // dopo non esiste, perché la barriera si onora prima del drain in cima.
    const coda: string[] = [];
    const w = world([call('wait', { seconds: 3600 }), answer('ecco, adesso te lo dico')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });

    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: w.sessions.open('sospeso'),
      text: 'cerca e poi aspetta',
      steer: () => coda.splice(0),
    });
    expect(first.stopped).toBe('suspended');

    // Metà 1 — sta nella riga, che è l'unica cosa che sopravvive al ritorno di
    // `runTurn` (il `finally` del connettore cancella la voce `vivi`).
    const row = w.turns.get(first.turnId)!;
    expect(row.status).toBe('waiting');
    expect(quante(row.messages, CORREZIONE)).toBe(1);
    // Drenata: la superficie ha già detto «ricevuto», e la porta non la tiene.
    expect(coda).toEqual([]);

    // Metà 2 — il turno che si sveglia la vede alla **prima** chiamata.
    const resumed = await resumeTurn(w.deps, first.turnId);
    expect('why' in resumed).toBe(false);
    expect(prompt(w.provider.seen[1])).toContain(CORREZIONE);
  });

  it('non finisce anche nella sessione: il turno non è finito, quindi non è roba del turno dopo', async () => {
    const coda: string[] = [];
    const w = world([call('wait', { seconds: 3600 }), answer('fatto')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    const session = w.sessions.open('sospeso-sessione');
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'cerca e poi aspetta',
      steer: () => coda.splice(0),
    });
    expect(first.stopped).toBe('suspended');
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(0);
  });

  it('se la scrittura di sospensione fallisce la correzione non si perde: va in conversazione, e il turno lo dice', async () => {
    const coda: string[] = [];
    const w = world([call('wait', { seconds: 3600 }), answer('mai')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    // La riga non diventerà `waiting`: nessuno sveglierebbe questo turno, e
    // consegnare la correzione «al risveglio» sarebbe una promessa vuota.
    const rotto: TurnStore = Object.create(w.turns) as TurnStore;
    (rotto as unknown as { suspend: TurnStore['suspend'] }).suspend = () => false;

    const session = w.sessions.open('sospensione-fallita');
    const result = await runTurn({ ...w.deps, turns: rotto }, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'cerca e poi aspetta',
      steer: () => coda.splice(0),
    });

    expect(result.stopped).toBe('error');
    expect(result.text).toContain('non sono riuscito a salvare lo stato del turno');
    // Drenata dalla porta, mai scritta in una riga: l'unico posto onesto che
    // resta è la conversazione, dove il turno dopo la vede.
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(1);
  });

  it('una correzione già consumata da un giro non viene consegnata una seconda volta', async () => {
    const coda: string[] = [];
    const w = world(
      [call('http_get', {}, 'a'), call('wait', { seconds: 3600 }, 'b'), answer('finito')],
      (n) => {
        if (n === 1) coda.push(CORREZIONE);
      },
    );
    const session = w.sessions.open('niente-doppioni');
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'cerca e poi aspetta',
      steer: () => coda.splice(0),
    });

    // Consumata in cima al giro 2, che poi chiede `wait`; il giro 3 sospende.
    expect(first.stopped).toBe('suspended');
    expect(prompt(w.provider.seen[1])).toContain(CORREZIONE);
    expect(quante(w.turns.get(first.turnId)!.messages, CORREZIONE)).toBe(1);
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(0);

    const resumed = await resumeTurn(w.deps, first.turnId);
    expect('why' in resumed).toBe(false);
    expect(quante(w.provider.seen[2]!.messages, CORREZIONE)).toBe(1);
    expect(quante(w.turns.get(first.turnId)!.messages, CORREZIONE)).toBe(1);
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(0);
  });
});
