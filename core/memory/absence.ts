import type Database from 'better-sqlite3';

/**
 * Who has gone quiet — the Stage-1 signal born of *what did not happen*.
 *
 * The principle is cognitive before it is technical
 * (`knowledge/04-learn-from-absence.md`): a central theme that disappears is a
 * narrative event, and the surprise of what is missing is prediction-error just
 * as much as the surprise of what arrives. The rule that makes the principle
 * measurable: **meaningful silence is the delta against the historical
 * pattern**, not the absolute value of `last_seen`. An entity named every six
 * months is not silent at three; one named every two days is silent at ten.
 *
 * ## Why not the "mean × 3" rule
 *
 * The old Muffin used two constants: at least 3 mentions, and silence >
 * mean × 3. They look like a 5% threshold: if the intervals between mentions
 * are exponential, P(gap > k·mean) = e^-k, and e^-3 = 0.0498. But that
 * arithmetic holds **only if the mean is known**, and here it is estimated from
 * a handful of intervals.
 *
 * With the mean estimated, the right predictive distribution is the conjugate
 * Gamma-Exponential: posterior Gamma(n, S) over λ, and a Lomax predictive tail
 *
 *      P(T > gap) = (1 + gap/S)^(-n)
 *
 * where **n = the number of observed intervals** and **S = their sum**, which
 * is simply `last_mention − first_mention`. The mean does not appear: it
 * cancels. With the shortest history we accept (3 occasions → n=2), the ×3 rule
 * gives p = 0.16 — **one false alarm every six entities**, not every twenty.
 * The ×3 form is the right tail in the limit of large n, and it lies exactly
 * where the old detector lived, at the minimum number of mentions.
 *
 * So the threshold here is **p**, not k: a single knob that *means* something
 * (the false-alarm rate you accept), and that on its own demands a longer
 * silence when the history is thinner. One observed interval asks for a 19× gap
 * before it will speak, without any constant imposing that on it.
 *
 * And the promise is **exact, not asymptotic** — *under the model's
 * assumption*: with V = gap/(gap+S) ~ Beta(1,n) you get p = (1-V)^n, hence
 * P(p < alpha) = alpha for *every* n. Simulated on live entities
 * (`absence.test.ts` §calibration): 0.047 · 0.051 · 0.053 at n = 2, 5, 20 —
 * while the ×3 rule, on the same sample, gives 0.154 · 0.099 · 0.063.
 *
 * **Where the assumption does not hold, and what it costs.** That proof has a
 * structural limit: its null hypothesis *is* the model, so it cannot see
 * misspecification. Intervals between human events are the textbook case of a
 * heavy tail, and it is measured in the same file: with strongly lognormal
 * intervals (σ=1.5) the real rate is **0.083-0.105**, that is 1.7× to 2.1× the
 * promised one. In the other direction, on a regular rhythm, it drops to 0.001:
 * the detector stays quiet about things a human would call gone.
 *
 * So alpha is an honest ceiling only up to a factor of two **at σ=1.5, and the
 * factor grows with the tail**: at σ=2 it is 0.090-0.155, up to 3.1×. The
 * condition belongs in this sentence and not only in the two above it, because
 * this is the sentence that gets quoted — the same failure as the index result
 * further down, where a number without its condition was irreproducible.
 *
 * **The constant depends on the prior, and that has to be said**: the one above
 * is the Jeffreys prior for an exponential rate, p(λ) ∝ 1/λ, i.e. an improper
 * Gamma(0,0). With a proper prior the "19×" changes. The conjugacy and the
 * Gamma-mixture-of-exponentials = Lomax identity are standard and verified
 * against third-party sources; this specific closed form we derived rather than
 * copied, and that is why `overdueProbability` is exported and tested against
 * numbers worked out by hand.
 *
 * **There is no prior art to calibrate against.** The research (2026-08-10, in
 * `docs/evidence/proattivita-quando-parlare.md`) found no literature treating "a
 * theme stops appearing" as a memory or retrieval signal: no benchmark against
 * which to measure this threshold. Hence the conservative posture — tight
 * alpha, absolute floor, low ceiling — which is a choice forced by the absence
 * of a measurement, not timidity.
 *
 * ## What counts as a mention
 *
 * An occasion on which the owner *brought that entity up*, not a true fact
 * about it. From which three choices that look like details and are not:
 *
 *  - **Expired facts count too.** Having talked about it is attention, and it
 *    stays attention even if the belief was later superseded. Filtering on
 *    `expired_at IS NULL` would measure what you believe now, not when you were
 *    busy with it.
 *  - **Tier ≤ 1 evidence only.** It is the gate's rail #1 applied to the
 *    *source*: a group that names X twenty times cannot create, through its
 *    later absence, a nudge in the owner's private channel (threat model §b).
 *  - **Mentions close together collapse into one.** One message produces five
 *    facts about the same entity in the same instant: without coalescing, the
 *    intervals are zero, S → 0 and *any* gap comes out infinitely improbable.
 *    It would be a firehose built by mistake inside the antidote to the
 *    firehose. The window collapses the burst into the one occasion it is.
 *
 * ## The cost, measured
 *
 * The query reads **every** fact in the tenant: the whole history is what gives
 * the rhythm, and no index avoids a scan of what has to be scanned anyway. On
 * this machine, in memory, 500 entities and a third of the mentions from the
 * object side: 25k facts → 18 ms, 100k → 86 ms, 400k → 532 ms (median of
 * five). Slightly superlinear because of the ORDER BY's temporary b-tree. It is
 * a **scheduled** path, not a turn path: nobody waits half a second while they
 * are talking. A second independent measurement gave the same shape at ~1.6×
 * the magnitude, so it is the ratios that count, not the milliseconds.
 *
 * An index on `facts(tenant_id, object_id)` looks like the obvious move for the
 * object-side branch and was **measured and dropped** — but the condition has
 * to be stated, because without it the result is irreproducible. **With
 * `sqlite_stat1` absent** (nobody here runs `ANALYZE`) the plan gets worse:
 * 103 ms against 88 ms at 100k, because on a scan of the whole tenant a
 * secondary index adds indirection without removing rows. **After an `ANALYZE`
 * the sign flips** and the index becomes neutral or marginally better. So: not
 * needed today, and whoever proposes it again has to say first whether their
 * database has the statistics — otherwise they will measure the opposite and
 * not know which of the two readings is wrong.
 */

