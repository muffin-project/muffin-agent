import type { DueCommitment, TodoStore } from '../turns/todo.js';
import type { FireLog } from './firelog.js';
import type { Deliver } from './scheduler.js';
import { decideProactive } from './proactivity.js';
import type { ProactiveContext, ProactiveDecision, ProactiveTrigger } from './proactivity.js';

/**
 * `commitment_due`, at last with a producer — ADR-0060.
 *
 * `ProactiveKind` has declared *"an obligation the owner recorded, its time
 * approaching"* since the day the set was written, and nothing has ever built
 * one (`docs/evidence/fuori-dal-turno-2026-09-03.md` §3). That is why
 * `proactive_fires` on the owner's install reads zero for a reason that is not
 * a defect in any gate: the alarm has been beating every thirty seconds for
 * weeks and nobody winds it.
 *
 * ## What a dated commitment is, and what it is not
 *
 * It is **one row of `todos` with a `due_at`**: a step, already durable, already
 * written by the model, already carrying the taint of the turn that wrote it,
 * that now also carries the moment it is owed. It is deliberately none of the
 * three things this repository already had:
 *
 *  - not a **job**, which models a *recurrence* — `JobStore.markRan` always
 *    recomputes the next fire and never deactivates a row, so a single promise
 *    written as `0 9 3 10 *` comes back every October; and a job fires with a
 *    system principal at a literal `taint: 0` (`agent/scheduler-run.ts`), so a
 *    date written there by a turn would launder that turn's provenance.
 *  - not a **`wait`**, which suspends *the current turn* for at most seven days
 *    (`core/turns/wait.ts`) and holds one of eight per-tenant slots while it
 *    does. Right for "ricontrolla fra un'ora", structurally wrong for "fra un
 *    mese".
 *  - not an **absence** (`gone_quiet`), which is Muffin's own inference over the
 *    owner's record. This is the owner's own sentence, given back.
 *
 * ## The rails are the ones that already exist
 *
 * This module owns no statistics and no rails. `TodoStore.dueCommitments`
 * produces the signal, `decideProactive` decides, `FireLog` remembers. Exactly
 * the split `observe.ts` keeps for absences, and for the same reason: a second
 * place that decided when Muffin may speak would be a second threat model.
 *
 * The taint rail is the load-bearing one and it is satisfied **by construction**
 * rather than by attention: the trigger's `tier` is the row's own `tier`, so a
 * commitment written during a turn that had read a web page at tier 3 arrives at
 * the gate at tier 3 and is denied `tainted_source` on the gate's first line.
 * That is the `s7` *remember-then-act* delayed-trigger shape
 * (`docs/evidence/eval-taint-corpus-avversariale-2026-09-03.md`), closed here
 * because the column travels rather than because anyone remembered to check.
 *
 * ## Once, and never again
 *
 * A delivered commitment burns its anchor in `FireLog` and that is the whole of
 * "done": there is no `markRan` here, nothing recomputes a next moment, and the
 * row is left exactly as the owner left it — still `pending`, because Muffin
 * reminding somebody is not the same event as the somebody doing the thing.
 */

/** Not a gate decision: the gate was never asked, because this was said already. */
type Skipped = { effect: 'skip'; reason: 'already_fired' };

export type CommitmentObservation = {
  commitment: DueCommitment;
  anchor: string;
  decision: ProactiveDecision | Skipped;
};

/**
 * The stable id of this commitment *at this moment*.
 *
 * `session_id` and `seq` name the row — the primary key is
 * `(tenant, session_id, key)` and `seq` is stable within a session — and the
 * due instant is in the anchor for the reason `absenceAnchor` carries
 * `lastSeen`: moving the date is a **new** commitment and may speak, whereas
 * the same date coming round on the next tick is the same one and must not.
 * Without the instant, an owner who pushed a promise from Tuesday to Friday
 * would never hear about it again.
 */
export function commitmentAnchor(c: DueCommitment): string {
  return `commitment:${c.sessionId}:${c.seq}:${c.dueAt.toISOString()}`;
}

