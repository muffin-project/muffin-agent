import type Database from 'better-sqlite3';

/**
 * One holder at a time, across processes, surviving a hard kill.
 *
 * This is `core/scheduler/sendlock.ts` with the table pulled out. Read that
 * file's docstring for *why* the claim has this exact shape — the file-lock
 * attempts that failed 6/6, and why `BEGIN IMMEDIATE` ends the whole family of
 * bugs by making check-then-act one step. None of that reasoning is repeated
 * here; what is repeated is the mistake of writing it twice.
 *
 * ## Why generalise instead of adding a sibling table
 *
 * The gateway needs the same three hard-won properties the send lock has: a
 * claim that cannot interleave with another claim, a dead holder that gets
 * taken over, and a stale holder that cannot wedge the command forever. Copying
 * them would have been two files that must stay in agreement about liveness —
 * and the repo's own rule is that two points doing the same thing diverge.
 *
 * What is *not* shared is the table. Each lock passes its own `CREATE TABLE`
 * and keeps its own columns, for one concrete reason: `send_lock` already
 * exists in every installed `~/.muffin/muffin.db`, and `CREATE TABLE IF NOT
 * EXISTS` does not migrate. Folding both into one keyed table would need a
 * migration to buy nothing — the algorithm is what was worth sharing, not the
 * storage.
 *
 * What is parameterised, and why each one had to be:
 *
 *  - **the stale horizon**, because the send lock's is an hour (a send is one
 *    model call) and the gateway's cannot be: a gateway legitimately holds its
 *    lock for weeks. Its horizon is a multiple of a heartbeat instead, which is
 *    what `refresh` exists for.
 *  - **the refusal**, because "another send is in flight, wait" and "a gateway
 *    is already running, here is its pid" are different sentences to a person.
 */

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

/**
 * Is anyone holding this row, right now? The single rule, so that a claim and
 * an inspection command cannot answer it differently — they would disagree
 * exactly around a crash, which is the moment the answer matters.
 *
 * Free, dead and stale all collapse to `null` on purpose: they are three ways
 * of not being held, and every caller acts on them identically.
 */
export function heldBy(
  row: { pid: number | null; takenAt: string | null } | undefined,
  nowMs: number,
  staleAfterMs: number,
  alive: (pid: number) => boolean,
): number | null {
  if (row?.pid == null) return null;
  const takenAt = row.takenAt ? Date.parse(row.takenAt) : NaN;
  // A pid is weaker evidence than it looks: ordinary reuse after a hard kill is
  // enough for a dead holder to read as alive, in hours rather than after 2³²
  // processes. `taken_at` is the backstop that keeps a corpse from wedging the
  // command forever.
  if (Number.isFinite(takenAt) && nowMs - takenAt > staleAfterMs) return null;
  // A live holder is a holder, including when it is this pid. The tempting
  // exemption — "a crashed earlier run of our own pid must not lock us out" —
  // cannot happen (a crashed process is not this one) and silently permits two
  // holders from *inside* one process.
  return alive(row.pid) ? row.pid : null;
}

export type DurableLockSpec = {
  /** Table name. Interpolated into SQL, so it is checked against a literal shape below. */
  table: string;
  /** The lock's own `CREATE TABLE IF NOT EXISTS`, with at least (id, pid, taken_at). */
  schema: string;
  /** After this much, a claim is stale whatever its pid says. */
  staleAfterMs: number;
  /** What the loser of the race is told. */
  refusal: (holder: number) => { held: string; remedy: string };
};

