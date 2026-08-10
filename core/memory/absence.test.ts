import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';
import { ABSENCE_DEFAULTS, absenceAnchor, detectAbsences, overdueProbability } from './absence.js';

/**
 * The absence detector, tested on the things that can turn it into a firehose.
 *
 * Every case below is a way this file can look right and not be: the burst that
 * zeroes the intervals, the rare rhythm mistaken for silence, the group
 * evidence that arms a private nudge. The thresholds are not tested against a
 * round number but against two entities in the same database with the same
 * `now`, because the rule is not "how many days" — it is the delta against that
 * particular thing's rhythm.
 */

const HOST = 'host';
const T0 = Date.parse('2026-01-01T09:00:00Z');
const DAY = 86_400_000;
/** Day `n` of the fake history, as ISO. */
const at = (days: number): string => new Date(T0 + days * DAY).toISOString();
const now = (days: number): Date => new Date(T0 + days * DAY);

function harness(): { db: Database; store: MemoryStore } {
  const db = new DatabaseCtor(':memory:');
  return { db, store: new MemoryStore(db) };
}

type MentionOpts = { tier?: 0 | 1 | 2 | 3; tenant?: string; asObject?: boolean };

/**
 * A mention = one episode plus one fact that names the entity. It goes through
 * the store's real API: a test that wrote the rows by hand would prove I can
 * write the same INSERT twice.
 */
function mention(h: ReturnType<typeof harness>, name: string, days: number, opts: MentionOpts = {}): number {
  const tenant = opts.tenant ?? HOST;
  const tier = opts.tier ?? 0;
  const when = at(days);
  const entityId = h.store.upsertEntity(tenant, name, 'thing', when);
  const episodeId = h.store.addEpisode({
    tenantId: tenant,
    connector: 'cli',
    threadKey: 't1',
    role: 'user',
    kind: 'message',
    content: `qualcosa su ${name}`,
    trustTier: tier,
    createdAt: when,
  });
  // The object side needs a different subject: "Marco's book" names Marco as
  // much as "Marco read" does.
  const otherId = opts.asObject ? h.store.upsertEntity(tenant, 'Giusto', 'person', when) : entityId;
  h.store.addFact({
    tenantId: tenant,
    subjectId: opts.asObject ? otherId : entityId,
    predicate: 'menzionato',
    ...(opts.asObject ? { objectId: entityId } : { objectValue: 'x' }),
    episodeId,
    trustTier: tier,
    confidence: 0.9,
    extractionV: 1,
    recordedAt: when,
  });
  return entityId;
}

const names = (rows: { name: string }[]): string[] => rows.map((r) => r.name);

describe('overdueProbability', () => {
  it('is the Lomax tail we expect, on numbers worked out by hand', () => {
    // A gap equal to the historical span, one single observed interval: half.
    expect(overdueProbability(10, 10, 1)).toBeCloseTo(0.5, 10);
    // Same gap, five intervals: 2^-5. More history ⇒ the same silence is
    // stranger, which is the whole point of the predictive.
    expect(overdueProbability(10, 10, 5)).toBeCloseTo(0.03125, 10);
    expect(overdueProbability(30, 10, 2)).toBeCloseTo(1 / 16, 10);
  });

  it('shows the "mean × 3" rule is not a 5% threshold when the history is short', () => {
    // The arithmetic the old detector did implicitly: gap = 3 × mean, with
    // mean = span/n. In the limit of large n it tends to e^-3 = 0.0498; with
    // two intervals — the minimum we accept — it is 0.16. One false alarm every
    // six entities instead of every twenty: this line is the reason the
    // threshold here is p and not k.
    const pAtThreeTimesMean = (n: number) => overdueProbability(3 * (10 / n), 10, n);
    expect(pAtThreeTimesMean(2)).toBeCloseTo(0.16, 2);
    expect(pAtThreeTimesMean(2)).toBeGreaterThan(ABSENCE_DEFAULTS.alpha * 3);
    // And it gets there slowly: at fifty intervals it is still 0.054, not
    // 0.0498. The ×3 rule is the right tail only in the limit, and no personal
    // history has five hundred mentions of the same thing.
    expect(pAtThreeTimesMean(50)).toBeGreaterThan(Math.exp(-3));
    expect(pAtThreeTimesMean(50)).toBeLessThan(0.06);
    expect(pAtThreeTimesMean(500)).toBeCloseTo(Math.exp(-3), 3);
  });

  it('does not call anomalous what it knows nothing about', () => {
    // No intervals, or every mention in the same instant: p = 1, never below
    // alpha. If this returned 0 the detector would fire on every entity named
    // exactly once.
    expect(overdueProbability(1000, 10, 0)).toBe(1);
    expect(overdueProbability(1000, 0, 5)).toBe(1);
  });
});

