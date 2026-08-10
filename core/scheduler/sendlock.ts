import type Database from 'better-sqlite3';

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
 * is not serialised by anything here. And liveness is a pid, so after a pid wrap
 * a dead holder can read as alive — the failure is then a refusal the owner can
 * see and clear, never a second message, which is the direction this is allowed
 * to fail in.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_lock (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  pid      INTEGER,
  taken_at TEXT
);
`;

/** Taken, or refused with the reason and what to do — the shape `ConfigError` uses. */
export type LockOutcome = { release: () => void } | { held: string; remedy: string };

/**
 * Signal 0 sends nothing: it only asks whether that process still exists.
 * EPERM means it exists and belongs to another user — alive, and not ours to
 * take. Only ESRCH is proof the holder is gone.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SendLock {
  constructor(
    private readonly db: Database.Database,
    /** Injected so a test can exercise dead, live and not-ours holders. */
    private readonly alive: (pid: number) => boolean = pidAlive,
  ) {
    db.exec(SCHEMA);
  }

  /**
   * Claims the lock, or names who holds it. The row is never deleted (§I-8):
   * releasing sets `pid` to NULL, so "when was a send last attempted" survives.
   */
  acquire(now: Date, pid: number = process.pid): LockOutcome {
    const claim = this.db.transaction((self: number, at: string): number | null => {
      const row = this.db.prepare(`SELECT pid FROM send_lock WHERE id = 1`).get() as
        | { pid: number | null }
        | undefined;
      // A live holder is a holder, including when it is this pid. The tempting
      // exemption — "a crashed earlier run of our own pid must not lock us out"
      // — was written and removed: it cannot happen (a crashed process is not
      // this one), and it silently permits two sends from *inside* one process,
      // which is exactly what a scheduler calling this in-process would do. The
      // case it was meant to cover, a pid reused after a wrap, is the documented
      // failure direction: a refusal the owner can see, never a second message.
      if (row?.pid != null && this.alive(row.pid)) return row.pid;
      this.db
        .prepare(
          `INSERT INTO send_lock (id, pid, taken_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, taken_at = excluded.taken_at`,
        )
        .run(self, at);
      return null;
    });

    // `.immediate` and not the default deferred: a deferred transaction takes
    // the write lock only at the INSERT, which puts the read and the claim back
    // on either side of a window and rebuilds the bug.
    const holder = claim.immediate(pid, now.toISOString()) as number | null;
    if (holder !== null) {
      return {
        held: `un altro invio proattivo è in corso (pid ${holder})`,
        remedy: 'aspetta che finisca e riprova',
      };
    }
    return { release: () => this.release(pid) };
  }

  private release(pid: number): void {
    // Guarded on the pid: a release must never free a lock this run does not
    // hold, which is what would happen after a takeover from a dead holder.
    this.db.prepare(`UPDATE send_lock SET pid = NULL WHERE id = 1 AND pid = ?`).run(pid);
  }

  /** The current holder, or null. For tests and for `doctor`-style inspection. */
  holder(): number | null {
    const row = this.db.prepare(`SELECT pid FROM send_lock WHERE id = 1`).get() as
      | { pid: number | null }
      | undefined;
    return row?.pid ?? null;
  }
}
