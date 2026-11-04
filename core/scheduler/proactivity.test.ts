import { describe, expect, it } from 'vitest';
import { decideProactive, inQuietHours, nextTimeOfDay, type ProactiveTrigger } from './proactivity.js';

const QUIET = { from: '23:00', to: '08:00', timezone: 'Europe/Rome' };
const ACTIVE_NOON = new Date('2026-06-15T12:00:00Z'); // 14:00 Rome (CEST) — awake
const DEEP_NIGHT = new Date('2026-06-15T01:00:00Z'); // 03:00 Rome — quiet

const owner: ProactiveTrigger = { tier: 0, channel: 'telegram', kind: 'deadline_near', anchor: 'fact:42' };

describe('decideProactive', () => {
  it('owner evidence, awake, under budget → allow', () => {
    const d = decideProactive(owner, { now: ACTIVE_NOON, quietHours: QUIET, budgetExhausted: false });
    expect(d).toEqual({ effect: 'allow' });
  });

  it('group content can never make Muffin speak first — denied and unbuildable as free text', () => {
    // The dormant memory-poisoning path (threat model §b): a stranger's message
    // (tier 2) that tries to arm a proactive nudge in the owner's channel.
    const fromGroup: ProactiveTrigger = { ...owner, tier: 2 };
    expect(decideProactive(fromGroup, { now: ACTIVE_NOON, quietHours: QUIET, budgetExhausted: false })).toEqual({
      effect: 'deny',
      reason: 'tainted_source',
    });
    // tier 3 (web / third-party tool) likewise.
    expect(decideProactive({ ...owner, tier: 3 }, { now: ACTIVE_NOON, quietHours: QUIET, budgetExhausted: false })).toMatchObject({
      effect: 'deny',
    });
  });

  it('in quiet hours it defers to the window end, never drops', () => {
    const d = decideProactive(owner, { now: DEEP_NIGHT, quietHours: QUIET, budgetExhausted: false });
    expect(d.effect).toBe('defer');
    if (d.effect === 'defer') {
      expect(d.reason).toBe('quiet_hours');
      // 08:00 Rome on the 15th = 06:00 UTC (CEST).
      expect(d.until.toISOString()).toBe('2026-06-15T06:00:00.000Z');
    }
  });

  it('over budget it defers even while awake — an unattended night cannot spend the month', () => {
    const d = decideProactive(owner, { now: ACTIVE_NOON, quietHours: QUIET, budgetExhausted: true });
    expect(d).toMatchObject({ effect: 'defer', reason: 'budget' });
  });
});

describe('inQuietHours (wrap-around)', () => {
  it('03:00 Rome is inside 23:00–08:00', () => {
    expect(inQuietHours(DEEP_NIGHT, QUIET)).toBe(true);
  });
  it('14:00 Rome is outside', () => {
    expect(inQuietHours(ACTIVE_NOON, QUIET)).toBe(false);
  });
  it('exactly 08:00 is already out (end is exclusive)', () => {
    expect(inQuietHours(new Date('2026-06-15T06:00:00Z'), QUIET)).toBe(false); // 08:00 Rome
  });
  it('exactly 23:00 is already in', () => {
    expect(inQuietHours(new Date('2026-06-15T21:00:00Z'), QUIET)).toBe(true); // 23:00 Rome
  });
});

describe('nextTimeOfDay', () => {
  it('computes the next 08:00 in the zone', () => {
    expect(nextTimeOfDay('08:00', 'Europe/Rome', DEEP_NIGHT).toISOString()).toBe('2026-06-15T06:00:00.000Z');
  });
});

describe('decideProactive lineage (#859)', () => {
  const ctx = { now: ACTIVE_NOON, quietHours: QUIET, budgetExhausted: false };
  const clean: ProactiveTrigger = { tier: 0, channel: 'telegram', kind: 'deadline_near', anchor: 'fact:1' };
  it('untrusted lineage without owner bytes fails closed', () => {
    expect(
      decideProactive({ ...clean, lineage: { ownerBytes: false, untrusted: true } }, ctx),
    ).toEqual({ effect: 'deny', reason: 'untrusted_lineage' });
  });
  it('owner bytes win over an untrusted match (re-authored)', () => {
    expect(
      decideProactive({ ...clean, lineage: { ownerBytes: true, untrusted: true } }, ctx),
    ).toEqual({ effect: 'allow' });
  });
  it('no lineage evidence keeps the tier-only behavior', () => {
    expect(decideProactive(clean, ctx)).toEqual({ effect: 'allow' });
    expect(
      decideProactive({ ...clean, lineage: { ownerBytes: false, untrusted: false } }, ctx),
    ).toEqual({ effect: 'allow' });
  });
  it('tier gate still fires first', () => {
    expect(
      decideProactive({ ...clean, tier: 2, lineage: { ownerBytes: true, untrusted: false } }, ctx),
    ).toEqual({ effect: 'deny', reason: 'tainted_source' });
  });
});
