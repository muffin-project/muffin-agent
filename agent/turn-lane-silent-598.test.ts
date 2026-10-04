import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl } from '../core/policy/types.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnLane } from '../core/turns/lane.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { makeJobRunner } from './scheduler-run.js';
import { makeLaneRunner } from './turn-lane.js';

/**
 * #598 silent-resume — the lane consults the job delivery policy.
 *
 * - silent + answered → no conversational message, delivery stays pending
 *   (the next scheduler tick settles the silent receipt);
 * - silent + ask/error/budget → still speaks (only routine success may hush);
 * - deliver (or no job, or unreadable row) + answered → speaks, as today.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next) throw new Error('script exhausted');
    return next;
  }
}

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const someUsage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const stall = (): ChatResult => ({
  text: null,
  toolCalls: [],
  stopReason: 'error',
  usage: zeroUsage,
  model: 'test',
});
const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: someUsage,
  model: 'test',
});
const call = (name: string, id: string, args: unknown = {}): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage: someUsage,
  model: 'test',
});

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

function world(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-598-silent-lane-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const jobs = new JobStore(db);
  const fires = new JobFireStore(db);
  const provider = new Scripted(script);
  const tools: RegisteredTool[] = [
    {
      capability: readDecl.id,
      spec: {
        name: 'demo_read',
        description: 'reads',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      handler: () => ({ content: 'contents', tier: 0 as const }),
      throwTier: 0,
    },
    {
      capability: probeDecl.id,
      spec: {
        name: 'probe_act',
        description: 'probe',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
      handler: () => ({ content: 'done', tier: 0 as const }),
      throwTier: 0,
    },
  ];
  const capabilities = new Map([
    [readDecl.id, readDecl],
    [probeDecl.id, probeDecl],
  ]);
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
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin.' },
  };
  return { deps, db, jobs, fires, turns };
}

async function settleLane(lane: TurnLane): Promise<void> {
  for (let i = 0; i < 600 && lane.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(lane.isRunning()).toBe(false);
}

const SPEC = { cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' };

/** Fires a job through one settled read + a recoverable stall; returns the bound continuable turn. */
async function fireToContinuable(w: ReturnType<typeof world>, delivery: 'deliver' | 'silent') {
  const job =
    delivery === 'silent' ? w.jobs.add({ ...SPEC, delivery: 'silent' }) : w.jobs.add(SPEC);
  const out = await makeJobRunner(w.deps, w.fires, null, null, { jobMonthUsd: (_id: string) => 0 })(
    job,
    undefined,
  );
  expect(out).toEqual({ deferred: true });
  const fire = w.fires.get(job.id, job.nextFireAt.toISOString());
  const turnId = fire?.turnId;
  if (!turnId) throw new Error('fire did not bind a turn');
  expect(w.deps.turns.get(turnId)?.status).toBe('continuable');
  return { job, turnId };
}

describe('#598 silent-resume · lane delivery decision', () => {
  it('TurnStore.jobDelivery reads the job row, defaulting to deliver', () => {
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    const jobs = new JobStore(db);
    const silent = jobs.add({ ...SPEC, delivery: 'silent' });
    const vocal = jobs.add({ ...SPEC, delivery: 'deliver' });
    expect(turns.jobDelivery(silent.id)).toBe('silent');
    expect(turns.jobDelivery(vocal.id)).toBe('deliver');
    expect(turns.jobDelivery('job-che-non-esiste')).toBe('deliver');
  });

  it('TurnStore.jobDelivery on a turns-only handle speaks (no jobs table)', () => {
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    expect(turns.jobDelivery('qualunque')).toBe('deliver');
  });

  it('silent + answered → lane stays silent, delivery stays pending', async () => {
    const w = world([
      call('demo_read', 'c1', { path: 'a.txt' }),
      stall(),
      stall(),
      stall(),
      stall(),
      stall(),
      answer('brief pronto'),
    ]);
    const { turnId } = await fireToContinuable(w, 'silent');
    const sent: string[] = [];
    const lane = new TurnLane({
      turns: w.turns,
      run: makeLaneRunner(
        w.deps,
        async (_turn, text) => {
          sent.push(text);
        },
        undefined,
        undefined,
        { jobCap: (_id: string) => null, jobMonthUsd: (_id: string) => 0 },
      ),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settleLane(lane);
    expect(w.turns.get(turnId)?.status).toBe('done');
    expect(w.turns.get(turnId)?.outcome).toBe('answered');
    expect(sent).toEqual([]);
    // No delivery attempted: the row carries no `sent`, so the next scheduler
    // tick recovers through the S4 silent branch (grant clears per-lease
    // delivery to NULL; a pending row would recover the same way).
    expect([null, 'pending']).toContain(w.turns.get(turnId)?.delivery);
  });

  it('deliver + answered → lane speaks, as today (default unchanged)', async () => {
    const w = world([
      call('demo_read', 'c1', { path: 'a.txt' }),
      stall(),
      stall(),
      stall(),
      stall(),
      stall(),
      answer('brief pronto'),
    ]);
    const { turnId } = await fireToContinuable(w, 'deliver');
    const sent: string[] = [];
    const lane = new TurnLane({
      turns: w.turns,
      run: makeLaneRunner(
        w.deps,
        async (_turn, text) => {
          sent.push(text);
        },
        undefined,
        undefined,
        { jobCap: (_id: string) => null, jobMonthUsd: (_id: string) => 0 },
      ),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settleLane(lane);
    expect(w.turns.get(turnId)?.outcome).toBe('answered');
    expect(sent).toEqual(['brief pronto']);
    expect(w.turns.get(turnId)?.delivery).toBe('sent');
  });

  it('silent + ask → needs-owner still speaks', async () => {
    // No delega wired (= manual): the high-risk act stays an open question.
    const w = world([
      call('demo_read', 'c1', { path: 'a.txt' }),
      stall(),
      stall(),
      stall(),
      stall(),
      stall(),
      call('probe_act', 'c2', { command: 'rotate-logs' }),
    ]);
    const { turnId } = await fireToContinuable(w, 'silent');
    const sent: string[] = [];
    const lane = new TurnLane({
      turns: w.turns,
      run: makeLaneRunner(
        w.deps,
        async (_turn, text) => {
          sent.push(text);
        },
        undefined,
        undefined,
        { jobCap: (_id: string) => null, jobMonthUsd: (_id: string) => 0 },
      ),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settleLane(lane);
    expect(w.turns.get(turnId)?.outcome).toBe('ask');
    expect(sent.length).toBe(1);
    expect(w.turns.get(turnId)?.delivery).toBe('sent');
  });

  it('explicit jobDelivery reader wins over the row', async () => {
    const w = world([
      call('demo_read', 'c1', { path: 'a.txt' }),
      stall(),
      stall(),
      stall(),
      stall(),
      stall(),
      answer('brief pronto'),
    ]);
    const { turnId } = await fireToContinuable(w, 'deliver');
    const sent: string[] = [];
    const lane = new TurnLane({
      turns: w.turns,
      run: makeLaneRunner(
        w.deps,
        async (_turn, text) => {
          sent.push(text);
        },
        undefined,
        undefined,
        {
          jobCap: (_id: string) => null,
          jobMonthUsd: (_id: string) => 0,
          jobDelivery: () => 'silent' as const,
        },
      ),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settleLane(lane);
    expect(w.turns.get(turnId)?.outcome).toBe('answered');
    expect(sent).toEqual([]);
    expect([null, 'pending']).toContain(w.turns.get(turnId)?.delivery);
  });
});
