/**
 * The single model lane, as one object two schedulers can hold.
 *
 * ADR-0022 gave the scheduler the property *"a running job is never picked up
 * twice… one owner, one model lane — jobs run one at a time, not
 * concurrently"*. `core/turns/lane.ts` then said the same sentence about
 * itself, and the two were true **separately**: `Scheduler` had a private
 * `running` flag, `TurnLane` had its own, and `Gateway.tick` calls both in the
 * same beat. A job and a resumed turn therefore ran at the same moment, against
 * one provider and one budget, while both files documented that they could not.
 *
 * The alternative was to have each lane ask the other (`gate: { isActive: () =>
 * scheduler.isRunning() }`). That is correct today and only today: it is two
 * wires that a construction site can attach one of, and the failure is silent —
 * everything keeps working, just twice at once. One token cannot be
 * half-connected, because a lane that was not given it does not serialise
 * against anything and the missing argument is at the construction site rather
 * than in a behaviour nobody watches.
 *
 * ## Not a lock
 *
 * No waiting, no queue, no fairness: `take` answers now, and a lane that is
 * refused simply defers to its next beat. That is deliberate — the beat is
 * 30 seconds and the work is minutes, so a queue here would only decide *which*
 * lane starves, and the ordering that matters (foreground first) is a different
 * mechanism (`ForegroundGate`). Single-threaded by construction too: everything
 * that touches this runs on one event loop, so `take` needs no atomicity beyond
 * a null check.
 */
export class ModelLane {
  private holder: string | null = null;

  /** Take it, or say who has it. `null` means it was free and is now yours. */
  take(who: string): string | null {
    if (this.holder !== null) return this.holder;
    this.holder = who;
    return null;
  }

  /**
   * Give it back. Guarded on identity so a late `finally` from a lane that was
   * already refused cannot release work somebody else is doing — the shape that
   * turns a serialiser into a no-op under exactly the load it exists for.
   */
  release(who: string): void {
    if (this.holder === who) this.holder = null;
  }

  /** Is anyone using the model right now? */
  busy(): boolean {
    return this.holder !== null;
  }

  /** Who, for a status line that has to say more than "busy". */
  heldBy(): string | null {
    return this.holder;
  }
}

/** The two holders that exist. Named, so a status line can say which. */
export const LANE_JOBS = 'jobs';
export const LANE_TURNS = 'turns';
