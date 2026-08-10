import { absenceAnchor, type Absence } from '../memory/absence.js';
import type { FireLog } from './firelog.js';
import type { decideProactive, ProactiveContext, ProactiveDecision, ProactiveTrigger } from './proactivity.js';

/**
 * Stage 1, joined to the gate.
 *
 * The two-stage gate (`knowledge/03-observing-spine.md`) is: a cheap
 * deterministic signal decides *whether* this is even a moment, and only on a
 * yes does a model decide *what* to say. This module is the seam. It owns no
 * statistics — `memory/absence.ts` produces the signal — and no rails —
 * `decideProactive` owns those. What it owns is the third thing, which had no
 * home and therefore did not exist: how often the same observation is allowed
 * to come back.
 *
 * Everything is injected because the seam is the part worth testing. A test
 * that had to stand up a model to find out whether a repeat is suppressed would
 * be a test nobody runs.
 */

/** Not a gate decision: the gate was never asked, because this was said already. */
export type Skipped = { effect: 'skip'; reason: 'already_fired' };

export type Observation = {
  absence: Absence;
  anchor: string;
  decision: ProactiveDecision | Skipped;
};

export type ObserveDeps = {
  /** Stage 1's signal producer. Deterministic, no model, capped by the detector. */
  absences: () => Absence[];
  decide: typeof decideProactive;
  /** Read here, written by the caller — see `recordFired`. */
  fires: FireLog;
  ctx: ProactiveContext;
  /** The surface a message would go out on; part of the trigger the gate sees. */
  channel: string;
};

/**
 * Stage 2's seam: given a silence that passed the gate, produce the message.
 * A promise of text and nothing else, so this module and its tests never need a
 * provider, a key or a network.
 */
export type ComposeAbsence = (a: Absence) => Promise<string>;

export function observe(deps: ObserveDeps): Observation[] {
  const out: Observation[] = [];
  for (const absence of deps.absences()) {
    const anchor = absenceAnchor(absence);

    // Dedup before the gate, not after: a repeat must not even be decided.
    // The anchor carries `lastSeen`, so this suppresses *this* silence and not
    // the entity — if the subject comes back and then goes quiet again, that is
    // a new anchor and it may speak. Remembering versus insisting.
    if (deps.fires.has(anchor)) {
      out.push({ absence, anchor, decision: { effect: 'skip', reason: 'already_fired' } });
      continue;
    }

    const trigger: ProactiveTrigger = {
      // tier 0, and it is not a shortcut past the rail that denies tier > 1:
      // `detectAbsences` counts only tier ≤ 1 evidence, so a group can neither
      // create a silence nor end one, and what is left is Muffin's own inference
      // over the owner's own record. The literal states that, and a detector
      // that ever widened its source would have to change it here.
      tier: 0,
      channel: deps.channel,
      kind: 'gone_quiet',
      anchor,
    };
    out.push({ absence, anchor, decision: deps.decide(trigger, deps.ctx) });
  }
  return out;
}

/**
 * Burn the anchor. Deliberately not called by `observe`: a `defer` is the gate
 * saying "not now", and recording it would turn every quiet-hours run into a
 * permanent silence about that entity. Only an allow that reached the owner is
 * a thing that was said — so the caller records it after the message actually
 * went out, and a composition that failed leaves the observation open.
 */
export function recordFired(fires: FireLog, obs: Observation, at: Date): void {
  fires.record({
    anchor: obs.anchor,
    kind: 'gone_quiet',
    decidedAt: at,
    effect: 'allow',
    // The evidence rather than a sentence about it: months later this row has
    // to justify the nudge without the detector being re-run.
    reason: `p ${obs.absence.p.toFixed(4)} · ${obs.absence.gapDays}g di silenzio · ${obs.absence.occasions} occasioni`,
  });
}
