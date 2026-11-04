import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStatus } from '../core/autonomy/run-status.js';
import { ApprovalStore } from '../core/approvals/store.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl } from '../core/policy/types.js';
import { Delega } from '../core/runtime/delega.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { makeJobRunner } from './scheduler-run.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * #598 S3 — armed-once goal fires exactly once, delegation carried to the fire.
 *
 * Falsificatori:
 * - senza `markRan → disattiva` il secondo tick ritrova il job dovuto e il
 *   modello riparte (once-semantics rossa);
 * - senza il carry in `Delega.modo` il fire yolo sospende/chiede invece di
 *   consumare via stesso registro (decided_by delegation assente);
 * - se yolo trasformasse un deny in allow, il fire DENY eseguirebbe.
 *
 * Nessuna soglia auto/yolo inventata qui (#740): `auto` escala come `manual`,
 * `yolo` consuma via `ask → decide → take`, `deny` resta `deny` nel kernel.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next) throw new Error('lo script è finito — il modello non doveva essere richiamato di nuovo');
    return next;
  }
}

const usage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });
const call = (name: string, id: string, args: unknown = {}): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

const probeDecl: CapabilityDecl = {
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

const readDecl: CapabilityDecl = {
  id: 'demo.read',
  effect: 'context',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  maxTaint: 3,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

function world(script: ChatResult[], conChiusa = false) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-598-s3-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const jobs = new JobStore(db, () => new Date('2026-06-15T05:00:00Z'));
  const fires = new JobFireStore(db);
  const approvals = new ApprovalStore(db);
  const delega = new Delega(db);
  const provider = new Scripted(script);
  const eseguiti = { probe: 0, chiusa: 0 };
  const tools: RegisteredTool[] = [
    {
      capability: probeDecl.id,
      spec: {
        name: 'probe_act',
        description: 'probe',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
      handler: () => {
        eseguiti.probe += 1;
        return { content: 'fatto', tier: 0 as const };
      },
      throwTier: 0,
    },
  ];
  if (conChiusa) {
    tools.push({
      capability: 'probe.closed',
      spec: {
        name: 'probe_chiusa',
        description: 'probe senza dichiarazione',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => {
        eseguiti.chiusa += 1;
        return { content: 'fatto', tier: 0 as const };
      },
      throwTier: 0,
    });
  }
  const capabilities = new Map([
    [probeDecl.id, probeDecl],
    [readDecl.id, readDecl],
  ]);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test-model',
    tools,
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: false }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos,
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    approvals,
    delega,
    // Come la produzione senza approvatore sulla superficie del job
    // (`agent/runtime.ts`: superficie senza approvatore → 'unavailable'): la
    // riga di domanda resta scritta e il turno chiude `ask` — la consegna in
    // coda che S1 proietta come needs-owner.
    approve: async () => 'unavailable' as const,
  };
  const budget = { jobMonthUsd: (_id: string) => 0 };
  return { deps, db, jobs, fires, approvals, delega, provider, eseguiti, budget };
}

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('riga attesa assente');
  return v;
}

describe('#598 S3 · armed-once fires exactly once', () => {
  it('prima tick esegue il modello, seconda tick stessa occorrenza non lo richiama, markRan disattiva', async () => {
    const w = world([answer('fatto una volta')]);
    const job = w.jobs.addOnce({ timezone: 'Europe/Rome', channel: 'cli', goal: 'fai una cosa sola' });
    const scheduledFor = job.nextFireAt.toISOString();

    const first = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    if (!('stopped' in first)) throw new Error(`atteso JobOutcome, ricevuto ${JSON.stringify(first)}`);
    expect(first.stopped).toBe('answered');
    expect(w.provider.calls).toBe(1);
    const turnId = must(first.turnId);

    // Stessa occorrenza prima di markRan: B7 la risolve senza rieseguire.
    const second = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    expect(w.provider.calls).toBe(1);
    if (!('stopped' in second)) throw new Error(`atteso JobOutcome, ricevuto ${JSON.stringify(second)}`);
    expect(second.turnId).toBe(turnId);

    // markRan disattiva: il giro dopo non trova niente da far girare.
    const ran = w.jobs.markRan(job.id);
    expect(ran?.active).toBe(false);
    expect(w.jobs.due(new Date('2026-06-15T06:00:00Z'))).toEqual([]);
    expect(w.jobs.list()).toEqual([]);
    expect(w.jobs.get(job.id)?.active).toBe(false);
  });
});

