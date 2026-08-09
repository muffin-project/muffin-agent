import { CronExpressionParser } from 'cron-parser';
import type { TrustTier } from '../policy/types.js';

/**
 * The proactivity gate: whether Muffin may speak first, right now, for this
 * trigger. The owner chose the "high-confidence signal" posture (2026-08-09) —
 * Muffin speaks first beyond what was explicitly asked, but only when a strong,
 * verifiable signal fires, and always behind these rails.
 *
 * It is a pure decision function, like the policy kernel, and for the same
 * reason: every inferred proactive action goes through it, so the rules live in
 * one place, in code, and a decision is explainable from a snapshot. The rails
 * are not product taste — they are the threat model:
 *
 *  1. **Only the owner's own evidence may arm it (tier ≤ 1).** A group message
 *     that tries to make Muffin speak first is the dormant memory-poisoning
 *     path (threat model §b): a stranger plants a fact, it surfaces later as a
 *     proactive nudge in the owner's private channel. Denied by construction,
 *     and logged.
 *  2. **Never in quiet hours.** Speaking first at 3am is a failure even when the
 *     signal is real. Deferred to the end of the quiet window, not dropped.
 *  3. **Under budget.** A proactive message costs; over the cap it defers, so an
 *     unattended night cannot spend the month on nudges.
 *
 * And one rail on *what* may speak, not just when — an owner constraint from
 * the previous Muffin, whose proactivity was a firehose of "ho notato X, ho
 * notato Y": vague, over-complex, sometimes unreal observations. So a trigger
 * `kind` is a **closed set of concrete, actionable signals** — a free-form
 * "I noticed a pattern" is not representable here. You cannot arm the gate
 * without a real anchor (a commitment, a deadline, a fact that became
 * actionable). The firehose is unbuildable, not merely discouraged. The
 * content rule that follows from it — lead with the concrete thing, cite the
 * evidence, one clear point, never a speculative analysis — belongs to the
 * message the signal-detector writes; this type keeps the *shape* honest.
 */

/**
 * The closed set of things that may make Muffin speak first. Each is anchored
 * in a concrete fact the owner would want surfaced now — not an inference about
 * them. Extending this set is a deliberate act (a new detector), never a
 * free-form string.
 */
export type ProactiveKind =
  | 'commitment_due' // an obligation the owner recorded, its time approaching
  | 'deadline_near' // a dated fact whose deadline is close
  | 'fact_actionable' // a tier ≤1 fact that just became something to act on
  | 'consolidation'; // internal: unconsolidated episodes crossed the threshold

export type ProactiveTrigger = {
  /** Provenance of the evidence that armed this. Only ≤ 1 (owner's own) may. */
  tier: TrustTier;
  /** The surface the message would be delivered on. */
  channel: string;
  /** One of the closed, actionable kinds — never a free-form observation. */
  kind: ProactiveKind;
  /**
   * A stable id of the concrete anchor (the commitment/fact/episode). Used to
   * dedup: the same signal must not re-fire day after day — the old "ho notato"
   * repetition. The consumer records fired anchors and skips a repeat.
   */
  anchor: string;
};

export type QuietHours = { from: string; to: string; timezone: string };

export type ProactiveContext = {
  now: Date;
  quietHours: QuietHours;
  budgetExhausted: boolean;
};

export type ProactiveDecision =
  | { effect: 'allow' }
  | { effect: 'defer'; until: Date; reason: 'quiet_hours' | 'budget' }
  | { effect: 'deny'; reason: 'tainted_source' };

export function decideProactive(trigger: ProactiveTrigger, ctx: ProactiveContext): ProactiveDecision {
  if (trigger.tier > 1) {
    return { effect: 'deny', reason: 'tainted_source' };
  }
  const quietEnd = nextTimeOfDay(ctx.quietHours.to, ctx.quietHours.timezone, ctx.now);
  if (ctx.budgetExhausted) {
    // Defer to the next quiet-window end: a fresh day, and past quiet hours.
    return { effect: 'defer', until: quietEnd, reason: 'budget' };
  }
  if (inQuietHours(ctx.now, ctx.quietHours)) {
    return { effect: 'defer', until: quietEnd, reason: 'quiet_hours' };
  }
  return { effect: 'allow' };
}

/** Minutes since local midnight for `date` in `tz`, via Intl (no extra dep). */
function localMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl can render midnight as "24" in en-GB; fold it back to 0.
  return ((h % 24) * 60 + m);
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True if `now` (wall-clock in tz) is inside [from, to), wrap-around aware. */
export function inQuietHours(now: Date, q: QuietHours): boolean {
  const cur = localMinutes(now, q.timezone);
  const from = hhmmToMinutes(q.from);
  const to = hhmmToMinutes(q.to);
  if (from === to) return false; // empty window
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** The next occurrence of HH:MM in `tz` strictly after `after`. */
export function nextTimeOfDay(hhmm: string, tz: string, after: Date): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const interval = CronExpressionParser.parse(`${m ?? 0} ${h ?? 0} * * *`, { tz, currentDate: after });
  return interval.next().toDate();
}