export class DurableLock {
  private readonly claimStmt: Database.Statement;
  private readonly readStmt: Database.Statement;
  private readonly refreshStmt: Database.Statement;
  private readonly releaseStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly spec: DurableLockSpec,
    /** Injected so a test can exercise dead, live and not-ours holders. */
    private readonly alive: (pid: number) => boolean = pidAlive,
  ) {
    // The table name reaches SQL by interpolation because a table name cannot
    // be a bound parameter. Every caller passes a literal, so this can only
    // fail on a programming error — which is exactly when an assertion is worth
    // its line, because the alternative is a crafted name becoming SQL.
    if (!/^[a-z_]+$/.test(spec.table)) throw new Error(`nome tabella non valido: ${spec.table}`);
    db.exec(spec.schema);
    this.claimStmt = db.prepare(
      `INSERT INTO ${spec.table} (id, pid, taken_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, taken_at = excluded.taken_at`,
    );
    this.readStmt = db.prepare(`SELECT pid, taken_at AS takenAt FROM ${spec.table} WHERE id = 1`);
    this.refreshStmt = db.prepare(`UPDATE ${spec.table} SET taken_at = ? WHERE id = 1 AND pid = ?`);
    this.releaseStmt = db.prepare(`UPDATE ${spec.table} SET pid = NULL WHERE id = 1 AND pid = ?`);
  }

  /**
   * Claims the lock, or names who holds it. The row is never deleted (§I-8):
   * releasing sets `pid` to NULL, so "when was it last taken" survives.
   *
   * `onClaim` runs **inside** the same immediate transaction, for the columns a
   * particular lock adds on top of the three here. Outside it, a reader could
   * see a row already claimed by the new holder while it still carried the old
   * holder's payload — which for the gateway means `status` describing a
   * process that is gone.
   */
  acquire(now: Date, pid: number = process.pid, onClaim?: () => void): LockOutcome {
    const claim = this.db.transaction((self: number, at: string): number | null => {
      const holder = this.currentHolder(Date.parse(at));
      if (holder !== null) return holder;
      this.claimStmt.run(self, at);
      onClaim?.();
      return null;
    });

    // `.immediate` and not the default deferred: a deferred transaction takes
    // the write lock only at the INSERT, which puts the read and the claim back
    // on either side of a window and rebuilds the bug sendlock.ts documents.
    const held = claim.immediate(pid, now.toISOString()) as number | null;
    if (held !== null) return this.spec.refusal(held);
    return { release: () => this.release(pid) };
  }

  /**
   * Push the staleness horizon out — the heartbeat of a long-lived holder.
   *
   * Guarded on the pid for the same reason `release` is: after a takeover the
   * old holder must not be able to refresh a lock it no longer has, or a dead
   * gateway's last timer keeps a live one's claim looking like its own. Returns
   * false when this pid is no longer the holder, which is a caller's cue to
   * stop rather than a failure to swallow.
   */
  refresh(now: Date, pid: number = process.pid, onRefresh?: () => void): boolean {
    const beat = this.db.transaction((at: string, self: number): boolean => {
      if (this.refreshStmt.run(at, self).changes === 0) return false;
      onRefresh?.();
      return true;
    });
    return beat.immediate(now.toISOString(), pid) as boolean;
  }

  release(pid: number = process.pid): void {
    // Guarded on the pid: a release must never free a lock this run does not
    // hold, which is what would happen after a takeover from a dead holder.
    this.releaseStmt.run(pid);
  }

  /** The current holder, or null when free, dead or stale. */
  holder(now: Date = new Date()): number | null {
    return this.currentHolder(now.getTime());
  }

  /**
   * The row as written, with no judgement about liveness applied.
   *
   * Kept separate from `holder` because the two answer different questions and
   * conflating them is a real bug in both directions: "who wrote this row" is
   * what an inspection command reports, "who holds this lock right now" is what
   * a claim decides. A caller that wants the second must say so.
   */
  recorded(): { pid: number | null; takenAt: string | null } | undefined {
    return this.readStmt.get() as { pid: number | null; takenAt: string | null } | undefined;
  }

  private currentHolder(nowMs: number): number | null {
    return heldBy(this.recorded(), nowMs, this.spec.staleAfterMs, this.alive);
  }
}