describe('#598 S3 · manual → durable needs-owner via S1', () => {
  it('un fire manual con ASK resta una domanda durevole, senza eseguire', async () => {
    const w = world([call('probe_act', 'c1', { command: 'rm -rf /tmp/x' })]);
    const job = w.jobs.addOnce({ timezone: 'Europe/Rome', channel: 'cli', goal: 'fai quella cosa rischiosa' });
    expect(job.delegation).toBe('manual');

    const outcome = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    if (!('stopped' in outcome)) throw new Error(`atteso JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('ask');
    const turnId = must(outcome.turnId);

    expect(w.eseguiti.probe).toBe(0);
    expect(w.deps.turns.get(turnId)?.outcome).toBe('ask');
    // La domanda resta scritta (una riga, mai decisa): è la coda durevole che
    // S1 proietta come needs-owner. `openRows` la esclude una volta che il
    // turno è finito (withdrawn), ma la riga resta — niente si cancella.
    const righe = w.db.prepare(`SELECT decision FROM approvals WHERE turn_id = ?`).all(turnId) as {
      decision: string | null;
    }[];
    expect(righe.length).toBe(1);
    expect(righe[0]?.decision).toBeNull();

    // S1 proietta needs-owner dai soli fatti durevoli, senza ridefinire stati.
    const fire = must(w.fires.get(job.id, job.nextFireAt.toISOString()));
    expect(runStatus(w.db, fire).state).toBe('needs-owner');
  });

  it('auto senza busta calibrata escala come manual: nessuna soglia inventata', async () => {
    const w = world([call('probe_act', 'c1', { command: 'rm -rf /tmp/x' })]);
    const job = w.jobs.addOnce({
      timezone: 'Europe/Rome',
      channel: 'cli',
      goal: 'fai quella cosa rischiosa',
      delegation: 'auto',
    });
    expect(w.delega.modo).toBeDefined();

    const outcome = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    if (!('stopped' in outcome)) throw new Error(`atteso JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('ask');
    expect(w.eseguiti.probe).toBe(0);
    const fire = must(w.fires.get(job.id, job.nextFireAt.toISOString()));
    expect(runStatus(w.db, fire).state).toBe('needs-owner');
  });
});

describe('#598 S3 · yolo → stesso registro consume (decided_by delegation)', () => {
  it('un fire yolo consuma un ASK reale senza chiedere, via ask→decide→take', async () => {
    const w = world([call('probe_act', 'c1', { command: 'rm -rf /tmp/x' }), answer('fatto da solo')]);
    const job = w.jobs.addOnce({
      timezone: 'Europe/Rome',
      channel: 'cli',
      goal: 'fai quella cosa rischiosa da solo',
      delegation: 'yolo',
    });

    const outcome = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    if (!('stopped' in outcome)) throw new Error(`atteso JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('answered');
    expect(outcome.text).toBe('fatto da solo');
    expect(w.eseguiti.probe).toBe(1);

    // Stesso registro, non accanto: la riga dice chi ha deciso.
    const righe = w.db
      .prepare(`SELECT decision, decided_by, consumed_at FROM approvals ORDER BY asked_at`)
      .all() as { decision: string | null; decided_by: string | null; consumed_at: string | null }[];
    expect(righe.length).toBeGreaterThanOrEqual(1);
    const consumata = righe.find((r) => r.decision === 'allow');
    expect(consumata?.decided_by).toBe('delegation');
    expect(consumata?.consumed_at).not.toBeNull();

    // Il carry è per lettura (turns.job_id → jobs.delegation): nessuna riga
    // per-turn è stata mintata dal fire — la storia resta sul job.
    const turnId = must(outcome.turnId);
    const perTurn = w.db
      .prepare(`SELECT count(*) AS n FROM delegation_modes WHERE turn_id = ?`)
      .get(turnId) as { n: number };
    expect(perTurn.n).toBe(0);
    expect(w.delega.modo(turnId)).toBe('yolo');
  });
});

describe('#598 S3 · DENY resta DENY anche armato yolo', () => {
  it('una capability senza dichiarazione non esegue e non chiede', async () => {
    const w = world(
      [call('probe_chiusa', 'c1', {}), answer('non lo faccio, ma chiudo')],
      true,
    );
    const job = w.jobs.addOnce({
      timezone: 'Europe/Rome',
      channel: 'cli',
      goal: 'prova la chiusa',
      delegation: 'yolo',
    });

    const outcome = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    if (!('stopped' in outcome)) throw new Error(`atteso JobOutcome, ricevuto ${JSON.stringify(outcome)}`);
    expect(outcome.stopped).toBe('answered');
    expect(w.eseguiti.chiusa).toBe(0);
    // Nessuna domanda registrata per un deny: il kernel non ha mai chiesto.
    const righe = w.db.prepare(`SELECT count(*) AS n FROM approvals`).get() as { n: number };
    expect(righe.n).toBe(0);
  });
});
