import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from '../core/approvals/store.js';
import { formatRunStatus, runStatus } from '../core/autonomy/run-status.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl } from '../core/policy/types.js';
import { Delega } from '../core/runtime/delega.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { type Job, JobStore } from '../core/scheduler/jobs.js';
import { type JobOutcome, Scheduler, type SchedulerEvent } from '../core/scheduler/scheduler.js';
import { SessionStore } from '../core/session/store.js';
import { DELIVERED } from '../core/surface/types.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { makeJobRunner } from './scheduler-run.js';

/**
 * #598 S4 — delivery policy: routine success settles to a durable receipt
 * with zero conversational message, needs-owner still surfaces.
 *
 * Falsificatori (uno per gamba del claim):
 * - policy=silent + successo → nessun messaggio E ricevuta interrogabile
 *   (rosso: deliver chiamato, oppure fire senza silent);
 * - policy assente → consegna di oggi (rosso se tace: il default deve parlare);
 * - policy=silent + needs-owner → arriva comunque (rosso se inghiottito);
 * - policy=silent + guasto → arriva comunque (un guasto silenzioso mente).
 *
 * Solo `answered` può tacere: la S1 proietta gli stati, questa slice non li
 * ridefinisce — qui si prova il ramo di consegna e la ricevuta sul fire.
 */

const SPEC = { cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' };
const AFTER_FIRE = new Date('2026-06-15T06:00:00Z');
const BEFORE_ADD = new Date('2026-06-15T05:00:00Z');
const flush = () => new Promise((r) => setImmediate(r));

const counters = {
  iterations: 1,
  recoveriesUsed: 0,
  transportRetriesLeft: 2,
  truncationsUsed: 0,
  toolCallsMade: 0,
  nudgedForCompletion: false,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  spentUsd: 0,
  resumes: 0,
  contextBuilt: true,
};

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('riga attesa assente');
  return v;
}

function stubWorld() {
  let current = BEFORE_ADD;
  const clock = () => current;
  const db = new DatabaseCtor(':memory:');
  const store = new JobStore(db, clock);
  const fires = new JobFireStore(db, clock);
  const turns = new TurnStore(db, clock);
  return { db, store, fires, turns, clock, set: (d: Date) => (current = d) };
}

/** A finished turn row, so the S1 projection has work to read. */
function answeredTurn(w: ReturnType<typeof stubWorld>, id: string): void {
  const aperta = w.turns.create({
    id,
    principal: { kind: 'system', source: 'scheduler' },
    tenant: 'host',
    surface: 'cli',
    sessionId: 'sess-s4',
    model: 'test',
    messages: [],
    taint: 0,
    counters,
  });
  w.turns.finish(id, { outcome: 'answered', messages: [], taint: 0, counters }, aperta.claimToken);
}

function drive(
  w: ReturnType<typeof stubWorld>,
  runJob: (job: Job) => Promise<JobOutcome>,
  events: SchedulerEvent[],
  deliver: ReturnType<typeof vi.fn>,
  recorded: Array<[string, string]>,
) {
  // Lo stub rivendica l'occorrenza come `makeJobRunner` fa in produzione
  // (B7): senza claim non c'è riga su cui settle possa scrivere la ricevuta.
  // Lega anche il turno al fire, così la proiezione S1 legge il lavoro vero.
  const claiming = async (job: Job): Promise<JobOutcome> => {
    const scheduledFor = job.nextFireAt.toISOString();
    w.fires.claim(job.id, scheduledFor);
    const outcome = await runJob(job);
    if (outcome.turnId !== null) w.fires.bind(job.id, scheduledFor, outcome.turnId);
    return outcome;
  };
  return new Scheduler(
    w.store,
    claiming,
    deliver,
    undefined,
    (e) => events.push(e),
    w.clock,
    undefined,
    (turnId, state) => recorded.push([turnId, state]),
    new ModelLane(),
    undefined,
    // Stesso cablaggio della produzione (`cli/gateway.ts`): la ricevuta
    // silenziosa viaggia sullo stesso settle, non su una seconda strada.
    (job, opts) => w.fires.settle(job.id, job.nextFireAt.toISOString(), opts),
  );
}

