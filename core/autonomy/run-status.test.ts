import DatabaseCtor from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../policy/types.js';
import { ApprovalStore } from '../approvals/store.js';
import { BudgetEngine } from '../budget/budget.js';
import { JobFireStore, type JobFire } from '../scheduler/job-fires.js';
import { TurnStore, type NewTurn, type TurnCounters } from '../turns/store.js';
import { formatRunStatus, listRunStatuses, runStatus } from './run-status.js';

/**
 * #598 S1: the 6-state answer over real fired-job rows.
 *
 * Every fixture below is written through the production stores
 * (`JobFireStore`, `TurnStore`, `ApprovalStore`, `BudgetEngine`) on a
 * throwaway `:memory:` database — the same shapes production reads, never
 * hand-built rows. The only raw SQL in this file is the falsifier's own
 * state flip (`done`→`running`), which is the observation under test, not a
 * store behaviour.
 */

const NOW = new Date('2026-09-20T08:00:00.000Z');
const FIRE_AT = '2026-09-20T08:00:00.000Z';

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

const counters = (): TurnCounters => ({
  iterations: 0,
  recoveriesUsed: 0,
  transportRetriesLeft: 2,
  truncationsUsed: 0,
  toolCallsMade: 0,
  nudgedForCompletion: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  spentUsd: 0,
  resumes: 0,
  contextBuilt: false,
});

const turnSpec = (id: string, over: Partial<NewTurn> = {}): NewTurn => ({
  id,
  principal: owner,
  tenant: 'host',
  surface: 'cli',
  sessionId: 's1',
  model: 'test-model',
  messages: [],
  taint: 0,
  counters: counters(),
  ...over,
});

type Harness = {
  db: DatabaseCtor.Database;
  fires: JobFireStore;
  turns: TurnStore;
  approvals: ApprovalStore;
  budget: BudgetEngine;
};

function harness(): Harness {
  const db = new DatabaseCtor(':memory:');
  return {
    db,
    fires: new JobFireStore(db, () => NOW),
    turns: new TurnStore(db, () => NOW),
    approvals: new ApprovalStore(db),
    budget: new BudgetEngine(db, { monthlyUsd: 100, perTenantDailyUsd: 10 }, () => NOW),
  };
}

/** Claim a fire and bind it to a freshly created (running) turn. */
function firedTurn(h: Harness, jobId: string, scheduledFor: string, turnId: string) {
  h.fires.claim(jobId, scheduledFor);
  const record = h.turns.create(turnSpec(turnId), 4242);
  h.fires.bind(jobId, scheduledFor, turnId);
  return record;
}

function fireOf(h: Harness, jobId: string, scheduledFor: string): JobFire {
  const fire = h.fires.get(jobId, scheduledFor);
  if (fire === null) throw new Error('fire expected');
  return fire;
}

describe('runStatus — pending while no work exists', () => {
  it('a claimed but unbound occurrence is pending', () => {
    const h = harness();
    h.fires.claim('job-1', FIRE_AT);
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.state).toBe('pending');
    expect(status.turnId).toBeNull();
    expect(status.turnStatus).toBeNull();
    expect(status.settledEffects).toBe(0);
    expect(status.spendUsd).toBe(0);
  });

  it('a bound turn nobody picked up yet (runnable) is still pending', () => {
    const h = harness();
    h.fires.claim('job-1', FIRE_AT);
    h.turns.enqueue(turnSpec('turn-1'));
    h.fires.bind('job-1', FIRE_AT, 'turn-1');
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.state).toBe('pending');
    expect(status.turnStatus).toBe('runnable');
  });

  it('a bound turn row that is absent reads pending, not failed', () => {
    const h = harness();
    h.fires.claim('job-1', FIRE_AT);
    h.fires.bind('job-1', FIRE_AT, 'ghost-turn');
    expect(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)).state).toBe('pending');
  });
});

