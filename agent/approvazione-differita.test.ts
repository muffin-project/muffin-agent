import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../core/approvals/store.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { decodeWaitFor } from '../core/turns/wait.js';
import { resumeTurn, runTurn, type ApprovalWhere, type LoopDeps, type RegisteredTool } from './loop.js';
import { runInit } from '../cli/init.js';
import { buildRuntime } from './runtime.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * Chiedere l'approvazione a chi non è davanti allo schermo.
 *
 * Prima di questa slice il kernel aveva due sole risposte: chiedo **adesso**,
 * o dico che qui non posso chiedere. Su Telegram valeva sempre la seconda,
 * cioè dal telefono non era usabile niente di ciò che chiede conferma — che
 * oggi è quasi tutto, perché finché `muffin rot harden` non è stato fatto
 * `sys.shell` chiede sempre.
 *
 * La terza risposta è `asked`: la domanda parte, il turno si **sospende su una
 * barriera persistita**, e riprende quando la risposta arriva — anche se nel
 * frattempo il processo è morto. È il meccanismo di `wait` (ADR-0047) applicato
 * a una domanda invece che a un'attesa, ed è il consumer che `M5-BIS` D12
 * chiede da mesi per la coda durevole degli ask.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  letti: string[] = [];
  chiamate = 0;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; text?: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    this.chiamate += 1;
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) this.letti.push(b.text);
        if (b.type === 'tool_result' && b.content) this.letti.push(b.content);
      }
    }
    return this.script[this.i++] ?? risposta('fine');
  }
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const risposta = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });

/** La forma di `sys.shell`: rischio alto, nessuna risorsa del kernel. */
const probeAct: CapabilityDecl = {
  id: 'probe.act',
  risk: 'high',
  reversible: 'no',
  rerunnable: false,
  maxTaint: 3,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

const owner: Principal = { kind: 'owner', connector: 'telegram', externalId: '4242' };

const chiamata = (id = 'c1'): ChatResult => ({
  text: null,
  toolCalls: [{ id, name: 'probe_act', args: { command: 'rm -rf /tmp/x', cwd: '/tmp' } }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

function harness(script: ChatResult[], opts: { conRegistro?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-appr-diff-'));
  const provider = new Scripted(script);
  const capabilities = new Map([[probeAct.id, probeAct]]);
  const db = new DatabaseCtor(':memory:');
  const approvals = new ApprovalStore(db);
  const eseguito = { volte: 0 };
  const tool: RegisteredTool = {
    capability: probeAct.id,
    spec: {
      name: 'probe_act',
      description: 'probe',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } } },
    },
    handler: () => {
      eseguito.volte += 1;
      return { content: 'fatto', tier: 0 as const };
    },
    throwTier: 0,
  };
  const chieste: ApprovalWhere[] = [];
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools: [tool],
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: false }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(db),
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    ...(opts.conRegistro === false ? {} : { approvals }),
    approve: async (_request, where) => {
      chieste.push(where);
      return 'asked';
    },
  };
  return { deps, provider, approvals, eseguito, chieste, home };
}

const parti = (deps: LoopDeps, home: string) =>
  runTurn(deps, {
    principal: owner,
    tenant: 'host',
    surface: 'telegram',
    session: deps.sessions.open('telegram:4242'),
    text: 'cancella quel file',
    replyTo: { chatId: 4242, messageId: 7 },
  });

describe('la domanda parte e il turno si mette da parte', () => {
  it('il turno si sospende su una barriera che porta il nome della domanda, e il tool non gira', async () => {
    const h = harness([chiamata()]);
    const esito = await parti(h.deps, h.home);

    expect(esito.stopped).toBe('suspended');
    expect(h.eseguito.volte).toBe(0);

    // La domanda è nel registro, aperta, e la barriera del turno la nomina.
    const aperta = h.approvals.open(esito.turnId);
    expect(aperta).not.toBeNull();
    expect(aperta?.capability).toBe('probe.act');
    // D12: ciò che l'owner leggerà è l'azione, non il nome della capability.
    expect(aperta?.resource).toContain('rm -rf /tmp/x');

    const riga = h.deps.turns.get(esito.turnId)!;
    expect(riga.status).toBe('waiting');
    expect(decodeWaitFor(riga.waitFor)).toEqual({ kind: 'approval', id: aperta!.id });
    // La scadenza c'è sempre: una domanda dimenticata non tiene un turno per sempre.
    expect(riga.wakeAt).not.toBeNull();
  });

  /**
   * L'approvatore riceve **dove** sta il turno. Era il difetto vero della
   * versione precedente: una funzione sola per processo, quindi un turno
   * arrivato da Telegram faceva comparire la domanda nel terminale.
   */
  it("e l'approvatore sa da quale superficie arriva il turno, e a quale indirizzo", async () => {
    const h = harness([chiamata()]);
    const esito = await parti(h.deps, h.home);

    expect(h.chieste[0]?.surface).toBe('telegram');
    expect(h.chieste[0]?.turnId).toBe(esito.turnId);
    expect(h.chieste[0]?.replyTo).toEqual({ chatId: 4242, messageId: 7 });
    // L'id viaggia dentro il pulsante: senza, la risposta tornerebbe senza
    // sapere a quale domanda appartiene.
    expect(h.chieste[0]?.approvalId).toBe(h.approvals.open(esito.turnId)?.id);
  });

  /**
   * Una superficie che dice «l'ho chiesto» senza un registro dove la risposta
   * possa tornare avrebbe sospeso il turno su una barriera che nessuno può
   * soddisfare. Meglio la vecchia risposta onesta.
   */
  it('senza registro, «l ho chiesto» torna a essere «qui non posso chiedertelo»', async () => {
    const h = harness([chiamata()], { conRegistro: false });
    const esito = await parti(h.deps, h.home);

    expect(esito.stopped).toBe('ask');
    expect(esito.text).toContain('non posso chiederla');
    expect(h.eseguito.volte).toBe(0);
  });
});

