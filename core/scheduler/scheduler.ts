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

export type SchedulerEvent =
  | { kind: 'ran'; job: Job; stopped: JobOutcome['stopped'] }
  | { kind: 'deferred'; reason: 'foreground' | 'in_flight' }
  | { kind: 'yielded'; job: Job }
  | { kind: 'delivery_failed'; job: Job; error: string };

export class Scheduler {
  private running = false;

  constructor(
    private readonly store: JobStore,
    private readonly runJob: RunJob,
    private readonly deliver: Deliver,
    private readonly gate: ForegroundGate = ALWAYS_IDLE,
    private readonly onEvent: (e: SchedulerEvent) => void = () => {},
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Process at most one due job. Returns immediately; the run happens in the
   * background so the caller's timer keeps ticking. Idempotent to call often.
   */
  tick(now: Date = this.clock()): void {
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

    // Deliver the answer, or — for a scheduler-principal ASK queued by the
    // kernel — the question the owner has to decide. Either way it is the job's
    // outcome for this fire; a delivery failure does not re-run the job (that
    // would double the work), it is reported.
    try {
      await this.deliver(job.channel, outcome.text);
    } catch (error) {
      this.onEvent({ kind: 'delivery_failed', job, error: error instanceof Error ? error.message : String(error) });
    }
    this.store.markRan(job.id);
    this.onEvent({ kind: 'ran', job, stopped: outcome.stopped });
  }

  /** True while a job is in flight — for a caller that wants to drain on shutdown. */
  isRunning(): boolean {
    return this.running;
  }
}