describe('runStatus — live work', () => {
  it('a running turn is running', () => {
    const h = harness();
    firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.state).toBe('running');
    expect(status.turnStatus).toBe('running');
  });

  it('a suspended (waiting) turn is running: the promise is owed, not owner-blocked', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    expect(
      h.turns.suspend(
        'turn-1',
        { messages: [], taint: 0, counters: counters(), wakeAt: '2026-09-20T09:00:00.000Z', waitFor: null },
        record.claimToken,
      ),
    ).toBe(true);
    expect(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)).state).toBe('running');
  });

  it('an interrupted turn is running: owed to the lane, not dead', () => {
    const h = harness();
    firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.db.prepare(`UPDATE turns SET status = 'interrupted' WHERE id = ?`).run('turn-1');
    expect(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)).state).toBe('running');
  });

  it('a continuable lease reads continuable', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    expect(
      h.turns.releaseContinuable(
        'turn-1',
        {
          messages: [],
          taint: 0,
          counters: counters(),
          reason: { class: 'provider_transport', lease: 0, at: NOW.toISOString() },
        },
        record.claimToken,
      ),
    ).toBe(true);
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.state).toBe('continuable');
    expect(status.turnStatus).toBe('continuable');
  });
});

describe('runStatus — needs-owner joins approvals', () => {
  it('an open approval on live work reads needs-owner', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.approvals.ask({ turnId: 'turn-1', capability: 'sys.shell', prompt: 'run this?', taint: 0 }, NOW);
    h.turns.suspend(
      'turn-1',
      { messages: [], taint: 0, counters: counters(), wakeAt: '2026-09-20T14:00:00.000Z', waitFor: 'approval:x' },
      record.claimToken,
    );
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.state).toBe('needs-owner');
    expect(status.openApprovals).toBe(1);
  });

  it('the approvals join is load-bearing: withdrawing the question returns to running', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.approvals.ask({ turnId: 'turn-1', capability: 'sys.shell', prompt: 'run this?', taint: 0 }, NOW);
    expect(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)).state).toBe('needs-owner');
    // The question retired (turn finished elsewhere, owner answered and it
    // was consumed, …): same turn row, no open approval — the read follows.
    h.approvals.withdrawForTurn('turn-1', NOW);
    const after = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(after.state).toBe('running');
    expect(after.openApprovals).toBe(0);
  });

  it('a decided-but-unconsumed approval is not an open question: still running', () => {
    const h = harness();
    firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    const id = h.approvals.ask({ turnId: 'turn-1', capability: 'sys.shell', prompt: 'run this?', taint: 0 }, NOW);
    expect(h.approvals.decide(id, 'allow', NOW)).toBe('ok');
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.openApprovals).toBe(0);
    expect(status.decidedUnconsumed).toBe(true);
    expect(status.state).toBe('running');
  });

  it('a turn finished asking reads needs-owner: the work ended on a question', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    expect(
      h.turns.finish('turn-1', { outcome: 'ask', messages: [], taint: 0, counters: counters() }, record.claimToken),
    ).toBe(true);
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.state).toBe('needs-owner');
    expect(status.turnOutcome).toBe('ask');
  });
});

describe('runStatus — terminal work', () => {
  it('an answered turn reads done, with delivery carried as evidence', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.turns.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: counters() }, record.claimToken);
    h.turns.delivered('turn-1', 'sent');
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.state).toBe('done');
    expect(status.delivery).toBe('sent');
  });

  it('a failed delivery does not fail the run: the work is done, the message is not', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.turns.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: counters() }, record.claimToken);
    h.turns.delivered('turn-1', 'failed:refused');
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.state).toBe('done');
    expect(status.delivery).toBe('failed:refused');
  });

  it.each(['cap', 'budget', 'aborted', 'error'] as const)('outcome %s reads failed', (outcome) => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.turns.finish('turn-1', { outcome, messages: [], taint: 0, counters: counters() }, record.claimToken);
    expect(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)).state).toBe('failed');
  });
});

describe('runStatus — the projection follows rows', () => {
  it('flipping a turn row done→running moves the projection with it', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.turns.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: counters() }, record.claimToken);
    expect(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)).state).toBe('done');
    h.db.prepare(`UPDATE turns SET status = 'running' WHERE id = ?`).run('turn-1');
    const moved = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(moved.state).toBe('running');
    expect(moved.turnStatus).toBe('running');
  });

  it('settling the fire is evidence, not outcome: done stays done', () => {
    const h = harness();
    const record = firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.turns.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: counters() }, record.claimToken);
    const before = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(before.settledAt).toBeNull();
    h.fires.settle('job-1', FIRE_AT);
    const after = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(after.state).toBe('done');
    expect(after.settledAt).not.toBeNull();
  });

  it('is deterministic: same rows, same answer', () => {
    const h = harness();
    firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    const fire = fireOf(h, 'job-1', FIRE_AT);
    expect(runStatus(h.db, fire)).toEqual(runStatus(h.db, fire));
  });
});

