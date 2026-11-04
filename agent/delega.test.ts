import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../core/approvals/store.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { Delega, levaDelega } from '../core/runtime/delega.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { resumeTurn, runTurn, type ApprovalWhere, type LoopDeps, type RegisteredTool } from './loop.js';
import type { ChatResult, Provider } from './providers/types.js';
import { CONSERVATIVE } from './profiles/profile.js';

/**
 * La delega dell'owner (issue #740): `/yolo` consuma gli ask, mai i divieti.
 *
 * Stesso harness di `agent/approvazione-differita.test.ts` — stessa `probe.act`
 * irreversibile sulla riga `host`, stesso approvatore che dice `asked` — più
 * la delega cablata nei `LoopDeps`. Ogni test qui sotto fallisce senza il ramo
 * di consumo in `agent/loop/tool-call.ts`: è il falsificatore della fetta.
 *
 * Nota sui round: ogni `ChatResult` dello script è un giro con una chiamata, e
 * una sospensione armata si onora al giro dopo — quindi un ask che «nasce dopo
 * /yolo» si prova sospendendo, attivando, risvegliando e riprendendo.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  chiamate = 0;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(_call: {
    messages: { content: { type: string; text?: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    this.chiamate += 1;
    return this.script[this.i++] ?? risposta('fine');
  }
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const risposta = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });

const probeAct: CapabilityDecl = {
  id: 'probe.act',
  effect: 'host',
  risk: 'high',
  reversible: 'no',
  rerunnable: false,
  maxTaint: 2,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

const owner: Principal = { kind: 'owner', connector: 'telegram', externalId: '4242' };

const chiamata = (id: string, command: string): ChatResult => ({
  text: null,
  toolCalls: [{ id, name: 'probe_act', args: { command, cwd: '/tmp' } }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

const chiamataChiusa = (id: string): ChatResult => ({
  text: null,
  toolCalls: [{ id, name: 'probe_chiusa', args: {} }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

type HarnessOpts = {
  /** Cosa fa l'approvatore oltre a rispondere (es. attiva yolo al primo ask). */
  duranteDomanda?: ((where: ApprovalWhere) => void) | undefined;
  /** Cosa fa il tool a ogni esecuzione (es. revoca la delega). */
  duranteEsecuzione?: ((volte: number) => void) | undefined;
  /** Una capability in più, senza dichiarazione nel kernel: il suo verdetto è deny. */
  conChiusa?: boolean | undefined;
};

function harness(sessione: string, script: ChatResult[], opts: HarnessOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-delega-'));
  const provider = new Scripted(script);
  const capabilities = new Map([[probeAct.id, probeAct]]);
  const db = new DatabaseCtor(':memory:');
  const approvals = new ApprovalStore(db);
  const delega = new Delega(db);
  const eseguito = { volte: 0 };
  const tools: RegisteredTool[] = [
    {
      capability: probeAct.id,
      spec: {
        name: 'probe_act',
        description: 'probe',
        inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } } },
      },
      handler: () => {
        eseguito.volte += 1;
        opts.duranteEsecuzione?.(eseguito.volte);
        return { content: 'fatto', tier: 0 as const };
      },
      throwTier: 0,
    },
  ];
  if (opts.conChiusa === true) {
    tools.push({
      capability: 'probe.closed',
      spec: {
        name: 'probe_chiusa',
        description: 'probe senza dichiarazione',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => {
        eseguito.volte += 1;
        return { content: 'fatto', tier: 0 as const };
      },
      throwTier: 0,
    });
  }
  const chieste: ApprovalWhere[] = [];
  const turns = new TurnStore(db);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: false }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    approvals,
    delega,
    approve: async (_request, where) => {
      chieste.push(where);
      opts.duranteDomanda?.(where);
      return 'asked';
    },
  };
  const parti = () =>
    runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: deps.sessions.open(sessione),
      text: 'fai quelle cose',
      replyTo: { chatId: 4242, messageId: 7 },
    });
  return { db, deps, approvals, delega, turns, eseguito, chieste, parti };
}

type RigaAudit = { resource: string | null; decision: string | null; decided_by: string | null; consumed_at: string | null };

function audit(db: DatabaseCtor.Database): RigaAudit[] {
  return db
    .prepare(`SELECT resource, decision, decided_by, consumed_at FROM approvals ORDER BY asked_at`)
    .all() as RigaAudit[];
}

describe('A — il kernel resta sovrano: deny è deny in ogni modalità', () => {
  it('yolo sul lavoro vero non fa passare una capability senza dichiarazione', async () => {
    const h = harness(
      'telegram:4242',
      [chiamata('c1', 'rm -rf /tmp/x'), chiamataChiusa('c2'), risposta('fine')],
      { conChiusa: true },
    );
    const primo = await h.parti();
    expect(primo.stopped).toBe('suspended');

    // L'owner attiva yolo sul lavoro vero, che si risveglia senza risposta.
    h.delega.metti(primo.turnId, 'yolo', 'owner', new Date());
    h.turns.wake(primo.turnId, new Date());
    const ripreso = await resumeTurn(h.deps, primo.turnId);

    expect('stopped' in ripreso && ripreso.stopped).toBe('answered');
    // La chiusa non ha girato e non ha nemmeno chiesto: il ramo ask non l'ha vista.
    expect(h.eseguito.volte).toBe(0);
    expect(h.chieste).toHaveLength(1);
  });
});

describe('B — manual è il comportamento di oggi, esattamente', () => {
  it('senza riga di delega l ask si sospende e chiede, come sempre', async () => {
    const h = harness('telegram:4242', [chiamata('c1', 'rm -rf /tmp/x')]);
    const esito = await h.parti();

    expect(esito.stopped).toBe('suspended');
    expect(h.chieste).toHaveLength(1);
    expect(h.eseguito.volte).toBe(0);
    expect(h.delega.modo(esito.turnId)).toBe('manual');
  });
});

