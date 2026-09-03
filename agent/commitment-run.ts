import { CommitmentLane, type CommitmentEvent } from '../core/scheduler/commitments.js';
import { FireLog } from '../core/scheduler/firelog.js';
import type { Deliver } from '../core/scheduler/scheduler.js';
import type { Runtime } from './runtime.js';

/**
 * The one construction of the dated-commitment lane (ADR-0060).
 *
 * Two surfaces own a scheduler — `cli/gateway.ts` and `cli/repl.ts`, which
 * stands down for it (ADR-0035) — and both must reach the same lane with the
 * same rails, or "una promessa torna" would be true of whichever process
 * happened to be up. One function, exactly as `makeJobRunner` is one function
 * for the same two callers: a manopola exposed from one door and not the other
 * is a mechanism the owner cannot rely on.
 *
 * Everything here is read from the runtime rather than re-derived: the quiet
 * window and the spend cap come from inside the seal via `Runtime.quietHours`
 * and `Runtime.budget`, the channel from the config the surfaces were built
 * from, and the database connection is the process's single one.
 */

/**
 * The owner's tenant, and the only one this lane serves.
 *
 * Not a widening waiting to happen: `turn.todo` is `hostOnly: true`, so no
 * remote tenant can write a row here at all. Naming the constant is what makes
 * that a stated scope instead of a literal nobody would notice changing.
 */
export const COMMITMENT_TENANT = 'host';

export function makeCommitmentLane(
  runtime: Runtime,
  deliver: Deliver,
  onEvent?: (e: CommitmentEvent) => void,
): CommitmentLane {
  return new CommitmentLane({
    todos: runtime.deps.todos,
    tenant: COMMITMENT_TENANT,
    // The same table `muffin observe` writes: one anchor namespace, so a
    // commitment and an absence can never collide and neither can speak twice.
    fires: new FireLog(runtime.db),
    deliver,
    channel: runtime.config.surfaces.default,
    // The owner's timezone, from the sealed root of trust — so "era per martedì
    // alle 09:00" is their Tuesday, not the supervisor's UTC.
    timezone: runtime.quietHours.timezone,
    // Read per pass, not captured once: `exhausted()` is a live question about
    // the month's spend, and a lane that answered it at boot would keep
    // speaking after the cap was reached.
    context: (now) => ({
      now,
      quietHours: runtime.quietHours,
      budgetExhausted: runtime.budget.exhausted(),
    }),
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}
