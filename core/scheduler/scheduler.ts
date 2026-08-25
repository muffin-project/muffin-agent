import { LANE_JOBS, ModelLane } from '../turns/model-lane.js';
import type { DeliveryState, TurnOutcome, TurnStopped } from '../turns/store.js';
import type { DeliveryOutcome } from '../surface/types.js';
import type { Job, JobStore } from './jobs.js';

/**
 * The scheduler loop: wakes, finds what is due, runs it as the scheduler
 * principal, delivers the result. The durable job store (jobs.ts) is the state;
 * this is the mechanism around it.
 *
 * Three properties come straight from ADR-0022, and each is a real bug avoided:
 *
 *  1. **The heartbeat does not depend on the job returning.** `tick()` launches
 *     a due job and returns; it does not await the run. So the timer that calls
 *     `tick` keeps firing while a twenty-minute job is still going — the exact
 *     failure of Hermes #25517, where a stalled worker looked dead and got a
 *     duplicate spawned on the same task.
 *  2. **A running job is never picked up twice.** `running` guards it: a job
 *     in flight is skipped by every later tick until it finishes. One owner,
 *     one model lane — jobs run one at a time, not concurrently.
 *  3. **Foreground wins the lane.** When interactive traffic is active, a tick
 *     defers rather than starting a job, and a job already running is handed an
 *     abort signal so it yields. An aborted job is left due and retried when the
 *     lane is idle — it does not count as run.
 *
 * A fourth arrived with ADR-0035 and is not the same as (3): `standDown` asks
 * whether **another process** now owns this store. See its own docstring — the
 * distinction matters because (3) is a lane inside one process and (4) is two
 * processes over one database.
 */

/** The contended resource, as an interface: is the owner talking right now? */
export interface ForegroundGate {
  /** True while interactive traffic holds the model lane. */
  isActive(): boolean;
  /** Aborts when foreground becomes active mid-run, so the job yields. */
  signal(): AbortSignal | undefined;
}

/** A gate that is always idle — for headless runs with no interactive surface. */
export const ALWAYS_IDLE: ForegroundGate = {
  isActive: () => false,
  signal: () => undefined,
};

export type JobOutcome = {
  /**
   * How the turn ended — 'aborted' means it yielded and must be retried, and
   * 'suspended' means it has not ended at all (see `run`).
   *
   * Referenced from `core/turns/store.ts` rather than re-declared. This union
   * had three literal copies — here, `TurnResult['stopped']` and the store's
   * own `TurnOutcome` — and the design that produced the turn record named the
   * divergence as this repo's typical defect *before* it happened
   * (`research/turno-sospendibile.md` §Domanda 6). One reference means adding an
   * arm reaches every consumer as a build error, which is how `suspended` got
   * an answer here at all instead of being silently treated as an ending.
   */
  stopped: TurnStopped;
  /** What to deliver to the channel (the answer, or the queued question). */
  text: string;
  /**
   * The row this fire wrote, so the delivery's outcome lands on the same record
   * as the turn's — the two answers ADR-0042 keeps in two columns.
   *
   * `null` only when no turn was created, which today means the runner threw
   * before `runTurn` got as far as writing the row. A job that produced no
   * record has nothing to settle, and saying so with a value beats a `turnId`
   * that is a plausible-looking lie.
   */
  turnId: string | null;
};

/**
 * "This occurrence's bound turn is not mine to run" — job_fires's answer when
 * a fire already has a `turn_id` and that turn is not `done`. That is either
 * `runnable`/`running`/`waiting`/`interrupted`: some other pass already
 * created it (this tick, or a crashed one before it) and it belongs to the
 * turn lane's normal resume machinery now, not to a second call into the
 * model for the same occurrence. `Scheduler` does nothing at all with a fire
 * in this state — no delivery, no `markRan` — and retries the check on the
 * next tick, which is a cheap poll against a row, not a job re-run.
 */
export type FireDeferred = { readonly deferred: true };

