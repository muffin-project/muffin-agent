import type Database from 'better-sqlite3';
import type { JobFire } from '../scheduler/job-fires.js';
import type { DeliveryState, TurnOutcome, TurnStatus } from '../turns/store.js';

/**
 * One durable answer for one fired job: `pending`/`running`/`continuable`/
 * `done`/`needs-owner`/`failed` (#598 S1).
 *
 * A durable unattended goal needs a run-outcome answerable from rows, not
 * model narration. The primitives exist but are scattered — `job_fires`
 * (`core/scheduler/job-fires.ts`) owns which occurrence maps to which turn,
 * `turns` (`core/turns/store.ts`) owns lifecycle/status/outcome/delivery,
 * `approvals` (`core/approvals/store.ts`) owns the open/decided questions,
 * `turn_tool_calls` owns effect metadata per call, `spend` owns the ledger —
 * and no single read joins them. This module is that read, nothing more.
 *
 * ## Read-only, by construction
 *
 * Every helper below runs `SELECT` and nothing else: this file holds no
 * write path, takes no clock, mints no ids and keeps no cache. The returned
 * value is a pure function of the five tables' current rows, so it varies
 * exactly when an underlying durable row varies — never with wall-clock
 * time, process state or call count.
 *
 * Spend is summed all-time per `job_id` rather than month-scoped on purpose:
 * the monthly gate (`BudgetEngine.jobMonthUsd`) owns the calendar, and
 * borrowing its clock would make this projection drift at midnight with no
 * row having moved. Purity is the guarantee; month windows stay with the
 * gate that enforces them.
 *
 * ## State precedence (closed world, documented once)
 *
 * 1. No turn bound, or the bound turn row is absent → `pending`. The
 *    occurrence is armed; no work exists yet.
 * 2. Turn `runnable` → `pending`: the row exists but nothing has picked it
 *    up yet.
 * 3. Turn `running`/`waiting`/`interrupted` → `running`, unless the turn
 *    carries an open approval (`decision IS NULL`, not withdrawn) →
 *    `needs-owner`. An interrupted row is still owed to the lane, not dead:
 *    reading it as failed would page the owner for a crash the runtime
 *    resumes on its own. A decided approval is not open — the owner already
 *    acted, and the wake belongs to the lane.
 * 4. Turn `continuable` → `continuable`, unless an open approval rides with
 *    it → `needs-owner`: the concrete question outranks the generic owed
 *    lease, because it names what the owner must answer.
 * 5. Turn `done` → by outcome: `answered` → `done`; `ask` → `needs-owner`
 *    (the work ended on a question, which is the truthful terminal state
 *    of #598's falsifier scene); anything else — `cap`, `budget`,
 *    `aborted`, `error`, or a row that names no outcome at all — → `failed`.
 *    A finished row that records no success is not a success.
 *
 * Delivery never moves the state, only the receipt: a failed delivery does
 * not re-run the work (that would double settled effects —
 * `core/scheduler/scheduler.ts` settled this for jobs already), so an
 * answered run whose message never arrived still reads `done`, with the
 * delivery column on the receipt saying where the message stands.
 *
 * Anything outside the six turn statuses the schema allows cannot be
 * produced through the stores; read defensively it maps to `failed` — a row
 * this build cannot execute is neither running work nor done work.
 *
 * ## Falsifiers
 *
 * - Remove the approvals read and the live `needs-owner` case collapses to
 *   `running`: the join is load-bearing, not decorative.
 * - Move a turn row `done`→`running` and the projection for its fire moves
 *   with it: state follows rows, nothing else.
 */

export type RunState = 'pending' | 'running' | 'continuable' | 'done' | 'needs-owner' | 'failed';

