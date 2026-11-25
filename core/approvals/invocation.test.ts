import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnStore } from '../turns/store.js';
import { APPROVAL_WINDOW_MS, ApprovalStore } from './store.js';

const now = new Date('2026-11-25T10:00:00Z');
const connections: Database.Database[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});

function fixture() {
  const db = new Database(':memory:');
  connections.push(db);
  const turns = new TurnStore(db);
  const approvals = new ApprovalStore(db);
  const record = turns.create({
    id: 'a'.repeat(32),
    tenant: 'host',
    principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
    surface: 'cli',
    sessionId: 'fixture-approval',
    model: 'fixture',
    messages: [],
    taint: 0,
    counters: {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 10,
      truncationsUsed: 0,
      toolCallsMade: 1,
      nudgedForCompletion: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 0,
      contextBuilt: true,
      activeModelMs: 0,
    },
  });
  const approval = {
    turnId: record.id,
    capability: 'sys.shell.write',
    resource: 'command: printf 42 · cwd: .',
    invocation: { callId: 'shell-1', digest: 'exact-invocation' },
  };
  const id = approvals.ask({ ...approval, prompt: 'Run it?', taint: 0 }, now);
  const proof = { ...approval, id, claimToken: record.claimToken };
  const markIntent = () =>
    turns.startToolCall(record.id, {
      callId: proof.invocation.callId,
      tool: 'shell_run_write',
      capability: proof.capability,
      rerunnable: false,
      args: { command: 'printf 42', cwd: '.' },
      effect: { row: 'host', reversible: 'no', resource: proof.resource, decision: 'ask' },
    });
  return { approvals, turns, record, proof, markIntent };
}

describe('deferred exact approvals', () => {
  it('cannot be used by a different or stale call, and consumes one bound intent', () => {
    const { approvals, turns, proof, markIntent } = fixture();
    const start = vi.fn(markIntent);
    expect(approvals.decide(proof.id, 'allow', now)).toBe('ok');
    expect(approvals.take(proof, now)).toBeNull();
    expect(approvals.startInvocation({ ...proof, turnId: 'b'.repeat(32) }, now, start)).toBeNull();
    expect(approvals.startInvocation({ ...proof, claimToken: 'stale' }, now, start)).toBeNull();
    expect(
      approvals.startInvocation(
        { ...proof, invocation: { ...proof.invocation, digest: 'changed-scope' } },
        now,
        start,
      ),
    ).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(approvals.get(proof.id)?.consumedAt).toBeNull();
    expect(approvals.startInvocation(proof, now, start)).toBe('allow');
    expect(approvals.startInvocation(proof, now, start)).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(turns.uncertainCalls(proof.turnId).map((entry) => entry.callId)).toEqual(['shell-1']);
  });

  it('rolls back the grant and the intent together on a failed write', () => {
    const { approvals, turns, proof, markIntent } = fixture();
    expect(approvals.decide(proof.id, 'allow', now)).toBe('ok');
    expect(() =>
      approvals.startInvocation(proof, now, () => {
        markIntent();
        throw new Error('interrupted before commit');
      }),
    ).toThrow('interrupted before commit');
    expect(approvals.get(proof.id)?.consumedAt).toBeNull();
    expect(turns.uncertainCalls(proof.turnId)).toEqual([]);
    expect(approvals.startInvocation(proof, now, markIntent)).toBe('allow');
  });

  it('handles a denial, a late answer and a cancelled turn without recording effects', () => {
    const denied = fixture();
    const late = fixture();
    const cancelled = fixture();
    const lateTime = new Date(now.getTime() + APPROVAL_WINDOW_MS + 1);
    const start = vi.fn();

    denied.approvals.decide(denied.proof.id, 'deny', now);
    expect(denied.approvals.startInvocation(denied.proof, now, start)).toBe('deny');
    expect(denied.approvals.startInvocation(denied.proof, now, start)).toBeNull();
    late.approvals.decide(late.proof.id, 'allow', lateTime);
    expect(late.approvals.startInvocation(late.proof, lateTime, start)).toBe('expired');
    cancelled.approvals.decide(cancelled.proof.id, 'allow', now);
    cancelled.turns.finish(
      cancelled.proof.turnId,
      { outcome: 'aborted', messages: [], taint: 0, counters: cancelled.record.counters },
      cancelled.record.claimToken,
    );
    expect(cancelled.approvals.startInvocation(cancelled.proof, now, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});
