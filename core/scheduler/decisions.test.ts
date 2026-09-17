import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { type Absence, absenceAnchor } from '../memory/absence.js';
import type { DueCommitment } from '../turns/todo.js';
import { observeCommitments } from './commitments.js';
import { type Decision, DecisionLog, decisionParts } from './decisions.js';
import { FireLog } from './firelog.js';
import { observe } from './observe.js';
import { decideProactive, type QuietHours } from './proactivity.js';

/**
 * DT-10: every proactive gate evaluation is durably recorded with its
 * discriminated reason — including the defers and skips `FireLog` must never
 * record. The load-bearing properties: the write happens on the real decide
 * path (not beside it), a repeated identical decision does not spam rows, and
 * reasons stay discriminated (the old `SilentReason`-constant failure).
 */

const QUIET: QuietHours = { from: '23:00', to: '08:00', timezone: 'Europe/Rome' };
const NOON = new Date('2026-08-10T12:00:00+02:00');
const NIGHT = new Date('2026-08-10T03:00:00+02:00');

const absence = (over: Partial<Absence> = {}): Absence => ({
  entityId: 7,
  name: 'tesi',
  kind: 'thing',
  occasions: 9,
  firstSeen: '2026-05-01T09:00:00.000Z',
  lastSeen: '2026-07-01T09:00:00.000Z',
  spanDays: 61,
  gapDays: 40,
  p: 0.004,
  ...over,
});

const commitment = (over: Partial<DueCommitment> = {}): DueCommitment => ({
  sessionId: 's1',
  seq: 0,
  text: 'chiama il commercialista',
  tier: 0,
  dueAt: new Date('2026-08-10T11:00:00+02:00'),
  createdAt: '2026-08-09T09:00:00.000Z',
  ...over,
});

function decision(over: Partial<Decision> = {}): Decision {
  return {
    decidedAt: NOON,
    source: 'observe',
    kind: 'gone_quiet',
    anchor: 'absence:7:2026-07-01T09:00:00.000Z',
    tier: 0,
    channel: 'cli',
    effect: 'allow',
    reason: 'allow',
    ...over,
  };
}

describe('DecisionLog', () => {
  it('round-trips every field, including the defer horizon', () => {
    const log = new DecisionLog(new DatabaseCtor(':memory:'));
    const until = new Date('2026-08-11T08:00:00+02:00');
    expect(log.record(decision({ effect: 'defer', reason: 'quiet_hours', untilAt: until }))).toBe(
      true,
    );
    const [row] = log.list();
    expect(row).toEqual(decision({ effect: 'defer', reason: 'quiet_hours', untilAt: until }));
  });

  it('does not spam: an identical decision for the same anchor writes once', () => {
    const log = new DecisionLog(new DatabaseCtor(':memory:'));
    expect(log.record(decision())).toBe(true);
    expect(log.record(decision())).toBe(false);
    expect(log.list()).toHaveLength(1);
  });

  it('writes again when the decision changes — effect or reason', () => {
    const log = new DecisionLog(new DatabaseCtor(':memory:'));
    log.record(decision({ effect: 'allow', reason: 'allow' }));
    log.record(decision({ effect: 'defer', reason: 'quiet_hours', untilAt: NIGHT }));
    // Same effect, different reason: still a change of mind worth keeping.
    log.record(decision({ effect: 'defer', reason: 'budget', untilAt: NIGHT }));
    expect(log.list()).toHaveLength(3);
  });

  it('keeps anchors apart: identical decisions on different anchors both write', () => {
    const log = new DecisionLog(new DatabaseCtor(':memory:'));
    log.record(decision({ anchor: 'a' }));
    log.record(decision({ anchor: 'b' }));
    expect(log.list()).toHaveLength(2);
  });

  it('reasons stay discriminated: mixed traffic never collapses to one label', () => {
    const log = new DecisionLog(new DatabaseCtor(':memory:'));
    const traffic: Decision[] = [
      decision({ anchor: 'a', effect: 'allow', reason: 'allow' }),
      decision({ anchor: 'b', effect: 'deny', reason: 'tainted_source' }),
      decision({ anchor: 'c', effect: 'defer', reason: 'quiet_hours', untilAt: NIGHT }),
      decision({ anchor: 'd', effect: 'skip', reason: 'already_fired' }),
      decision({ anchor: 'e', effect: 'defer', reason: 'budget', untilAt: NIGHT }),
    ];
    for (const d of traffic) log.record(d);
    const pairs = new Set(log.list().map((r) => `${r.effect}/${r.reason}`));
    expect(pairs.size).toBe(5);
  });
});

