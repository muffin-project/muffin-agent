import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

/**
 * `/steer` mandato mentre la corsia sta GIÀ eseguendo un turno ripreso — non
 * prima che si sospenda (i test sopra), un caso diverso: qui la correzione
 * arriva dopo il risveglio, mentre il tool call del resume sta girando.
 *
 * Chiuso 2026-09-04. `drive()` (`agent/loop.ts`) legge `options.steer` a ogni
 * giro da sempre, e `runTurn` lo inoltra da sempre — ma `resumeTurn` fino a
 * oggi accettava solo `onDelta`/`onProgress` da `ResumeStream`: `steer` (e
 * `signal`, per `/stop`) non erano nel tipo, quindi nessun chiamante poteva
 * passarli, quale che fosse il connettore. Il meccanismo esisteva
 * (`options.steer` in `drive`) e la produzione non lo raggiungeva per un
 * turno ripreso — la stessa forma di guasto che questo repository chiama
 * "un meccanismo che c'è e la produzione non lo raggiunge".
 *
 * Il sintomo misurato era in `connectors/telegram/connector.ts`: `vivi` (la
 * mappa "turno vivo per questa chat" che `/steer`/`/stop` consultano) veniva
 * popolata solo da `handle()`, mai da `resumeStream` — quindi un `/steer`
 * mandato mentre un turno ripreso girava trovava `vivi.has(chatId)` falso e
 * rispondeva «nessun turno in corso», falso. Questo file prova il livello
 * sotto quel sintomo (`resumeTurn` stesso), perché è lì che il filo era
 * reciso; `connectors/telegram/busy.test.ts` prova che l'owner riceve
 * davvero l'effetto attraverso il connettore vero.
 */
describe('/steer durante l esecuzione di un turno che la corsia ha già ripreso', () => {
  it('resumeTurn inoltra `steer` a `drive` come runTurn — la correzione arriva al giro dopo quello in cui è stata scritta, dentro la STESSA ripresa', async () => {
    const coda: string[] = [];
    // 1ª chiamata: sospende su `wait` (nessuna correzione ancora).
    // 2ª chiamata: il PRIMO giro del resume — chiama `http_get`, e la
    // correzione viene scritta mentre questa chiamata è "in volo" (`durante`
    // corre prima che `drive` droni il turno risultato del tool).
    // 3ª chiamata: il giro successivo, ANCORA dentro lo stesso `resumeTurn` —
    // deve vedere la correzione.
    const w = world([call('wait', { seconds: 3600 }), call('http_get'), answer('fatto')], (n) => {
      if (n === 2) coda.push(CORREZIONE);
    });

    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: w.sessions.open('ripreso-vivo'),
      text: 'cerca e poi aspetta',
    });
    expect(first.stopped).toBe('suspended');
    expect(w.provider.seen).toHaveLength(1);
    expect(coda).toEqual([]); // non scritta ancora: il turno dorme

    // La leva che un connettore come Telegram (`resumeStream`,
    // `connectors/telegram/connector.ts`) ora passa: lo stesso `() =>
    // vivo.correzioni.splice(0)` che `handle()` passa a `runTurn`.
    const resumed = await resumeTurn(w.deps, first.turnId, { steer: () => coda.splice(0) });

    expect('why' in resumed).toBe(false);
    expect(w.provider.seen).toHaveLength(3);
    // Non alla chiamata dove è stata scritta (troppo tardi per quella, la
    // richiesta era già in volo) — a quella dopo, nella STESSA ripresa.
    expect(prompt(w.provider.seen[1])).not.toContain(CORREZIONE);
    expect(prompt(w.provider.seen[2])).toContain(CORREZIONE);
    expect(coda).toEqual([]); // drenata, non lasciata per il prossimo risveglio
  });

  it('senza `steer` passato a resumeTurn, una correzione scritta durante la ripresa non arriva mai (il gap che questa fix chiude)', async () => {
    const coda: string[] = [];
    const w = world([call('wait', { seconds: 3600 }), call('http_get'), answer('fatto')], (n) => {
      if (n === 2) coda.push(CORREZIONE);
    });
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: w.sessions.open('ripreso-senza-leva'),
      text: 'cerca e poi aspetta',
    });
    expect(first.stopped).toBe('suspended');

    // Nessun `steer` nel terzo argomento — la forma di `resumeTurn` prima di
    // questo commit, e ancora una chiamata legittima oggi (uno stream senza
    // leva, es. un resume da un processo senza connettore vivo).
    const resumed = await resumeTurn(w.deps, first.turnId);

    expect('why' in resumed).toBe(false);
    expect(prompt(w.provider.seen[2])).not.toContain(CORREZIONE);
    // La correzione non è sparita: è ancora nella coda del chiamante, che
    // resta responsabile di consegnarla altrove (`/steer` di nuovo, un
    // prossimo risveglio con la leva questa volta).
    expect(coda).toEqual([CORREZIONE]);
  });
});

