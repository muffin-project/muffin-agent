import type Database from 'better-sqlite3';
import { DurableLock, pidAlive, type LockOutcome } from '../lock/durable.js';

/**
 * One extractor at a time.
 *
 * The hole this closes: `pendingEpisodes` has no claim and no status column —
 * a hand-typed `muffin memory extract` overlapping a scheduled tick would read
 * the same pending set and both extract it. Every episode processed twice,
 * every judge call paid for twice, `markExtracted` racing itself.
 *
 * ## Why a lane lock and not per-episode claiming
 *
 * The old system (`memory_work_queue.ts`, `claimNextWork`) claimed individual
 * work items — `status='processing'` flipped inside a synchronous transaction
 * — because it had a genuine multi-consumer shape: a gateway process enqueuing
 * work and a separate "thinker" process dequeuing it, concurrently. That shape
 * does not exist here. ADR-0022 is one OS process for the whole runtime,
 * `ingestPending` already documents itself as running "one tenant at a time,
 * always", and its callers — a hand-typed CLI invocation and, since ADR-0038,
 * the trailing-edge trigger in `consolidator.ts` — are *whole-batch*
 * invocations of the same job racing each other, never two workers splitting
 * one batch between them.
 *
 * ADR-0035 made that race real rather than hypothetical, and the sentence above
 * about "one OS process" now needs its caveat: a gateway and a REPL window can
 * both be up, each with its own consolidator, over one database. This lock is
 * what makes that safe, and it is the only thing that does — the in-process
 * guard in `Consolidator.fire` cannot see the other process at all. A lane lock — one row, one holder, the whole job or nothing — covers
 * every collision that can actually happen. Per-episode claiming would add a
 * status column, claim/release semantics on every row and a stale-processing
 * sweep (the old system's `recoverStaleProcessing`) to protect against a race
 * this codebase cannot produce. Smaller mechanism, per PRACTICES.md §5.
 *
 * The claim itself is `core/lock/durable.ts`, shared with the send lock and
 * the gateway lock (ADR-0035): a `BEGIN IMMEDIATE` transaction makes
 * check-then-claim one step, so two callers racing to start a batch cannot
 * both win. Refusal, not blocking — a caller who loses is told to retry later
 * rather than parked inside the transaction, so `ingestPending` always
 * returns a report and never hangs waiting for a batch it did not start.
 */

/**
 * How long a claim can stand before it is stale regardless of its pid.
 *
 * Reasoned, not measured, the same way the send lock's hour is: a batch is
 * capped at `limit` episodes (25 per call from the CLI today), and each
 * episode costs one extraction call plus at most one judge call per fact it
 * produces. At a few seconds per model call, even a slow, retry-heavy batch
 * finishes in single-digit minutes. Thirty minutes keeps roughly the same
 * order-of-magnitude margin over a real batch that the send lock's hour keeps
 * over its one call — generous enough that a live batch is never mistaken for
 * dead, short enough that a genuinely crashed run does not wedge the lane for
 * the rest of the day.
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest_lock (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  pid       INTEGER,
  taken_at  TEXT,
  holder_id TEXT
);
`;

/** Re-exported so callers of `IngestLock` do not also need to import `../lock/durable.js`. */
export { pidAlive, type LockOutcome };

export class IngestLock {
  private readonly lock: DurableLock;

  constructor(
    db: Database.Database,
    /** Injected so a test can exercise dead, live and not-ours holders. */
    alive: (pid: number) => boolean = pidAlive,
  ) {
    this.lock = new DurableLock(
      db,
      {
        table: 'ingest_lock',
        schema: SCHEMA,
        staleAfterMs: STALE_AFTER_MS,
        refusal: (holder) => ({
          held: `un'altra estrazione è già in corso (pid ${holder})`,
          remedy: 'aspetta che finisca e riprova',
        }),
      },
      alive,
    );
  }

  /** Claims the lane, or names who holds it. The row is never deleted (§I-8). */
  acquire(now: Date, pid: number = process.pid): LockOutcome {
    return this.lock.acquire(now, pid);
  }

  release(pid: number = process.pid): void {
    this.lock.release(pid);
  }
}
