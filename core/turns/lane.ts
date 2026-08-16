import { pidAlive } from '../lock/durable.js';
import { ALWAYS_IDLE, type ForegroundGate, type StandDown } from '../scheduler/scheduler.js';
import type { TurnStopped, TurnStore } from './store.js';
import { decodeWaitFor, satisfied } from './wait.js';

/**
 * The thing that picks a turn back up.
 *
 * Everything under it was built and had no consumer: `runnable` rows a surface
 * created and did not execute (B2), `waiting` rows past their deadline (B3),
 * `interrupted` rows a dead process left behind (B5). `TurnStore.due` returns
 * all three in one query because they are one queue, and until this file
 * existed nothing ever read it — the exact shape `AGENTS.md` opens by naming, a
 * mechanism with a schema, passing tests and no caller.
 *
 * ## Why it is a sibling of `Scheduler` and not a method on it
 *
 * They tick on the same timer and share the model lane, and they are still two
 * things: a job is *work that is due*, a turn is *work that was interrupted*.
 * Merging them would put `markRan` and `claim` in one body, and the two have
 * opposite failure directions — a job that runs twice costs money, a turn that
 * runs twice repeats its tool calls. What they do share is deliberately shared
 * rather than re-derived: `ForegroundGate` and `StandDown` come from
 * `scheduler.ts`, so "the owner is talking" and "another process owns this
 * store" cannot be answered differently in the two lanes.
 *
 * ## What it does not do
 *
 * It does not deliver, and it does not know what a chat id is. `run` is handed
 * in by the assembly (`agent/turn-lane.ts`), which owns the loop and the
 * surface. Keeping the address out of `core` is the boundary the previous
 * system lost when its gateway started building Telegram-shaped footers.
 */

/** What running one row produced, in the only two shapes the lane distinguishes. */
export type LaneRun = (turnId: string) => Promise<{ stopped: TurnStopped } | { refused: string }>;

export type LaneEvent =
  /** An event barrier came true, so the row is runnable ahead of its deadline. */
  | { kind: 'woken'; turnId: string }
  | { kind: 'ran'; turnId: string; stopped: TurnStopped }
  /**
   * The turn produced an answer and the row carries no address.
   *
   * Its own arm rather than silence, because silence is what this slice was
   * caught doing: a scheduled job that suspended came back, answered, and its
   * text went nowhere because nothing had written `replyTo`. An answer that
   * cannot be delivered is a fact the owner needs — it is the difference
   * between "the agent said nothing" and "the agent said something and this
   * process had no idea where to put it".
   */
  | { kind: 'undeliverable'; turnId: string; surface: string; text: string }
  | { kind: 'refused'; turnId: string; why: string }
  | { kind: 'failed'; turnId: string; error: string }
  | { kind: 'deferred'; reason: 'in_flight' | 'foreground' | 'handover' };

export type LaneDeps = {
  /** Only what the lane touches, so a test can drive it with three methods. */
  turns: Pick<TurnStore, 'due' | 'armed' | 'wake'>;
  run: LaneRun;
  gate?: ForegroundGate;
  standDown?: StandDown;
  onEvent?: (e: LaneEvent) => void;
  clock?: () => Date;
  /** Injected for the same reason the store injects it: a test needs a dead pid. */
  alive?: (pid: number) => boolean;
};

export class TurnLane {
  private running = false;
  private readonly gate: ForegroundGate;
  private readonly standDown: StandDown;
  private readonly onEvent: (e: LaneEvent) => void;
  private readonly clock: () => Date;
  private readonly alive: (pid: number) => boolean;

  constructor(private readonly deps: LaneDeps) {
    this.gate = deps.gate ?? ALWAYS_IDLE;
    this.standDown = deps.standDown ?? (() => false);
    this.onEvent = deps.onEvent ?? (() => {});
    this.clock = deps.clock ?? (() => new Date());
    this.alive = deps.alive ?? pidAlive;
  }

  /**
   * One beat: check the barriers, then take at most one row. Returns at once —
   * the run happens in the background so the caller's timer keeps ticking, which
   * is `Scheduler.tick`'s property and the same measured failure behind it
   * (Hermes #25517: a stalled worker looked dead and got a duplicate spawned on
   * the same task).
   *
   * **The barrier sweep runs even when the lane is busy**, and that ordering is
   * deliberate: waking a row is a single `UPDATE` that starts nothing, and a
   * turn whose process exited while a long turn was in flight would otherwise
   * sit until its deadline for no reason. Only *starting* work is serialised.
   */
  tick(now: Date = this.clock()): void {
    if (this.standDown()) {
      this.onEvent({ kind: 'deferred', reason: 'handover' });
      return;
    }

    this.sweepBarriers();

    if (this.running) {
      this.onEvent({ kind: 'deferred', reason: 'in_flight' });
      return;
    }
    if (this.gate.isActive()) {
      this.onEvent({ kind: 'deferred', reason: 'foreground' });
      return;
    }

    const [row] = this.deps.turns.due(now, 1);
    if (!row) return;

    this.running = true;
    void this.take(row.id).finally(() => {
      this.running = false;
    });
  }

  /**
   * Event barriers, evaluated here because this is the only process that can.
   *
   * The predicate has to be *checkable*, which is why `WaitKind` is a closed set
   * of one: `process_exit` is decidable on this machine without a broker. A
   * barrier nothing evaluates is a suspension only its deadline can ever end,
   * and a closed set whose members nothing can satisfy would be one more
   * mechanism connected to nothing.
   *
   * An unreadable `wait_for` is skipped rather than thrown on: the value came
   * off disk, and a row written by a future version must not take the lane down.
   * It degrades to "this turn has only its deadline", which still ends.
   */
  private sweepBarriers(): void {
    for (const row of this.deps.turns.armed()) {
      const barrier = decodeWaitFor(row.waitFor);
      if (barrier === null || !satisfied(barrier, this.alive)) continue;
      // Guarded on `waiting` inside the store, so an event arriving twice — or
      // arriving for a row the deadline already woke — moves nothing.
      if (this.deps.turns.wake(row.id, this.clock())) {
        this.onEvent({ kind: 'woken', turnId: row.id });
      }
    }
  }

  /**
   * Run one row, and never let its failure end the lane.
   *
   * A turn that throws is one bad row; a lane that dies with it stops every
   * other suspended turn on the machine, silently, until someone restarts the
   * gateway. The same reasoning as `Scheduler.run`'s try around `runJob`, and
   * the same direction: report, continue.
   */
  private async take(turnId: string): Promise<void> {
    try {
      const outcome = await this.deps.run(turnId);
      if ('refused' in outcome) this.onEvent({ kind: 'refused', turnId, why: outcome.refused });
      else this.onEvent({ kind: 'ran', turnId, stopped: outcome.stopped });
    } catch (error) {
      this.onEvent({ kind: 'failed', turnId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** True while a turn is in flight — for a caller that drains on shutdown. */
  isRunning(): boolean {
    return this.running;
  }
}