/** An entity that stopped appearing, with the arithmetic that says so. */
export type Absence = {
  entityId: number;
  name: string;
  kind: string;
  /** Distinct occasions on which it appeared (bursts already collapsed). */
  occasions: number;
  /** First and last occasion, ISO. */
  firstSeen: string;
  lastSeen: string;
  /** Days between the first and last occasion: the sum of the intervals. */
  spanDays: number;
  /** Days of silence right now. */
  gapDays: number;
  /**
   * P(a silence at least this long | your pattern) under the predictive.
   * The smaller it is, the more anomalous. It is the number the cut is on.
   */
  p: number;
};

export type AbsenceOptions = {
  /**
   * The accepted false-alarm rate, **per entity**. 0.05 is the convention, and
   * here it has a readable price: out of a hundred entities with enough
   * history, about five will come out silent by chance — and out of two
   * hundred, ten.
   *
   * Said in full, because the previous version of this line claimed the ceiling
   * below "keeps that number away from the owner" and **it is not true**: the
   * ceiling sorts the false alarms by how extreme they are and hands over the
   * worst three. Alpha bounds the per-entity rate; the ceiling bounds the burst
   * per run; **nothing at all bounds the per-owner rate**, because there is
   * still no per-window cap and no decay-on-ignore, which P-I requires. It is
   * the one piece of P-I this slice does not carry, and it is written here
   * instead of being implicit.
   */
  alpha?: number;
  /**
   * The absolute minimum silence, in days. Not statistics: posture. An entity
   * named every hour is "overdue" after half a day and there is nothing to ask.
   * No statistical threshold can express that, because the arithmetic is right
   * — it is the question that is not worth asking.
   */
  minGapDays?: number;
  /**
   * The minimum number of occasions. Two intervals are the least for which the
   * word "pattern" means anything in plain English; the formula holds with one
   * as well, but nobody would call two mentions a pattern.
   */
  minOccasions?: number;
  /** Mentions within this distance of each other are the same occasion. */
  coalesceMinutes?: number;
};

export const ABSENCE_DEFAULTS: Required<AbsenceOptions> = {
  alpha: 0.05,
  minGapDays: 7,
  minOccasions: 3,
  coalesceMinutes: 60,
};

const DAY_MS = 86_400_000;

/**
 * The predictive tail. Exported because it is the one claim in this file that
 * can be wrong in silence: a single test checking it against numbers worked out
 * by hand is worth ten that check the machinery around it.
 *
 * `n` intervals, sum `span`, gap `gap` (same units). Returns P(T > gap).
 */
export function overdueProbability(gap: number, span: number, n: number): number {
  if (n <= 0) return 1;
  // A zero span with more than one occasion means coalescing did not collapse a
  // burst: no time passed between distinct mentions. There is no pattern to
  // violate, and returning 0 would make everything fire.
  if (span <= 0) return 1;
  return Math.pow(1 + gap / span, -n);
}

type MentionRow = { entityId: number; name: string; kind: string; at: string };

