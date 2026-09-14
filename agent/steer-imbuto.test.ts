import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { type LoopDeps, type RegisteredTool, resumeTurn, runTurn } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import { type ChatCall, type ChatResult, type Provider, ProviderError } from './providers/types.js';
import { makeWaitTool, waitCapability } from './tools/wait.js';

/**
 * L'imbuto (ADR-0054 §2, emendamento 03/09c).
 *
 * L'invariante è una riga: **una correzione `/steer` non si perde mai e non
 * arriva mai due volte.** È stata riparata tre volte aggiungendo un drain a
 * un'uscita in più, e ogni volta ne restava scoperta un'altra. Qui si misura la
 * *forma* che la tiene: il motore gira dentro un guardiano, e su ogni strada
 * che ne esce — ritorno o `throw` — la porta è vuota e ciò che ne è uscito è
 * durevole da qualche parte che l'owner vede.
 *
 * I due test che contano di più:
 *
 *  - «il provider esaurisce i ritentativi» — l'unica strada che nessuno dei
 *    cinque siti copriva, quindi va rossa se l'imbuto non c'è;
 *  - «l'imbuto è portante» — va rossa quando si toglie **solo** l'imbuto,
 *    lasciando in piedi tutti i drain di sito: è ciò che distingue una
 *    primitiva condivisa da un sesto sito.
 */

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const NOW = () => new Date('2026-09-03T10:00:00.000Z');
const CORREZIONE = 'no, fermati e dimmi solo il titolo';

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage,
  model: 'test-model',
});
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
    private readonly script: (ChatResult | Error)[],
    private readonly durante: (n: number) => void = () => {},
  ) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push({
      ...request,
      messages: JSON.parse(JSON.stringify(request.messages)) as ChatCall['messages'],
    });
    this.durante(this.seen.length);
    const next = this.script[this.i++] ?? this.script.at(-1);
    if (next === undefined) throw new Error('lo script è finito');
    if (next instanceof Error) throw next;
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

