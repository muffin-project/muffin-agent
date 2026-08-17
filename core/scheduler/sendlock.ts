import type Database from 'better-sqlite3';
import { DurableLock, pidAlive, type LockOutcome } from '../lock/durable.js';

/**
 * One proactive send at a time.
 *
 * The hole it closes: `observe()` reads `fires.has(anchor)`, the caller records
 * the fire after delivery, and nothing spans the two — so two runs started
 * together both see an unfired anchor and both deliver. Measured before this
 * existed: two messages, one row, exit 0 twice. `INSERT OR IGNORE` protects the
 * row, not the owner, and a duplicate nudge is exactly the repetition the
 * observing spine exists to prevent.
 *
 * ## Why a table and not a lock file
 *
 * The first attempt was `open(..., 'wx')` plus a pid file, and it was wrong in a
 * way worth keeping written down, because it is the ordinary way to write this.
 * An O_EXCL create is atomic, but *stealing a stale lock is not*: a run reads a
 * dead pid, then unlinks — and by then the file may be someone else's live lock.
 * Two processes measured it 6 times out of 6, both holding the lock, both
 * delivering.
 *
 * `rename` instead of `unlink` fixes the wrong half. It makes the steal have a
 * single winner, but the winner still renames away a path, not the inode it
 * judged dead — same 6/6. Verifying what you took (read it back, put it back if
 * it is not the pid you condemned) narrows it to a three-process window, where
 * the restore can land on top of a lock created while you looked.
 *
 * `BEGIN IMMEDIATE` has none of it: SQLite admits one writer, so read-then-claim
 * cannot interleave with another read-then-claim. There is nothing to steal and
 * nothing to put back, and the database was already open two lines away. The
 * shape of the bug — check, then act on what you checked — is the same one the
 * lock was written to fix, which is why it kept reappearing until the check and
 * the act stopped being two steps.
 *
 * ## What it still does not cover
 *
 * Nothing outside this database: another process writing the fire log directly
 * is not serialised by anything here.
 *
 * And one guarantee this file depends on without owning: a run that loses the
 * race must **wait** for the writer ahead of it rather than throwing
 * SQLITE_BUSY out of `acquire`. That comes from better-sqlite3, which sets
 * `busy_timeout = 5000` on every connection unless a caller passes `timeout: 0`
 * (measured, both ways). Setting the pragma here again was written and removed:
 * it changed nothing, and the test asserting it was asserting the driver.
 * `sendlock.test.ts` guards the inherited default instead, which is the thing
 * that could actually stop being true.
 *
 * Liveness is a pid, and a bare pid is weaker than it looks — it takes ordinary
 * reuse after a hard kill, not a 2³² wrap, for a dead holder to read as alive,
 * and that happens in hours on a busy machine. Left there it would wedge the
 * command permanently while telling the owner to wait for a send that ended
 * days ago. So `taken_at` is the backstop: a lock older than an hour is stale
 * whatever its pid says. A proactive send is one model call, so an hour is
 * generous by two orders of magnitude, and it collapses the whole liveness
 * question into a clause the row already has the data for.
 *
 * ## Where the mechanism now lives
 *
 * The claim itself moved to `core/lock/durable.ts` when the gateway needed the
 * same three properties (ADR-0035). This file keeps its table, its horizon and
 * its wording; the transaction is shared. The schema below is unchanged and
 * deliberately so — every installed home already has this table, and
 * `CREATE TABLE IF NOT EXISTS` does not migrate.
 */

/**
 * How long a claim can stand before it is stale regardless of its pid. Not a
 * timeout on the send: the send is a single model call. It is the horizon after
 * which "that pid is alive" stops being evidence that *this* lock is held.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_lock (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  pid       INTEGER,
  taken_at  TEXT,
  holder_id TEXT
);
`;

/** Re-exported: the send lock's callers have always imported both from here. */
export { pidAlive, type LockOutcome };

export class SendLock {
  private readonly lock: DurableLock;

  constructor(
    db: Database.Database,
    /** Injected so a test can exercise dead, live and not-ours holders. */
    alive: (pid: number) => boolean = pidAlive,
  ) {
    this.lock = new DurableLock(
      db,
      {
        table: 'send_lock',
        schema: SCHEMA,
        staleAfterMs: STALE_AFTER_MS,
        refusal: (holder) => ({
          held: `un altro invio proattivo è in corso (pid ${holder})`,
          remedy: 'aspetta che finisca e riprova',
        }),
      },
      alive,
    );
  }

  /**
   * Claims the lock, or names who holds it. The row is never deleted (§I-8):
   * releasing sets `pid` to NULL, so "when was a send last attempted" survives.
   */
  acquire(now: Date, pid: number = process.pid): LockOutcome {
    return this.lock.acquire(now, pid);
  }

  /**
   * The pid on the row, as written. Deliberately *not* the liveness-judged
   * holder: this is inspection, and a caller asking "who took it last" must not
   * be handed a null just because the clock has moved past the horizon.
   */
  holder(): number | null {
    return this.lock.recorded()?.pid ?? null;
  }
}