/**
 * Reads the mentions and derives the silences from them. Synchronous and
 * model-free: this is Stage 1 in full — an LLM decides *what* to say, never
 * *whether* there is anything.
 */
export function detectAbsences(
  db: Database.Database,
  tenantId: string,
  now: Date,
  options: AbsenceOptions = {},
): Absence[] {
  const o = { ...ABSENCE_DEFAULTS, ...options };

  // An entity is "mentioned" from the subject side as much as from the object
  // side: "I saw Marco" and "Marco's book" are both occasions on which Marco
  // came up. UNION ALL and not UNION: a fact that names it twice is still one
  // row per side, and coalescing merges them right afterwards.
  const rows = db
    .prepare(
      `SELECT e.id AS entityId, e.name, e.kind, f.recorded_at AS at
         FROM facts f JOIN entities e ON e.id = f.subject_id
        WHERE f.tenant_id = ? AND f.trust_tier <= 1
       UNION ALL
       SELECT e.id AS entityId, e.name, e.kind, f.recorded_at AS at
         FROM facts f JOIN entities e ON e.id = f.object_id
        WHERE f.tenant_id = ? AND f.trust_tier <= 1
        ORDER BY entityId, at`,
    )
    .all(tenantId, tenantId) as MentionRow[];

  const byEntity = new Map<number, MentionRow[]>();
  for (const row of rows) {
    const list = byEntity.get(row.entityId);
    if (list) list.push(row);
    else byEntity.set(row.entityId, [row]);
  }

  const found: Absence[] = [];
  for (const [entityId, mentions] of byEntity) {
    // UNION ALL does not guarantee the order inside the group on every engine:
    // sort here, where it costs nothing and does not depend on the query plan.
    const times = mentions
      .map((m) => Date.parse(m.at))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    const occasions = coalesce(times, o.coalesceMinutes * 60_000);
    if (occasions.length < o.minOccasions) continue;

    const first = occasions[0]!;
    const last = occasions[occasions.length - 1]!;
    const span = last - first;
    const gap = now.getTime() - last;
    if (gap < o.minGapDays * DAY_MS) continue;

    const p = overdueProbability(gap, span, occasions.length - 1);
    if (p >= o.alpha) continue;

    found.push({
      entityId,
      name: mentions[0]!.name,
      kind: mentions[0]!.kind,
      occasions: occasions.length,
      firstSeen: new Date(first).toISOString(),
      lastSeen: new Date(last).toISOString(),
      spanDays: round1(span / DAY_MS),
      gapDays: round1(gap / DAY_MS),
      p,
    });
  }

  // Most anomalous first, and **uncapped**. The per-run ceiling used to live
  // here, and applying it before the gate's dedup starved the feature: `p`
  // shrinks as a silence lengthens, so entities that already fired kept ranking
  // first forever, filled every slot, and were then dropped as already-said.
  // After three nudges nothing new surfaced again — while the command printed
  // three lines and exit 0, which is this repo's canonical way of looking
  // healthy. The ceiling is a proactivity rail (P-I), not a property of memory,
  // so it lives next to the gate now, in `scheduler/observe.ts`.
  found.sort((a, b) => a.p - b.p || b.gapDays - a.gapDays);
  return found;
}

/** Sorted timestamps → occasions: the first of each burst. */
function coalesce(sorted: number[], windowMs: number): number[] {
  const out: number[] = [];
  for (const t of sorted) {
    const prev = out[out.length - 1];
    // Against the start of the burst, not the last element: otherwise ten
    // messages 59 minutes apart from one another become a single occasion ten
    // hours long.
    if (prev === undefined || t - prev > windowMs) out.push(t);
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * `p` for a human, on screen and inside the prompt.
 *
 * `toFixed(4)` alone prints `0.0000` exactly where the evidence is strongest —
 * eleven occasions and a gap five times the span is p ≈ 1.6e-8 — in the line
 * whose entire job is to show the arithmetic that justified speaking. Shared by
 * both readers so they cannot drift: what the owner sees and what the model is
 * told have to be the same number.
 */
export function formatP(p: number): string {
  return p < 1e-4 ? p.toExponential(1) : p.toFixed(4);
}

/**
 * The anchor for the gate's dedup. It carries `lastSeen`: the same silence does
 * not repeat, but if you talk about it again and then go quiet again, that is a
 * new silence and it may speak. It is the difference between remembering and
 * insisting.
 *
 * Namespaced by tenant: entity ids are one autoincrement shared by every
 * tenant, so `absence:7:…` in two tenants is two silences, not one. Without
 * the tenant a nudge fired in one room would forever silence the same-numbered
 * entity in every other room (slice/tenant-anchors).
 */
export function absenceAnchor(a: Absence, tenantId: string): string {
  return `absence:${tenantId}:${a.entityId}:${a.lastSeen}`;
}