export type RunStatus = {
  state: RunState;
  jobId: string;
  scheduledFor: string;
  /** The bound turn, or `null` while the occurrence has no work yet. */
  turnId: string | null;
  /** Scheduler bookkeeping, carried as evidence — never a state driver. */
  settledAt: string | null;
  turnStatus: TurnStatus | null;
  turnOutcome: TurnOutcome | null;
  delivery: DeliveryState | null;
  /** Questions awaiting an owner answer on this turn. Drives `needs-owner`. */
  openApprovals: number;
  /** Decided but not yet consumed: the owner acted, the lane owns the wake. */
  decidedUnconsumed: boolean;
  /** Finished calls still standing (undone ones excluded — see below). */
  settledEffects: number;
  /** Started calls with no outcome row: crash candidates or still in flight. */
  uncertainCalls: number;
  /** Finished calls `muffin undo` has put back: history, not current truth. */
  undoneEffects: number;
  /** All-time ledger sum for this `job_id`. Purity note above. */
  spendUsd: number;
  /**
   * Silent receipt (#598 S4): the fire settled a routine success with zero
   * conversational message under a `silent` delivery policy
   * (`job_fires.silent`, written by `core/scheduler/scheduler.ts`). Present
   * and `true` only there — absent on every delivered fire and every legacy
   * row, so existing lines render byte-for-byte as before. Optional (rather
   * than required) so hand-built literals elsewhere keep compiling; readers
   * treat anything but `true` as "spoke, or predates the receipt". States
   * above are untouched: this is evidence on the receipt, never a state
   * driver — a silent `answered` run still reads `done`.
   */
  silent?: boolean;
};

type TurnShape = {
  status: TurnStatus;
  outcome: TurnOutcome | null;
  delivery: DeliveryState | null;
};

/** `true` only for the storage-missing-table case; every other error throws. */
function isMissingTable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no such table');
}

/** `true` only for a `job_fires` table that predates the S4 `silent` column. */
function isMissingColumn(error: unknown): boolean {
  return error instanceof Error && /no such column/i.test(error.message);
}