describe('E — yolo: un ask ordinario esegue senza chiedere', () => {
  it('l ask che nasce dopo /yolo non tocca la superficie e lascia traccia di delega', async () => {
    const h = harness('telegram:4242', [chiamata('c1', 'rm -rf /tmp/x'), chiamata('c2', 'rm -rf /tmp/y'), risposta('fine')]);
    const primo = await h.parti();
    expect(primo.stopped).toBe('suspended');

    // /yolo scritto diretto (senza decidere la domanda aperta): la seconda
    // chiamata deve passare per il ramo di consumo, non per la superficie.
    h.delega.metti(primo.turnId, 'yolo', 'owner', new Date());
    h.turns.wake(primo.turnId, new Date());
    await resumeTurn(h.deps, primo.turnId);

    // Una sola domanda alla superficie (la prima); la seconda è passata per delega.
    expect(h.chieste).toHaveLength(1);
    expect(h.eseguito.volte).toBe(1);
    const righe = audit(h.db);
    const seconda = righe.find((r) => r.resource?.includes('/tmp/y') === true);
    expect(seconda?.decision).toBe('allow');
    expect(seconda?.decided_by).toBe('delegation');
    expect(seconda?.consumed_at).not.toBeNull();
    // La prima resta una domanda aperta (mai decisa da nessuno).
    const prima = righe.find((r) => r.resource?.includes('/tmp/x') === true);
    expect(prima?.decision).toBeNull();
  });

  it('/yolo su un lavoro sospeso decide la domanda aperta e lo risveglia, come il pulsante', async () => {
    const h = harness('telegram:4242', [chiamata('c1', 'rm -rf /tmp/x'), chiamata('c2', 'rm -rf /tmp/x'), risposta('fatto')]);
    const primo = await h.parti();
    expect(primo.stopped).toBe('suspended');

    // L'owner manda /yolo: la stessa leva dei comandi veri.
    let spinta = 0;
    const leva = levaDelega({
      delega: h.delega,
      approvals: h.approvals,
      turns: h.turns,
      sessionId: () => 'telegram:4242',
      onWork: () => {
        spinta += 1;
      },
    });
    const esito = leva.metti('yolo');
    expect(esito).toEqual({ turnId: primo.turnId, cambiato: true, risposteDate: 1 });
    expect(spinta).toBe(1);

    const ripreso = await resumeTurn(h.deps, primo.turnId);
    expect('stopped' in ripreso && ripreso.stopped).toBe('answered');
    expect(h.eseguito.volte).toBe(1);
    // Nessuna seconda domanda: la risposta decisa per delega è stata consumata.
    expect(h.chieste).toHaveLength(1);
    const domanda = h.approvals.get(h.chieste[0]!.approvalId!);
    expect(domanda?.decision).toBe('allow');
    expect(domanda?.decidedBy).toBe('delegation');
    // La delega sopravvive alla ripresa: riavviare non la dimentica.
    expect(h.delega.modo(primo.turnId)).toBe('yolo');
  });
});

describe('G — /manual revoca subito: l ask dopo chiede di nuovo', () => {
  it('revoca a metà turno: la terza chiamata torna all owner', async () => {
    const h = harness(
      'telegram:4242',
      [chiamata('c1', 'rm -rf /tmp/x'), chiamata('c2', 'rm -rf /tmp/y'), chiamata('c3', 'rm -rf /tmp/z'), risposta('fine')],
      {
        duranteDomanda: (where) => {
          if (h.chieste.length === 1) h.delega.metti(where.turnId, 'yolo', 'owner', new Date());
        },
        duranteEsecuzione: (volte) => {
          // Dopo la prima esecuzione (la seconda chiamata, per delega)
          // l'owner torna in manuale.
          if (volte === 1) h.delega.metti(h.chieste[0]!.turnId, 'manual', 'owner', new Date());
        },
      },
    );
    const primo = await h.parti();
    expect(primo.stopped).toBe('suspended');

    h.turns.wake(primo.turnId, new Date());
    await resumeTurn(h.deps, primo.turnId);

    // c1 chiesta, c2 per delega, c3 di nuovo all'owner.
    expect(h.eseguito.volte).toBe(1);
    expect(h.chieste).toHaveLength(2);
  });
});

describe('F — la delega è del lavoro, non della chat', () => {
  it('yolo su un altro lavoro non tocca questo turno', async () => {
    const h = harness('telegram:4242', [chiamata('c1', 'rm -rf /tmp/x')]);
    h.delega.metti('un-altro-lavoro', 'yolo', 'owner', new Date());
    const esito = await h.parti();

    expect(esito.stopped).toBe('suspended');
    expect(h.chieste).toHaveLength(1);
    expect(h.eseguito.volte).toBe(0);
  });
});

describe('auto senza calibrazione: ogni ask sale all owner', () => {
  it('la busta è vuota, quindi chiede — ma la modalità resta visibile', async () => {
    const h = harness('telegram:4242', [chiamata('c1', 'rm -rf /tmp/x'), chiamata('c2', 'rm -rf /tmp/y'), risposta('fine')]);
    const primo = await h.parti();
    expect(primo.stopped).toBe('suspended');

    h.delega.metti(primo.turnId, 'auto', 'owner', new Date());
    h.turns.wake(primo.turnId, new Date());
    await resumeTurn(h.deps, primo.turnId);

    expect(h.chieste).toHaveLength(2);
    expect(h.eseguito.volte).toBe(0);
    expect(h.delega.modo(primo.turnId)).toBe('auto');
  });
});