/**
 * "This occurrence's turn already finished, and something already delivered
 * or definitively failed to deliver it" — the other half of recovering a
 * `done` turn found on a later tick (B7's fault point 5, "turno `done` prima
 * di `markRan`"). The turn's own `delivery` column is already terminal
 * (`sent` / `failed:…` / `undeliverable`), so calling `Deliver` again would
 * send the answer a second time. `Scheduler` skips straight to marking the
 * fire settled and calling `markRan` — advancing the schedule without ever
 * touching the channel.
 */
export type FireSettleOnly = {
  readonly settleOnly: true;
  turnId: string;
  outcome: TurnOutcome;
  /** Whether the *other* mechanism's delivery attempt succeeded. */
  delivered: boolean;
};

/**
 * Runs a job's goal through the loop as the scheduler principal — or says
 * that this occurrence's identity is already spoken for, one way or the
 * other. `agent/scheduler-run.ts`'s `makeJobRunner` is the one implementation
 * and the one place that resolves `(job.id, job.nextFireAt)` against
 * `job_fires` before ever deciding which of the three shapes to hand back.
 */
export type RunJob = (job: Job, signal: AbortSignal | undefined) => Promise<JobOutcome | FireDeferred | FireSettleOnly>;

/**
 * Delivers text to a surface, and **says whether it arrived**.
 *
 * The return type is the whole repair, and it is the one `docs/ORCHESTRATION.md`
 * §14 names by hand: *"Una firma che ritorna `void` non può dire «non ho
 * consegnato»: ogni implementazione deve ricordarsi di lanciare, e delle tre una
 * sola se n'è ricordata"*. This used to be `Promise<void>`, so the only channel
 * for "it did not arrive" was an exception the type could not require —
 * TypeScript has no checked exceptions. `cli/gateway.ts` wrote the message to
 * stderr and returned normally; `markRan` then advanced the schedule and the
 * job reported success for a message nobody received.
 *
 * Implementations now live behind `core/surface/`, so this type is what the
 * registry satisfies rather than something three call sites hand-roll.
 */
export type Deliver = (channel: string, text: string) => Promise<DeliveryOutcome>;

/**
 * Writes how the delivery went onto the turn's row. Absent in tests that are
 * not about the record; wired in production by whoever built the runtime.
 *
 * Not merged into `Deliver`: the surface knows whether the bytes went out, and
 * the runtime knows which row to write it on. Handing the surface a turn id
 * would make every connector a writer of the turns table.
 */
export type RecordDelivery = (turnId: string, delivery: DeliveryState) => void;

/**
 * "Has someone else taken this job store over?" — the REPL's half of ADR-0035.
 *
 * `ForegroundGate` arbitrates a lane **inside one process**. This arbitrates
 * **between processes**, and the two cannot be the same thing: a REPL that
 * yields to the gateway must not run the job at all, whereas a REPL that yields
 * to its own interactive turn will run it a moment later.
 *
 * The gateway passes nothing. Its answer is always "no, I own it", and a
 * constant-false default keeps that answer off any path that costs a read —
 * the gateway must not pay a database round-trip per tick to be told what it
 * already knows.
 */
export type StandDown = () => boolean;

export type SchedulerEvent =
  /**
   * The fire completed. `delivered` is on the same event as `stopped` on
   * purpose: an observer that reports "job eseguito" without it is reporting
   * half the outcome, which is the sentence this whole slice exists to stop.
   */
  | { kind: 'ran'; job: Job; stopped: JobOutcome['stopped']; delivered: boolean }
  // 'bound_turn_pending' is `FireDeferred`: the fire's turn exists and is not
  // `done` yet, which belongs to the turn lane's own resume machinery.
  | { kind: 'deferred'; reason: 'foreground' | 'in_flight' | 'handover' | 'bound_turn_pending' }
  | { kind: 'yielded'; job: Job }
  | { kind: 'delivery_failed'; job: Job; error: string }
  /** The turn ran, and the store could not be told. See `run`. */
  | { kind: 'not_recorded'; job: Job; error: string };

