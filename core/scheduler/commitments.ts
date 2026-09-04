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
 * The taint rail is the load-bearing one: the trigger's `tier` is the row's own
 * `max(tier, due_tier)`, so a commitment written or dated during a turn that had
 * read a web page at tier 3 arrives at the gate at tier 3 and is denied
 * `tainted_source` on the gate's first line. That is the `s7`
 * *remember-then-act* delayed-trigger shape
 * (`docs/evidence/eval-taint-corpus-avversariale-2026-09-03.md`).
 *
 * The first version of this paragraph said the rail was satisfied *"by
 * construction, because the column travels"*, and a judge measured that the
 * column travelled carrying the **wrong value**: `tier` comes from
 * `ctx.intrinsicTaint()`, which is defined to exclude what came back from an
 * earlier turn — i.e. defined to exclude exactly the delayed case. The row now
 * carries a second number for the ceiling that armed the date
 * (`core/turns/todo.ts`, `due_tier`), and the sentence is kept here with its
 * correction attached, because "closed by construction" is the claim this
 * repository is most often wrong about.
 *
 * ### Where the rail ends, measured
 *
 * It bounds the class; it does not close it, and the second judge measured the
 * boundary. `due_tier` is the ceiling of the turn that put the **date** on the
 * row, and a ceiling decays: `taint()` is computed over the reinjected history,
 * which is `MAX_HISTORY_TURNS = 40` turns (`agent/loop.ts`). A page read at
 * turn N can have its sentence written as a plan step at turn N+1 already at
 * tier 0 — `intrinsicTaint()` is *defined* to exclude what came back from an
 * earlier turn, and `agent/tools/todo.test.ts` asserts that as intended — and
 * once the tainted lines have fallen out of the window, dating that still-open
 * step arms it at `max(0, 0) = 0`. The lane then allows it and speaks the
 * page's sentence.
 *
 * So the honest claim is narrower than "denied": a promise planted by a page or
 * a group is denied while the turn that plants or dates it still carries the
 * ceiling, which is the whole same-turn case and the following forty. Beyond
 * that window the ceiling is gone and the rail is not there. Closing it needs
 * provenance **per row** rather than a snapshot of a tier — a different, larger
 * decision than ADR-0060, recorded in its "Limiti noti" rather than implied
 * away here. Stated rather than discovered, because the previous two versions
 * of this paragraph both claimed a closure the code did not have.
 *
 * ## Un `deny` e' definitivo, e si registra
 *
 * Both tiers are monotone per row (`max()` in every writer), so a commitment
 * denied `tainted_source` can never later be allowed. Recording that deny is
 * therefore sound, and it is what stops three poisoned rows from occupying the
 * burst budget on every tick for ever. A `defer` is **not** recorded, for the
 * reason `observe.ts` gives: it is the gate saying "not now".
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
function commitmentAnchor(c: DueCommitment): string {
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
const LATE_AFTER_MS = 60 * 60 * 1000;

/**
 * How many commitments may reach the owner in one pass.
 *
 * A burst limiter, the same rail and the same three as `observe.ts`'s
 * `OBSERVE_LIMIT`: what is bounded is how much lands at once, not how often the
 * passes happen.
 *
 * It counts `allow` and nothing else, and that wording is a repair rather than
 * a restatement. It used to count *decisions*, applied after the dedup — which
 * reproduced one step further along the exact starvation `OBSERVE_LIMIT`'s own
 * docstring says it was moved to avoid: with `ORDER BY due_at` the three denied
 * rows are the three oldest, they filled the budget on every tick, and a clean
 * commitment behind them was never delivered — not late, never. A `deny`, a
 * `defer` and a `skip` all land nothing on the owner, so none of them may spend
 * a budget that exists to bound what lands.
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
  let allowed = 0;
  for (const commitment of deps.due()) {
    if (allowed >= limit) break;
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
    const decision = deps.decide(trigger, deps.ctx);
    out.push({ commitment, anchor, decision });
    if (decision.effect === 'allow') allowed += 1;
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
function recordCommitmentFired(fires: FireLog, obs: CommitmentObservation, at: Date): void {
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

/**
 * Record a refusal, permanently — the second writer `firelog.ts` never had.
 *
 * Only for `deny`, never for `defer`, and the difference is not taste: a
 * `defer` is "not now" and must stay re-decidable, while a `deny` here is
 * `tainted_source` on a number that only ever rises (both `tier` and `due_tier`
 * are `max()`-ed by every writer). A decision that cannot change is a decision
 * worth writing down.
 *
 * It buys two things. The row stops being re-decided on every tick for ever,
 * which is what freed the burst budget the judge measured three poisoned rows
 * holding hostage. And the fire log becomes able to answer *"what did you
 * refuse to say, and why"* — which `docs/evidence/fuori-dal-turno-2026-09-03.md`
 * §9.5 names as the missing half of ADR-0028's own reversibility signal.
 */
function recordCommitmentDenied(
  fires: FireLog,
  obs: CommitmentObservation,
  reason: string,
  at: Date,
): void {
  fires.record({
    anchor: obs.anchor,
    kind: 'commitment_due',
    decidedAt: at,
    effect: 'deny',
    reason: `${reason} · tier ${obs.commitment.tier} · impegno del ${obs.commitment.createdAt.slice(0, 10)}`,
  });
}

export type CommitmentLaneDeps = {
  todos: TodoStore;
  tenant: string;
  fires: FireLog;
  deliver: Deliver;
  /**
   * Where the owner reads, **asked per pass** — not captured once.
   *
   * Same rule as `context` below, and the second judge is why it is a function
   * rather than a string. `surfaces.default` is the manopola the `unreachable`
   * event tells the owner to turn, and it is turned by a *different process*
   * (`muffin surface default`, writing `config.json`). A lane that read it at
   * construction obeyed a value from boot for ever: measured on a running
   * gateway, the knob went to `telegram` and the next pass still printed
   * `"cli" non arriva a nessuno da qui`. Under launchd that is a remedy the
   * owner performs, sees no effect from, and has no way to tell from a bug —
   * the mechanism existing while production never reaches it, on the one field
   * that decides whether a promise is ever spoken.
   *
   * `config.json` is deliberately outside the seal (`core/rot/budgets.ts`
   * says why: it holds the surfaces and the pairing state), so re-reading it
   * is a plain file read and crosses no trust boundary.
   */
  channel: () => string;
  /**
   * Does a message sent to that channel actually arrive where the owner is?
   *
   * Required, not optional, and the judge's B1 is why. `cliSurface.deliver`
   * writes to stdout and returns `DELIVERED` — honestly, because for that
   * surface the bytes really are on the file descriptor. Under launchd or
   * systemd that file descriptor is the journal, and on the owner's real
   * installation `surfaces.default` is `cli` while Telegram is enabled: so the
   * lane wrote the promise into a log nobody reads and then burned the anchor,
   * which is the exact outcome ADR-0060 exists to prevent. A `Deliver` cannot
   * answer this — it reports whether the bytes moved, not whether a person is
   * at the other end — so the question is asked separately, before anything is
   * sent.
   */
  reachesOwner: (channel: string) => boolean;
  /** The owner's timezone, from the sealed root of trust — never the host's. */
  timezone: string;
  /** The quiet window and the spend cap, read fresh per pass by the caller. */
  context: (now: Date) => ProactiveContext;
  decide?: typeof decideProactive;
  onEvent?: (e: CommitmentEvent) => void;
};

export type CommitmentEvent =
  | { kind: 'spoke'; anchor: string; late: boolean }
  /**
   * Reachable in principle, and the send did not land. Deduped exactly like
   * `unreachable`, and the second judge is why: only that one was, so a
   * default surface that was permanently down wrote a line every thirty
   * seconds for ever — the 2 880 lines a day the other dedup exists to
   * prevent. Suppressing the *line* is not suppressing the retry: the anchor
   * stays open and the next pass tries again, and a send that lands is
   * reported as `spoke`.
   */
  | { kind: 'undelivered'; anchor: string; why: string }
  /**
   * Due, allowed by the gate, and nowhere to say it. Reported once per anchor
   * **and channel** per process, not once per tick: the promise stays open and
   * the tick is every thirty seconds, so the alternative is a log that repeats
   * the same line 2 880 times a day. The channel is part of the key because it
   * can now change under a running process — after the owner turns the knob,
   * a still-unreachable promise is a different fact and says so once more.
   */
  | { kind: 'unreachable'; anchor: string; channel: string; remedy: string }
  /** The pass itself threw. See `tick`: this must never reach the process. */
  | { kind: 'failed'; error: string };

/**
 * The pass, on the scheduler's own beat.
 *
 * Fire-and-forget like `Scheduler.tick`, and for the same reason: the beat that
 * drives this is also the heartbeat that keeps the gateway's claim alive
 * (`core/gateway/service.ts`), so nothing on it may be awaited. `inFlight`
 * guards the overlap a 30-second beat makes real — a delivery slower than one
 * tick must not be started twice — and `idle()` is what lets a test await the
 * pass instead of racing it.
 *
 * **Nothing in here may end the process, and that is a rail rather than
 * tidiness.** Measured by a judge: a `timezone: "Europe/Roma"` in the sealed
 * budgets made `decideProactive` die inside cron-parser, outside the `try` that
 * only wrapped `deliver`, on a promise that was never awaited — an unhandled
 * rejection, and the gateway exited 1 at every start. Before this lane existed
 * that same typo broke only `muffin observe --send`, a command the owner types
 * and watches. Putting a producer on the 30-second beat is what turned it into
 * a dead agent, so the whole pass is contained and the failure is an event.
 * (The typo itself is now refused where it is parsed, `core/rot/budgets.ts` —
 * two independent repairs, because one of them being enough is a guess.)
 */
export class CommitmentLane {
  private inFlight: Promise<void> = Promise.resolve();
  private running = false;
  /**
   * Anchors already reported as unspoken, this process, keyed by anchor and
   * channel — see `unreachable` and `undelivered`.
   */
  private readonly announced = new Set<string>();

  constructor(private readonly deps: CommitmentLaneDeps) {}

  tick(now: Date): void {
    if (this.running) return;
    this.running = true;
    this.inFlight = this.pass(now)
      .catch((error: unknown) => {
        this.deps.onEvent?.({
          kind: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.running = false;
      });
    void this.inFlight;
  }

  /**
   * Resolves when the pass started by the last `tick` has finished.
   *
   * It never rejects, by construction of `tick` above — a failure arrives as a
   * `failed` event instead, which is what lets a test assert *both* that the
   * process survived and what killed the pass.
   */
  async idle(): Promise<void> {
    await this.inFlight;
  }

  private async pass(now: Date): Promise<void> {
    // Once per pass, not once per row: every observation in this pass is
    // judged against the same channel, and a config rewritten mid-loop must
    // not split one beat between two answers.
    const channel = this.deps.channel();
    const detto = (anchor: string): boolean => {
      const key = `${anchor}\u0000${channel}`;
      if (this.announced.has(key)) return true;
      this.announced.add(key);
      return false;
    };
    const observations = observeCommitments({
      due: () => this.deps.todos.dueCommitments(this.deps.tenant, now),
      decide: this.deps.decide ?? decideProactive,
      fires: this.deps.fires,
      ctx: this.deps.context(now),
      channel,
    });

    for (const obs of observations) {
      // A refusal that can never be reconsidered, written down once. See
      // `recordCommitmentDenied`: this is what stops the oldest poisoned rows
      // from re-occupying the pass on every beat.
      if (obs.decision.effect === 'deny') {
        recordCommitmentDenied(this.deps.fires, obs, obs.decision.reason, now);
        continue;
      }
      if (obs.decision.effect !== 'allow') continue;

      // Asked before anything is sent, and it leaves the anchor open: a
      // promise the owner cannot receive is still owed. It is *not* delivered
      // to the terminal-of-last-resort first — that would print the same
      // reminder into the journal every thirty seconds for ever.
      if (!this.deps.reachesOwner(channel)) {
        if (!detto(obs.anchor)) {
          this.deps.onEvent?.({
            kind: 'unreachable',
            anchor: obs.anchor,
            channel,
            remedy: 'muffin surface default <telegram|discord>',
          });
        }
        continue;
      }

      try {
        const text = commitmentMessage(obs.commitment, now, this.deps.timezone);
        const outcome = await this.deps.deliver(channel, text);
        if (!outcome.delivered) {
          // The anchor stays open, the rule `cli/observe.ts` runs on: only a
          // message that reached the owner is a thing that was said. A promise
          // burned on a delivery that did not happen is a promise lost for
          // good, which is the one outcome ADR-0060 refuses.
          if (!detto(obs.anchor)) {
            this.deps.onEvent?.({ kind: 'undelivered', anchor: obs.anchor, why: outcome.why });
          }
          continue;
        }
        recordCommitmentFired(this.deps.fires, obs, now);
        this.deps.onEvent?.({
          kind: 'spoke',
          anchor: obs.anchor,
          late: now.getTime() - obs.commitment.dueAt.getTime() >= LATE_AFTER_MS,
        });
      } catch (error) {
        // Rendering is inside this `try` too, not only the send: `quando()`
        // reaches `Intl` with a timezone this process has never validated.
        if (!detto(obs.anchor)) {
          this.deps.onEvent?.({
            kind: 'undelivered',
            anchor: obs.anchor,
            why: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