describe('runStatus — receipt evidence from tool calls and spend', () => {
  it('counts settled, uncertain and undone calls from turn_tool_calls', () => {
    const h = harness();
    firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.turns.startToolCall('turn-1', {
      callId: 'c1',
      tool: 'fs_write',
      capability: 'sys.fs',
      rerunnable: false,
      args: { path: '/tmp/a' },
      effect: { row: 'host', reversible: 'no', resource: '/tmp/a', decision: 'allow' },
    });
    h.turns.endToolCall('turn-1', 'c1', { content: 'ok', isError: false, tier: 0 });
    h.turns.startToolCall('turn-1', {
      callId: 'c2',
      tool: 'sys_shell',
      capability: 'sys.shell',
      rerunnable: false,
      args: { cmd: 'sleep 30' },
      effect: { row: 'host', reversible: 'no', resource: null, decision: 'ask' },
    });
    h.turns.startToolCall('turn-1', {
      callId: 'c3',
      tool: 'fs_write',
      capability: 'sys.fs',
      rerunnable: false,
      args: { path: '/tmp/b' },
      effect: { row: 'host', reversible: 'yes', resource: '/tmp/b', decision: 'allow' },
    });
    h.turns.endToolCall('turn-1', 'c3', { content: 'ok', isError: false, tier: 0 });
    h.turns.markUndone('turn-1', ['c3']);
    const status = runStatus(h.db, fireOf(h, 'job-1', FIRE_AT));
    expect(status.settledEffects).toBe(1);
    expect(status.uncertainCalls).toBe(1);
    expect(status.undoneEffects).toBe(1);
  });

  it('sums the job ledger from spend', () => {
    const h = harness();
    firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    h.budget.record({ tenant: 'host', capability: 'sys.infer', model: 'm', inputTokens: 10, outputTokens: 5, usd: 2.5, jobId: 'job-1' });
    h.budget.record({ tenant: 'host', capability: 'sys.infer', model: 'm', inputTokens: 10, outputTokens: 5, usd: 1.25, jobId: 'job-1' });
    h.budget.record({ tenant: 'host', capability: 'sys.infer', model: 'm', inputTokens: 10, outputTokens: 5, usd: 9, jobId: 'other-job' });
    expect(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)).spendUsd).toBeCloseTo(3.75);
  });
});

describe('listRunStatuses / formatRunStatus', () => {
  it('lists every fire oldest-first with its answer', () => {
    const h = harness();
    const first = firedTurn(h, 'job-1', '2026-09-20T08:00:00.000Z', 'turn-1');
    h.turns.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: counters() }, first.claimToken);
    firedTurn(h, 'job-1', '2026-09-21T08:00:00.000Z', 'turn-2');
    const listed = listRunStatuses(h.db);
    expect(listed.map((s) => s.scheduledFor)).toEqual(['2026-09-20T08:00:00.000Z', '2026-09-21T08:00:00.000Z']);
    expect(listed.map((s) => s.state)).toEqual(['done', 'running']);
  });

  it('reads as empty where job_fires never existed — inspect must not break on an older home', () => {
    const db = new DatabaseCtor(':memory:');
    expect(listRunStatuses(db)).toEqual([]);
  });

  it('formats one stable line per run', () => {
    const h = harness();
    firedTurn(h, 'job-1', FIRE_AT, 'turn-1');
    const line = formatRunStatus(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)));
    expect(line).toContain('job-1@2026-09-20T08:00:00.000Z → running');
    expect(line).toContain('turn turn-1');
    expect(formatRunStatus(runStatus(h.db, fireOf(h, 'job-1', FIRE_AT)))).toBe(line);
  });
});

describe('runStatus — read-only guarantee', () => {
  it('the module holds no write path', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'run-status.ts'), 'utf8');
    expect(source).not.toMatch(/INSERT/);
    expect(source).not.toMatch(/UPDATE/);
  });
});