describe('#598 S4 · il ramo di consegna (stub runJob, store veri)', () => {
  it('silent + answered → zero messaggi, schedulazione avanza, ricevuta durevole e interrogabile', async () => {
    const w = stubWorld();
    const job = w.store.add({ ...SPEC, delivery: 'silent' });
    w.set(AFTER_FIRE);
    answeredTurn(w, 'turn-s4-silent');
    const deliver = vi.fn(async (_channel: string, _text: string) => DELIVERED);
    const events: SchedulerEvent[] = [];
    const recorded: Array<[string, string]> = [];
    const sched = drive(
      w,
      async () => ({ stopped: 'answered', text: 'il brief', turnId: 'turn-s4-silent' }),
      events,
      deliver,
      recorded,
    );

    sched.tick();
    await flush();

    // Zero conversational message.
    expect(deliver).not.toHaveBeenCalled();
    // Ma il giro è completo: la schedulazione avanza come dopo una consegna.
    expect(must(w.store.get(job.id)).lastRunAt).not.toBeNull();
    // La ricevuta è durevole: sulla riga del fire, non in un log.
    const fire = must(w.fires.get(job.id, job.nextFireAt.toISOString()));
    expect(fire.settledAt).not.toBeNull();
    expect(fire.silent).toBe(true);
    // E interrogabile dalla proiezione S1: done + ricevuta, senza ridefinire stati.
    const status = runStatus(w.db, fire);
    expect(status.state).toBe('done');
    expect(status.silent).toBe(true);
    // La stessa riga che sys.inspect stampa: la ricevuta ci arriva da sola.
    const line = formatRunStatus(status);
    expect(line).toContain('done');
    expect(line).toContain('· silent');
    // L'evento resta onesto: niente è stato consegnato, e lo dice.
    expect(events.find((e) => e.kind === 'ran')).toMatchObject({
      stopped: 'answered',
      delivered: false,
    });
  });

  it('policy assente → consegna di oggi: il default parla (rosso se tace)', async () => {
    const w = stubWorld();
    const job = w.store.add(SPEC);
    expect(job.delivery).toBe('deliver');
    w.set(AFTER_FIRE);
    answeredTurn(w, 'turn-s4-default');
    const deliver = vi.fn(async (_channel: string, _text: string) => DELIVERED);
    const events: SchedulerEvent[] = [];
    const sched = drive(
      w,
      async () => ({ stopped: 'answered', text: 'il brief', turnId: 'turn-s4-default' }),
      events,
      deliver,
      [],
    );

    sched.tick();
    await flush();

    expect(deliver).toHaveBeenCalledWith('cli', 'il brief');
    expect(must(w.store.get(job.id)).lastRunAt).not.toBeNull();
    const fire = must(w.fires.get(job.id, job.nextFireAt.toISOString()));
    expect(fire.silent).toBe(false);
    const status = runStatus(w.db, fire);
    expect(status.state).toBe('done');
    expect(status.silent).toBeUndefined();
    expect(formatRunStatus(status)).not.toContain('silent');
  });

  it('silent + ask → needs-owner arriva comunque (rosso se inghiottito)', async () => {
    const w = stubWorld();
    const job = w.store.add({ ...SPEC, delivery: 'silent' });
    w.set(AFTER_FIRE);
    const deliver = vi.fn(async (_channel: string, _text: string) => DELIVERED);
    const events: SchedulerEvent[] = [];
    const sched = drive(
      w,
      async () => ({
        stopped: 'ask',
        text: 'In coda per te: "probe.act" — conferma?',
        turnId: 'turn-s4-ask',
      }),
      events,
      deliver,
      [],
    );

    sched.tick();
    await flush();

    expect(deliver).toHaveBeenCalledWith('cli', 'In coda per te: "probe.act" — conferma?');
    expect(must(w.store.get(job.id)).lastRunAt).not.toBeNull();
    // La domanda non è un successo ordinario: nessuna ricevuta silenziosa.
    expect(must(w.fires.get(job.id, job.nextFireAt.toISOString())).silent).toBe(false);
  });

  it('silent + error → il guasto arriva comunque: un guasto silenzioso mente', async () => {
    const w = stubWorld();
    w.store.add({ ...SPEC, delivery: 'silent' });
    w.set(AFTER_FIRE);
    const deliver = vi.fn(async (_channel: string, _text: string) => DELIVERED);
    const sched = drive(
      w,
      async () => ({ stopped: 'error', text: 'il provider non risponde', turnId: 'turn-s4-err' }),
      [],
      deliver,
      [],
    );

    sched.tick();
    await flush();

    expect(deliver).toHaveBeenCalledWith('cli', 'il provider non risponde');
  });

  it('silent + testo vuoto → il ramo del silenzio preesistente, senza ricevuta S4', async () => {
    // Ordine documentato: un fire vuoto taceva già prima di S4 (stdout vuoto =
    // silenzio) e resta sul suo ramo — la ricevuta S4 segna solo il successo
    // non-vuoto che la policy ha scelto di non messaggiare.
    const w = stubWorld();
    const job = w.store.add({ ...SPEC, delivery: 'silent' });
    w.set(AFTER_FIRE);
    const deliver = vi.fn(async (_channel: string, _text: string) => DELIVERED);
    const sched = drive(
      w,
      async () => ({ stopped: 'answered', text: '   ', turnId: 'turn-s4-empty' }),
      [],
      deliver,
      [],
    );

    sched.tick();
    await flush();

    expect(deliver).not.toHaveBeenCalled();
    expect(must(w.store.get(job.id)).lastRunAt).not.toBeNull();
    expect(must(w.fires.get(job.id, job.nextFireAt.toISOString())).silent).toBe(false);
  });
});

