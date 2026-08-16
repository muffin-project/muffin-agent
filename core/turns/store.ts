import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Message } from '../../agent/providers/types.js';
import { heldBy, pidAlive } from '../lock/durable.js';
import type { Principal, TrustTier } from '../policy/types.js';

/**
 * A turn is a durable record with an identity, not a stack frame.
 *
 * That sentence is the whole design (`docs/blueprint/research/turno-sospendibile.md`),
 * and it is the substrate under three separate blockers: a connector that must
 * not block for minutes (B2), a `wait` primitive (B3) and a resume after a crash
 * (B5). None of those three is built here. What is built is the row they all
 * read: identity, the pinned model, the transcript, the taint, the counters and
 * where the answer goes.
 *
 * ## Why a new table and not the session JSONL
 *
 * `core/session/store.ts` says what that file is for: *"the raw record of what
 * was said, which memory will later be built from"*. It is **evidence** —
 * append-only, monotone, never rewritten. A turn's state is **mutable**: taint
 * rises, counters advance, status moves. Two different things, two places. The
 * measured half of the argument is in the design §Domanda 1: `SessionMessage.content`
 * is a `string` so a tool-using assistant turn has nowhere to go, thinking
 * blocks never reach the file at all, intermediate assistant turns are not
 * written, and the reader filters tool rows back out.
 *
 * ## Migration cost, declared
 *
 * **Zero, today and on a populated database.** This repo has no migration
 * runner: every store runs its own `db.exec(SCHEMA)` in its constructor, and
 * `CREATE TABLE IF NOT EXISTS` *creates* a new table on an installed database.
 * That is how `jobs`, `spend` and `gateway_lock` arrived, and it is why nothing
 * here touches `episodes` — whose `kind` carries a five-value `CHECK` SQLite
 * cannot alter (`core/memory/schema.ts:34`).
 *
 * **The one cost that is not zero, and it is ours**: `status` carries a `CHECK`
 * for the same reason `episodes.kind` does, and it inherits the same trap. A
 * status value not in the list below cannot be added to an installed database
 * without rebuilding the table. So the list is written for the consumers that
 * are coming, not only for the one caller that exists today — `waiting` and
 * `runnable` have no writer in this slice and are in the `CHECK` anyway. After
 * day 1 of the fourteen, a sixth status costs a table rebuild; before it, it
 * costs an edit to this line.
 */

/**
 * Where a turn can be.
 *
 * A closed set with a `CHECK`, because a free string here rebuilds exactly the
 * ambiguity the enum removes. Only three of the five have a writer today:
 *
 *  - `running` — claimed by a live process, being executed now. Written by `create`.
 *  - `done` — the turn ended, however it ended. Written by `finish`.
 *  - `interrupted` — the row was claimed by a process that is gone, and **no
 *    outcome was ever recorded**. This is the state that makes the defect in
 *    `connectors/telegram/connector.ts:230-239` visible: today a process that
 *    dies inside `handle()` leaves the update pending and the restart re-runs
 *    the turn from the top, tool calls and their effects included, with nothing
 *    anywhere saying so.
 *  - `runnable` / `waiting` — for the resume and the `wait` primitive. Declared
 *    here and written by nobody yet, deliberately: see the migration note above.
 *    A row is never *read* as these two either, so nothing depends on a value
 *    that does not occur.
 */
export type TurnStatus = 'runnable' | 'running' | 'waiting' | 'interrupted' | 'done';

/** How the turn itself ended. The `stopped` value of `TurnResult`, verbatim. */
export type TurnOutcome = 'answered' | 'cap' | 'budget' | 'aborted' | 'error' | 'ask';

/**
 * How the *delivery* went, which is a second question and never the same one.
 *
 * `core/scheduler/scheduler.ts:166-171` already fixed this once, for jobs: a
 * failed delivery does not re-run the work, because that would double it. The
 * record keeps the two answers in two columns so nothing can merge them later
 * by accident.
 *
 * `null` means this surface delivers **in band** — the caller of `runTurn` has
 * the text in its hand and there is no separate step that can fail. A turn that
 * carries a `replyTo` is the other kind, and starts at `pending`.
 */