function world(script: (ChatResult | Error)[], durante: (n: number) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-steer-imbuto-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const provider = new Scripted(script, durante);
  const sessions = new SessionStore(home);
  const decls = [waitCapability, webCapability];
  const tools: RegisteredTool[] = [
    makeWaitTool(turns, NOW),
    {
      capability: webCapability.id,
      spec: {
        name: 'http_get',
        description: 'fetch',
        inputSchema: { type: 'object', properties: {} },
      },
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
  return { deps, turns, provider, sessions };
}

/** Quante volte esattamente quel testo compare, come stringa JSON esatta. */
const quante = (haystack: unknown, testo: string): number =>
  JSON.stringify(haystack).split(JSON.stringify(testo)).length - 1;

const prompt = (c: ChatCall | undefined): string =>
  (c?.messages ?? [])
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
    .join('\n');

describe('l imbuto: una uscita sola per le correzioni', () => {
  it('il provider termina con errore: la correzione resta, e il turno dopo la vede', async () => {
    // Il ProviderError terminale chiude la riga con `error` e resta un errore
    // utente leggibile senza perdere il contenuto di `/steer`.
    const coda: string[] = [];
    // Scritta durante l'ultimo retry: nessun giro successivo la drena, quindi
    // al risultato terminale è ancora nella porta del connettore.
    const w = world([new ProviderError('502 dal provider', true, 502, 'transport')], (n) => {
      if (n === 11) coda.push(CORREZIONE);
    });
    const session = w.sessions.open('rethrow');

    const result = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'cerca una cosa',
      steer: () => coda.splice(0),
    });
    expect(result).toMatchObject({ stopped: 'error', reason: 'provider_error' });
    expect(result.text).toContain('HTTP 502');
    expect(result.text).not.toContain('502 dal provider');

    // Metà 1 — durevole. Una volta sola, e fuori dalla porta.
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(1);
    expect(coda).toEqual([]);

    // Metà 2 — raggiungibile: la history reinjection la rimette nella **prima**
    // chiamata al modello del turno successivo.
    const w2 = { ...w.deps, provider: new Scripted([answer('ok')]) };
    await runTurn(w2, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'e allora?',
    });
    expect(prompt((w2.provider as Scripted).seen[0])).toContain(CORREZIONE);
  });

  it('l imbuto è portante: se una sessione rotta lo fa fallire, il turno lo dice all owner', async () => {
    // Prima il fallimento di scrittura finiva su un attributo di span: l'owner
    // restava con un «ricevuto» che nessuno aveva onorato.
    const coda: string[] = [];
    const w = world([answer('ecco la risposta')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    const rotte: SessionStore = Object.create(w.sessions) as SessionStore;
    // Fallisce **solo** la scrittura della correzione: tutto il resto del turno
    // è normale, così l'unica cosa che il testo può denunciare è quella.
    (rotte as unknown as { append: SessionStore['append'] }).append = (ref, m) => {
      if (m.content === CORREZIONE) throw new Error('disco pieno');
      SessionStore.prototype.append.call(w.sessions, ref, m);
    };

    const result = await runTurn(
      { ...w.deps, sessions: rotte },
      {
        principal: owner,
        tenant: 'host',
        surface: 'telegram',
        session: rotte.open('scrittura-rotta'),
        text: 'dimmi una cosa',
        steer: () => coda.splice(0),
      },
    );

    expect(result.stopped).toBe('answered');
    expect(result.text).toContain('ecco la risposta');
    expect(result.text).toContain('Non sono riuscito a salvare la correzione');
    expect(result.text).toContain(CORREZIONE);
  });

  it('una risposta in un giro solo: consegnata una volta, in conversazione', async () => {
    const coda: string[] = [];
    const w = world([answer('fatto')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    const session = w.sessions.open('un-giro');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'dimmi',
      steer: () => coda.splice(0),
    });
    expect(r.stopped).toBe('answered');
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(1);
    expect(quante(w.turns.get(r.turnId)!.messages, CORREZIONE)).toBe(0);
    expect(coda).toEqual([]);
  });

  it('consumata da un giro: una volta nella riga, zero in conversazione', async () => {
    const coda: string[] = [];
    const w = world([call('http_get'), answer('fatto')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    const session = w.sessions.open('un-giro-la-consuma');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'cerca',
      steer: () => coda.splice(0),
    });
    expect(r.stopped).toBe('answered');
    expect(prompt(w.provider.seen[1])).toContain(CORREZIONE);
    expect(quante(w.turns.get(r.turnId)!.messages, CORREZIONE)).toBe(1);
    // L'imbuto ha trovato la porta vuota: è il no-op che rende sicuri i drain
    // di sito, e qui si misura invece di assumerlo.
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(0);
  });

  it('messa nella riga da suspendHere: una volta lì, zero in conversazione', async () => {
    const coda: string[] = [];
    const w = world([call('wait', { seconds: 3600 }), answer('fine')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    const session = w.sessions.open('sospende');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'aspetta',
      steer: () => coda.splice(0),
    });
    expect(r.stopped).toBe('suspended');
    expect(quante(w.turns.get(r.turnId)!.messages, CORREZIONE)).toBe(1);
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(0);
  });

  it('su /stop non si ripesca niente, e la porta resta vuota', async () => {
    const coda: string[] = [];
    const controller = new AbortController();
    const w = world([call('http_get'), answer('mai')], (n) => {
      if (n === 1) {
        coda.push(CORREZIONE);
        controller.abort();
      }
    });
    const session = w.sessions.open('stoppato');
    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session,
      text: 'cerca',
      signal: controller.signal,
      steer: () => coda.splice(0),
    });
    expect(r.stopped).toBe('aborted');
    expect(quante(w.sessions.read(session), CORREZIONE)).toBe(0);
    // Svuotata e buttata: nessuno può ripescarla più tardi.
    expect(coda).toEqual([]);
  });

  it('una ripresa rifiutata non seppellisce la correzione: il rifiuto la riporta all owner', async () => {
    const coda: string[] = [];
    const w = world([call('wait', { seconds: 3600 }), answer('mai')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: w.sessions.open('ripresa-rifiutata'),
      text: 'aspetta',
      steer: () => coda.splice(0),
    });
    expect(first.stopped).toBe('suspended');
    expect(quante(w.turns.get(first.turnId)!.messages, CORREZIONE)).toBe(1);

    // Il modello cambia: `resumeTurn` rifiuta **prima** di `drive` e `closeRow`
    // chiude la riga. La correzione era conservata e irraggiungibile.
    const rifiuto = await resumeTurn({ ...w.deps, model: 'un-altro-modello' }, first.turnId);
    expect('why' in rifiuto).toBe(true);
    const detail = (rifiuto as { detail: string }).detail;
    expect(detail).toContain('il modello non ha mai visto');
    expect(detail).toContain(CORREZIONE);
  });

  it('una ripresa rifiutata senza niente di non visto non aggiunge rumore', async () => {
    const w = world([call('wait', { seconds: 3600 }), answer('mai')]);
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: w.sessions.open('rifiuto-pulito'),
      text: 'aspetta',
    });
    expect(first.stopped).toBe('suspended');
    const rifiuto = await resumeTurn({ ...w.deps, model: 'un-altro-modello' }, first.turnId);
    expect((rifiuto as { detail: string }).detail).not.toContain('il modello non ha mai visto');
  });
});
