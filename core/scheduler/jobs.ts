import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

/**
 * The durable core of M5: jobs that survive a restart, and a next-fire that is
 * correct across a DST change.
 *
 * The "semantic" half of semantic cron is a model turning "ogni mattina alle 8"
 * into a cron spec, confirmed in chat — that lives in the CLI/loop. Here there
 * is no model: a stored cron expression plus a timezone, and a deterministic
 * `next()`. Computing "the next 08:00 Europe/Rome" through a spring-forward is
 * exactly the arithmetic you do not write by hand, so it goes to cron-parser
 * (pure parser, tz+DST correct, does not own any timer — the scheduler loop is
 * ours, per ADR-0022).
 *
 * Rows are never deleted (invariant §I-8): a retired job is `active = 0`, so
 * "what did I have scheduled in May" stays answerable.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  cron         TEXT NOT NULL,
  timezone     TEXT NOT NULL,
  goal         TEXT NOT NULL,
  channel      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  next_fire_at TEXT NOT NULL,
  last_run_at  TEXT,
  active       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(active, next_fire_at);
`;

export type Job = {
  id: string;
  /** Standard 5-field cron expression. */
  cron: string;
  /** IANA timezone the cron is interpreted in. */
  timezone: string;
  /** The natural-language goal to run when it fires. */
  goal: string;
  /** Delivery surface id (e.g. 'cli', 'telegram'). */
  channel: string;
  createdAt: Date;
  nextFireAt: Date;
  lastRunAt: Date | null;
  active: boolean;
};

export type NewJob = {
  cron: string;
  timezone: string;
  goal: string;
  channel: string;
};

/** Thrown on a bad cron or timezone, so the CLI can name what was wrong. */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobError';
  }
}

/**
 * A bad timezone must be rejected here: `cron-parser` silently accepts an
 * unknown `tz` (verified — `Not/AZone` does not throw), which would compute
 * fire times against the wrong clock forever. `Intl.DateTimeFormat` throws on
 * an invalid IANA zone, so it is the boundary check.
 */
export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new JobError(`timezone non valida: "${tz}" (attesa una zona IANA, es. Europe/Rome)`);
  }
}

/** Next fire strictly after `after`, in `tz`. Throws JobError on bad input. */
export function nextFire(cron: string, tz: string, after: Date): Date {
  assertTimezone(tz);
  let interval;
  try {
    interval = CronExpressionParser.parse(cron, { tz, currentDate: after });
  } catch (error) {
    throw new JobError(`espressione cron non valida: "${cron}" — ${error instanceof Error ? error.message : String(error)}`);
  }
  return interval.next().toDate();
}

type Row = {
  id: string;
  cron: string;
  timezone: string;
  goal: string;
  channel: string;
  created_at: string;
  next_fire_at: string;
  last_run_at: string | null;
  active: number;
};

function toJob(row: Row): Job {
  return {
    id: row.id,
    cron: row.cron,
    timezone: row.timezone,
    goal: row.goal,
    channel: row.channel,
    createdAt: new Date(row.created_at),
    nextFireAt: new Date(row.next_fire_at),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
    active: row.active === 1,
  };
}

export class JobStore {
  private readonly insertStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly dueStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly ranStmt: Database.Statement;
  private readonly disableStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
    this.insertStmt = db.prepare(
      `INSERT INTO jobs (id, cron, timezone, goal, channel, created_at, next_fire_at, last_run_at, active)
       VALUES (@id, @cron, @timezone, @goal, @channel, @createdAt, @nextFireAt, NULL, 1)`,
    );
    this.listStmt = db.prepare(`SELECT * FROM jobs WHERE active = 1 ORDER BY next_fire_at`);
    this.dueStmt = db.prepare(
      `SELECT * FROM jobs WHERE active = 1 AND next_fire_at <= ? ORDER BY next_fire_at`,
    );
    this.getStmt = db.prepare(`SELECT * FROM jobs WHERE id = ?`);
    this.ranStmt = db.prepare(`UPDATE jobs SET last_run_at = @now, next_fire_at = @next WHERE id = @id`);
    this.disableStmt = db.prepare(`UPDATE jobs SET active = 0 WHERE id = ? AND active = 1`);
  }

  /** Validates, computes the first fire from now, persists. Throws JobError. */
  add(spec: NewJob): Job {
    const now = this.clock();
    const next = nextFire(spec.cron, spec.timezone, now); // throws before any write
    const job: Job = {
      id: randomUUID(),
      cron: spec.cron,
      timezone: spec.timezone,
      goal: spec.goal,
      channel: spec.channel,
      createdAt: now,
      nextFireAt: next,
      lastRunAt: null,
      active: true,
    };
    this.insertStmt.run({
      id: job.id,
      cron: job.cron,
      timezone: job.timezone,
      goal: job.goal,
      channel: job.channel,
      createdAt: now.toISOString(),
      nextFireAt: next.toISOString(),
    });
    return job;
  }

  list(): Job[] {
    return (this.listStmt.all() as Row[]).map(toJob);
  }

  /** Active jobs whose fire time has arrived. Default now = the injected clock. */
  due(now: Date = this.clock()): Job[] {
    return (this.dueStmt.all(now.toISOString()) as Row[]).map(toJob);
  }

  get(id: string): Job | null {
    const row = this.getStmt.get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /**
   * Record a run and schedule the next fire. Computed from `now`, not from the
   * old next_fire_at: if the process was down over a fire, the job runs once on
   * catch-up and then resumes its cadence, rather than replaying every missed
   * slot.
   */
  markRan(id: string): Job | null {
    const job = this.get(id);
    if (!job || !job.active) return null;
    const now = this.clock();
    const next = nextFire(job.cron, job.timezone, now);
    this.ranStmt.run({ id, now: now.toISOString(), next: next.toISOString() });
    return { ...job, lastRunAt: now, nextFireAt: next };
  }

  /** Soft-delete: the row stays (§I-8), it just stops firing. */
  disable(id: string): boolean {
    return this.disableStmt.run(id).changes > 0;
  }
}
