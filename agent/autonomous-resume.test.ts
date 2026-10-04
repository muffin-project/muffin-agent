import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStatus } from '../core/autonomy/run-status.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { JobFireStore } from '../core/scheduler/job-fires.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { SessionStore } from '../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { TurnLane } from '../core/turns/lane.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { MAX_AUTONOMOUS_LEASES, TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { makeJobRunner } from './scheduler-run.js';
import { makeLaneRunner } from './turn-lane.js';
import type { LoopDeps, RegisteredTool } from './loop.js';
import { MAX_TRANSPORT_RETRIES } from './loop/types.js';
import { CONSERVATIVE, type Profile } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * #598 S2 — bounded unattended resume for scheduler-bound turns.
 *
 * A fired job whose lease ends `continuable` after useful work is the hole
 * this slice closes: the scheduler defers the bound non-done turn every tick,
 * `due()` never listed it, and the job's synthetic session has no owner to
 * say "riprendi" — so the work waited for ever with settled effects on disk.
 * The lane now picks exactly `{ kind: 'system', source: 'scheduler' }`-bound
 * rows back up and continues them on the same `turn_id` through the canonical
 * `continueTurn`, with no owner message anywhere in the loop.
 *
 * The load-bearing assertions, in order:
 *
 * 1. same `turn_id` resumes with no owner message and reaches `done` (or
 *    `ask`, which is the truthful terminal state S1 already projects as
 *    `needs-owner`);
 * 2. `turn_tool_calls` holds exactly the N settled effects — N+1 rows is the
 *    duplication this WAL exists to prevent (intent `ON CONFLICT DO NOTHING`
 *    + `reconcile` replay in `agent/loop/`);
 * 3. an owner-principal `continuable` row in the same database is untouched;
 * 4. iteration (`maxToolCallsPerTurn`) and budget (`per_job_usd` via
 *    `jobExhausted`, tenant/monthly via `budgetExhausted`) ceilings still bind;
 * 5. past `MAX_AUTONOMOUS_LEASES` the row stays continuable for an explicit
 *    grant instead of resuming on its own.
 *
 * Falsifier pairing: revert the `due()` inclusion in `core/turns/store.ts`
 * and the first test goes red — the row never leaves `continuable`, no model
 * call ever happens for it.
 */

/** Unwrap-or-throw for rows the test itself just wrote: a missing row is a setup bug, not an assertion. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('riga attesa assente nel database di prova');
  return value;
}

const scheduler: Principal = { kind: 'system', source: 'scheduler' };
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const someUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

const stall = (): ChatResult => ({ text: null, toolCalls: [], stopReason: 'error', usage: zeroUsage, model: 'test' });
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: someUsage, model: 'test' });
const call = (name: string, id: string, args: unknown = {}): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage: someUsage,
  model: 'test',
});

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

/** A read that settles a real effect row through the normal intent/WAL path.
 *
 * Deliberately `resourceKind: 'none'`: a `query` resource would meet the
 * composed-params gate (`gateParams` in `core/policy/decide.ts`), which
 * denies model-composed bytes to every non-owner principal by design — no
 * autonomous turn may search the web on words it just invented. That posture
 * is owned elsewhere and is not probed here; what this slice must prove is
 * resume-without-duplication, which needs an allowed effect, not a denied one.
 */
function readTool(callsByPath: Map<string, number>): { tool: RegisteredTool; decl: CapabilityDecl } {
  const decl: CapabilityDecl = {
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
  return {
    decl,
    tool: {
      capability: decl.id,
      spec: {
        name: 'demo_read',
        description: 'legge un appunto',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      handler: (args) => {
        const path = ((args ?? {}) as Record<string, unknown>).path;
        if (typeof path === 'string') callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
        return { content: `contenuto di ${String(path)}`, tier: 0 as const };
      },
      throwTier: 0,
    },
  };
}

/** The canonical ASK shape: high-risk, irreversible, no channel to ask on here. */
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

function probeTool(calls: { n: number }): { tool: RegisteredTool; decl: CapabilityDecl } {
  return {
    decl: probeDecl,
    tool: {
      capability: probeDecl.id,
      spec: {
        name: 'probe_act',
        description: 'probe',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
      handler: () => {
        calls.n += 1;
        return { content: 'fatto', tier: 0 as const };
      },
      throwTier: 0,
    },
  };
}

function counters() {
  return {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: MAX_TRANSPORT_RETRIES,
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
  };
}

const SPEC = { cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'leggi i file e fai il brief', channel: 'cli' };

function world(
  script: ChatResult[],
  opts: {
    profile?: Profile;
    caps?: Map<string, number>;
    spends?: Map<string, number>;
    exhausted?: (tenant: string) => boolean;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-s2-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const jobs = new JobStore(db);
  const fires = new JobFireStore(db);
  const provider = new Scripted(script);
  const reads = new Map<string, number>();
  const probes = { n: 0 };
  const { tool: fsTool, decl: fsDecl } = readTool(reads);
  const { tool: actTool, decl: actDecl } = probeTool(probes);
  const capabilities = new Map([[fsDecl.id, fsDecl], [actDecl.id, actDecl]]);
  const deps: LoopDeps = {
    provider,
    profile: opts.profile ?? CONSERVATIVE,
    model: 'test-model',
    tools: [fsTool, actTool],
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: false }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos,
    budgetExhausted: opts.exhausted ?? (() => false),
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  const auto = {
    jobCap: (id: string) => opts.caps?.get(id) ?? null,
    jobMonthUsd: (id: string) => opts.spends?.get(id) ?? 0,
  };
  // The same counter the fire-time gate reads — production passes the real
  // ledger (`cli/gateway.ts`); here the `spends` map plays it.
  const budget = { jobMonthUsd: (id: string) => opts.spends?.get(id) ?? 0 };
  return { deps, db, jobs, fires, provider, reads, probes, auto, budget };
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

/** Lets the background run the lane started finish, without a fixed sleep. */
async function settle(lane: TurnLane): Promise<void> {
  for (let i = 0; i < 800 && lane.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(lane.isRunning()).toBe(false);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('#598 S2 · unattended resume of a scheduler-bound continuable turn', () => {
  it('kill mid-goal with settled effects → same turn resumes with no owner message, no duplicate, reaches done', async () => {
    const w = world([
      call('demo_read', 'c1', { path: 'a.txt' }),
      call('demo_read', 'c2', { path: 'b.txt' }),
      stall(), stall(), stall(), stall(), stall(),
      answer('brief pronto'),
    ]);
    const job = w.jobs.add(SPEC);
    const scheduledFor = job.nextFireAt.toISOString();

    // The fire runs useful work, then the lease ends recoverably.
    const fired = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    expect(fired).toEqual({ deferred: true });
    const fire = w.fires.get(job.id, scheduledFor);
    const turnId = must(fire?.turnId);
    expect(w.deps.turns.get(turnId)?.status).toBe('continuable');
    // The occurrence stays open: nothing delivered, nothing advanced.
    expect(fire?.settledAt).toBeNull();
    // Two settled effects on disk — the crash/kill boundary this slice survives.
    expect(settledEffects(w.db, turnId)).toBe(2);
    expect(w.reads.get('a.txt')).toBe(1);
    expect(w.reads.get('b.txt')).toBe(1);

    // An owner-principal continuable row in the same database must stay owed
    // to its owner — never auto-picked.
    const mine = w.deps.turns.create(
      {
        id: 'owner-continuable',
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'owner-sess',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'il mio lavoro' }] }],
        taint: 0,
        counters: { ...counters(), contextBuilt: true },
      },
      4242,
    );
    expect(
      w.deps.turns.releaseContinuable(
        mine.id,
        {
          messages: [],
          taint: 0,
          counters: mine.counters,
          reason: { class: 'provider_empty', lease: 0, at: new Date().toISOString() },
        },
        mine.claimToken,
      ),
    ).toBe(true);

    // The lane sees the scheduler row and not the owner one.
    expect(w.deps.turns.due().map((r) => r.id)).toContain(turnId);
    expect(w.deps.turns.due().map((r) => r.id)).not.toContain('owner-continuable');

    // No owner message exists anywhere in this flow: the lane beats on its own.
    const sent: { turnId: string; text: string }[] = [];
    const lane = new TurnLane({
      turns: w.deps.turns,
      run: makeLaneRunner(w.deps, async (turn, text) => {
        sent.push({ turnId: turn.id, text });
      }, undefined, undefined, w.auto),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settle(lane);

    // Same identity, terminal, delivered once.
    const done = must(w.deps.turns.get(turnId));
    expect(done.status).toBe('done');
    expect(done.outcome).toBe('answered');
    expect(done.leaseIndex).toBe(1);
    expect(sent).toEqual([{ turnId, text: 'brief pronto' }]);
    expect(done.delivery).toBe('sent');

    // No duplicate settled effect: still exactly the two calls, each ran once.
    // A third settled row here would be the re-execution this WAL prevents.
    expect(settledEffects(w.db, turnId)).toBe(2);
    expect(w.reads.get('a.txt')).toBe(1);
    expect(w.reads.get('b.txt')).toBe(1);

    // The owner's row is untouched — still owed, still waiting for "riprendi".
    expect(w.deps.turns.get('owner-continuable')?.status).toBe('continuable');

    // S1's projection reads the finished run from durable rows, no new states:
    // `done` for the answered run.
    const final = w.fires.get(job.id, scheduledFor);
    expect(runStatus(w.db, must(final)).state).toBe('done');

    // And the next scheduler tick settles without ever calling the model again.
    const callsBefore = w.provider.calls;
    const again = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    expect(w.provider.calls).toBe(callsBefore);
    if (!('settleOnly' in again)) throw new Error(`atteso settleOnly, ricevuto ${JSON.stringify(again)}`);
    expect(again.turnId).toBe(turnId);
    expect(again.delivered).toBe(true);
  });

  it('a continued run that ends on a question exposes the canonical ASK and consumes nothing', async () => {
    const w = world([
      call('demo_read', 'c1', { path: 'a.txt' }),
      stall(), stall(), stall(), stall(),
      call('probe_act', 'c2', { command: 'rm -rf /tmp/x' }),
    ]);
    const job = w.jobs.add(SPEC);
    const scheduledFor = job.nextFireAt.toISOString();

    const fired = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    expect(fired).toEqual({ deferred: true });
    const turnId = must(must(w.fires.get(job.id, scheduledFor)).turnId);
    expect(settledEffects(w.db, turnId)).toBe(1);

    const sent: { turnId: string; text: string }[] = [];
    const lane = new TurnLane({
      turns: w.deps.turns,
      run: makeLaneRunner(w.deps, async (turn, text) => {
        sent.push({ turnId: turn.id, text });
      }, undefined, undefined, w.auto),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settle(lane);

    // The work ended on a question: S1 projects `needs-owner`, the truthful
    // terminal state — and #740 owns resolving it, so nothing here consumes.
    const done = must(w.deps.turns.get(turnId));
    expect(done.status).toBe('done');
    expect(done.outcome).toBe('ask');
    expect(w.probes.n).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('probe.act');
    const fire = w.fires.get(job.id, scheduledFor);
    expect(runStatus(w.db, must(fire)).state).toBe('needs-owner');
    // Still exactly the one settled effect from the first lease.
    expect(settledEffects(w.db, turnId)).toBe(1);
  });

  it('the profile tool-call ceiling still binds inside an autonomous lease', async () => {
    const w = world(
      [
        call('demo_read', 'c1', { path: 'a.txt' }),
        stall(), stall(), stall(), stall(),
        call('demo_read', 'c2', { path: 'b.txt' }),
        call('demo_read', 'c3', { path: 'c.txt' }),
        answer('fatto col tetto'),
      ],
      { profile: { ...CONSERVATIVE, maxToolCallsPerTurn: 1 } },
    );
    const job = w.jobs.add(SPEC);
    const scheduledFor = job.nextFireAt.toISOString();

    const fired = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    expect(fired).toEqual({ deferred: true });
    const turnId = must(must(w.fires.get(job.id, scheduledFor)).turnId);

    const sent: string[] = [];
    const lane = new TurnLane({
      turns: w.deps.turns,
      run: makeLaneRunner(w.deps, async (_turn, text) => {
        sent.push(text);
      }, undefined, undefined, w.auto),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settle(lane);

    // One call per lease: the first lease settled c1, the autonomous lease
    // settled c2 and refused c3 at the ceiling — then answered.
    const done = must(w.deps.turns.get(turnId));
    expect(done.status).toBe('done');
    expect(settledEffects(w.db, turnId)).toBe(2);
    expect(w.reads.get('a.txt')).toBe(1);
    expect(w.reads.get('b.txt')).toBe(1);
    expect(w.reads.get('c.txt')).toBeUndefined();
    expect(sent).toEqual(['fatto col tetto']);
  });

  it('an exhausted per-job ceiling blocks the autonomous lease — exhaustion test', async () => {
    const caps = new Map<string, number>();
    const spends = new Map<string, number>();
    const w = world([call('demo_read', 'c1', { path: 'a.txt' }), stall(), stall(), stall(), stall()], {
      caps,
      spends,
    });
    const job = w.jobs.add({ ...SPEC, perJobUsd: 0.5 });
    caps.set(job.id, 0.5);
    // Fire time: nothing spent yet, so the fire-time gate lets it start.
    const scheduledFor = job.nextFireAt.toISOString();

    const fired = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    expect(fired).toEqual({ deferred: true });
    const turnId = must(must(w.fires.get(job.id, scheduledFor)).turnId);
    expect(settledEffects(w.db, turnId)).toBe(1);
    const callsBefore = w.provider.calls;

    // …then the spend lands past the ceiling before the lane beats again.
    // `jobExhausted` must hold the autonomous lease the same way the
    // fire-time gate holds a fresh fire.
    spends.set(job.id, 0.75);

    const lane = new TurnLane({
      turns: w.deps.turns,
      run: makeLaneRunner(w.deps, async () => {}, undefined, undefined, w.auto),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settle(lane);

    // `jobExhausted` held: no new lease, no model call, the row stays owed.
    expect(w.provider.calls).toBe(callsBefore);
    expect(w.deps.turns.get(turnId)?.status).toBe('continuable');
    expect(settledEffects(w.db, turnId)).toBe(1);
    const fire = w.fires.get(job.id, scheduledFor);
    expect(runStatus(w.db, must(fire)).state).toBe('continuable');
  });

  it('without a spend counter the lane refuses rather than granting blind — fail closed', async () => {
    const w = world([call('demo_read', 'c1', { path: 'a.txt' }), stall(), stall(), stall(), stall()]);
    const job = w.jobs.add(SPEC);
    const scheduledFor = job.nextFireAt.toISOString();

    const fired = await makeJobRunner(w.deps, w.fires, null, null, w.budget)(job, undefined);
    expect(fired).toEqual({ deferred: true });
    const turnId = must(must(w.fires.get(job.id, scheduledFor)).turnId);
    const callsBefore = w.provider.calls;

    const lane = new TurnLane({
      // No `auto` reader wired: the per-job ceiling is unverifiable.
      turns: w.deps.turns,
      run: makeLaneRunner(w.deps, async () => {}),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settle(lane);

    expect(w.provider.calls).toBe(callsBefore);
    expect(w.deps.turns.get(turnId)?.status).toBe('continuable');
  });

  it(`past MAX_AUTONOMOUS_LEASES the row stays continuable for an explicit grant`, async () => {
    const w = world([answer('non deve mai essere chiamato')]);
    const job = w.jobs.add(SPEC);
    const rec = w.deps.turns.create(
      {
        id: 'tired-turn',
        principal: scheduler,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'job-sess',
        inputText: 'gira e rigira',
        providerLease: { model: 'test-model', checkpoint: [] },
        taint: 0,
        counters: { ...counters(), contextBuilt: true },
        jobId: job.id,
        replyTo: { channel: 'cli' },
      },
      4242,
    );
    const at = new Date().toISOString();
    for (let lease = 0; lease < MAX_AUTONOMOUS_LEASES; lease += 1) {
      expect(
        w.deps.turns.releaseContinuable(
          rec.id,
          { messages: [], taint: 0, counters: must(w.deps.turns.get(rec.id)).counters, reason: { class: 'provider_empty', lease, at } },
          must(w.deps.turns.get(rec.id)).claimToken,
        ),
      ).toBe(true);
      const granted = w.deps.turns.grantContinuation(
        rec.id,
        {
          messages: [],
          taint: 0,
          counters: { ...must(w.deps.turns.get(rec.id)).counters, contextBuilt: true },
          newLeaseStartedAt: at,
        },
        4242,
      );
      expect(granted).not.toBeNull();
    }
    expect(
      w.deps.turns.releaseContinuable(
        rec.id,
        {
          messages: [],
          taint: 0,
          counters: must(w.deps.turns.get(rec.id)).counters,
          reason: { class: 'provider_empty', lease: MAX_AUTONOMOUS_LEASES, at },
        },
        must(w.deps.turns.get(rec.id)).claimToken,
      ),
    ).toBe(true);
    expect(w.deps.turns.get(rec.id)?.leaseIndex).toBe(MAX_AUTONOMOUS_LEASES);

    const lane = new TurnLane({
      turns: w.deps.turns,
      run: makeLaneRunner(w.deps, async () => {}, undefined, undefined, w.auto),
      modelLane: new ModelLane(),
    });
    lane.tick();
    await settle(lane);

    expect(w.provider.calls).toBe(0);
    expect(w.deps.turns.get(rec.id)?.status).toBe('continuable');
  });
});
