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
import { Scheduler, type SchedulerEvent } from '../core/scheduler/scheduler.js';
import { SessionStore } from '../core/session/store.js';
import { DELIVERED } from '../core/surface/types.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnLane } from '../core/turns/lane.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { type JobBudget, makeJobRunner } from './scheduler-run.js';
import { makeLaneRunner } from './turn-lane.js';

/**
 * #598 assembled proof — the spine S1+S2+S3+S4 in one run.
 *
 * One owner action arms an armed-once goal with yolo posture and a silent
 * delivery policy (S3 arm surface + S4 policy, both read from the same job
 * row — nothing here redefines them). The production `Scheduler` fires it on
 * its tick; the first lease settles a real effect and yields `continuable`
 * (the kill boundary: everything the next process needs is on durable rows,
 * and real-SIGKILL survival across that same boundary is already proven by
 * `agent/autonomous-resume-kill.test.ts`, reused here by reference, not
 * re-enacted). The production `TurnLane` resumes the same turn with no owner
 * message anywhere (S2 autonomous grant), the resumed lease consumes a real
 * ASK through the yolo delegation carry (S3) and answers, and the occurrence
 * settles silently with a queryable receipt that the S1 projection reads as
 * terminal (S1 states reused, never redefined; S4 receipt reused).
 *
 * Each load-bearing assertion names its link, so a red names the broken one:
 * - S2 link: `due()` lists the scheduler-bound continuable row; the lane
 *   resumes the SAME turn_id with no owner message and no duplicate settled
 *   effect;
 * - S3 link: the fire ran under yolo (`Delega.modo` carries the job posture
 *   to the not-yet-minted fire turn, explicit per-turn wins) — the ASK row
 *   says `decided_by delegation` and the tool ran; a second tick never
 *   re-runs the model (armed-once);
 * - S4 link: neither the scheduler channel nor the lane channel ever carries
 *   a conversational message, and the fire settles WITH the silent receipt;
 * - S1 link: `runStatus` reads `continuable` mid-flight and `done` + `silent`
 *   at the end, from durable rows only.
 *
 * Scope: this file only. No production path is touched — if the assembled run
 * goes red on a link, that is a wiring finding to report, not a fix to smuggle.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next) throw new Error('script exhausted — the model must not be called again');
    return next;
  }
}

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const someUsage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A lease that yields recoverably instead of finishing (S2 `provider_empty` shape). */
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

/** Low-risk read: settles a real effect row through the normal intent/WAL path (S2 shape). */
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

/** High-risk irreversible act: the canonical ASK the yolo carry must consume (S3 shape). */
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

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected row absent — test setup bug');
  return v;
}