export type DeliveryState = 'pending' | 'sent' | `failed:${string}`;

export type TurnCounters = {
  iterations: number;
  recoveriesUsed: number;
  transportRetriesLeft: number;
  toolCallsMade: number;
  nudgedForCompletion: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  spentUsd: number;
};

export type TurnRecord = {
  id: string;
  principal: Principal;
  tenant: string;
  surface: string;
  sessionId: string;
  /**
   * Pinned, and a resume on a different one is a refusal rather than an attempt.
   *
   * A `thinking` block carries a `signature` belonging to the model that
   * produced it (`agent/providers/types.ts`). ADR-0037 documents what happens
   * when those are sent to a model that cannot read them: the server strips
   * them or turns thinking off — **no 400, no noise**, just a worse agent. That
   * is this repo's documented way of failing, so the model is a column.
   */
  model: string;
  messages: Message[];
  /**
   * The turn's taint, as a column and never derived.
   *
   * The threat model scopes taint to the turn and raises it monotonically
   * (`docs/blueprint/03-threat-model.md`). Today it lives in the closure of
   * `makeSnapshot` (`agent/loop.ts`) and is recoverable from nothing else — so
   * a resume that rebuilt it from the principal would restart at tier 0 a turn
   * that had already read the web, which is the fetch-then-act pattern the
   * kernel exists to close, reopened by a new door.
   */
  taint: TrustTier;
  counters: TurnCounters;
  /** Opaque to the loop: each surface owns the shape and validates its own. */
  replyTo: Record<string, unknown> | null;
  status: TurnStatus;
  wakeAt: string | null;
  waitFor: string | null;
  claimedBy: number | null;
  claimedAt: string | null;
  outcome: TurnOutcome | null;
  delivery: DeliveryState | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A tool call that started and never recorded an outcome.
 *
 * The pair of rows is what separates *done* from *maybe done*, which today
 * cannot be separated at all: the loop appends the result **after** the handler
 * returns (`agent/loop.ts`), so an invocation that started and died leaves no
 * trace whatsoever.
 *
 * `rerunnable` is copied from the capability declaration **at the time of the
 * call**, not looked up later: what the code says six months from now is not
 * what was true when the effect may have landed.
 */
export type UncertainCall = {
  callId: string;
  tool: string;
  capability: string;
  rerunnable: boolean;
  startedAt: string;
};

/**
 * A turn that finished and whose answer cannot be shown to have arrived.
 *
 * Deliberately not folded into `InterruptedTurn`: an interrupted turn is one
 * whose *process* died, and this is one whose *delivery* did — the same
 * separation `TurnOutcome` and `DeliveryState` keep in two columns. A turn can
 * be both, and reporting it once under the wrong heading loses the half the
 * owner can act on.
 */
export type UndeliveredTurn = {
  id: string;
  surface: string;
  tenant: string;
  startedAt: string;
  /** `pending` (nothing ever settled it) or `failed:<why>` (the surface said no). */
  delivery: DeliveryState;
};

/** An interrupted turn, with everything needed to say what may have happened. */
export type InterruptedTurn = {
  id: string;
  surface: string;
  tenant: string;
  sessionId: string;
  model: string;
  startedAt: string;
  /** Its own delivery state, so "answered but never sent" stays visible. */
  delivery: DeliveryState | null;
  uncertain: UncertainCall[];
};

export type NewTurn = {
  /** The trace id of the turn's root span: one identity, so "why" is a join. */
  id: string;
  principal: Principal;
  tenant: string;
  surface: string;
  sessionId: string;
  model: string;
  messages: Message[];
  taint: TrustTier;
  counters: TurnCounters;
  replyTo?: Record<string, unknown> | undefined;
};

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,
  principal     TEXT NOT NULL,
  tenant        TEXT NOT NULL,
  surface       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  messages      TEXT NOT NULL,
  taint         INTEGER NOT NULL CHECK (taint BETWEEN 0 AND 3),
  counters      TEXT NOT NULL,
  reply_to      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('runnable','running','waiting','interrupted','done')),
  wake_at       TEXT,
  wait_for      TEXT,
  claimed_by    INTEGER,
  claimed_at    TEXT,
  turn_outcome  TEXT,
  delivery      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_turns_due ON turns(status, wake_at);