/**
 * ADR-0054 §2: la correzione che nessun giro consuma viene ripescata a fine
 * turno da `finish` (`scriviCorrezioniInSessione` in `agent/loop.ts`) e
 * scritta in sessione con `deps.sessions.append`. Chiuso 2026-09-04.
 *
 * Prima di questa fix, un `sessions.append` che lanciava finiva SOLO in un
 * attributo dello span di tracing (`muffin.turn.steer_residuo_error`) — mai
 * letto da nessuna superficie, mai visto da nessun owner. La correzione
 * spariva e il turno rispondeva come se niente fosse: esattamente il
 * "silenzioso" che l'assegnazione misura. Ora `scriviCorrezioniInSessione`
 * riporta l'esito e `finish` lo aggiunge al testo che l'owner legge — lo
 * stesso canale con cui ogni altra risposta arriva, senza dover toccare
 * nessun connettore di superficie.
 */
describe('sessions.append fallito nella ripesca finale di /steer non è più silenzioso', () => {
  it('il turno finisce comunque, ma la risposta dice che la correzione non è stata salvata', async () => {
    const coda: string[] = [];
    // Un solo giro, senza tool: `finish` è l'unico punto che ripesca questa
    // correzione (nessun giro successivo la consuma prima).
    const w = world([answer('fatto subito')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });
    // Solo la scrittura della correzione residua fallisce — il preambolo del
    // turno (`sessions.append` con il messaggio dell'owner che apre il
    // turno) deve continuare a funzionare, o il test proverebbe un guasto
    // diverso da quello che sta misurando.
    const originaleAppend = w.sessions.append.bind(w.sessions);
    vi.spyOn(w.sessions, 'append').mockImplementation((session, message) => {
      if (message.content === CORREZIONE) throw new Error('disco pieno (simulato)');
      return originaleAppend(session, message);
    });

    const result = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: w.sessions.open('steer-perso'),
      text: 'rispondi subito',
      steer: () => coda.splice(0),
    });

    // Il guasto di una sessione non deve trasformare un turno riuscito in un
    // errore (lo dice già il commento su `scriviCorrezioniInSessione`).
    expect(result.stopped).toBe('answered');
    expect(result.text).toContain('fatto subito');
    // L'avviso non lo compone piu' `finish` con una costante di modulo: da
    // ADR-0054 §2 (emendamento 03/09c) c'e' un solo punto che svuota la porta
    // dello `/steer`, l'imbuto in `drive`, ed e' lui a parlare. La promessa
    // misurata qui non cambia — l'owner deve **sapere** che la correzione e'
    // andata persa — e in piu' l'imbuto gliela **ricita**, cosi' puo'
    // rimandarla senza riscriverla a memoria.
    expect(result.text).toContain('riuscito a salvare la correzione');
    expect(result.text).toContain(CORREZIONE);
  });

  it('senza guasto, la stessa correzione residua non lascia traccia nella risposta (il caso normale)', async () => {
    const coda: string[] = [];
    const w = world([answer('fatto subito')], (n) => {
      if (n === 1) coda.push(CORREZIONE);
    });

    const result = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: w.sessions.open('steer-ok'),
      text: 'rispondi subito',
      steer: () => coda.splice(0),
    });

    expect(result.text).toBe('fatto subito');
  });
});