describe('threshold calibration', () => {
  /**
   * The only eval that counts on this piece, and it needs no model to run:
   * generate **live** entities — exponential intervals, and a current silence
   * drawn from the same law — and count how often the detector cries absence.
   * If `alpha` means what it says, the answer is alpha.
   *
   * It is not an approximation: with V = gap/(gap+S) ~ Beta(1,n) you get
   * p = (1-V)^n, hence P(p < alpha) = alpha exactly, for every n. The
   * simulation is there to check that the *code* does the arithmetic the
   * algebra says it does, which is a different thing.
   *
   * Fixed seed: this is a deterministic calculation, not a test that passes
   * every now and then.
   */
  const lcg = (seed: number): (() => number) => {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  };

  it('the false-alarm rate is alpha, and does not depend on how much history there is', () => {
    const N = 20_000;
    const rates: number[] = [];
    const inherited: number[] = [];
    for (const n of [2, 5, 20]) {
      const rnd = lcg(20260810 + n);
      let byP = 0;
      let byK = 0;
      for (let i = 0; i < N; i++) {
        let span = 0;
        for (let k = 0; k < n; k++) span += -Math.log(1 - rnd());
        const gap = -Math.log(1 - rnd());
        if (overdueProbability(gap, span, n) < 0.05) byP++;
        // The inherited rule, on the exact same sample.
        if (gap > 3 * (span / n)) byK++;
      }
      rates.push(byP / N);
      inherited.push(byK / N);
    }

    // 0.0473 · 0.0508 · 0.0527 — the knob keeps its promise at every n.
    for (const r of rates) expect(r).toBeGreaterThan(0.04);
    for (const r of rates) expect(r).toBeLessThan(0.06);

    // 0.1538 · 0.0992 · 0.0629 — the "mean × 3" rule is off by three times
    // where it was being used, and only gets there with a history nobody has.
    expect(inherited[0]!).toBeGreaterThan(3 * ABSENCE_DEFAULTS.alpha);
    expect(inherited[0]!).toBeGreaterThan(inherited[1]!);
    expect(inherited[1]!).toBeGreaterThan(inherited[2]!);
    expect(inherited[2]!).toBeGreaterThan(rates[2]!);
  });

  it('and stops being exact when the intervals are not exponential', () => {
    /**
     * The structural limit of the proof above: its null hypothesis **is** the
     * model, so it cannot see misspecification. Intervals between human events
     * are the textbook case of a heavy tail — bursts and long empty stretches —
     * and that is the real operating point, not the promised one.
     *
     * Measured here instead of ignored: with strongly lognormal intervals the
     * threshold costs twice what it says. In the other direction, on a regular
     * rhythm, the detector is far more cautious than alpha — it stays quiet
     * about things a human would call gone.
     */
    const boxMuller = (rnd: () => number, sigma: number): number => {
      const u1 = Math.max(rnd(), 1e-12);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rnd());
      return Math.exp(sigma * z - (sigma * sigma) / 2); // mean 1, like the exponential
    };
    const rateFor = (n: number, draw: (r: () => number) => number): number => {
      const rnd = lcg(20260810 + n);
      let hit = 0;
      for (let i = 0; i < 20_000; i++) {
        let span = 0;
        for (let k = 0; k < n; k++) span += draw(rnd);
        if (overdueProbability(draw(rnd), span, n) < ABSENCE_DEFAULTS.alpha) hit++;
      }
      return hit / 20_000;
    };

    const bursty = [2, 5, 20].map((n) => rateFor(n, (r) => boxMuller(r, 1.5)));
    // 0.105 · 0.106 · 0.083 — 1.7× to 2.1× the promise, and the gap narrows
    // with history. The upper bound is worth as much as the lower one: it says
    // the degradation is a factor of two, not an order of magnitude.
    for (const r of bursty) expect(r).toBeGreaterThan(1.5 * ABSENCE_DEFAULTS.alpha);
    for (const r of bursty) expect(r).toBeLessThan(0.15);
    expect(bursty[2]!).toBeLessThan(bursty[0]!);

    // Mean of four exponentials = regular rhythm. 0.0006 · 0.0011 · 0.0018.
    const regular = [2, 5, 20].map((n) =>
      rateFor(n, (r) => (-Math.log(1 - r()) - Math.log(1 - r()) - Math.log(1 - r()) - Math.log(1 - r())) / 4),
    );
    for (const r of regular) expect(r).toBeLessThan(0.01);
  });
});