export class Scheduler {
  constructor(
    private readonly store: JobStore,
    private readonly runJob: RunJob,
    private readonly deliver: Deliver,
    private readonly gate: ForegroundGate = ALWAYS_IDLE,
    private readonly onEvent: (e: SchedulerEvent) => void = () => {},
    private readonly clock: () => Date = () => new Date(),
    private readonly standDown: StandDown = () => false,
    private readonly recordDelivery: RecordDelivery = () => {},
    /**
     * The single model lane, shared with `TurnLane` when both are running.
     *
     * Property (2) above — *"one owner, one model lane"* — used to be a private
     * boolean, so it was true of this class **alone**: `Gateway.tick` drives
     * this and the turn lane on the same beat, and both would start work in the
     * same tick against one provider and one budget.
     *
     * **Mandatory (D1, judge round 2).** A default of `= new ModelLane()` sat
     * here until a mutation showed exactly what it cost: give `cli/gateway.ts`
     * a second, unshared `ModelLane` for the turn lane and nothing caught it —
     * `tsc` compiled, all 1192 tests stayed green, and the two-lanes-at-once
     * bug the token exists to prevent came back. A default is a value nobody
     * had to choose, and this one was load-bearing. Every construction site now
     * states its choice: a scheduler run without a turn lane passes its own
     * fresh `new ModelLane()` (unchanged behaviour, just spelled out), and
     * `cli/gateway.ts` passes the one token both lanes share.
     *
     * Placed last, after `recordDelivery` (which has a default): TypeScript
     * allows a required parameter after one with an initializer, and callers
     * that only care about `modelLane` pass `undefined` for the slot before it.
     */
    private readonly modelLane: ModelLane,
    /**
     * "Is the claim this process is running under still, right now, the one
     * it was minted for?" — P20's fix.
     *
     * `standDown` answers a different question: "has *some* other gateway
     * shown up" (the REPL's view, via `readGateway`), and the gateway's own
     * scheduler always passes `() => false` for it — the gateway's answer to
     * "do I own this" is structurally always yes, so `standDown` gives the
     * gateway's own scheduler no protection at all. `stillOwner` is what does:
     * wired from `cli/gateway.ts` as `() => lock.isCurrentClaim()`, a fresh,
     * uncached read every call. Checked at the same two points `standDown`
     * already is — before a job starts (alongside `modelLane.take`) and again
     * before delivery — because a claim can be taken over *during* a run that
     * takes minutes, not just at its start (P20: `Gateway.tick` used to check
     * `beat()` once and then run both lanes with no re-check inside).
     *
     * Defaults to always-true: the REPL's own scheduler holds no gateway claim
     * to re-verify, and most tests do not either — `standDown` alone is their
     * whole cross-process story, unchanged.
     */
    private readonly stillOwner: () => boolean = () => true,
    /**
     * Marks this fire's `job_fires` row settled — the last write before
     * `markRan`, never after (B7, fault point 7: "solo dopo il settlement
     * avanza la schedule"). Every caller of `this.store.markRan` in this file
     * calls this immediately first, which is what makes the ordering a
     * property of this class rather than a convention each call site has to
     * remember.
     *
     * Defaults to a no-op: a scheduler with no `job_fires` behind it (most
     * tests, today's REPL and gateway wiring being the only two production
     * constructions) settles nothing and behaves exactly as before this
     * column existed — additive, never a required rewire of every test that
     * does not care about occurrence identity.
     */
    private readonly settleFire: (job: Job) => void = () => {},
  ) {}

  /**
   * Process at most one due job. Returns immediately; the run happens in the
   * background so the caller's timer keeps ticking. Idempotent to call often.
   */
  tick(now: Date = this.clock()): void {
    // Before anything, including the deferral bookkeeping: if another process
    // owns this store there is nothing here to defer — this ticker is simply
    // not the scheduler any more, and the honest thing is to stop being one.
    if (this.standDown()) {
      this.onEvent({ kind: 'deferred', reason: 'handover' });
      return;
    }
    // Asked of the shared lane, not of a flag of our own: the thing that must
    // not happen twice is a *model call*, and the turn lane makes them too.
    if (this.modelLane.busy()) {
      this.onEvent({ kind: 'deferred', reason: 'in_flight' });
      return;
    }
    if (this.gate.isActive()) {
      this.onEvent({ kind: 'deferred', reason: 'foreground' });
      return;
    }
    const [job] = this.store.due(now);
    if (!job) return;

    // Re-verified right before the job actually starts, the same point
    // `modelLane.take` is — a claim can be taken over between the top of this
    // tick and here in principle, and this is the last chance to catch it
    // before the model is ever called.
    if (!this.stillOwner()) {
      this.onEvent({ kind: 'deferred', reason: 'handover' });
      return;
    }
    if (this.modelLane.take(LANE_JOBS) !== null) {
      // Somebody took it between the check above and here. Impossible on one
      // event loop today, and cheap insurance against the day it is not.
      this.onEvent({ kind: 'deferred', reason: 'in_flight' });
      return;
    }
    void this.run(job).finally(() => {
      this.modelLane.release(LANE_JOBS);
    });
  }