CREATE TABLE IF NOT EXISTS turn_tool_calls (
  turn_id     TEXT NOT NULL,
  call_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  capability  TEXT NOT NULL,
  rerunnable  INTEGER NOT NULL,
  args_digest TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  content     TEXT,
  is_error    INTEGER,
  tier        INTEGER,
  PRIMARY KEY (turn_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_tool_calls_open ON turn_tool_calls(turn_id, ended_at);
`;

/**
 * A turn untouched for this long is gone, whatever its pid says.
 *
 * The same reasoning as `core/scheduler/sendlock.ts`, and the same number: a
 * turn is a handful of model calls, so an hour of silence is not a slow turn.
 * The backstop matters because pids are reused within hours, so a dead holder
 * can read as alive — `heldBy` collapses free, dead and stale to one answer and
 * is reused here rather than re-derived, because two places that judge liveness
 * differently disagree exactly around a crash.
 */
export const TURN_STALE_AFTER_MS = 60 * 60 * 1000;

type Row = {
  id: string;
  principal: string;
  tenant: string;
  surface: string;
  session_id: string;
  model: string;
  messages: string;
  taint: number;
  counters: string;
  reply_to: string | null;
  status: string;
  wake_at: string | null;
  wait_for: string | null;
  claimed_by: number | null;
  claimed_at: string | null;
  turn_outcome: string | null;
  delivery: string | null;
  created_at: string;
  updated_at: string;
};

function toRecord(row: Row): TurnRecord {
  return {
    id: row.id,
    principal: JSON.parse(row.principal) as Principal,
    tenant: row.tenant,
    surface: row.surface,
    sessionId: row.session_id,
    model: row.model,
    messages: JSON.parse(row.messages) as Message[],
    taint: row.taint as TrustTier,
    counters: JSON.parse(row.counters) as TurnCounters,
    replyTo: row.reply_to === null ? null : (JSON.parse(row.reply_to) as Record<string, unknown>),
    status: row.status as TurnStatus,
    wakeAt: row.wake_at,
    waitFor: row.wait_for,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    outcome: row.turn_outcome as TurnOutcome | null,
    delivery: row.delivery as DeliveryState | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Arguments are stored as a digest, never verbatim.
 *
 * The question a resume asks is *"is this the same call I already made"*, and a
 * hash answers it. Keeping the arguments would put every shell command and
 * every URL a turn touched into a second place that has to be redacted — and
 * `core/tracing/redact.ts` exists because that problem is real. The tool's
 * *result* is stored, because a resume that cannot replay a recorded outcome
 * has to call the handler again; that is the same content the session JSONL
 * already holds verbatim, in the same home, so it is not a new exposure.
 */
export function argsDigest(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex').slice(0, 16);
}

export class TurnStore {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly checkpointStmt: Database.Statement;
  private readonly finishStmt: Database.Statement;
  private readonly deliveryStmt: Database.Statement;
  private readonly intentStmt: Database.Statement;
  private readonly outcomeStmt: Database.Statement;
  private readonly taintStmt: Database.Statement;
  private readonly staleStmt: Database.Statement;
  private readonly interruptStmt: Database.Statement;
  private readonly openCallsStmt: Database.Statement;
  private readonly interruptedStmt: Database.Statement;
  private readonly undeliveredStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
    /** Injected so a test can exercise dead, live and reused holders. */
    private readonly alive: (pid: number) => boolean = pidAlive,
  ) {
    db.exec(SCHEMA);
    this.insertStmt = db.prepare(
      `INSERT INTO turns (id, principal, tenant, surface, session_id, model, messages, taint, counters,
                          reply_to, status, claimed_by, claimed_at, delivery, created_at, updated_at)
       VALUES (@id, @principal, @tenant, @surface, @sessionId, @model, @messages, @taint, @counters,
               @replyTo, 'running', @pid, @now, @delivery, @now, @now)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM turns WHERE id = ?`);
    this.checkpointStmt = db.prepare(
      `UPDATE turns SET messages = @messages, taint = @taint, counters = @counters, updated_at = @now
       WHERE id = @id`,
    );
    // One write advances the state, and `claimed_by` goes with it: a finished
    // turn is nobody's, so the reclaim below can never see it as abandoned.
    this.finishStmt = db.prepare(
      `UPDATE turns SET status = 'done', turn_outcome = @outcome, messages = @messages, taint = @taint,
                        counters = @counters, claimed_by = NULL, updated_at = @now
       WHERE id = @id`,
    );
    this.deliveryStmt = db.prepare(`UPDATE turns SET delivery = @delivery, updated_at = @now WHERE id = @id`);
    this.intentStmt = db.prepare(
      `INSERT INTO turn_tool_calls (turn_id, call_id, tool, capability, rerunnable, args_digest, started_at)
       VALUES (@turnId, @callId, @tool, @capability, @rerunnable, @digest, @now)
       ON CONFLICT(turn_id, call_id) DO NOTHING`,
    );
    this.outcomeStmt = db.prepare(
      `UPDATE turn_tool_calls SET ended_at = @now, content = @content, is_error = @isError, tier = @tier
       WHERE turn_id = @turnId AND call_id = @callId`,
    );
    this.taintStmt = db.prepare(
      `UPDATE turns SET taint = max(taint, @taint), updated_at = @now WHERE id = @id`,
    );
    this.staleStmt = db.prepare(
      `SELECT id, claimed_by AS pid, updated_at AS takenAt FROM turns WHERE status = 'running'`,
    );
    this.interruptStmt = db.prepare(
      `UPDATE turns SET status = 'interrupted', claimed_by = NULL, updated_at = @now
       WHERE id = @id AND status = 'running'`,
    );
    this.openCallsStmt = db.prepare(
      `SELECT call_id AS callId, tool, capability, rerunnable, started_at AS startedAt
       FROM turn_tool_calls WHERE turn_id = ? AND ended_at IS NULL ORDER BY started_at`,
    );
    // Both kinds in one query, and the `running` half is the load-bearing one:
    // a crash is not reported by the process that crashed, and `doctor` — the
    // command an owner runs *because* something feels wrong — does not build a
    // runtime, so it never reaches `reclaim`. Reading only already-marked rows
    // would make the diagnosis blind for exactly as long as nobody restarts.
    this.interruptedStmt = db.prepare(
      `SELECT id, surface, tenant, session_id AS sessionId, model, created_at AS startedAt, delivery,
              status, claimed_by AS pid, updated_at AS takenAt
       FROM turns WHERE status IN ('interrupted','running') AND updated_at >= @since
       ORDER BY updated_at DESC`,
    );
    /**
     * Turns that owed a delivery and cannot show one.
     *
     * Both halves matter and they are different failures. `failed:%` is a
     * delivery that was attempted and reported back — the surface said no.
     * `pending` on a turn that is already `done` is worse: the work finished and
     * *nothing ever settled the delivery*, which is what a process dying between
     * the answer and the send looks like from the outside.
     *
     * `status = 'done'` excludes a turn that is still running, whose `pending`
     * is simply the truth for now.
     */
    this.undeliveredStmt = db.prepare(
      `SELECT id, surface, tenant, created_at AS startedAt, delivery
       FROM turns
       WHERE status = 'done' AND (delivery = 'pending' OR delivery LIKE 'failed:%')
         AND updated_at >= @since
       ORDER BY updated_at DESC`,
    );
    this.countStmt = db.prepare(`SELECT count(*) AS n FROM turns`);
  }

  /**
   * The row exists before anything is generated, and this is the load-bearing
   * order: the caller must let a failure here stop the turn. A record that is
   * written *after* the model has been called is a record of something that
   * already happened, which is a log — the point of this one is that it exists
   * while the work is still owed.
   */
  create(spec: NewTurn, pid: number = process.pid): TurnRecord {
    const now = this.clock().toISOString();
    this.insertStmt.run({
      id: spec.id,
      principal: JSON.stringify(spec.principal),
      tenant: spec.tenant,
      surface: spec.surface,
      sessionId: spec.sessionId,
      model: spec.model,
      messages: JSON.stringify(spec.messages),
      taint: spec.taint,
      counters: JSON.stringify(spec.counters),
      replyTo: spec.replyTo === undefined ? null : JSON.stringify(spec.replyTo),
      // The address and the delivery state travel together: a turn nobody has
      // to deliver to has no delivery that can fail.
      delivery: spec.replyTo === undefined ? null : 'pending',
      pid,
      now,
    });
    const created = this.get(spec.id);
    if (created === null) throw new Error(`turn ${spec.id} non scritto`);
    return created;
  }

  get(id: string): TurnRecord | null {
    const row = this.getStmt.get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** The state at a suspension point: transcript, taint and counters together. */
  checkpoint(id: string, patch: { messages: Message[]; taint: TrustTier; counters: TurnCounters }): void {
    this.checkpointStmt.run({
      id,
      messages: JSON.stringify(patch.messages),
      taint: patch.taint,
      counters: JSON.stringify(patch.counters),
      now: this.clock().toISOString(),
    });
  }

  /**
   * The single write that ends a turn — and it says nothing about delivery.
   *
   * ADR-0035 §1 keeps a killed gateway from losing work by making `markRan` the
   * only writer of `next_fire_at`. This is the same property on this table: one
   * write moves the status, so a second writer added later cannot advance a
   * turn past an outcome nobody recorded.
   */
  finish(
    id: string,
    end: { outcome: TurnOutcome; messages: Message[]; taint: TrustTier; counters: TurnCounters },
  ): void {
    this.finishStmt.run({
      id,
      outcome: end.outcome,
      messages: JSON.stringify(end.messages),
      taint: end.taint,
      counters: JSON.stringify(end.counters),
      now: this.clock().toISOString(),
    });
  }

  /** The other outcome. Never merged with the one above — see `DeliveryState`. */
  delivered(id: string, delivery: DeliveryState): void {
    this.deliveryStmt.run({ id, delivery, now: this.clock().toISOString() });
  }

  /** "I am about to call this handler." Written before the effect can land. */
  startToolCall(
    turnId: string,
    call: { callId: string; tool: string; capability: string; rerunnable: boolean; args: unknown },
  ): void {
    this.intentStmt.run({
      turnId,
      callId: call.callId,
      tool: call.tool,
      capability: call.capability,
      rerunnable: call.rerunnable ? 1 : 0,
      digest: argsDigest(call.args),
      now: this.clock().toISOString(),
    });
  }

  /**
   * "It came back, and here is what it said." Written with the turn's taint in
   * one transaction, because a tier-3 result raises the taint of the turn and
   * the two facts must not be able to land separately: a crash between them
   * would leave a record that had read the web at a tier that says it had not.
   */
  endToolCall(
    turnId: string,
    callId: string,
    result: { content: string; isError: boolean; tier?: TrustTier | undefined },
  ): void {
    const now = this.clock().toISOString();
    const write = this.db.transaction(() => {
      this.outcomeStmt.run({
        turnId,
        callId,
        content: result.content,
        isError: result.isError ? 1 : 0,
        tier: result.tier ?? null,
        now,
      });
      if (result.tier !== undefined) this.taintStmt.run({ id: turnId, taint: result.tier, now });
    });
    write();
  }

  /**
   * Rows claimed by a process that is gone, marked as what they are.
   *
   * Odysseus does the same thing at start-up and for the same reason
   * (`docs/blueprint/research/b1-runtime-processo.md`): a row left `running` by
   * a dead process is `aborted`, not `error` — the task is not to blame for an
   * infrastructure event. The status change is guarded on `status = 'running'`
   * and only rows this call actually changed are returned, so two processes
   * booting at the same moment report each interrupted turn exactly once
   * instead of both announcing it.
   *
   * It does **not** resume anything, and it does not pretend it could: a
   * resumable turn is `runnable`, and nothing writes that yet.
   */
  reclaim(now: Date = this.clock()): InterruptedTurn[] {
    const nowMs = now.getTime();
    const at = now.toISOString();
    const candidates = this.staleStmt.all() as { id: string; pid: number | null; takenAt: string | null }[];
    const out: InterruptedTurn[] = [];
    for (const row of candidates) {
      if (heldBy(row, nowMs, TURN_STALE_AFTER_MS, this.alive) !== null) continue;
      if (this.interruptStmt.run({ id: row.id, now: at }).changes === 0) continue;
      const record = this.get(row.id);
      if (record === null) continue;
      out.push({
        id: record.id,
        surface: record.surface,
        tenant: record.tenant,
        sessionId: record.sessionId,
        model: record.model,
        startedAt: record.createdAt,
        delivery: record.delivery,
        uncertain: this.uncertainCalls(record.id),
      });
    }
    return out;
  }

  /**
   * Answers "did the thing I was told was sent actually go out".
   *
   * The reader for M5-BIS B8. Before this, a job whose delivery failed was
   * indistinguishable from one that arrived: `markRan` advanced the schedule
   * either way and the only trace was a line on stderr that nobody was
   * necessarily reading. The scheduler now settles every fire onto the turn's
   * row, and this is the query that reads it back.
   *
   * Bounded by a window for the same reason `health` is: rows are never deleted
   * (§I-8), so without one a failure from last month sits next to this
   * morning's for ever.
   */
  undelivered(options: { now?: Date; windowMs?: number } = {}): UndeliveredTurn[] {
    const now = options.now ?? this.clock();
    const windowMs = options.windowMs ?? DOCTOR_WINDOW_MS;
    const since = new Date(now.getTime() - windowMs).toISOString();
    return (this.undeliveredStmt.all({ since }) as {
      id: string;
      surface: string;
      tenant: string;
      startedAt: string;
      delivery: string;
    }[]).map((r) => ({ ...r, delivery: r.delivery as DeliveryState }));
  }

  /** Tool calls with an intent row and no outcome row — the "maybe done" set. */
  uncertainCalls(turnId: string): UncertainCall[] {
    const rows = this.openCallsStmt.all(turnId) as {
      callId: string;
      tool: string;
      capability: string;
      rerunnable: number;
      startedAt: string;
    }[];
    return rows.map((r) => ({ ...r, rerunnable: r.rerunnable === 1 }));
  }

  /**
   * What `doctor` asks: is anything writing these rows, and did anything die
   * holding one. Both halves matter — a table that stays empty while turns are
   * happening is this repo's signature defect, not a healthy install.
   *
   * A turn counts as interrupted here if it is *marked* interrupted or if it
   * says `running` and nobody live is holding it — one liveness rule, the same
   * `heldBy` the reclaim uses, so the two can never answer differently. This
   * one only reads: marking is `reclaim`'s job and stays with the process that
   * announces it.
   *
   * `windowMs` bounds the noise, and the bound belongs here rather than in the
   * table: rows are never deleted (§I-8), so without a window a crash from last
   * month would sit in `doctor` for ever, next to one from ten minutes ago that
   * actually wants looking at.
   */
  health(options: { now?: Date; windowMs?: number } = {}): { total: number; interrupted: InterruptedTurn[] } {
    const now = options.now ?? this.clock();
    const since = options.windowMs === undefined ? '' : new Date(now.getTime() - options.windowMs).toISOString();
    const total = (this.countStmt.get() as { n: number }).n;
    const rows = this.interruptedStmt.all({ since }) as {
      id: string;
      surface: string;
      tenant: string;
      sessionId: string;
      model: string;
      startedAt: string;
      delivery: string | null;
      status: string;
      pid: number | null;
      takenAt: string | null;
    }[];
    const abandoned = rows.filter(
      (r) => r.status === 'interrupted' || heldBy(r, now.getTime(), TURN_STALE_AFTER_MS, this.alive) === null,
    );
    return {
      total,
      interrupted: abandoned.map((r) => ({
        id: r.id,
        surface: r.surface,
        tenant: r.tenant,
        sessionId: r.sessionId,
        model: r.model,
        startedAt: r.startedAt,
        delivery: r.delivery as DeliveryState | null,
        uncertain: this.uncertainCalls(r.id),
      })),
    };
  }
}

/**
 * One wording for an interrupted turn, used by every surface that reports one.
 *
 * Shared rather than written twice: `buildRuntime` says it at boot and `doctor`
 * says it on demand, and two places describing the same row in different words
 * is how an owner ends up believing they are two different problems.
 *
 * It says what happened and what is *unknown*, and never guesses which. The
 * last clause is the one that matters — a call that is not declared re-runnable
 * may have sent the message, and no record on this side can settle it.
 */
export function describeInterrupted(turn: InterruptedTurn): string {
  const when = turn.startedAt.slice(0, 16).replace('T', ' ');
  const head = `turno ${turn.id.slice(0, 12)} su ${turn.surface} (${when}): il processo che lo eseguiva non c'è più`;
  if (turn.uncertain.length === 0) {
    return `${head} — nessuna tool call era in corso, quindi non ha lasciato effetti a metà`;
  }
  const names = turn.uncertain.map((c) => c.tool).join(', ');
  const risky = turn.uncertain.filter((c) => !c.rerunnable);
  if (risky.length === 0) {
    return `${head} — ${turn.uncertain.length} tool call senza esito (${names}), tutte dichiarate ri-eseguibili`;
  }
  return (
    `${head} — ${risky.length} tool call può essere partita e non risulta conclusa ` +
    `(${risky.map((c) => c.tool).join(', ')}), e non è dichiarata ri-eseguibile: non è possibile sapere se ha avuto effetto`
  );
}

/**
 * The same two answers for a caller that has a database and no runtime —
 * `doctor` opens its own handle, the way it does for the gateway lock and the
 * consolidation register. `null` means the table is not there at all, which is
 * a different fact from "no turns yet".
 */
export function readTurnHealth(
  db: Database.Database,
  windowMs: number = DOCTOR_WINDOW_MS,
): { total: number; interrupted: InterruptedTurn[] } | null {
  try {
    db.prepare(`SELECT 1 FROM turns LIMIT 1`).get();
  } catch {
    return null;
  }
  // Read-only: the constructor's `CREATE TABLE IF NOT EXISTS` is a no-op here
  // because the probe above already proved the table exists.
  return new TurnStore(db).health({ windowMs });
}

/**
 * `undelivered()`'s own half of the pair above — same shape, same reason:
 * `doctor` opens a read-only handle and has no runtime to hold a `TurnStore`.
 *
 * D3 (judge, PR #42): this method had zero callers and zero tests until
 * `cli/doctor.ts` read it here — B8's own guarantee ("un job che dice
 * «inviato» è arrivato") was checkable in principle and unchecked in
 * practice, the exact shape `AGENTS.md` names: a mechanism with a schema and
 * no caller.
 */
export function readUndelivered(
  db: Database.Database,
  windowMs: number = DOCTOR_WINDOW_MS,
): UndeliveredTurn[] | null {
  try {
    db.prepare(`SELECT 1 FROM turns LIMIT 1`).get();
  } catch {
    return null;
  }
  return new TurnStore(db).undelivered({ windowMs });
}

/**
 * How far back a diagnosis looks for an interrupted turn.
 *
 * A day, because that is the horizon on which "something went wrong and I do
 * not know what" is still a live question for the owner. Older crashes stay in
 * the table — nothing is deleted — they simply stop being today's news.
 */
export const DOCTOR_WINDOW_MS = 24 * 60 * 60 * 1000;
