import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  checkedAllowance,
  isOwnerActivityAutonomous,
  newActivityAllowance,
  OWNER_ACTIVITY_RECOVERABLE_REASONS,
} from './activity-allowance.js';
import { type ContinuableClass, type NewTurn, TurnStore } from './store.js';

const limits = { maxModelCalls: 2, maxToolCalls: 2, maxAutomaticContinuations: 1 };
const spec = (): NewTurn => ({
  id: 'a',
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
  tenant: 'host',
  surface: 'cli',
  sessionId: 's',
  model: 'test',
  messages: [],
  taint: 0,
  counters: {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 2,
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
    activityAllowance: newActivityAllowance(limits),
  },
});
function fixture() {
  const db = new Database(':memory:');
  const s = new TurnStore(db);
  const r = s.create(spec());
  return { db, s, r };
}
function release(s: TurnStore, r: ReturnType<TurnStore['create']>) {
  return s.releaseContinuable(
    r.id,
    {
      messages: [],
      taint: 0,
      counters: spec().counters,
      reason: { class: 'model_deadline', lease: r.leaseIndex, at: new Date().toISOString() },
    },
    r.claimToken,
  );
}
describe('durable activity allowance', () => {
  it('validates safe finite integer limits and usage', () => {
    expect(() =>
      checkedAllowance({ ...newActivityAllowance(limits), modelCallsUsed: NaN }),
    ).toThrow();
    expect(() => newActivityAllowance({ ...limits, maxModelCalls: 0 })).toThrow();
  });
  it('permits zero automatic renewals without making owner work autonomous', () => {
    const a = newActivityAllowance({ ...limits, maxAutomaticContinuations: 0 });
    expect(a.maxAutomaticContinuations).toBe(0);
    const { s, r } = fixture();
    release(s, r);
    const row = s.get('a')!;
    expect(
      isOwnerActivityAutonomous({ ...row, counters: { ...row.counters, activityAllowance: a } }),
    ).toBe(false);
  });
  it('reserves before use, fences claims, and preserves reservations through stale writes and reopen', () => {
    const { db, s, r } = fixture();
    expect(s.reserveActivity('a', 'wrong', 'model')).toBe(false);
    expect(s.reserveActivity('a', r.claimToken!, 'model')).toBe(true);
    s.checkpoint('a', { messages: [], taint: 0, counters: spec().counters }, r.claimToken);
    expect(new TurnStore(db).activityAllowance('a')?.modelCallsUsed).toBe(1);
    expect(s.reserveActivity('a', r.claimToken!, 'model')).toBe(true);
    expect(s.reserveActivity('a', r.claimToken!, 'model')).toBe(false);
  });
  it('preserves use across suspension and terminal writes', () => {
    const { s, r } = fixture();
    s.reserveActivity('a', r.claimToken!, 'tool');
    s.suspend(
      'a',
      {
        messages: [],
        taint: 0,
        counters: spec().counters,
        wakeAt: new Date().toISOString(),
        waitFor: null,
      },
      r.claimToken,
    );
    expect(s.activityAllowance('a')?.toolCallsUsed).toBe(1);
  });
  it('bounds automatic grants, consumes once, and cannot reset via stale counters', () => {
    const { s, r } = fixture();
    s.reserveActivity('a', r.claimToken!, 'model');
    expect(release(s, r)).toBe(true);
    expect(s.due().map((x) => x.id)).toContain('a');
    const patch = {
      messages: [],
      taint: 0 as const,
      counters: spec().counters,
      newLeaseStartedAt: new Date().toISOString(),
      automatic: true,
    };
    const granted = s.grantContinuation('a', patch);
    expect(granted?.counters.activityAllowance).toMatchObject({
      modelCallsUsed: 1,
      automaticContinuationsUsed: 1,
    });
    expect(s.grantContinuation('a', patch)).toBeNull();
    release(s, granted!);
    expect(s.due()).toHaveLength(0);
    expect(s.grantContinuation('a', patch)).toBeNull();
  });
  it('explicit extension retains spent resources', () => {
    const { s, r } = fixture();
    s.reserveActivity('a', r.claimToken!, 'model');
    release(s, r);
    const next = s.grantContinuation('a', {
      messages: [],
      taint: 0,
      counters: spec().counters,
      newLeaseStartedAt: new Date().toISOString(),
      activityExtension: { maxModelCalls: 3, maxToolCalls: 4, maxAutomaticContinuations: 2 },
    });
    expect(next?.counters.activityAllowance).toMatchObject({
      modelCallsUsed: 1,
      maxModelCalls: 4,
      maxToolCalls: 4,
    });
  });
  it('does not autonomously pick legacy, nonowner, exhausted, or activity_budget rows', () => {
    const { s, r } = fixture();
    release(s, r);
    const row = s.get('a')!;
    expect(isOwnerActivityAutonomous(row)).toBe(true);
    expect(
      isOwnerActivityAutonomous({
        ...row,
        continuableReason: { ...row.continuableReason!, class: 'activity_budget' },
      }),
    ).toBe(false);
    expect(
      isOwnerActivityAutonomous({ ...row, principal: { kind: 'system', source: 'scheduler' } }),
    ).toBe(false);
    const { activityAllowance: _ignored, ...legacyCounters } = row.counters;
    expect(isOwnerActivityAutonomous({ ...row, counters: legacyCounters })).toBe(false);
  });
  it('corrupt persisted allowance fails closed', () => {
    const { db, s, r } = fixture();
    db.prepare(
      "UPDATE turns SET counters=json_set(counters,'$.activityAllowance.modelCallsUsed',-1) WHERE id='a'",
    ).run();
    expect(() => s.reserveActivity('a', r.claimToken!, 'model')).toThrow();
    expect(() => s.activityAllowance('a')).toThrow();
  });
  it('preserves reservation on finish even when caller omits allowance', () => {
    const { s, r } = fixture();
    s.reserveActivity('a', r.claimToken!, 'tool');
    const { activityAllowance: _ignored, ...counters } = spec().counters;
    expect(
      s.finish('a', { outcome: 'answered', messages: [], taint: 0, counters }, r.claimToken),
    ).toBe(true);
    expect(s.activityAllowance('a')?.toolCallsUsed).toBe(1);
    expect(s.reserveActivity('a', r.claimToken!, 'tool')).toBe(false);
  });
  it('does not let caller introduce an allowance into a legacy checkpoint', () => {
    const db = new Database(':memory:');
    const s = new TurnStore(db);
    const input = spec();
    delete input.counters.activityAllowance;
    const r = s.create(input);
    expect(s.reserveActivity('a', r.claimToken!, 'model')).toBe(true);
    expect(s.reserveActivity('a', 'wrong', 'model')).toBe(false);
    s.checkpoint('a', { messages: [], taint: 0, counters: spec().counters }, r.claimToken);
    expect(s.activityAllowance('a')).toBeNull();
    release(s, r);
    expect(s.due()).toHaveLength(0);
    expect(
      s.grantContinuation('a', {
        messages: [],
        taint: 0,
        counters: spec().counters,
        newLeaseStartedAt: new Date().toISOString(),
        activityExtension: limits,
      })?.counters.activityAllowance,
    ).toEqual(newActivityAllowance(limits));
  });
  it('SQL due inclusion agrees with owner policy for each reason and resource exhaustion', () => {
    const { db, s, r } = fixture();
    release(s, r);
    for (const reason of [
      ...OWNER_ACTIVITY_RECOVERABLE_REASONS,
      'activity_budget',
    ] as ContinuableClass[]) {
      db.prepare(
        "UPDATE turns SET continuable_reason=json_set(continuable_reason,'$.class',?) WHERE id='a'",
      ).run(reason);
      expect(s.due().length === 1).toBe(isOwnerActivityAutonomous(s.get('a')!));
    }
    db.prepare(
      "UPDATE turns SET continuable_reason=json_set(continuable_reason,'$.class','plan_open') WHERE id='a'",
    ).run();
    for (const [used, max] of [
      ['modelCallsUsed', 'maxModelCalls'],
      ['toolCallsUsed', 'maxToolCalls'],
      ['automaticContinuationsUsed', 'maxAutomaticContinuations'],
    ]) {
      const allowance = newActivityAllowance(limits);
      (allowance as unknown as Record<string, number>)[used!] = (
        allowance as unknown as Record<string, number>
      )[max!]!;
      db.prepare(
        "UPDATE turns SET counters=json_set(counters,'$.activityAllowance',json(?)) WHERE id='a'",
      ).run(JSON.stringify(allowance));
      expect(s.due()).toHaveLength(0);
      expect(isOwnerActivityAutonomous(s.get('a')!)).toBe(false);
    }
  });
  it('does not reset ceilings on ordinary owner grant or accept extension on automatic grant', () => {
    const { s, r } = fixture();
    s.reserveActivity('a', r.claimToken!, 'model');
    release(s, r);
    const patch = {
      messages: [],
      taint: 0 as const,
      counters: spec().counters,
      newLeaseStartedAt: new Date().toISOString(),
    };
    expect(
      s.grantContinuation('a', { ...patch, automatic: true, activityExtension: limits }),
    ).toBeNull();
    const next = s.grantContinuation('a', patch)!;
    expect(next.counters.activityAllowance).toMatchObject({
      maxModelCalls: 2,
      modelCallsUsed: 1,
      automaticContinuationsUsed: 0,
    });
  });
  it('retains reservation after closing database and gives only one holder a competing grant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-activity-store-'));
    const path = join(dir, 'state.db');
    const db = new Database(path);
    let reopened: Database.Database | undefined;
    let competing: Database.Database | undefined;
    try {
      const s = new TurnStore(db);
      const r = s.create(spec());
      s.reserveActivity('a', r.claimToken!, 'model');
      release(s, r);
      db.close();
      reopened = new Database(path);
      competing = new Database(path);
      const first = new TurnStore(reopened);
      const second = new TurnStore(competing);
      expect(first.activityAllowance('a')?.modelCallsUsed).toBe(1);
      const patch = {
        messages: [],
        taint: 0 as const,
        counters: spec().counters,
        newLeaseStartedAt: new Date().toISOString(),
        automatic: true,
      };
      const granted = first.grantContinuation('a', patch)!;
      expect(second.grantContinuation('a', patch)).toBeNull();
      expect(second.reserveActivity('a', r.claimToken!, 'model')).toBe(false);
      expect(second.activityAllowance('a')?.automaticContinuationsUsed).toBe(1);
      expect(first.reserveActivity('a', granted.claimToken!, 'model')).toBe(true);
      expect(second.reserveActivity('a', granted.claimToken!, 'model')).toBe(false);
    } finally {
      if (db.open) db.close();
      reopened?.close();
      competing?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