// --- Il giro vero: modello → turno → scheduler, come la produzione. ---

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next)
      throw new Error('lo script è finito — il modello non doveva essere richiamato di nuovo');
    return next;
  }
}

const usage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage,
  model: 'test',
});
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

function loopWorld(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-598-s4-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const jobs = new JobStore(db);
  const fires = new JobFireStore(db);
  const approvals = new ApprovalStore(db);
  const delega = new Delega(db);
  const provider = new Scripted(script);
  const eseguiti = { probe: 0 };
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
  const capabilities = new Map([[probeDecl.id, probeDecl]]);
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
      hardened: false,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos,
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    approvals,
    delega,
    // Come la produzione senza approvatore sulla superficie del job: la domanda
    // resta scritta e il turno chiude `ask` (stesso cablaggio del mondo S3).
    approve: async () => 'unavailable' as const,
  };
  const budget = { jobMonthUsd: (_id: string) => 0 };
  return { deps, db, jobs, fires, turns, provider, eseguiti, budget };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout aspettando ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('#598 S4 · il giro vero: successo silenzioso e needs-owner', () => {
  it('un fire silent con risposta del modello non manda messaggi e lascia una ricevuta interrogabile', async () => {
    const w = loopWorld([answer('brief silenzioso: tutto bene')]);
    const job = w.jobs.addOnce({
      channel: 'cli',
      goal: 'controlla che vada tutto bene',
      delivery: 'silent',
    });
    const scheduledFor = job.nextFireAt.toISOString();
    const deliver = vi.fn(async (_channel: string, _text: string) => DELIVERED);
    const events: SchedulerEvent[] = [];
    const sched = new Scheduler(
      w.jobs,
      makeJobRunner(w.deps, w.fires, null, null, w.budget),
      deliver,
      undefined,
      (e) => events.push(e),
      () => new Date(),
      undefined,
      (turnId, state) => w.turns.delivered(turnId, state),
      new ModelLane(),
      undefined,
      (j, opts) => w.fires.settle(j.id, j.nextFireAt.toISOString(), opts),
    );

    sched.tick();
    await waitFor(() => events.some((e) => e.kind === 'ran'), 'il fire silent');

    expect(w.provider.calls).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(events.find((e) => e.kind === 'ran')).toMatchObject({
      stopped: 'answered',
      delivered: false,
    });
    // Una-tantum: dopo il fire il modello non viene richiamato (S3 resta vero).
    expect(must(w.jobs.get(job.id)).active).toBe(false);

    const fire = must(w.fires.get(job.id, scheduledFor));
    expect(fire.settledAt).not.toBeNull();
    expect(fire.silent).toBe(true);
    const status = runStatus(w.db, fire);
    expect(status.state).toBe('done');
    expect(status.turnOutcome).toBe('answered');
    expect(status.silent).toBe(true);
    expect(formatRunStatus(status)).toContain('· silent');
  });

  it('un fire silent che finisce in ask consegna la domanda: needs-owner non si zittisce', async () => {
    const w = loopWorld([call('probe_act', 'c1', { command: 'rm -rf /tmp/x' })]);
    const job = w.jobs.addOnce({
      channel: 'cli',
      goal: 'fai quella cosa rischiosa in silenzio',
      delivery: 'silent',
    });
    const scheduledFor = job.nextFireAt.toISOString();
    const deliver = vi.fn(async (_channel: string, _text: string) => DELIVERED);
    const events: SchedulerEvent[] = [];
    const sched = new Scheduler(
      w.jobs,
      makeJobRunner(w.deps, w.fires, null, null, w.budget),
      deliver,
      undefined,
      (e) => events.push(e),
      () => new Date(),
      undefined,
      (turnId, state) => w.turns.delivered(turnId, state),
      new ModelLane(),
      undefined,
      (j, opts) => w.fires.settle(j.id, j.nextFireAt.toISOString(), opts),
    );

    sched.tick();
    await waitFor(() => events.some((e) => e.kind === 'ran'), 'il fire ask');

    expect(w.provider.calls).toBe(1);
    expect(w.eseguiti.probe).toBe(0);
    expect(deliver).toHaveBeenCalledOnce();
    expect(must(deliver.mock.calls[0])[1]).toContain('In coda per te');
    const fire = must(w.fires.get(job.id, scheduledFor));
    expect(fire.silent).toBe(false);
    expect(runStatus(w.db, fire).state).toBe('needs-owner');
  });
});