function readTurn(db: Database.Database, turnId: string): TurnShape | null {
  try {
    const row = db
      .prepare(`SELECT status, turn_outcome AS outcome, delivery FROM turns WHERE id = ?`)
      .get(turnId) as { status: string; outcome: string | null; delivery: string | null } | undefined;
    if (row === undefined) return null;
    return {
      status: row.status as TurnStatus,
      outcome: row.outcome as TurnOutcome | null,
      delivery: row.delivery as DeliveryState | null,
    };
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

function countOpenApprovals(db: Database.Database, turnId: string): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM approvals
          WHERE turn_id = ? AND decision IS NULL AND withdrawn_at IS NULL`,
      )
      .get(turnId) as { n: number };
    return row.n;
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

function hasDecidedUnconsumed(db: Database.Database, turnId: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS one FROM approvals
          WHERE turn_id = ? AND decision IS NOT NULL AND consumed_at IS NULL LIMIT 1`,
      )
      .get(turnId) as { one: number } | undefined;
    return row !== undefined;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

function countCalls(db: Database.Database, turnId: string, which: 'settled' | 'uncertain' | 'undone'): number {
  const clause =
    which === 'settled'
      ? `ended_at IS NOT NULL AND undone_at IS NULL`
      : which === 'uncertain'
        ? `ended_at IS NULL`
        : `undone_at IS NOT NULL`;
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM turn_tool_calls WHERE turn_id = ? AND ${clause}`)
      .get(turnId) as { n: number };
    return row.n;
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

function sumSpend(db: Database.Database, jobId: string): number {
  try {
    const row = db
      .prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE job_id = ?`)
      .get(jobId) as { total: number };
    return row.total;
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

function deriveState(turn: TurnShape | null, openApprovals: number): RunState {
  if (turn === null) return 'pending';
  switch (turn.status) {
    case 'runnable':
      return 'pending';
    case 'running':
    case 'waiting':
    case 'interrupted':
      return openApprovals > 0 ? 'needs-owner' : 'running';
    case 'continuable':
      return openApprovals > 0 ? 'needs-owner' : 'continuable';
    case 'done':
      if (turn.outcome === 'answered') return 'done';
      if (turn.outcome === 'ask') return 'needs-owner';
      return 'failed';
    default:
      return 'failed';
  }
}

/**
 * The 6-state answer for one fired occurrence, plus the receipt that proves
 * it — every number on the receipt names the durable rows it was folded
 * from. Read-only: `SELECT` over the five tables, no clock, no cache.
 */
export function runStatus(db: Database.Database, fire: JobFire): RunStatus {
  const turn = fire.turnId === null ? null : readTurn(db, fire.turnId);
  const openApprovals = fire.turnId === null ? 0 : countOpenApprovals(db, fire.turnId);
  return {
    state: deriveState(turn, openApprovals),
    jobId: fire.jobId,
    scheduledFor: fire.scheduledFor,
    turnId: fire.turnId,
    settledAt: fire.settledAt,
    turnStatus: turn?.status ?? null,
    turnOutcome: turn?.outcome ?? null,
    delivery: turn?.delivery ?? null,
    openApprovals,
    decidedUnconsumed: fire.turnId === null ? false : hasDecidedUnconsumed(db, fire.turnId),
    settledEffects: fire.turnId === null ? 0 : countCalls(db, fire.turnId, 'settled'),
    uncertainCalls: fire.turnId === null ? 0 : countCalls(db, fire.turnId, 'uncertain'),
    undoneEffects: fire.turnId === null ? 0 : countCalls(db, fire.turnId, 'undone'),
    spendUsd: sumSpend(db, fire.jobId),
    // The silent receipt rides on the fire, not the turn: present only when
    // the scheduler closed this occurrence without messaging.
    ...(fire.silent ? { silent: true as const } : {}),
  };
}

type FireRow = {
  job_id: string;
  scheduled_for: string;
  turn_id: string | null;
  settled_at: string | null;
  silent?: number | null;
};

/**
 * Every recorded occurrence, oldest first, each with its 6-state answer.
 * Read-only like `runStatus`; an install whose `job_fires` table predates
 * this reader (or has no fires yet) reads as the empty list, never an
 * error — `sys.inspect` must not break on an older home.
 */
export function listRunStatuses(db: Database.Database): RunStatus[] {
  let rows: FireRow[];
  try {
    rows = db
      .prepare(
        `SELECT job_id, scheduled_for, turn_id, settled_at, silent FROM job_fires
          ORDER BY scheduled_for ASC, job_id ASC`,
      )
      .all() as FireRow[];
  } catch (error) {
    if (isMissingTable(error)) return [];
    // A `job_fires` table written before S4 has no `silent` column: read it
    // the old way rather than breaking `sys.inspect` on an older home
    // (same posture as the missing-table case above, one column narrower).
    if (isMissingColumn(error)) {
      rows = db
        .prepare(
          `SELECT job_id, scheduled_for, turn_id, settled_at FROM job_fires
            ORDER BY scheduled_for ASC, job_id ASC`,
        )
        .all() as FireRow[];
    } else {
      throw error;
    }
  }
  return rows.map((row) =>
    runStatus(db, {
      jobId: row.job_id,
      scheduledFor: row.scheduled_for,
      turnId: row.turn_id,
      settledAt: row.settled_at,
      silent: row.silent === 1,
    }),
  );
}

/** One deterministic line per run for `sys.inspect` — same rows, same line. */
export function formatRunStatus(status: RunStatus): string {
  const turn = status.turnId === null ? 'turn none' : `turn ${status.turnId.slice(0, 12)}`;
  const shape = `${status.turnStatus ?? '-'}/${status.turnOutcome ?? '-'}`;
  return (
    `run ${status.jobId}@${status.scheduledFor} → ${status.state}` +
    ` · ${turn} ${shape}` +
    ` · delivery ${status.delivery ?? '-'}` +
    // The receipt, and only when there is one: every other line renders
    // exactly as before S4, which is what keeps the S1 determinism test
    // (`same rows, same line`) green without touching it.
    (status.silent === true ? ' · silent' : '') +
    ` · approvals open ${status.openApprovals}` +
    ` · effects settled ${status.settledEffects}/uncertain ${status.uncertainCalls}/undone ${status.undoneEffects}` +
    ` · spend $${status.spendUsd.toFixed(4)}`
  );
}
