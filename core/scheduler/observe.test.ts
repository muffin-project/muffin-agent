import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { absenceAnchor, overdueProbability, type Absence } from '../memory/absence.js';
import { FireLog } from './firelog.js';
import { decideProactive, type ProactiveTrigger, type QuietHours } from './proactivity.js';
import { observe, recordFired, type ObserveDeps } from './observe.js';

/**
 * Stage 1 wired to the gate.
 *
 * The absence detector and `decideProactive` were each finished and each
 * reached by nothing; every case here is about the join between them rather
 * than about either side's logic. So the real `decideProactive` is used
 * wherever the point is "the gate actually decided this" — a fake would keep
 * passing after the rail it stands for was removed, which is the failure this
 * whole slice exists to close.
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

function deps(over: Partial<ObserveDeps> = {}): ObserveDeps {
  return {
    absences: () => [absence()],
    decide: decideProactive,
    fires: new FireLog(new DatabaseCtor(':memory:')),
    ctx: { now: NOON, quietHours: QUIET, budgetExhausted: false },
    channel: 'cli',
    ...over,
  };
}

describe('observe', () => {
  it('arms the real gate and gets an allow — the owner\'s own evidence, awake, under budget', () => {
    const [seen] = observe(deps());
    expect(seen?.decision).toEqual({ effect: 'allow' });
    expect(seen?.anchor).toBe('absence:7:2026-07-01T09:00:00.000Z');
  });

  it('builds the trigger from the absence: closed kind, owner tier, the channel it would speak on', () => {
    const triggers: ProactiveTrigger[] = [];
    observe(
      deps({
        decide: (t, ctx) => {
          triggers.push(t);
          return decideProactive(t, ctx);
        },
        channel: 'telegram',
      }),
    );
    expect(triggers).toHaveLength(1);
    // tier 0 is the load-bearing literal: the detector only ever reads the
    // owner's own evidence, so anything above 0 here is the rail being dodged.
    expect(triggers[0]).toEqual({
      tier: 0,
      channel: 'telegram',
      kind: 'gone_quiet',
      anchor: 'absence:7:2026-07-01T09:00:00.000Z',
    });
  });

  it('an anchor already fired is skipped and never re-decided', () => {
    const fires = new FireLog(new DatabaseCtor(':memory:'));
    const a = absence();
    recordFired(fires, { absence: a, anchor: absenceAnchor(a), decision: { effect: 'allow' } }, NOON);
    const decide = vi.fn(decideProactive);

    const [seen] = observe(deps({ fires, decide }));

    expect(seen?.decision).toEqual({ effect: 'skip', reason: 'already_fired' });
    // Not merely "not delivered": the gate is not consulted at all, so a
    // repeat cannot spend a decision or a budget check on a question already asked.
    expect(decide).not.toHaveBeenCalled();
  });

  it('a new silence after the topic came back is a different anchor and may speak', () => {
    const fires = new FireLog(new DatabaseCtor(':memory:'));
    const old = absence();
    recordFired(fires, { absence: old, anchor: absenceAnchor(old), decision: { effect: 'allow' } }, NOON);

    // Same entity: it was mentioned again in July and then went quiet again.
    const fresh = absence({ lastSeen: '2026-07-20T09:00:00.000Z' });
    const [seen] = observe(deps({ fires, absences: () => [fresh] }));

    expect(seen?.decision).toEqual({ effect: 'allow' });
  });

  it('quiet hours defer instead of speaking, and the defer is not recorded as fired', () => {
    const fires = new FireLog(new DatabaseCtor(':memory:'));
    const [seen] = observe(deps({ fires, ctx: { now: NIGHT, quietHours: QUIET, budgetExhausted: false } }));

    expect(seen?.decision).toMatchObject({ effect: 'defer', reason: 'quiet_hours' });
    expect(fires.has(seen!.anchor)).toBe(false);

    // And so the next run reconsiders it rather than treating it as said.
    const [again] = observe(deps({ fires }));
    expect(again?.decision).toEqual({ effect: 'allow' });
  });

  it('an exhausted budget defers, and is likewise still open next run', () => {
    const fires = new FireLog(new DatabaseCtor(':memory:'));
    const [seen] = observe(deps({ fires, ctx: { now: NOON, quietHours: QUIET, budgetExhausted: true } }));

    expect(seen?.decision).toMatchObject({ effect: 'defer', reason: 'budget' });
    expect(fires.has(seen!.anchor)).toBe(false);
  });

  it('nothing silent, nothing observed', () => {
    expect(observe(deps({ absences: () => [] }))).toEqual([]);
  });

  it('every absence is decided, and the order the detector ranked them in survives', () => {
    const rows = [absence({ entityId: 1, name: 'a', p: 0.001 }), absence({ entityId: 2, name: 'b', p: 0.02 })];
    expect(observe(deps({ absences: () => rows })).map((o) => o.absence.name)).toEqual(['a', 'b']);
  });

  it('the ceiling counts decisions, so what was already said cannot crowd out what was not', () => {
    /**
     * The starvation this exists to stop. `p` only shrinks as a silence
     * lengthens, so the entities that already fired keep ranking first forever.
     * With the ceiling applied before the dedup — where it used to be, in the
     * detector — those three filled every slot and were then dropped as
     * already-said, and after three nudges nothing new ever surfaced again. The
     * command printed three lines and exit 0, which is what made it invisible.
     */
    const fires = new FireLog(new DatabaseCtor(':memory:'));
    const rows = [1, 2, 3, 4, 5, 6].map((i) =>
      // Ranked as the detector ranks them: the oldest silences are the strongest.
      absence({ entityId: i, name: `e${i}`, p: 0.001 * i }),
    );
    for (const a of rows.slice(0, 3)) {
      fires.record({ anchor: absenceAnchor(a), kind: 'gone_quiet', decidedAt: NOON, effect: 'allow', reason: 'x' });
    }

    const out = observe(deps({ absences: () => rows, fires }));

    expect(out.filter((o) => o.decision.effect === 'skip').map((o) => o.absence.name)).toEqual(['e1', 'e2', 'e3']);
    // Three fresh ones still got through — the whole point.
    expect(out.filter((o) => o.decision.effect === 'allow').map((o) => o.absence.name)).toEqual(['e4', 'e5', 'e6']);
  });

  it('the ceiling still bounds what reaches the owner', () => {
    // The other half: moving the cap must not remove it. Four fresh silences,
    // three decided, the least strange dropped.
    const rows = [1, 2, 3, 4].map((i) => absence({ entityId: i, name: `e${i}`, p: 0.001 * i }));
    const out = observe(deps({ absences: () => rows }));
    expect(out.map((o) => o.absence.name)).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('recordFired', () => {
  it('writes the anchor, the kind and the numbers that justified it', () => {
    const fires = new FireLog(new DatabaseCtor(':memory:'));
    const a = absence();
    recordFired(fires, { absence: a, anchor: absenceAnchor(a), decision: { effect: 'allow' } }, NOON);

    const row = fires.get(absenceAnchor(a));
    expect(row?.kind).toBe('gone_quiet');
    expect(row?.effect).toBe('allow');
    expect(row?.reason).toContain('0.004');
    expect(row?.decidedAt.toISOString()).toBe(NOON.toISOString());
  });

  it('keeps the strongest evidence readable in the row that has to justify it later', () => {
    // `formatP` was added for the two paths the owner sees and missed this one —
    // the durable row whose own docstring says it must justify the nudge months
    // later without re-running the detector. Eleven occasions and a long silence
    // is p ≈ 1e-8, which `toFixed(4)` renders as `0.0000`: the strongest case
    // reading as the weakest, permanently.
    const fires = new FireLog(new DatabaseCtor(':memory:'));
    const a = absence({ p: overdueProbability(500, 100, 10), occasions: 11, gapDays: 500 });
    recordFired(fires, { absence: a, anchor: absenceAnchor(a), decision: { effect: 'allow' } }, NOON);

    expect(fires.get(absenceAnchor(a))?.reason).not.toContain('0.0000');
  });
});