describe('la risposta arriva, e il lavoro riparte', () => {
  it('un sì fa partire proprio quella chiamata, senza richiedere niente', async () => {
    const h = harness([chiamata(), chiamata('c2'), risposta('fatto')]);
    const primo = await parti(h.deps, h.home);

    const id = h.approvals.open(primo.turnId)!.id;
    h.approvals.decide(id, 'allow', new Date());
    // Quello che fa la lane al suo battito: da `waiting` a `runnable`.
    expect(h.deps.turns.wake(primo.turnId, new Date())).toBe(true);

    const ripreso = await resumeTurn(h.deps, primo.turnId);

    expect('stopped' in ripreso && ripreso.stopped).toBe('answered');
    expect(h.eseguito.volte).toBe(1);
    // Il modello è stato avvisato che la risposta era arrivata.
    expect(h.provider.letti.some((t) => t.includes("L'owner ha risposto"))).toBe(true);
    // E nessuna seconda domanda: la risposta c'era già.
    expect(h.chieste).toHaveLength(1);
  });

  it('un no non fa partire niente, e lo dice al modello', async () => {
    const h = harness([chiamata(), chiamata('c2'), risposta('non l ho fatto')]);
    const primo = await parti(h.deps, h.home);

    h.approvals.decide(h.approvals.open(primo.turnId)!.id, 'deny', new Date());
    h.deps.turns.wake(primo.turnId, new Date());
    await resumeTurn(h.deps, primo.turnId);

    expect(h.eseguito.volte).toBe(0);
    expect(h.provider.letti.some((t) => t.includes('ha rifiutato'))).toBe(true);
  });

  /**
   * **La proprietà di sicurezza.** Un sì vale una volta, sulla chiamata per
   * cui è stato chiesto. Senza, l'owner che consente un comando avrebbe
   * consentito ogni comando successivo dello stesso turno — un interruttore
   * girato senza saperlo, non una domanda.
   */
  it('e vale una volta sola: la chiamata dopo torna a chiedere', async () => {
    const h = harness([chiamata(), chiamata('c2'), chiamata('c3'), risposta('ok')]);
    const primo = await parti(h.deps, h.home);

    h.approvals.decide(h.approvals.open(primo.turnId)!.id, 'allow', new Date());
    h.deps.turns.wake(primo.turnId, new Date());
    const ripreso = await resumeTurn(h.deps, primo.turnId);

    expect(h.eseguito.volte).toBe(1);
    // La seconda chiamata identica non è passata: si è sospeso di nuovo,
    // con una domanda nuova.
    expect('stopped' in ripreso && ripreso.stopped).toBe('suspended');
    expect(h.chieste).toHaveLength(2);
    expect(h.chieste[1]?.approvalId).not.toBe(h.chieste[0]?.approvalId);
  });

  /**
   * Nessuno ha premuto niente. Il turno si sveglia comunque alla sua scadenza
   * e **lo dice**: l'owner legge «non hai risposto, non l'ho fatto» invece di
   * non leggere niente.
   */
  it('e se nessuno risponde, la scadenza sveglia il turno che lo racconta', async () => {
    const h = harness([chiamata(), risposta('te lo dico')]);
    const primo = await parti(h.deps, h.home);

    // Nessun `decide`: solo il tempo.
    h.deps.turns.wake(primo.turnId, new Date());
    await resumeTurn(h.deps, primo.turnId);

    expect(h.eseguito.volte).toBe(0);
    expect(h.provider.letti.some((t) => t.includes('non ha risposto'))).toBe(true);
  });
});

describe("chi chiede è la superficie da cui il turno è arrivato", () => {
  /**
   * Il difetto vero della versione precedente: `deps.approve` era **una
   * funzione per processo**, e il REPL ci scriveva la sua. Un turno arrivato da
   * Telegram faceva quindi comparire `[s/N]` nel terminale — la domanda a chi
   * non l'aveva fatta, su uno schermo che in quel momento nessuno guarda,
   * mentre il telefono taceva.
   *
   * Provato sull'instradatore vero, quello che `buildRuntime` cabla: riscriverne
   * uno qui dentro proverebbe soltanto che so scrivere lo stesso codice due volte.
   */
  const domanda = { capability: 'probe.act', prompt: 'eseguo?', taint: 0 as const };

  it('un turno di Telegram non finisce a chiedere al terminale', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-appr-route-'));
    runInit({ home, apiKey: 'sk-instradatore-never-called' });
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-appr-route-ws-')));

    let terminaleInterrogato = false;
    runtime.approvers.set('cli', async () => {
      terminaleInterrogato = true;
      return 'allow';
    });

    expect(await runtime.deps.approve!(domanda, { surface: 'telegram', turnId: 't1' })).toBe('unavailable');
    expect(terminaleInterrogato).toBe(false);

    expect(await runtime.deps.approve!(domanda, { surface: 'cli', turnId: 't1' })).toBe('allow');
    expect(terminaleInterrogato).toBe(true);
  });
});
