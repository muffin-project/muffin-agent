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
  /** How the turn ended — 'aborted' means it yielded and must be retried. */
  stopped: 'answered' | 'cap' | 'budget' | 'aborted' | 'error' | 'ask';
  /** What to deliver to the channel (the answer, or the queued question). */
  text: string;
};

/** Runs a job's goal through the loop as the scheduler principal. */
export type RunJob = (job: Job, signal: AbortSignal | undefined) => Promise<JobOutcome>;

/** Delivers text to a surface. Failures are the scheduler's to swallow or log. */
export type Deliver = (channel: string, text: string) => Promise<void>;

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
  | { kind: 'ran'; job: Job; stopped: JobOutcome['stopped'] }
  | { kind: 'deferred'; reason: 'foreground' | 'in_flight' | 'handover' }
  | { kind: 'yielded'; job: Job }
  | { kind: 'delivery_failed'; job: Job; error: string }
  /** The turn ran, and the store could not be told. See `run`. */
  | { kind: 'not_recorded'; job: Job; error: string };

export class Scheduler {
  private running = false;

  constructor(
    private readonly store: JobStore,
    private readonly runJob: RunJob,
    private readonly deliver: Deliver,
    private readonly gate: ForegroundGate = ALWAYS_IDLE,
    private readonly onEvent: (e: SchedulerEvent) => void = () => {},
    private readonly clock: () => Date = () => new Date(),
    private readonly standDown: StandDown = () => false,
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
    if (this.running) {
      this.onEvent({ kind: 'deferred', reason: 'in_flight' });
      return;
    }
    if (this.gate.isActive()) {
      this.onEvent({ kind: 'deferred', reason: 'foreground' });
      return;
    }
    const [job] = this.store.due(now);
    if (!job) return;

    this.running = true;
    void this.run(job).finally(() => {
      this.running = false;
    });
  }

  private async run(job: Job): Promise<void> {
    const signal = this.gate.signal();
    let outcome: JobOutcome;
    try {
      outcome = await this.runJob(job, signal);
    } catch (error) {
      outcome = { stopped: 'error', text: `job fallito: ${error instanceof Error ? error.message : String(error)}` };
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
     * **The residual window is from this line to the `deliver` below** —
     * sub-millisecond, and it is the whole remaining exposure for a duplicate
     * delivery. What it does *not* cover is a duplicate *execution*: between
     * the tick-start check and here, both processes may have run the same
     * goal, so the model is paid for twice. That is bounded by one turn's
     * duration, it is money and not correctness, and closing it would require
     * claiming the fire before running it — which ADR-0035 refuses, because
     * `markRan` being the only writer of `next_fire_at` is what makes a killed
     * gateway lose no work.
     */
    if (this.standDown()) {
      this.onEvent({ kind: 'yielded', job });
      return;
    }

    // Deliver the answer, or — for a scheduler-principal ASK queued by the
    // kernel — the question the owner has to decide. Either way it is the job's
    // outcome for this fire; a delivery failure does not re-run the job (that
    // would double the work), it is reported.
    try {
      await this.deliver(job.channel, outcome.text);
    } catch (error) {
      this.onEvent({ kind: 'delivery_failed', job, error: error instanceof Error ? error.message : String(error) });
    }

    // `markRan` inside the guard, for a measured crash rather than out of
    // caution. `Gateway.drain` closes the database when a turn overruns the
    // drain budget, and this line then ran against a closed handle: `TypeError:
    // The database connection is not open`, thrown from a floating promise, so
    // an unhandled rejection took the process down with exit 1 — turning the
    // one exit that says "esco comunque" into a stack trace in the journal.
    // The job survives either way (the throw precedes the write, so it stays
    // due), which is why this reports instead of retrying.
    try {
      this.store.markRan(job.id);
      this.onEvent({ kind: 'ran', job, stopped: outcome.stopped });
    } catch (error) {
      this.onEvent({ kind: 'not_recorded', job, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** True while a job is in flight — for a caller that wants to drain on shutdown. */
  isRunning(): boolean {
    return this.running;
  }
}