describe('detectAbsences', () => {
  it('measures the delta from the rhythm, not the days: same now, two opposite verdicts', () => {
    const h = harness();
    // You go to the dentist every six months: ninety days of silence is normal.
    for (const d of [0, 180, 360, 540]) mention(h, 'dentista', d);
    // The gym was every two days: twenty days is an event.
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'palestra', d);

    const found = detectAbsences(h.db, HOST, now(630));

    expect(names(found)).toEqual(['palestra']);
    // The dentist has been quiet more days than the gym, and it is the one that
    // does NOT come out.
    const dentistGap = 630 - 540;
    const gymGap = 630 - 610;
    expect(dentistGap).toBeGreaterThan(gymGap);
  });

  it('a burst is one occasion, or the detector fires on everything', () => {
    const h = harness();
    // Five facts from the same moment of attention: one message that names the
    // same thing five times. Without coalescing the intervals are worth
    // minutes, the historical span collapses and any gap becomes impossible —
    // the firehose built by mistake inside the antidote to the firehose.
    for (const m of [0, 1, 2, 3, 5]) mention(h, 'bug', 600 + m / 1440);

    const found = detectAbsences(h.db, HOST, now(660));

    expect(names(found)).toEqual([]);
    // And the same number of mentions, spread out, is a real pattern.
    const spread = harness();
    for (const d of [600, 610, 620, 630, 640]) mention(spread, 'bug', d);
    expect(names(detectAbsences(spread.db, HOST, now(700)))).toEqual(['bug']);
  });

  it('separates two occasions by distance from the start of the burst, not from the last mention', () => {
    const h = harness();
    // 0, +30min, +90min: the third is 60 minutes from the second but 90 from
    // the start, and it is a new occasion. Counting from the last mention, a
    // conversation that ran all evening would collapse into a single point.
    const hour = 1 / 24;
    for (const d of [600, 600 + hour / 2, 600 + 1.5 * hour, 610, 620, 630, 640]) {
      mention(h, 'progetto', d);
    }

    const found = detectAbsences(h.db, HOST, now(700));

    expect(found).toHaveLength(1);
    // Six: the half hour merges into the first, the hour and a half does not.
    // Counting from the last element it would be five, and the test would stay
    // green on a detector that flattens an entire evening into one point.
    expect(found[0]!.occasions).toBe(6);
  });

  it('evidence from a group arms nothing', () => {
    const h = harness();
    // The gate's rail #1, applied to the source: a stranger who names X twenty
    // times and then stops cannot produce a nudge in the owner's private
    // channel. It is the dormant memory-poisoning, which here would come in *by
    // absence* — a path the downstream gate would not see as tainted.
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'tizio', d, { tier: 2 });

    expect(detectAbsences(h.db, HOST, now(630))).toEqual([]);
  });

  it('does not leave the tenant', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) {
      mention(h, 'palestra', d, { tenant: 'group:telegram:42', tier: 0 });
    }
    expect(detectAbsences(h.db, HOST, now(630))).toEqual([]);
    expect(names(detectAbsences(h.db, 'group:telegram:42', now(630)))).toEqual(['palestra']);
  });

  it('counts the mentions even when the belief has been withdrawn', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'palestra', d);
    // Having talked about it is attention, and it stays attention after the
    // fact has expired. Filtering on expired_at would measure what you believe
    // now, not when you were busy with it — and an entity you changed your mind
    // about would drop off the radar exactly as it becomes interesting.
    h.db.prepare(`UPDATE facts SET expired_at = ?`).run(at(611));

    expect(names(detectAbsences(h.db, HOST, now(630)))).toEqual(['palestra']);
  });

  it('counts object-side mentions too', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'Marco', d, { asObject: true });
    expect(names(detectAbsences(h.db, HOST, now(630)))).toContain('Marco');
  });

  it('stays quiet below the absolute floor, however anomalous the arithmetic', () => {
    const h = harness();
    // A half-day rhythm: three days of silence is already p < 0.05, and there
    // is nothing to ask anyone. The statistics are right, the question is not.
    for (const d of [600, 600.5, 601, 601.5, 602]) mention(h, 'caffè', d);

    expect(detectAbsences(h.db, HOST, now(605))).toEqual([]);
    // The exact same history: it is the floor that stops it, not the threshold.
    expect(names(detectAbsences(h.db, HOST, now(605), { minGapDays: 1 }))).toEqual(['caffè']);
  });

  it('two mentions are not a pattern, and the formula already knows that on its own', () => {
    const h = harness();
    // One single observed interval: ten days between the two times, two hundred
    // of silence. The predictive is (1 + 200/10)^-1 = 0.0476 — under alpha by a
    // hair, after a gap twenty times the historical span. It is the docstring's
    // claim ("one interval demands 19×") put to the test instead of asserted:
    // no constant imposes that slowness, the formula does.
    for (const d of [600, 610]) mention(h, 'tizio', d);
    expect(overdueProbability(200, 10, 1)).toBeLessThan(ABSENCE_DEFAULTS.alpha);

    // And even though the arithmetic lets it through, the floor on occasions
    // stops it: two times are not a rhythm in any language.
    expect(detectAbsences(h.db, HOST, now(810))).toEqual([]);
    expect(names(detectAbsences(h.db, HOST, now(810), { minOccasions: 2 }))).toEqual(['tizio']);
    // A little under 19× and it stays quiet anyway: the threshold is not the
    // number of occasions.
    expect(detectAbsences(h.db, HOST, now(790), { minOccasions: 2 })).toEqual([]);
  });

  it('when the ceiling cuts, it cuts the least strange', () => {
    const h = harness();
    // Four real silences, anomaly decreasing along with the number of
    // occasions: more history ⇒ smaller p at the same gap/span ratio.
    const rhythms: [string, number[]][] = [
      ['a', [600, 602, 604, 606, 608, 610, 612, 614]],
      ['b', [600, 602, 604, 606, 608, 610]],
      ['c', [600, 603, 606, 609]],
      ['d', [600, 605, 610]],
    ];
    for (const [name, days] of rhythms) for (const d of days) mention(h, name, d);

    const found = detectAbsences(h.db, HOST, now(660));

    expect(found).toHaveLength(ABSENCE_DEFAULTS.limit);
    expect([...found].sort((x, y) => x.p - y.p)).toEqual(found);
    // The fourth exists and it is the one dropped: the ceiling is not a random
    // filter.
    const uncapped = detectAbsences(h.db, HOST, now(660), { limit: 10 });
    expect(uncapped).toHaveLength(4);
    expect(names(found)).not.toContain(names(uncapped)[3]);
  });

  it('reports the numbers that justify the question', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'palestra', d);

    const [found] = detectAbsences(h.db, HOST, now(630));

    // A nudge whose evidence cannot be inspected is the old "ho notato" with
    // better manners: whoever reads it has to be able to redo the arithmetic.
    expect(found).toMatchObject({ occasions: 6, spanDays: 10, gapDays: 20 });
    expect(found!.p).toBeCloseTo(Math.pow(3, -5), 10);
    expect(found!.lastSeen).toBe(at(610));
  });
});

describe('absenceAnchor', () => {
  it('changes when the silence is a new silence', () => {
    const h = harness();
    for (const d of [600, 602, 604, 606, 608, 610]) mention(h, 'palestra', d);
    const first = absenceAnchor(detectAbsences(h.db, HOST, now(630))[0]!);

    // You talk about it again, then go quiet again: that is another silence and
    // it may speak.
    mention(h, 'palestra', 640);
    const second = absenceAnchor(detectAbsences(h.db, HOST, now(680))[0]!);

    expect(second).not.toBe(first);
    // But the same silence, read again, stays the same: it is what the gate's
    // dedup rests on, and without this half you notice one thing forever.
    expect(absenceAnchor(detectAbsences(h.db, HOST, now(690))[0]!)).toBe(second);
  });
});