/**
 * Past this, the message says it is late and names the moment it was for.
 *
 * The owner's decision, recorded in ADR-0060: **late but honest**, never
 * silently dropped. A commitment that vanished because the process was down for
 * three days is indistinguishable, from the owner's side, from a Muffin that
 * never worked — and this repository has already paid for that confusion
 * elsewhere. So the grace is unlimited, exactly like `markRan`'s coalescing
 * (`core/scheduler/jobs.ts`), and what changes is that the dated case *says so*
 * instead of inheriting cron semantics in silence.
 *
 * One hour, and the number is a judgement rather than a measurement: inside it a
 * promise arrives at its moment as a person experiences a moment (the tick is
 * 30 s, and quiet hours are the only other thing that can hold it). Past it the
 * owner needs to be told *when* it was for, because "ricordati della cosa" two
 * days late is a different message from the same words on time.
 */
export const LATE_AFTER_MS = 60 * 60 * 1000;

/**
 * How many commitments may reach the owner in one pass.
 *
 * A burst limiter, the same rail and the same three as `observe.ts`'s
 * `OBSERVE_LIMIT`: what is bounded is how much lands at once, not how often the
 * passes happen. Applied **after** the dedup, for the bug that file records —
 * counting skips would hand the whole budget to the ones that are never
 * delivered.
 */
const COMMITMENT_LIMIT = 3;

export type CommitmentDeps = {
  /** Stage 1's signal producer: one indexed query, no model, deliberately uncapped. */
  due: () => DueCommitment[];
  decide: typeof decideProactive;
  /** Read here, written by the caller after delivery — see `recordCommitmentFired`. */
  fires: FireLog;
  ctx: ProactiveContext;
  /** The surface a message would go out on; part of the trigger the gate sees. */
  channel: string;
  limit?: number;
};

export function observeCommitments(deps: CommitmentDeps): CommitmentObservation[] {
  const out: CommitmentObservation[] = [];
  const limit = deps.limit ?? COMMITMENT_LIMIT;
  let decided = 0;
  for (const commitment of deps.due()) {
    if (decided >= limit) break;
    const anchor = commitmentAnchor(commitment);

    // Dedup before the gate, never after: a repeat must not even be decided.
    // This is also the whole of "a commitment is not a recurrence" — the row
    // stays where it is and the anchor is what makes it silent for ever.
    if (deps.fires.has(anchor)) {
      out.push({ commitment, anchor, decision: { effect: 'skip', reason: 'already_fired' } });
      continue;
    }

    const trigger: ProactiveTrigger = {
      // The row's own tier, never a literal. This is the line the whole design
      // turns on: what arrives at the gate is the provenance of the turn that
      // wrote the promise, so a promise planted by a web page or a group
      // message is denied here and not merely unlikely to be written.
      tier: commitment.tier,
      channel: deps.channel,
      kind: 'commitment_due',
      anchor,
    };
    out.push({ commitment, anchor, decision: deps.decide(trigger, deps.ctx) });
    decided += 1;
  }
  return out;
}