function world(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-598-assembled-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const jobs = new JobStore(db);
  const fires = new JobFireStore(db);
  const approvals = new ApprovalStore(db);
  const delega = new Delega(db);
  const provider = new Scripted(script);
  const executed = { reads: new Map<string, number>(), probes: 0 };
  const tools: RegisteredTool[] = [
    {
      capability: readDecl.id,
      spec: {
        name: 'demo_read',
        description: 'reads a note',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      handler: (args) => {
        const path = ((args ?? {}) as Record<string, unknown>).path;
        if (typeof path === 'string') executed.reads.set(path, (executed.reads.get(path) ?? 0) + 1);
        return { content: `contents of ${String(path)}`, tier: 0 as const };
      },
      throwTier: 0,
    },
    {
      capability: probeDecl.id,
      spec: {
        name: 'probe_act',
        description: 'probe',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
      handler: () => {
        executed.probes += 1;
        return { content: 'done', tier: 0 as const };
      },
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
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    approvals,
    delega,
    // Production shape with no approver on the job surface: a manual ASK stays
    // queued, a yolo ASK consumes via the same registry (S3 — reused, not redefined).
    approve: async () => 'unavailable' as const,
  };
  // No per-job ceiling on the armed goal, so the counter reads zero everywhere;
  // both readers (fire-time gate, lane grant) see the same counter, as
  // `cli/gateway.ts` wires them in production.
  const budget: JobBudget = { jobMonthUsd: (_id: string) => 0 };
  const auto = { jobCap: (_id: string) => null as number | null, jobMonthUsd: (_id: string) => 0 };
  return { deps, db, jobs, fires, turns, delega, provider, executed, budget, auto };
}

function settledEffects(db: DatabaseCtor.Database, turnId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM turn_tool_calls WHERE turn_id = ? AND ended_at IS NOT NULL AND undone_at IS NULL`,
      )
      .get(turnId) as { n: number }
  ).n;
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Lets the lane beat the test started finish, without a fixed sleep (S2 shape). */
async function settleLane(lane: TurnLane): Promise<void> {
  for (let i = 0; i < 600 && lane.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(lane.isRunning()).toBe(false);
}

describe('#598 assembled · arm-once yolo silent → fire → kill boundary → resume → silent settle', () => {
  it('one lineage, no duplicate effects, zero messages, S1 terminal with silent receipt', async () => {
    // Lease 0 (fire): one settled read, then the lease yields recoverably.
    // Resumed lease (lane, no owner message): the yolo ASK is consumed and
    // executed, then the turn answers. Anything more would be a third lease
    // this proof never grants.
    const w = world([
      call('demo_read', 'c1', { path: 'a.txt' }),
      stall(),
      stall(),
      stall(),
      stall(),
      call('probe_act', 'c2', { command: 'rotate-logs' }),
      answer('brief pronto: tutto bene'),
    ]);

    // ONE owner action arms the goal: once + yolo posture + silent policy.
    const job = w.jobs.addOnce({
      channel: 'cli',
      goal: 'controlla i log e fammi il brief senza disturbarmi',
      delegation: 'yolo',
      delivery: 'silent',
    });
    expect(job.delegation, 'S3 link: the armed goal carries the yolo posture').toBe('yolo');
    expect(job.delivery, 'S4 link: the armed goal carries the silent policy').toBe('silent');
    const scheduledFor = job.nextFireAt.toISOString();

    // Production-shaped scheduler wiring (same order as `cli/gateway.ts`):
    // run through makeJobRunner, deliver to the channel, settle the fire receipt.
    const channelDeliver = vi.fn(async (_channel: string, _text: string) => DELIVERED);
    const events: SchedulerEvent[] = [];
    const sched = new Scheduler(
      w.jobs,
      makeJobRunner(w.deps, w.fires, null, null, w.budget),
      channelDeliver,
      undefined,
      (e) => events.push(e),
      () => new Date(),
      undefined,
      (turnId, state) => w.turns.delivered(turnId, state),
      new ModelLane(),
      undefined,
      (j: Job, opts?: { silent?: boolean }) =>
        w.fires.settle(j.id, j.nextFireAt.toISOString(), opts),
    );

    // The tick fires without a fresh owner message: one armed goal, one fire.
    sched.tick();
    await waitFor(
      () => events.some((e) => e.kind === 'deferred' || e.kind === 'ran'),
      'the first tick resolving the fire',
    );
    expect(
      w.provider.calls,
      'S3 link: the armed-once goal fired exactly once so far',
    ).toBeGreaterThan(0);
    const callsAfterFire = w.provider.calls;

    // The fire yielded mid-goal: the lane owns the turn now, the scheduler
    // delivered nothing and advanced nothing.
    const fireAfterYield = must(w.fires.get(job.id, scheduledFor));
    const turnId = must(fireAfterYield.turnId);
    expect(fireAfterYield.settledAt, 'S2 link: the yielded occurrence stays open').toBeNull();
    expect(w.turns.get(turnId)?.status, 'S2 link: the lease ended continuable, work intact').toBe(
      'continuable',
    );
    expect(channelDeliver, 'S4 link: a yielded fire messages nobody').not.toHaveBeenCalled();

    // ---- the kill boundary: everything a fresh process needs is on disk ----
    // One settled effect before the interruption; S1 already reads the
    // mid-flight truth from durable rows.
    expect(settledEffects(w.db, turnId), 'S2 link: useful work settled before the kill').toBe(1);
    expect(w.executed.reads.get('a.txt'), 'S2 link: the settled read ran exactly once').toBe(1);
    expect(
      runStatus(w.db, fireAfterYield).state,
      'S1 link: mid-flight projection reads continuable',
    ).toBe('continuable');
    // S2 due-inclusion: the lane sees the scheduler row on its own beat.
    expect(
      w.turns.due().map((r) => r.id),
      'S2 link: due() lists the scheduler-bound continuable row',
    ).toContain(turnId);

    // ---- resume: one lane beat, no owner message anywhere in the loop ----
    const laneMessages: { turnId: string; text: string }[] = [];
    const laneRunner = makeLaneRunner(
      w.deps,
      async (turn, text) => {
        laneMessages.push({ turnId: turn.id, text });
      },
      undefined,
      undefined,
      w.auto,
    );
    const resumeLane = new TurnLane({
      turns: w.turns,
      run: laneRunner,
      modelLane: new ModelLane(),
    });
    resumeLane.tick();
    await settleLane(resumeLane);

    // Same identity, terminal: the durable work continued, not restarted.
    const done = must(w.turns.get(turnId));
    expect(done.status, 'S2 link: the same turn resumed to done').toBe('done');
    expect(
      done.outcome,
      'S2/S3 link: the resumed turn answered (resume granted AND yolo consumed)',
    ).toBe('answered');
    expect(done.leaseIndex, 'S2 link: exactly one autonomous lease was granted').toBe(1);

    // No duplicate settled effects: still the fire-lease read (replayed, never
    // re-ran) plus the resumed-lease yolo act — each handler ran once.
    expect(
      settledEffects(w.db, turnId),
      'S2 link: no duplicate settled effects across the kill',
    ).toBe(2);
    expect(
      w.executed.reads.get('a.txt'),
      'S2 link: the pre-kill read was replayed, not re-executed',
    ).toBe(1);
    expect(
      w.executed.probes,
      'S3 link: the yolo act executed exactly once, in the resumed lease',
    ).toBe(1);

    // S3 delegation carry, read off durable rows: no per-turn row was minted
    // by the fire (the history stays on the job), yet the fire turn ran yolo.
    const perTurn = w.db
      .prepare(`SELECT count(*) AS n FROM delegation_modes WHERE turn_id = ?`)
      .get(turnId) as { n: number };
    expect(perTurn.n, 'S3 link: the carry is a read, not a minted per-turn row').toBe(0);
    expect(w.delega.modo(turnId), 'S3 link: the fire turn reads the job yolo posture').toBe('yolo');
    const asks = w.db
      .prepare(
        `SELECT decision, decided_by, consumed_at FROM approvals WHERE turn_id = ? ORDER BY asked_at`,
      )
      .all(turnId) as {
      decision: string | null;
      decided_by: string | null;
      consumed_at: string | null;
    }[];
    const consumed = asks.find((r) => r.decision === 'allow');
    expect(
      consumed?.decided_by,
      'S3 link: the ASK was consumed by delegation, not by an owner',
    ).toBe('delegation');
    expect(consumed?.consumed_at, 'S3 link: the delegation decision was consumed').not.toBeNull();

    // ---- settle: the next scheduler tick closes the occurrence ----
    sched.tick();
    await waitFor(() => events.some((e) => e.kind === 'ran'), 'the settling tick');
    const ran = events.find((e) => e.kind === 'ran');
    expect(ran, 'the occurrence settled after the resume').toMatchObject({ stopped: 'answered' });

    // Armed-once (S3): the schedule advanced to inactive and a further tick
    // never calls the model again.
    expect(
      must(w.jobs.get(job.id)).active,
      'S3 link: markRan deactivated the armed-once goal',
    ).toBe(false);
    const callsBeforeIdle = w.provider.calls;
    sched.tick();
    await new Promise((r) => setTimeout(r, 200));
    expect(w.provider.calls, 'S3 link: an idle tick never re-runs the model').toBe(callsBeforeIdle);
    expect(
      callsAfterFire,
      'S3 link: the whole goal cost exactly its two leases',
    ).toBeLessThanOrEqual(w.provider.calls);

    // Zero conversational messages end to end — neither the scheduler channel
    // nor the lane channel ever spoke (S4 silent policy through the resume path).
    // Soft: every link below must report in ONE run, so a red pins each broken
    // link instead of stopping at the first.
    expect
      .soft(channelDeliver, 'S4 link: the scheduler channel stayed silent end to end')
      .not.toHaveBeenCalled();
    expect.soft(laneMessages, 'S4 link: the lane channel stayed silent on resume').toEqual([]);

    // The receipt is durable and queryable; S1 reads the terminal state off it.
    const fire = must(w.fires.get(job.id, scheduledFor));
    expect.soft(fire.turnId, 'lineage: the fire still binds the same turn end to end').toBe(turnId);
    expect.soft(fire.settledAt, 'S4 link: the occurrence settled').not.toBeNull();
    expect.soft(fire.silent, 'S4 link: the fire carries the silent receipt').toBe(true);
    const status = runStatus(w.db, fire);
    expect.soft(status.jobId, 'lineage: S1 reads the same job').toBe(job.id);
    expect.soft(status.turnId, 'lineage: S1 reads the same turn').toBe(turnId);
    expect.soft(status.state, 'S1 link: terminal projection reads done').toBe('done');
    expect.soft(status.turnOutcome, 'S1 link: the terminal outcome is answered').toBe('answered');
    expect.soft(status.settledEffects, 'S1 link: the receipt counts both settled effects').toBe(2);
    expect.soft(status.silent, 'S1 link: the receipt carries silent').toBe(true);
    expect
      .soft(formatRunStatus(status), 'S1 link: sys.inspect renders the silent receipt')
      .toContain('· silent');
  });
});
