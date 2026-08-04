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
