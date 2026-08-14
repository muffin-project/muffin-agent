import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { BudgetEngine } from './budget.js';

function engine(now: () => Date) {
  return new BudgetEngine(
    new DatabaseCtor(':memory:'),
    { monthlyUsd: 10, perTenantDailyUsd: 2 },
    now,
  );
}

const spend = (tenant: string, usd: number) => ({
  tenant,
  capability: 'chat',
  model: 'test',
  inputTokens: 100,
  outputTokens: 10,
  usd,
});

describe('budget', () => {
  it('adds up the month and trips the global cap', () => {
    const b = engine(() => new Date('2026-08-04T10:00:00Z'));
    b.record(spend('host', 4));
    b.record(spend('host', 5));
    expect(b.exhausted()).toBe(false);
    b.record(spend('host', 1.5));
    expect(b.exhausted()).toBe(true);
  });

  it('keeps a noisy group from eating the whole month', () => {
    // The failure mode this exists for: a group echo loop. The tenant cap trips
    // long before the monthly one, and the owner's own tenant is untouched.
    const b = engine(() => new Date('2026-08-04T10:00:00Z'));
    b.record(spend('group:telegram:42', 2.5));
    expect(b.tenantExhausted('group:telegram:42')).toBe(true);
    expect(b.tenantExhausted('host')).toBe(false);
    expect(b.exhausted()).toBe(false);
  });

  it('never applies the daily cap to the owner, however much the owner spends', () => {
    // The test above passes for a weak reason: `host` had spent nothing. This
    // is the strong one. Two dollars is roughly fifteen frontier turns, so a
    // cap written to stop a group echo loop would, applied to `host`, stop the
    // owner by mid-morning — and the exit criterion for Gate 1 is days of
    // ordinary use. The owner's ceiling is the monthly cap and nothing else.
    const b = engine(() => new Date('2026-08-04T10:00:00Z'));
    b.record(spend('host', 9));
    expect(b.tenantTodayUsd('host')).toBe(9);
    expect(b.tenantExhausted('host')).toBe(false);
    expect(b.exhausted()).toBe(false);
  });

  it('resets the tenant cap the next day and keeps the monthly one', () => {
    let now = new Date('2026-08-04T10:00:00Z');
    const b = engine(() => now);
    b.record(spend('group:telegram:42', 2.5));
    now = new Date('2026-08-05T10:00:00Z');
    expect(b.tenantExhausted('group:telegram:42')).toBe(false);
    expect(b.monthToDateUsd()).toBe(2.5);
  });

  it('starts a fresh month', () => {
    let now = new Date('2026-08-31T23:00:00Z');
    const b = engine(() => now);
    b.record(spend('host', 10));
    expect(b.exhausted()).toBe(true);
    now = new Date('2026-09-01T01:00:00Z');
    expect(b.exhausted()).toBe(false);
  });

  it('announces the crossing once, not on every turn', () => {
    const b = engine(() => new Date('2026-08-04T10:00:00Z'));
    b.record(spend('host', 10));
    expect(b.status().justCrossed).toBe('monthly');
    expect(b.status().justCrossed).toBeNull();
  });
});
