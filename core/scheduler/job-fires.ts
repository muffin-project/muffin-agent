import type Database from 'better-sqlite3';

/**
 * The identity/idempotency bridge from a due occurrence to a durable turn.
 *
 * Owner decision, verbatim (2026-08-17, B7/ADR-0035 emendamento №3's open
 * item): *"ogni occorrenza stabile `(job_id, scheduled_for)` deve mappare a
 * UNA sola identità durevole di lavoro/turno; dopo crash Muffin continua o
 * conclude quella stessa identità, non crea un secondo turn e non abbandona
 * il primo."* This table is that mapping, nothing more — **not** a second
 * `TurnStore`. It never carries a transcript, a status or an outcome; `turns`
 * owns all of that. It owns exactly three facts: which occurrence this is,
 * which turn it is bound to (once one exists), and whether the scheduler has
 * finished handling it.
 *
 * `scheduled_for` is the occurrence **that was due** — `Job.nextFireAt` as
 * read at the moment `due()` returned it — never the wall-clock instant a
 * process happened to notice it. Two processes racing on the same cron slot
 * agree on this string; they would not agree on "when I got to it".
 *
 * `(job_id, scheduled_for)` is the primary key, which is the UNIQUE
 * constraint the mandate asks for: SQLite enforces one row per occurrence at
 * the storage layer, not merely by convention in the code that writes it.
 *
 * ## Why additive, on the owner's existing database
 *
 * Same shape as `jobs`/`turns`/every other store in this repo (`AGENTS.md`,
 * `core/turns/store.ts`'s own docstring on migration cost): `CREATE TABLE IF
 * NOT EXISTS` in the constructor is a no-op on a database that already has
 * the table and creates it fresh on one that does not. There is nothing to
 * backfill — a fire this table has never seen simply does not exist yet, and
 * the first `claim()` for it creates the row.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_fires (
  job_id        TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  turn_id       TEXT,
  settled_at    TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (job_id, scheduled_for)
);
`;

export type JobFire = {
  jobId: string;
  scheduledFor: string;
  /** `null` until a turn exists for this occurrence. */
  turnId: string | null;
  /** `null` until the scheduler has finished handling this occurrence. */
  settledAt: string | null;
};

type Row = { job_id: string; scheduled_for: string; turn_id: string | null; settled_at: string | null };

function toFire(row: Row): JobFire {
  return { jobId: row.job_id, scheduledFor: row.scheduled_for, turnId: row.turn_id, settledAt: row.settled_at };
}

export class JobFireStore {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly bindStmt: Database.Statement;
  private readonly settleStmt: Database.Statement;

  constructor(
    db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
    // OR IGNORE, not OR REPLACE: a second `claim` for a key that already
    // exists (a retry after a crash, a second process reading the same due
    // list) must leave whatever the first claim wrote — including a `turn_id`
    // it may since have gained — untouched. Replacing would silently unbind a
    // turn that already exists, which is precisely the second-turn bug this
    // table exists to rule out.
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO job_fires (job_id, scheduled_for, turn_id, settled_at, created_at)
       VALUES (@jobId, @scheduledFor, NULL, NULL, @now)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM job_fires WHERE job_id = @jobId AND scheduled_for = @scheduledFor`);
    // Guarded on `turn_id IS NULL`: whichever caller's write lands first wins,
    // and a loser's `changes === 0` is how `bind` (below) knows to hand back
    // the winner's id instead of its own — never two turns for one occurrence,
    // even if two processes both decided this fire looked unbound at once.
    this.bindStmt = db.prepare(
      `UPDATE job_fires SET turn_id = @turnId WHERE job_id = @jobId AND scheduled_for = @scheduledFor AND turn_id IS NULL`,
    );
    // Guarded on `settled_at IS NULL` for the same reason: idempotent under a
    // retry, and the first settlement is the one that counts.
    this.settleStmt = db.prepare(
      `UPDATE job_fires SET settled_at = @now WHERE job_id = @jobId AND scheduled_for = @scheduledFor AND settled_at IS NULL`,
    );
  }

  /**
   * The occurrence exists before any work does — fault point 1 (crash before
   * the fire → it gets created) and its own recovery in one method: calling
   * this again for a key that already has a row is a read, not a write.
   */
  claim(jobId: string, scheduledFor: string): JobFire {
    this.insertStmt.run({ jobId, scheduledFor, now: this.clock().toISOString() });
    const row = this.getStmt.get({ jobId, scheduledFor }) as Row | undefined;
    if (!row) throw new Error(`job_fires non scritto per ${jobId}@${scheduledFor}`);
    return toFire(row);
  }

  /**
   * First writer wins, and every caller — first or raced — gets back the id
   * that actually landed rather than the one it proposed. A caller that lost
   * never has a turn of its own to run: it asks what the winner's id is and
   * defers to it, which is what makes a second, competing turn for the same
   * occurrence structurally unreachable rather than merely unlikely.
   */
  bind(jobId: string, scheduledFor: string, turnId: string): string {
    this.bindStmt.run({ jobId, scheduledFor, turnId });
    const row = this.getStmt.get({ jobId, scheduledFor }) as Row | undefined;
    if (!row || row.turn_id === null) {
      throw new Error(`job_fires senza turn_id dopo bind per ${jobId}@${scheduledFor}`);
    }
    return row.turn_id;
  }

  /**
   * Marks the occurrence as fully handled by the scheduler. Idempotent, so a
   * duplicate tick or a retried delivery never moves `settled_at` a second
   * time. `Scheduler` calls this immediately before `markRan` and never
   * after — fault point 7, "solo dopo il settlement avanza la schedule".
   */
  settle(jobId: string, scheduledFor: string): void {
    this.settleStmt.run({ jobId, scheduledFor, now: this.clock().toISOString() });
  }

  get(jobId: string, scheduledFor: string): JobFire | null {
    const row = this.getStmt.get({ jobId, scheduledFor }) as Row | undefined;
    return row ? toFire(row) : null;
  }
}