describe('decisionParts', () => {
  it('renders a defer with its horizon, a deny with its code', () => {
    expect(decisionParts({ effect: 'deny', reason: 'tainted_source' })).toEqual({
      effect: 'deny',
      reason: 'tainted_source',
    });
    expect(decisionParts({ effect: 'defer', reason: 'budget', until: NIGHT })).toEqual({
      effect: 'defer',
      reason: 'budget',
      untilAt: NIGHT,
    });
  });
});

describe('wiring: the record happens on the real decide path', () => {
  it('observe() records allow with source, kind, tier and channel', () => {
    const db = new DatabaseCtor(':memory:');
    const decisions = new DecisionLog(db);
    const [seen] = observe({
      absences: () => [absence()],
      decide: decideProactive,
      fires: new FireLog(db),
      decisions,
      ctx: { now: NOON, quietHours: QUIET, budgetExhausted: false },
      channel: 'cli',
    });
    expect(seen?.decision).toEqual({ effect: 'allow' });
    const [row] = decisions.list();
    expect(row).toMatchObject({
      source: 'observe',
      kind: 'gone_quiet',
      anchor: 'absence:7:2026-07-01T09:00:00.000Z',
      tier: 0,
      channel: 'cli',
      effect: 'allow',
      reason: 'allow',
    });
  });

  it('observe() records the skip too: a silence explained is not a silence hidden', () => {
    const db = new DatabaseCtor(':memory:');
    const fires = new FireLog(db);
    const decisions = new DecisionLog(db);
    const a = absence();
    fires.record({
      anchor: absenceAnchor(a),
      kind: 'gone_quiet',
      decidedAt: NOON,
      effect: 'allow',
      reason: 'p 0.004 · 40g di silenzio · 9 occasioni',
    });
    const [seen] = observe({
      absences: () => [a],
      decide: decideProactive,
      fires,
      decisions,
      ctx: { now: NOON, quietHours: QUIET, budgetExhausted: false },
      channel: 'cli',
    });
    expect(seen?.decision).toEqual({ effect: 'skip', reason: 'already_fired' });
    const [row] = decisions.list();
    expect(row).toMatchObject({ effect: 'skip', reason: 'already_fired' });
  });

  it('observeCommitments() records a tainted deny with the row tier', () => {
    const db = new DatabaseCtor(':memory:');
    const decisions = new DecisionLog(db);
    const [seen] = observeCommitments({
      due: () => [commitment({ tier: 3 })],
      decide: decideProactive,
      fires: new FireLog(db),
      decisions,
      ctx: { now: NOON, quietHours: QUIET, budgetExhausted: false },
      channel: 'cli',
    });
    expect(seen?.decision).toEqual({ effect: 'deny', reason: 'tainted_source' });
    const [row] = decisions.list();
    expect(row).toMatchObject({
      source: 'commitments',
      kind: 'commitment_due',
      tier: 3,
      effect: 'deny',
      reason: 'tainted_source',
    });
  });

  it('a tick that changes nothing writes nothing: the 30-second beat stays quiet', () => {
    const db = new DatabaseCtor(':memory:');
    const decisions = new DecisionLog(db);
    const deps = {
      due: () => [commitment()],
      decide: decideProactive,
      fires: new FireLog(db),
      decisions,
      ctx: { now: NIGHT, quietHours: QUIET, budgetExhausted: false },
      channel: 'cli',
    };
    observeCommitments(deps);
    observeCommitments(deps);
    // Same anchor, same defer-quiet_hours: one row, not two.
    expect(decisions.list()).toHaveLength(1);
  });
});
