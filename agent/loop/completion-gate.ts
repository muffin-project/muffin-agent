import type { TodoItem } from '../../core/turns/todo.js';

/**
 * The completion gate: which open rows would make settling `answered` a
 * silent drop of granted work (#811).
 *
 * Rows carry no turn identity (their key is tenant/session/text), and the
 * tool-call ledger stores digests, not args — so ownership is derived from
 * timestamps, not joined. A row counts as this turn's granted work when it
 * was born under the current lease, or when it predates the lease but this
 * turn's lifetime touched it. Rows that predate the turn and stayed untouched
 * since are somebody else's plan, and a fresh (never-granted) turn owns
 * nothing at all — multi-turn plans written for later settle `answered`
 * exactly as before.
 *
 * Only `pending`/`retry` rows fire: that is the finito set the DAY-1
 * requirement names, and `blocked`/`waiting` are deliberate terminal-ish
 * states the model chose on purpose. Malformed timestamps compare false, so
 * a corrupt clock fails closed into no-fire, never into a forced
 * continuation.
 *
 * Pure and total: the decision is a query on rows, never prose in context.
 */
export function ownedOpenRows(opts: {
  open: TodoItem[];
  turnCreatedAt: string;
  leaseStartedAt: string;
}): TodoItem[] {
  const born = Date.parse(opts.turnCreatedAt);
  const leaseStart = Date.parse(opts.leaseStartedAt);
  return opts.open.filter(
    (row) =>
      (row.state === 'pending' || row.state === 'retry') &&
      (Date.parse(row.createdAt) >= leaseStart ||
        (Date.parse(row.createdAt) < leaseStart && Date.parse(row.updatedAt) >= born)),
  );
}