/** `martedì 3 ottobre alle 09:00`, in the owner's timezone. */
function quando(at: Date, timezone: string): string {
  const giorno = new Intl.DateTimeFormat('it-IT', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(at);
  const ora = new Intl.DateTimeFormat('it-IT', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return `${giorno} alle ${ora}`;
}

/**
 * What the owner reads. Deterministic, and no model call.
 *
 * Stage 2 for an absence needs a model because the *observation* has to be put
 * into words; a commitment is already words — the owner's own, through the
 * model that wrote the row — and paraphrasing it would be the one thing a
 * reminder must not do. So this lane costs zero tokens and works on a home with
 * no API key, which is also why it can sit on the tick.
 */
export function commitmentMessage(c: DueCommitment, now: Date, timezone: string): string {
  const late = now.getTime() - c.dueAt.getTime() >= LATE_AFTER_MS;
  if (!late) return `Promemoria: ${c.text}`;
  return `Promemoria in ritardo: ${c.text} — era per ${quando(c.dueAt, timezone)}.`;
}

/**
 * Burn the anchor. Deliberately not called by `observeCommitments`, exactly as
 * `recordFired` is not called by `observe`: a `defer` is the gate saying "not
 * now", and recording it would turn one quiet-hours pass into permanent silence
 * about that promise.
 */
export function recordCommitmentFired(fires: FireLog, obs: CommitmentObservation, at: Date): void {
  fires.record({
    anchor: obs.anchor,
    kind: 'commitment_due',
    decidedAt: at,
    // The evidence rather than a sentence about it (`firelog.ts`): months later
    // this row has to justify the nudge without the plan being re-read — when
    // the promise was made, and when it was for.
    reason: `impegno del ${obs.commitment.createdAt.slice(0, 10)} · scadeva ${obs.commitment.dueAt.toISOString()}`,
    effect: 'allow',
  });
}

export type CommitmentLaneDeps = {
  todos: TodoStore;
  tenant: string;
  fires: FireLog;
  deliver: Deliver;
  channel: string;
  /** The owner's timezone, from the sealed root of trust — never the host's. */
  timezone: string;
  /** The quiet window and the spend cap, read fresh per pass by the caller. */
  context: (now: Date) => ProactiveContext;
  decide?: typeof decideProactive;
  onEvent?: (e: CommitmentEvent) => void;
};

export type CommitmentEvent =
  | { kind: 'spoke'; anchor: string; late: boolean }
  | { kind: 'undelivered'; anchor: string; why: string };

/**
 * The pass, on the scheduler's own beat.
 *
 * Fire-and-forget like `Scheduler.tick`, and for the same reason: the beat that
 * drives this is also the heartbeat that keeps the gateway's claim alive
 * (`core/gateway/service.ts`), so nothing on it may be awaited. `inFlight`
 * guards the overlap a 30-second beat makes real — a delivery slower than one
 * tick must not be started twice — and `idle()` is what lets a test await the
 * pass instead of racing it.
 */
export class CommitmentLane {
  private inFlight: Promise<void> = Promise.resolve();
  private running = false;

  constructor(private readonly deps: CommitmentLaneDeps) {}

  tick(now: Date): void {
    if (this.running) return;
    this.running = true;
    this.inFlight = this.pass(now).finally(() => {
      this.running = false;
    });
    void this.inFlight;
  }

  /** Resolves when the pass started by the last `tick` has finished. */
  async idle(): Promise<void> {
    await this.inFlight;
  }

  private async pass(now: Date): Promise<void> {
    const observations = observeCommitments({
      due: () => this.deps.todos.dueCommitments(this.deps.tenant, now),
      decide: this.deps.decide ?? decideProactive,
      fires: this.deps.fires,
      ctx: this.deps.context(now),
      channel: this.deps.channel,
    });

    for (const obs of observations) {
      if (obs.decision.effect !== 'allow') continue;
      const text = commitmentMessage(obs.commitment, now, this.deps.timezone);
      try {
        const outcome = await this.deps.deliver(this.deps.channel, text);
        if (!outcome.delivered) {
          // The anchor stays open, the rule `cli/observe.ts` runs on: only a
          // message that reached the owner is a thing that was said. A promise
          // burned on a delivery that did not happen is a promise lost for
          // good, which is the one outcome ADR-0060 refuses.
          this.deps.onEvent?.({ kind: 'undelivered', anchor: obs.anchor, why: outcome.why });
          continue;
        }
        recordCommitmentFired(this.deps.fires, obs, now);
        this.deps.onEvent?.({
          kind: 'spoke',
          anchor: obs.anchor,
          late: now.getTime() - obs.commitment.dueAt.getTime() >= LATE_AFTER_MS,
        });
      } catch (error) {
        this.deps.onEvent?.({
          kind: 'undelivered',
          anchor: obs.anchor,
          why: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