  private async run(job: Job): Promise<void> {
    const signal = this.gate.signal();
    let outcome: JobOutcome | FireDeferred | FireSettleOnly;
    try {
      outcome = await this.runJob(job, signal);
    } catch (error) {
      outcome = {
        stopped: 'error',
        text: `job fallito: ${error instanceof Error ? error.message : String(error)}`,
        turnId: null,
      };
    }

    /**
     * This occurrence's identity is bound to a turn that is not `done` yet —
     * `makeJobRunner` found it mid-flight (this tick's own run, or a crashed
     * one before it) or still owed a resume/wake. Neither delivery nor
     * `markRan` belongs here: the turn lane's ordinary machinery owns finishing
     * it, and the next tick's `job_fires` check is what notices when it does.
     */
    if ('deferred' in outcome) {
      this.onEvent({ kind: 'deferred', reason: 'bound_turn_pending' });
      return;
    }

    /**
     * The turn is `done` and something else already delivered it (or
     * definitively could not) — B7's fault point 5, found on a tick that did
     * not run the model at all. Calling `deliver` again would send a second
     * copy of an answer that already went out (or retry one that is recorded
     * as undeliverable for a real reason). The only thing still owed is the
     * bookkeeping: settle the fire, advance the schedule.
     */
    if ('settleOnly' in outcome) {
      try {
        this.settleFire(job);
        this.store.markRan(job.id);
        this.onEvent({ kind: 'ran', job, stopped: outcome.outcome, delivered: outcome.delivered });
      } catch (error) {
        this.onEvent({ kind: 'not_recorded', job, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // A yield is not a completion: leave the job due, retry when the lane frees.
    if (outcome.stopped === 'aborted') {
      this.onEvent({ kind: 'yielded', job });
      return;
    }

    /**
     * The second stand-down, and the one that closes the window the first
     * cannot.
     *
     * A tick-start check only proves nobody owned the store when the turn
     * *began*. A turn is a model call with tools — seconds to minutes — and a
     * gateway can claim in the middle of one (it does exactly that at login,
     * and after a laptop sleep long enough to make a live claim read stale).
     * Checking again here costs one read, measured at 0.022 ms, and buys the
     * two things that are actually irreversible: the owner is not told the same
     * thing twice, and `markRan` does not move a fire the new owner is about to
     * serve.
     *
     * `standDown` OR `stillOwner`, not either alone: `standDown` is the REPL's
     * question ("has some *other* gateway shown up") and is a constant `false`
     * for the gateway's own scheduler, so on its own it gives the gateway zero
     * protection against exactly the case named above — a second gateway
     * claiming mid-run. `stillOwner` (P20) is what answers that one, and it is
     * the fresh, uncached read a laptop-sleep steal needs: cached state from
     * the last successful `beat()` would still say "mine" for up to a whole
     * tick interval after a takeover.
     *
     * **The residual window is from this line to the `deliver` below** —
     * sub-millisecond, and it is the whole remaining exposure for a duplicate
     * *delivery*.
     *
     * The sentence that used to follow this one said closing the duplicate
     * *execution* risk — two processes both paying for the same goal — would
     * require claiming the fire before running it, and that ADR-0035 refused
     * to do so. B7 (`job_fires`, `agent/scheduler-run.ts`) is exactly that
     * claim, made anyway: `makeJobRunner` binds a `turn_id` to
     * `(job.id, job.nextFireAt)` *before* the model is ever called, so a
     * second gateway whose tick-start `stillOwner` was still true reads this
     * fire as already bound and defers (`FireDeferred`) instead of running the
     * goal a second time. What that does not buy is a lock: nothing prevents
     * two processes from racing to bind at once, only from *both* ending up
     * with a turn to run — `JobFireStore.bind` is `UPDATE … WHERE turn_id IS
     * NULL`, so exactly one of them wins and the other resolves the winner's
     * id instead of minting its own. `markRan` stays the only writer of
     * `next_fire_at`, unchanged — a killed gateway still loses no work, it
     * just no longer risks paying for the same work twice on the way there.
     */
    if (this.standDown() || !this.stillOwner()) {
      this.onEvent({ kind: 'yielded', job });
      return;
    }

    /**
     * A suspended turn is delivered by whoever resumes it, not here.
     *
     * It sits between the two arms above and `settle` below, and it belongs to
     * neither. It is **not** a yield: the turn released the runtime on purpose,
     * its row says `waiting`, and the lane will pick it up at its deadline — so
     * leaving the job due would fire a *second* turn for the same goal while the
     * first is still owed, which is the duplicate execution the whole record
     * exists to prevent. And it is not a completion either: there is nothing to
     * say yet, and sending the placeholder text would tell the owner a job
     * answered when it has not started answering.
     *
     * So: no delivery is attempted, `settle`'s `recordDelivery` call is
     * skipped entirely (the row's `delivery` stays `pending`, exactly where
     * `agent/turn-lane.ts` will settle it once the lane resumes the turn), and
     * `markRan` still runs — the fire happened, whether or not it has finished
     * answering.
     *
     * `job_fires` is marked settled here too, and that is a deliberate reading
     * of "settled": this *occurrence* is fully handled by the scheduler — its
     * turn exists, is bound, and has been handed to the lane — even though the
     * *turn* has not finished answering yet. The two are different questions.
     * `next_fire_at` already moves at this same instant (unchanged from before
     * B7), so a daily job that suspends does not block tomorrow's occurrence;
     * `job_fires`'s row for *this* occurrence simply stops being interesting to
     * the scheduler once its identity is settled, which is exactly the state a
     * fresh process must be able to tell apart from "crashed before this line
     * ever ran" (fault point 2) on the next restart.
     */
    if (outcome.stopped === 'suspended') {
      try {
        this.settleFire(job);
        this.store.markRan(job.id);
        this.onEvent({ kind: 'ran', job, stopped: outcome.stopped, delivered: false });
      } catch (error) {
        this.onEvent({ kind: 'not_recorded', job, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    /**
     * Niente da dire, quindi non dice niente.
     *
     * Un job che produce testo vuoto ha **girato**: la sua occorrenza va
     * settled e la schedulazione avanza. Ma consegnarlo produrrebbe un
     * messaggio vuoto, che `agent/scheduler-run.ts` descrive già come *"un job
     * che non ha prodotto niente"* — cioè rumore indistinguibile da un
     * guasto. È il caso ordinario di un job `script`: «controlla se il sito è
     * giù» non deve dire niente nei giorni in cui il sito è su, e la
     * differenza fra silenzio e messaggio vuoto è tutta la differenza fra un
     * controllo che si può tenere acceso e uno che si finisce per spegnere.
     *
     * `error` è escluso, e non per simmetria. Un turno può finire in errore
     * con testo vuoto — il ramo del claim perso in `agent/loop.ts` lo fa —
     * e quella riga assorbita qui diventerebbe indistinguibile da «girato,
     * niente da dire»: nessuno stamperebbe più niente, e un esito perso in
     * una race di fencing avrebbe lo stesso aspetto di una giornata in cui il
     * sito era su. Il silenzio è una risposta; un guasto silenzioso no.
     */
    if (outcome.text.trim() === '' && outcome.stopped !== 'error') {
      try {
        this.settleFire(job);
        this.store.markRan(job.id);
        this.onEvent({ kind: 'ran', job, stopped: outcome.stopped, delivered: false });
      } catch (error) {
        this.onEvent({ kind: 'not_recorded', job, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // Deliver the answer, or — for a scheduler-principal ASK queued by the
    // kernel — the question the owner has to decide.
    //
    // The result is a value now, not the absence of an exception. A `Deliver`
    // that returns normally used to mean "delivered", so the implementation that
    // printed to stderr and returned looked identical to the one that sent a
    // message. There is no shape left for that: both arms of `DeliveryOutcome`
    // have to be constructed on purpose.
    const delivery = await this.deliver(job.channel, outcome.text);
    this.settle(job, outcome, delivery);
  }

  /**
   * The end of a fire: record the delivery, advance the schedule, announce it.
   *
   * **The only caller of `markRan` in this class, and that is structural rather
   * than tidy.** ADR-0035 §1 makes `markRan` the single writer of
   * `next_fire_at`; this makes the delivery's outcome the single thing you have
   * to be holding in order to call it. A future branch that advances the
   * schedule without knowing whether the message arrived does not compile,
   * because there is no path to `markRan` that does not take a `DeliveryOutcome`.
   * A suspended turn's fire never reaches this method at all — see the guard
   * in `run` above — because there is no delivery outcome to hold yet.
   *
   * **What it deliberately does not do is re-run the job.** A failed delivery
   * must not put the fire back: the model has already been paid for, and
   * re-firing doubles the spend to re-send text that is sitting in
   * `outcome.text`. That was already the rule and it stays; what was missing was
   * anywhere that recorded the failure, so "il job dice inviato" was
   * unfalsifiable. Now the turn's row carries `failed:<why>`, and it is read
   * back by `core/turns/store.ts`'s `TurnStore.undelivered()` (through the
   * `readUndelivered` wrapper, the same shape as `readTurnHealth`) — wired
   * into the "consegne" check in `cli/doctor.ts`, not merely declared as a
   * capability nothing calls (D3, judge, PR #42: this method had zero
   * callers and zero tests until that wiring existed).
   */
  private settle(job: Job, outcome: JobOutcome, delivery: DeliveryOutcome): void {
    // Before `markRan`, so a crash between the two leaves a fire that has not
    // advanced rather than a delivery nobody recorded — the same ordering the
    // Telegram connector uses, and the same reason.
    if (outcome.turnId !== null) {
      try {
        this.recordDelivery(outcome.turnId, delivery.delivered ? 'sent' : `failed:${delivery.why}`);
      } catch (error) {
        // Never allowed to fail the fire. The precedent is literal: this class
        // already crashed the gateway once through a bookkeeping write against a
        // closed database, thrown from a floating promise.
        this.onEvent({ kind: 'not_recorded', job, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (!delivery.delivered) {
      this.onEvent({ kind: 'delivery_failed', job, error: delivery.why });
    }

    // `markRan` inside the guard, for a measured crash rather than out of
    // caution. `Gateway.drain` closes the database when a turn overruns the
    // drain budget, and this line then ran against a closed handle: `TypeError:
    // The database connection is not open`, thrown from a floating promise, so
    // an unhandled rejection took the process down with exit 1 — turning the
    // one exit that says "esco comunque" into a stack trace in the journal.
    // The job survives either way (the throw precedes the write, so it stays
    // due), which is why this reports instead of retrying.
    //
    // `settleFire` first, in the same try and the same order `run`'s suspended
    // branch already uses: B7's fault point 7 — "solo dopo il settlement
    // avanza la schedule" — is this line's ordering, not a separate mechanism.
    try {
      this.settleFire(job);
      this.store.markRan(job.id);
      this.onEvent({ kind: 'ran', job, stopped: outcome.stopped, delivered: delivery.delivered });
    } catch (error) {
      this.onEvent({ kind: 'not_recorded', job, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * True while **this** lane holds the model — not merely while the model is
   * busy. `Gateway` asks both lanes and ORs the answers, so a shared "is anyone
   * working" here would make each lane report the other's work as its own.
   */
  isRunning(): boolean {
    return this.modelLane.heldBy() === LANE_JOBS;
  }
}
