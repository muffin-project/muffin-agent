import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../core/approvals/store.js';
import { SHADOW_PACK } from '../core/judgment/pack.js';
import type {
  JudgmentAnswer,
  JudgmentQuestion,
  SystemOnePort,
  SystemOneVerdict,
} from '../core/judgment/port.js';
import { makeShadowJudge, type ShadowJudge } from '../core/judgment/shadow.js';
import { JudgmentStore } from '../core/judgment/store.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { Delega } from '../core/runtime/delega.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import {
  type ApprovalWhere,
  type LoopDeps,
  type RegisteredTool,
  resumeTurn,
  runTurn,
} from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * System One in shadow sul percorso di produzione del loop (#740 fase 1):
 * il giudizio parte accanto alla domanda, la lascia intatta, e lascia la
 * riga che la fase 2 confronterà con la decisione dell'owner. Il
 * falsificatore della fetta: staccare l'hook in `tool-call.ts` rende rosso
 * il primo test (nessuna riga) senza toccare gli altri.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(_call: {
    messages: { content: { type: string; text?: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    return this.script[this.i++] ?? risposta('fine');
  }
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const risposta = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage,
  model: 'test',
});

const probeAct: CapabilityDecl = {
  id: 'sys.shell.write',
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

const chiamata = (id: string, description?: string): ChatResult => ({
  text: null,
  toolCalls: [
    {
      id,
      name: 'probe_act',
      args: {
        command: 'echo ciao',
        cwd: '.',
        ...(description === undefined ? {} : { description }),
      },
    },
  ],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

const verdetto = (): SystemOneVerdict => ({
  provider: 'finto',
  model: 'finto-1.0',
  answers: Object.fromEntries(
    SHADOW_PACK.map((q) => [q.id, { kind: 'noul', probability: 0.9 } as JudgmentAnswer]),
  ),
  usage: { inputTokens: 300, outputTokens: 30 },
  latencyMs: 5,
});

type Porto = { esiti: ('ok' | 'error')[] } & SystemOnePort;

const porto = (esiti: ('ok' | 'error')[]): Porto => ({
  provider: 'finto',
  model: 'finto-1.0',
  esiti,
  judge: async (_input: { state: object; questions: readonly JudgmentQuestion[] }) => {
    const esito = esiti.shift() ?? 'ok';
    if (esito === 'error') throw new Error('provider giù');
    return verdetto();
  },
});

function harness(script: ChatResult[], conGiudizio?: Porto) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-ask-shadow-'));
  const provider = new Scripted(script);
  const capabilities = new Map([[probeAct.id, probeAct]]);
  const db = new DatabaseCtor(':memory:');
  const approvals = new ApprovalStore(db);
  const delega = new Delega(db);
  const judgmentStore = new JudgmentStore(db);
  const eseguito = { volte: 0 };
  const tool: RegisteredTool = {
    capability: probeAct.id,
    spec: {
      name: 'probe_act',
      description: 'probe',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    handler: () => {
      eseguito.volte += 1;
      return { content: 'fatto', tier: 0 as const };
    },
    throwTier: 0,
  };
  const chieste: ApprovalWhere[] = [];
  let judgment: ShadowJudge | undefined;
  if (conGiudizio !== undefined) {
    judgment = makeShadowJudge({
      port: conGiudizio,
      store: judgmentStore,
      tracer: new SimpleTracer(new JsonlExporter(home)),
    });
  }
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools: [tool],
    capabilities,
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities,
      budgetExhausted: () => false,
      hardened: false,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(db),
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    approvals,
    delega,
    ...(judgment === undefined ? {} : { judgment }),
    approve: async (_request, where) => {
      chieste.push(where);
      return 'asked';
    },
  };
  const parti = () =>
    runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      session: deps.sessions.open('telegram:4242'),
      text: 'esegui echo ciao per favore',
      replyTo: { chatId: 4242, messageId: 7 },
    });
  return { deps, judgmentStore, eseguito, chieste, parti };
}

const attesa = async (condizione: () => boolean, ms = 2000): Promise<void> => {
  const scadenza = Date.now() + ms;
  while (!condizione()) {
    if (Date.now() > scadenza) throw new Error('attesa scaduta');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * La degradazione dichiarata dall'ADR-0096: config che nomina il giudice ma
 * segreto mancato → nessun giudizio cablato, nessuna eccezione, una riga
 * nelle bootLines. È il «capability accesa e non raggiungibile» di sempre,
 * provato sul runtime vero e non a parole.
 */
describe('buildRuntime: il giudice senza segreto si dice, non si rompe', () => {
  it('config judgment + segreto assente → bootLine, deps.judgment assente', async () => {
    const { runInit } = await import('../cli/init.js');
    const { buildRuntime } = await import('./runtime.js');
    const { writeFileSync } = await import('node:fs');
    const home = mkdtempSync(join(tmpdir(), 'muffin-shadow-degrade-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
    config['judgment'] = { provider: 'typesafe', apiKeyRef: 'secret://typesafe_key' };
    writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-shadow-degrade-ws-')));
    try {
      expect(runtime.deps.judgment).toBeUndefined();
      expect(runtime.bootLines.join('\n')).toContain('system one');
      expect(runtime.bootLines.join('\n')).toContain('segreto manca');
    } finally {
      runtime.close();
    }
  });
});

describe('il giudizio shadow parte accanto alla domanda e non la tocca', () => {
  it('riga ok: judgment per l ask della famiglia shell, join per approval id', async () => {
    const p = porto(['ok']);
    const h = harness([chiamata('c1', 'stampa la parola ciao')], p);
    const esito = await h.parti();

    // Il percorso dell'owner è quello di sempre: sospeso, non eseguito.
    expect(esito.stopped).toBe('suspended');
    expect(h.eseguito.volte).toBe(0);
    expect(h.chieste).toHaveLength(1);

    const approvalId = h.chieste[0]?.approvalId;
    if (approvalId === undefined) throw new Error('nessuna domanda registrata');
    await attesa(() => h.judgmentStore.forApproval(approvalId)?.status === 'ok');
    const riga = h.judgmentStore.forApproval(approvalId);
    expect(riga?.turnId).toBe(esito.turnId);
    expect(riga?.capability).toBe('sys.shell.write');
    expect(riga?.delegationMode).toBe('manual');
    // L'envelope porta ciò che il giudice ha visto: comando, descrizione, intento.
    const envelope = JSON.parse(riga?.envelope ?? '{}') as Record<string, unknown>;
    const azione = envelope.action as Record<string, unknown>;
    expect(String(azione.resource)).toContain('echo ciao');
    expect(String(azione.description)).toContain('stampa la parola ciao');
    expect(String(envelope.owner_request)).toContain('esegui echo ciao');
    const risposte = JSON.parse(riga?.answers ?? '{}') as Record<string, JudgmentAnswer>;
    expect(risposte.human_judgment_required).toEqual({ kind: 'noul', probability: 0.9 });
  });

  it('senza giudizio cablato: nessuna riga, e nessun byte parte', async () => {
    const h = harness([chiamata('c1')]);
    const esito = await h.parti();
    expect(esito.stopped).toBe('suspended');
    expect(h.judgmentStore.count()).toBe(0);
  });

  it('provider giù: riga error, e la domanda all owner non si accorge di niente', async () => {
    const p = porto(['error']);
    const h = harness([chiamata('c1')], p);
    const esito = await h.parti();
    expect(esito.stopped).toBe('suspended');
    const approvalId = h.chieste[0]?.approvalId;
    if (approvalId === undefined) throw new Error('nessuna domanda registrata');
    await attesa(() => h.judgmentStore.forApproval(approvalId)?.status === 'error');
    expect(h.judgmentStore.forApproval(approvalId)?.detail).toContain('provider giù');
  });

  it('sotto yolo non si giudica: consumato per delega, nessuna domanda nuova', async () => {
    const p = porto(['ok']);
    const h = harness(
      [chiamata('c1', 'stampa la parola ciao'), chiamata('c2'), risposta('fatto')],
      p,
    );
    const primo = await h.parti();
    expect(primo.stopped).toBe('suspended');

    // La prima domanda (in manuale) è stata giudicata: era una domanda vera.
    const approvalId = h.chieste[0]?.approvalId;
    if (approvalId === undefined) throw new Error('nessuna domanda registrata');
    await attesa(() => h.judgmentStore.forApproval(approvalId)?.status === 'ok');
    expect(h.judgmentStore.count()).toBe(1);

    // Poi l'owner attiva yolo: la ripetizione della chiamata passa per
    // delega — niente nuova domanda, e niente nuovo giudizio (non c'è
    // decisione owner da calibrare).
    h.deps.delega?.metti(primo.turnId, 'yolo', 'owner', new Date());
    h.deps.turns.wake(primo.turnId, new Date());
    const ripreso = await resumeTurn(h.deps, primo.turnId);
    expect('stopped' in ripreso && ripreso.stopped).toBe('answered');
    expect(h.eseguito.volte).toBe(1);
    expect(h.chieste).toHaveLength(1);
    expect(h.judgmentStore.count()).toBe(1);
  });
});
