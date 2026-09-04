import { redactText } from '../tracing/redact.js';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '../../agent/providers/types.js';
import { ensureColumn, heldBy, pidAlive } from '../lock/durable.js';
import type { Principal, TrustTier } from '../policy/types.js';

/**
 * A turn is a durable record with an identity, not a stack frame.
 *
 * That sentence is the whole design (`docs/evidence/turno-sospendibile.md`),
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
 *  - `runnable` — created by a surface that will not execute it (B2), or woken
 *    from `waiting`. Written by `enqueue` and `wake`; read by `due`.
 *  - `waiting` — the turn released the runtime and is owed a wake-up. Written
 *    by `suspend`, which is also the only writer of `wake_at` and `wait_for`.
 *
 * The last two arrived with the consumers (`slice/turno-sospeso`) and were in
 * the `CHECK` before them, which is the whole reason this list was written for
 * the consumers that were coming rather than for the one writer that existed:
 * adding them now cost nothing, and after day 1 of the fourteen it would have
 * cost a table rebuild.
 */
export type TurnStatus = 'runnable' | 'running' | 'waiting' | 'interrupted' | 'done';

/** How the turn itself ended. The `stopped` value of `TurnResult`, verbatim. */
export type TurnOutcome = 'answered' | 'cap' | 'budget' | 'aborted' | 'error' | 'ask';

/**
 * How a *step* of a turn stopped — the outcomes above, plus the one that is not
 * an ending at all.
 *
 * `suspended` is deliberately **not** a `TurnOutcome`: `turn_outcome` is the
 * column that says how the turn ended, and a suspended turn has not ended. It
 * has released the runtime and is owed a resume. Keeping the two unions apart
 * is what stops `finish` from ever writing an outcome for a turn that is coming
 * back.
 *
 * Declared here, in `core`, because it had grown **three** literal copies —
 * `TurnResult['stopped']`, `JobOutcome['stopped']` and this file's own
 * `TurnOutcome` — and the design that produced this table named the divergence
 * as this repo's typical defect (`docs/evidence/turno-sospendibile.md` §Domanda 6,
 * row 9). One reference each now; adding an arm reaches every consumer.
 */
export type TurnStopped = TurnOutcome | 'suspended';

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
 *
 * `'undeliverable'` (D2, judge round 2) is the fourth outcome: the turn ended
 * with an answer and the row carries **no** address at all — not a delivery
 * that was attempted and failed, but one that was never attemptable.
 * `agent/turn-lane.ts` already emitted a `LaneEvent.undeliverable` for this
 * case; the gap was that the event reached only the process's own stderr and
 * nothing wrote it onto the row, so a restart — or `doctor`, which opens its
 * own handle and never sees an in-memory event — had no way to learn it had
 * happened. `possibly_sent` is the deliberately terminal answer for a remote
 * effect whose response was lost: it is never silently converted back to a
 * retry. Additive: existing rows keep reading `pending` / `sent` / `failed:…`
 * exactly as before.
 */
export type DeliveryState = 'pending' | 'sent' | 'possibly_sent' | 'undeliverable' | `failed:${string}`;

export type TurnCounters = {
  iterations: number;
  recoveriesUsed: number;
  transportRetriesLeft: number;
  toolCallsMade: number;
  nudgedForCompletion: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  spentUsd: number;
  /**
   * How many times this row has been picked back up.
   *
   * The bound on a resume loop, and it belongs in the record rather than in the
   * lane: a turn whose resume kills the process would otherwise be retried by
   * every boot for ever, and the process that dies is not the one that can
   * count. Counted in the JSON blob and not in a column because that is the
   * cheap direction (§T2, "blob JSON contro colonne": additive, low cost) —
   * and read defensively, since rows written before this field existed have no
   * value for it.
   */
  resumes: number;
  /**
   * Whether the deterministic preamble has already run for this row.
   *
   * The preamble is not idempotent: it writes the user episode, calls recall
   * and appends the user line to the session file. A resumed turn that ran it
   * again would duplicate the owner's words in memory and in the transcript,
   * and — worse — would *rebuild* the transcript from the session file,
   * throwing away the half-answered tool batch the crash left behind, which is
   * the one thing `reconcile` needs to repair anything.
   *
   * It is also what makes `enqueueTurn` legal: a connector writes a row whose
   * transcript is only the owner's words and returns in milliseconds, and this
   * flag is how the lane knows the expensive half is still owed. Read
   * defensively for the same reason `resumes` is — rows written by the slice
   * before this field have no value for it, and `undefined` must read as "not
   * built yet" rather than as `NaN`-shaped nonsense.
   */
  contextBuilt: boolean;
};

/**
 * Counters as they come off disk, with the fields a row may predate filled in.
 *
 * A `JSON.parse(...) as TurnCounters` is a claim, not a check, and the one
 * field this slice added would arrive as `undefined` on any row written by the
 * slice before it — then `resumes + 1` is `NaN`, `NaN >= MAX` is false, and the
 * bound above silently stops bounding. One place normalises, so no consumer has
 * to remember.
 */
function toCounters(raw: string): TurnCounters {
  const parsed = JSON.parse(raw) as TurnCounters;
  return {
    ...parsed,
    resumes: Number.isFinite(parsed.resumes) ? parsed.resumes : 0,
    contextBuilt: parsed.contextBuilt === true,
  };
}

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
   * (`docs/history/rebuild-2026/03-threat-model.md`). Today it lives in the closure of
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
  /**
   * The fencing token this claim was minted with — `null` on a row nobody
   * currently holds. The same mechanism as `core/lock/durable.ts`'s
   * `holder_id`, one table over: `claim()` mints a fresh, random one on every
   * successful claim, first or stolen alike, and `checkpoint`/`finish`/
   * `suspend` must be given it back. A write whose token does not match the
   * row's current one changes zero rows — the caller has lost the claim and
   * must stop, not overwrite whatever the new holder is doing (P19's second
   * finding: these three writes used to be guarded on `id` alone).
   */
  claimToken: string | null;
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
 *
 * A different question from `TurnHealth.undeliverable` below, and the two are
 * not merged: this is a turn that **had** an address and the delivery either
 * never settled (`pending`), was attempted and refused (`failed:<why>`), or
 * crossed the remote boundary without a readable response (`possibly_sent`) —
 * `TurnHealth.undeliverable` is a turn that had **no** address at all, so
 * there was never a delivery to attempt or fail. Same family of fact
 * (`DeliveryState`), two different rows it can be true of.
 */
export type UndeliveredTurn = {
  id: string;
  surface: string;
  tenant: string;
  startedAt: string;
  /** `pending`, `failed:<why>`, or terminal uncertainty after a remote effect. */
  delivery: DeliveryState;
};

/**
 * What `doctor` and the boot sequence ask about the table.
 *
 * Two different questions, kept apart because their remedies are: an
 * *interrupted* turn is a thing that already went wrong and may have left
 * effects, a *waiting* one is a promise that only comes true if some process is
 * running the lane.
 */
export type TurnHealth = {
  total: number;
  waiting: { count: number; oldestWakeAt: string | null };
  /**
   * Turns that finished with an answer and no address to send it to (D2,
   * judge round 2). Counted the same way `waiting` is — unwindowed, because a
   * reply stranded last week is exactly as owed as one from ten minutes ago —
   * and named next to it for the same reason: both are promises the row keeps
   * that only a human reading `doctor` can now close.
   */
  undeliverable: { count: number };
  interrupted: InterruptedTurn[];
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

/**
 * Il valore di `model` per un turno che non ha un modello.
 *
 * Un job `script` scrive una riga in `turns` come qualsiasi altro lavoro —
 * è ciò che gli dà identità durevole ed esattamente-una-volta — ma non c'è
 * nessuna inferenza da riprendere. Serve un discriminante *nominato*, e non
 * un confronto di stringhe sparso: `agent/loop.ts` lo legge per rifiutarsi di
 * riprendere attraverso il modello un turno che il modello non ha mai visto,
 * e senza questa costante quel rifiuto sarebbe una stringa scritta due volte
 * in due file che possono divergere.
 */
export const SCRIPT_MODEL = '(script: nessun modello)';

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

const SCHEMA = `
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
  claim_token   TEXT,
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
  -- D11, the half that PR #186 measured missing: the moment "muffin undo"
  -- put this call's file back. Additive (ensureColumn below, for a database
  -- that already has this table) and never cleared once set -- an undo that
  -- gets undone ("muffin undo annulla-<turno>") is a *different* row's
  -- undone_at, on the reversing turn, not an erasure of this one's.
  undone_at   TEXT,
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
  claim_token: string | null;
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
    counters: toCounters(row.counters),
    replyTo: row.reply_to === null ? null : (JSON.parse(row.reply_to) as Record<string, unknown>),
    status: row.status as TurnStatus,
    wakeAt: row.wake_at,
    waitFor: row.wait_for,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    claimToken: row.claim_token,
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
function argsDigest(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex').slice(0, 16);
}

/**
 * L'unico posto in cui i messaggi di un turno diventano righe di database.
 *
 * Quattro istruzioni scrivono `turns.messages` — l'insert, i due checkpoint e
 * la chiusura — e prima di questa funzione ognuna faceva il proprio
 * `JSON.stringify`. Quattro copie della stessa decisione sono quattro posti in
 * cui la quinta nascerà senza la difesa: è la ragione per cui il floor sta qui
 * e non nei chiamanti, la stessa che mette `redactText` dentro `addEpisode`
 * invece che nei suoi quattro.
 *
 * **Si redige il JSON già serializzato, di proposito.** Un `ContentBlock` ha
 * più forme (testo, immagine, risultato di tool, pensiero) e camminarle a mano
 * vorrebbe dire aggiornare questa funzione ogni volta che ne nasce una — cioè
 * dimenticarsene. Il marcatore è `«redacted:N»`: nessuna virgoletta, nessun
 * backslash, niente che sia speciale dentro una stringa JSON, quindi la
 * sostituzione non può produrre JSON invalido. Non è un'assunzione:
 * `store.test.ts` lo rilegge con `JSON.parse` dopo aver piantato una chiave.
 */
function serializzaMessaggi(messages: readonly Message[]): string {
  return redactText(JSON.stringify(messages));
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
  private readonly waitingStmt: Database.Statement;
  private readonly claimStmt: Database.Statement;
  private readonly suspendStmt: Database.Statement;
  private readonly dueStmt: Database.Statement;
  private readonly armedStmt: Database.Statement;
  private readonly wakeStmt: Database.Statement;
  private readonly suspendedCountStmt: Database.Statement;
  private readonly outcomesStmt: Database.Statement;
  private readonly undeliverableCountStmt: Database.Statement;
  private readonly markUndoneStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
    /** Injected so a test can exercise dead, live and reused holders. */
    private readonly alive: (pid: number) => boolean = pidAlive,
  ) {
    db.exec(SCHEMA);
    // Additive, for a database written before `claim_token` existed — see
    // `ensureColumn`'s own docstring in `core/lock/durable.ts`.
    ensureColumn(db, 'turns', 'claim_token', 'claim_token TEXT');
    // Additive, for a database written before D11's undo-realigns-the-turn
    // half existed. See the column's own comment in `SCHEMA` above.
    ensureColumn(db, 'turn_tool_calls', 'undone_at', 'undone_at TEXT');
    // `@status` and a nullable `@pid`, where both used to be the literal
    // `'running'` and this process: a connector that creates the row and
    // returns (B2) writes a turn nobody is executing yet, and a row claimed by
    // a pid that is not running it would be reclaimed as *interrupted* the
    // moment that pid dies — reporting a crash for work that had not started.
    // `@claimToken` travels with `@pid`: a row created already `running` (a
    // fresh `runTurn`) needs a token from the start, exactly as much as one
    // `claim()` hands the lane later — see `insert`.
    this.insertStmt = db.prepare(
      `INSERT INTO turns (id, principal, tenant, surface, session_id, model, messages, taint, counters,
                          reply_to, status, claimed_by, claimed_at, claim_token, delivery, created_at, updated_at)
       VALUES (@id, @principal, @tenant, @surface, @sessionId, @model, @messages, @taint, @counters,
               @replyTo, @status, @pid, @claimedAt, @claimToken, @delivery, @now, @now)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM turns WHERE id = ?`);
    // Fenced on `claim_token` (P19's second finding): a checkpoint from a
    // process that has been stolen from must change zero rows, not overwrite
    // whatever the new holder has already written. `changes` is read back by
    // `checkpoint()` below; `agent/loop.ts` stops the turn when it is 0.
    this.checkpointStmt = db.prepare(
      `UPDATE turns SET messages = @messages, taint = @taint, counters = @counters, updated_at = @now
       WHERE id = @id AND claim_token = @claimToken`,
    );
    // One write advances the state, and `claimed_by`/`claim_token` go with it:
    // a finished turn is nobody's, so the reclaim below can never see it as
    // abandoned, and no stale token can ever fence a write back in later.
    // Fenced the same way as `checkpoint` — see that statement's comment.
    this.finishStmt = db.prepare(
      `UPDATE turns SET status = 'done', turn_outcome = @outcome, messages = @messages, taint = @taint,
                        counters = @counters, claimed_by = NULL, claim_token = NULL, updated_at = @now
       WHERE id = @id AND claim_token = @claimToken`,
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
    // Deliberately *not* fenced on `claim_token`, unlike checkpoint/finish/
    // suspend above: taint must only ever rise, never be silently under-
    // reported, and a tool call this row's process actually made is true
    // regardless of who holds the claim by the time it returns. Fencing this
    // write would let a legitimate taint escalation from the losing side of a
    // steal go unrecorded on the winner's row — the unsafe direction. Intent
    // and outcome rows (`intentStmt`/`outcomeStmt`) are the same call: their
    // own `(turn_id, call_id)` key already scopes them to one specific call,
    // which is a different, already-adequate guard than "who currently owns
    // the row".
    this.taintStmt = db.prepare(
      `UPDATE turns SET taint = max(taint, @taint), updated_at = @now WHERE id = @id`,
    );
    this.staleStmt = db.prepare(
      `SELECT id, claimed_by AS pid, updated_at AS takenAt FROM turns WHERE status = 'running'`,
    );
    // Clears `claim_token` along with `claimed_by`: the row is nobody's now,
    // so no write fenced on the old token may land on it later either.
    this.interruptStmt = db.prepare(
      `UPDATE turns SET status = 'interrupted', claimed_by = NULL, claim_token = NULL, updated_at = @now
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
     * `possibly_sent` is the safe terminal state for an effect whose response
     * was lost: it needs operator attention but must not become an automatic
     * retry. `pending` on a turn that is already `done` is worse: the work finished and
     * *nothing ever settled the delivery*, which is what a process dying between
     * the answer and the send looks like from the outside.
     *
     * `status = 'done'` excludes a turn that is still running, whose `pending`
     * is simply the truth for now.
     */
    this.undeliveredStmt = db.prepare(
      `SELECT id, surface, tenant, created_at AS startedAt, delivery
       FROM turns
       WHERE status = 'done' AND (delivery IN ('pending','possibly_sent') OR delivery LIKE 'failed:%')
         AND updated_at >= @since
       ORDER BY updated_at DESC`,
    );
    this.countStmt = db.prepare(`SELECT count(*) AS n FROM turns`);
    /**
     * Suspended turns, and the one that has been owed longest.
     *
     * `health` used to count only `interrupted`, so a turn suspended from the
     * REPL or from `muffin run` — neither of which owns a lane — sat at
     * `waiting` for ever and **nothing said so**. That is the failure this whole
     * inventory exists to stop shipping: a mechanism that works, a row that is
     * correct, and no path by which an owner ever learns the wake-up is owed to
     * a process that is not running.
     */
    this.waitingStmt = db.prepare(
      `SELECT count(*) AS n, min(wake_at) AS oldest FROM turns WHERE status = 'waiting'`,
    );

    /**
     * The claim, as one statement.
     *
     * `BEGIN IMMEDIATE` is what `core/lock/durable.ts` needed because its claim
     * is a *read* of the holder followed by a *write*. This one is not: a
     * single `UPDATE` with the old status in its `WHERE` is already atomic in
     * SQLite, so two processes racing for the same row produce one `changes: 1`
     * and one `changes: 0`. The guard on `status` is what makes it a claim
     * rather than an assignment — a row somebody is already running has left
     * the set and cannot be taken.
     *
     * `@token` is a fresh id `claim()` mints for every winning claim (first
     * claim or a steal after `reclaim()` alike) — the fencing token every
     * subsequent write on this row must carry back. Not read here, only
     * written: the atomicity that makes this claim safe is the `status IN
     * (...)` guard, exactly as before token existed.
     */
    /**
     * Prendere la riga, e **spegnere la barriera nello stesso atto**.
     *
     * `wake_at`/`wait_for` erano appiccicosi: nessuno li azzerava mai. Chi
     * riprende il turno li legge per sapere *se* e *perché* è tornato — una
     * riga che se li tiene per sempre racconterebbe «attesa finita» a ogni
     * ripresa successiva, compresa quella dopo un crash che con l'attesa non
     * c'entra niente.
     *
     * Azzerati qui e non prima perché `resumeTurn` legge la riga **e poi**
     * la reclama: la lettura vede ancora la barriera, la scrittura la chiude.
     * Una riga reclamata è `running`, e nessuna delle due query che leggono
     * queste colonne (`due`, `armed`, `health`) guarda righe che non siano
     * `waiting` — quindi qui non si toglie niente a nessuno.
     */
    this.claimStmt = db.prepare(
      `UPDATE turns SET status = 'running', claimed_by = @pid, claimed_at = @now, claim_token = @token,
                        wake_at = NULL, wait_for = NULL, updated_at = @now
       WHERE id = @id AND status IN ('runnable','waiting','interrupted')`,
    );
    /**
     * The write that suspends, and it releases the claim in the same statement.
     *
     * Same shape as `finish`: **one write advances the state**, which is
     * ADR-0035's property (`markRan` the only writer of `next_fire_at`)
     * applied here. A suspended row must not keep a pid, or the next boot would
     * reclaim it as interrupted the moment that process exits — turning every
     * `wait` that outlives its process into a reported crash. `claim_token`
     * leaves with it, for the same reason `claimed_by` does: nobody holds a
     * `waiting` row, so no fenced write may land on it later either. Fenced on
     * the incoming token exactly as `checkpoint`/`finish` are — a suspend from
     * a process that has been stolen from must change zero rows, same as those
     * two (`status = 'running'` already guarded this; the token guards it
     * against the same holder's pid winning a *later*, unrelated claim too).
     */
    this.suspendStmt = db.prepare(
      `UPDATE turns SET status = 'waiting', wake_at = @wakeAt, wait_for = @waitFor,
                        messages = @messages, taint = @taint, counters = @counters,
                        claimed_by = NULL, claim_token = NULL, updated_at = @now
       WHERE id = @id AND status = 'running' AND claim_token = @claimToken`,
    );
    /**
     * What the lane may pick up, oldest first.
     *
     * Three producers in one query, because they are one queue: a turn a
     * surface created and did not run (`runnable`), a turn whose deadline has
     * arrived (`waiting` past `wake_at`), and a turn a dead process was holding
     * (`interrupted`). `idx_turns_due` covers the first two; the third is the
     * one `reclaim` writes, and until this slice nothing ever read it back.
     */
    this.dueStmt = db.prepare(
      `SELECT * FROM turns
       WHERE status IN ('runnable','interrupted')
          OR (status = 'waiting' AND wake_at IS NOT NULL AND wake_at <= @now)
       ORDER BY updated_at LIMIT @limit`,
    );
    /** Suspended turns with an event barrier — the rows whose predicate is evaluated. */
    this.armedStmt = db.prepare(
      `SELECT * FROM turns WHERE status = 'waiting' AND wait_for IS NOT NULL ORDER BY updated_at LIMIT @limit`,
    );
    this.wakeStmt = db.prepare(
      `UPDATE turns SET status = 'runnable', updated_at = @now WHERE id = @id AND status = 'waiting'`,
    );
    this.suspendedCountStmt = db.prepare(
      `SELECT count(*) AS n FROM turns WHERE tenant = @tenant AND status = 'waiting'`,
    );
    /** Recorded tool outcomes, for a resume that must replay instead of re-calling. */
    this.outcomesStmt = db.prepare(
      `SELECT call_id AS callId, content, is_error AS isError, tier
       FROM turn_tool_calls WHERE turn_id = ? AND ended_at IS NOT NULL`,
    );
    /** Turns whose answer has nowhere to go (D2) — read by `health`. */
    this.undeliverableCountStmt = db.prepare(`SELECT count(*) AS n FROM turns WHERE delivery = 'undeliverable'`);
    // Guarded on `ended_at IS NOT NULL`: a call still open has no outcome to
    // mislabel yet, and `muffin undo` only ever names calls that finished
    // (the journal only records a snapshot for a capability that ran).
    this.markUndoneStmt = db.prepare(
      `UPDATE turn_tool_calls SET undone_at = @now
       WHERE turn_id = @turnId AND call_id = @callId AND ended_at IS NOT NULL`,
    );
  }

  /**
   * The row exists before anything is generated, and this is the load-bearing
   * order: the caller must let a failure here stop the turn. A record that is
   * written *after* the model has been called is a record of something that
   * already happened, which is a log — the point of this one is that it exists
   * while the work is still owed.
   */
  create(spec: NewTurn, pid: number = process.pid): TurnRecord {
    return this.insert(spec, 'running', pid);
  }

  /**
   * The same row, written by a caller that is **not** going to run it.
   *
   * This is B2's whole mechanism, and it is one word of SQL: a connector that
   * creates the record and returns leaves a `runnable` row, and the lane
   * executes it. `runTurn` staying synchronous was never the property anybody
   * wanted — the property was that the connector does not block, and a row
   * nobody claimed is how that is expressed durably instead of by dropping an
   * `await` and hoping (`docs/evidence/turno-sospendibile.md` §B2, the three
   * guarantees a bare `void runTurn(...)` breaks).
   *
   * `claimed_by` is NULL, deliberately: a pid on a row nobody is executing
   * would be reclaimed as *interrupted* the moment that process exited, which
   * is a crash report for work that had not started.
   */
  enqueue(spec: NewTurn): TurnRecord {
    return this.insert(spec, 'runnable', null);
  }

  private insert(spec: NewTurn, status: TurnStatus, pid: number | null): TurnRecord {
    const now = this.clock().toISOString();
    // A row created already `running` needs a fencing token from the start,
    // for the same reason `claim()` mints one below: `checkpoint`, the very
    // first one, is only a few lines away. `enqueue` (pid `null`) gets none —
    // nobody holds the row yet, so there is nothing to fence.
    const token = pid === null ? null : randomUUID();
    this.insertStmt.run({
      id: spec.id,
      principal: JSON.stringify(spec.principal),
      tenant: spec.tenant,
      surface: spec.surface,
      sessionId: spec.sessionId,
      model: spec.model,
      messages: serializzaMessaggi(spec.messages),
      taint: spec.taint,
      counters: JSON.stringify(spec.counters),
      replyTo: spec.replyTo === undefined ? null : JSON.stringify(spec.replyTo),
      // The address and the delivery state travel together: a turn nobody has
      // to deliver to has no delivery that can fail.
      delivery: spec.replyTo === undefined ? null : 'pending',
      status,
      pid,
      claimedAt: pid === null ? null : now,
      claimToken: token,
      now,
    });
    const created = this.get(spec.id);
    if (created === null) throw new Error(`turn ${spec.id} non scritto`);
    return created;
  }

  /**
   * Take a row that nobody is running, or say somebody else got there first.
   *
   * `null` is not an error: two lanes ticking over one database is the normal
   * case this exists for (a REPL and a gateway both up for the seconds before
   * the REPL stands down), and the loser simply has nothing to do. What it must
   * never be is *both* — a turn executed twice re-runs its tool calls, which is
   * the effect duplication the whole record exists to prevent.
   *
   * A fresh `claimToken` is minted on every winning claim, exactly as
   * `core/lock/durable.ts`'s `holder_id` is on every `acquire` — first claim
   * or a steal via `reclaim()` alike. The caller must hold onto
   * `record.claimToken` and hand it back to `checkpoint`/`finish`/`suspend`;
   * `agent/loop.ts` is the one caller that does, threading it through `drive`.
   */
  claim(id: string, pid: number = process.pid, now: Date = this.clock()): TurnRecord | null {
    const at = now.toISOString();
    const token = randomUUID();
    if (this.claimStmt.run({ id, pid, token, now: at }).changes === 0) return null;
    return this.get(id);
  }

  /**
   * The turn released the runtime and is owed a wake-up.
   *
   * `wakeAt` is **not optional**, and that is a decision with a measured
   * precedent: a job with no stop condition keeps arriving, so the owner
   * notices it; a suspended turn with no deadline is *silent* — it holds a row
   * and its whole context and nothing ever says so
   * (`docs/evidence/turno-sospendibile.md` §Domanda 3). The deadline is the backstop
   * even when an event barrier is also armed: whichever comes first wins, and
   * neither can be absent.
   *
   * `claimToken` fences the write (P19's second finding): it must be the value
   * `claim()`/`create()` handed the caller. A `false` return already meant
   * "the write did not land" before fencing existed (the `status = 'running'`
   * guard); it now also covers "landed on the wrong holder's claim", and the
   * caller (`agent/loop.ts`) treats both identically — stop, do not pretend
   * the state was saved.
   */
  suspend(
    id: string,
    patch: {
      messages: Message[];
      taint: TrustTier;
      counters: TurnCounters;
      wakeAt: string;
      waitFor: string | null;
    },
    claimToken: string | null,
  ): boolean {
    return (
      this.suspendStmt.run({
        id,
        messages: serializzaMessaggi(patch.messages),
        taint: patch.taint,
        counters: JSON.stringify(patch.counters),
        wakeAt: patch.wakeAt,
        waitFor: patch.waitFor,
        claimToken,
        now: this.clock().toISOString(),
      }).changes === 1
    );
  }

  /** Rows the lane may pick up now: enqueued, expired, or left by a dead process. */
  due(now: Date = this.clock(), limit = 20): TurnRecord[] {
    return (this.dueStmt.all({ now: now.toISOString(), limit }) as Row[]).map(toRecord);
  }

  /** Suspended rows carrying an event barrier, for the lane to evaluate. */
  armed(limit = 50): TurnRecord[] {
    return (this.armedStmt.all({ limit }) as Row[]).map(toRecord);
  }

  /**
   * The barrier was satisfied: the row becomes runnable ahead of its deadline.
   *
   * Guarded on `waiting` so an event arriving twice, or arriving for a turn the
   * deadline already woke, cannot move a row that has left the waiting set.
   */
  wake(id: string, now: Date = this.clock()): boolean {
    return this.wakeStmt.run({ id, now: now.toISOString() }).changes === 1;
  }

  /**
   * How many turns this tenant is holding suspended.
   *
   * The ceiling `wait` is refused above. Without one, a model that likes
   * waiting produces rows without a bottom and nobody reads a table
   * (`docs/evidence/turno-sospendibile.md` §Domanda 3, third stop condition).
   */
  countSuspended(tenant: string): number {
    return (this.suspendedCountStmt.get({ tenant }) as { n: number }).n;
  }

  /**
   * The tool calls this turn already has an answer for.
   *
   * The half of the two-phase record that a resume *replays* instead of
   * re-running — Temporal's property in our own words: "When a Workflow calls
   * an Activity … During replay, that result is reused, not recomputed."
   */
  recordedOutcomes(turnId: string): Map<string, { content: string; isError: boolean; tier: TrustTier | null }> {
    const rows = this.outcomesStmt.all(turnId) as {
      callId: string;
      content: string | null;
      isError: number | null;
      tier: number | null;
    }[];
    return new Map(
      rows.map((r) => [
        r.callId,
        { content: r.content ?? '', isError: r.isError === 1, tier: (r.tier as TrustTier | null) ?? null },
      ]),
    );
  }

  get(id: string): TurnRecord | null {
    const row = this.getStmt.get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * The taint each of these rows is at, keyed by id — which is also `traceId`
   * (`NewTurn.id`'s own docstring: "one identity, so 'why' is a join").
   *
   * One query for the whole set, never one per row: `agent/context/
   * history-taint.ts` calls this with every `traceId` a turn is about to
   * reinject from `SessionStore` (ADR-0044 §Revisione), which on a long
   * session is dozens of rows for one context build. Not a prepared statement
   * in the constructor like the rest of this class — the placeholder count
   * varies with the caller's set, and `better-sqlite3` has no bind-an-array
   * primitive — but this runs once per turn's context assembly, not once per
   * row, so preparing it fresh here costs nothing a hot loop would notice.
   */
  taintForIds(ids: readonly string[]): Map<string, TrustTier> {
    const out = new Map<string, TrustTier>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return out;
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, taint FROM turns WHERE id IN (${placeholders})`)
      .all(...unique) as { id: string; taint: number }[];
    for (const row of rows) out.set(row.id, row.taint as TrustTier);
    return out;
  }

  /**
   * The state at a suspension point: transcript, taint and counters together.
   *
   * Fenced on `claimToken` (P19's second finding) and now returns whether it
   * landed: `false` means this process's claim is gone — someone else's write
   * is on the row now — and the caller must stop rather than keep checkpointing
   * (and eventually finishing) a turn it no longer owns. `agent/loop.ts` is the
   * one caller; every one of its three call sites checks the return.
   */
  checkpoint(
    id: string,
    patch: { messages: Message[]; taint: TrustTier; counters: TurnCounters },
    claimToken: string | null,
  ): boolean {
    return (
      this.checkpointStmt.run({
        id,
        messages: serializzaMessaggi(patch.messages),
        taint: patch.taint,
        counters: JSON.stringify(patch.counters),
        claimToken,
        now: this.clock().toISOString(),
      }).changes === 1
    );
  }

  /**
   * The single write that ends a turn — and it says nothing about delivery.
   *
   * ADR-0035 keeps a killed gateway from losing work by making `markRan` the
   * only writer of `next_fire_at`. This is the same property on this table: one
   * write moves the status, so a second writer added later cannot advance a
   * turn past an outcome nobody recorded.
   *
   * Fenced on `claimToken`, same as `checkpoint`, and for the same reason: a
   * `finish` from the losing side of a steal must not overwrite whatever the
   * new holder has already recorded. Returns whether the write landed;
   * `agent/loop.ts`'s `finish` closure treats `false` as "the claim is gone,
   * report nothing further" rather than retrying or pretending the outcome
   * this call was about to record is now durable.
   */
  finish(
    id: string,
    end: { outcome: TurnOutcome; messages: Message[]; taint: TrustTier; counters: TurnCounters },
    claimToken: string | null,
  ): boolean {
    return (
      this.finishStmt.run({
        id,
        outcome: end.outcome,
        messages: serializzaMessaggi(end.messages),
        taint: end.taint,
        counters: JSON.stringify(end.counters),
        claimToken,
        now: this.clock().toISOString(),
      }).changes === 1
    );
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
   * Quante volte questo turno ha **gia** fatto questa identica chiamata, con
   * esito buono.
   *
   * Non tiene stato nuovo: legge le righe che il turno scrive comunque, con la
   * stessa `argsDigest` che le ha scritte — quindi il confronto non puo
   * divergere dalla scrittura, e non c'e una seconda nozione di «identica».
   *
   * **Durevole, e per questo sopravvive al resume.** Un contatore in memoria
   * attorno all'invocazione si azzererebbe alla ripresa, e un turno che si
   * sospende in mezzo al proprio giro a vuoto ricomincerebbe a contare da capo
   * — cioe proprio il caso in cui il giro a vuoto e piu lungo.
   *
   * Solo le chiamate **finite bene**: una fallita e ripetuta e un'altra classe
   * di guasto — vedi `identicalFailuresDone` qui sotto, che la copre.
   *
   * Quel taglio di portata risaliva al corpus dogfood del 30/08/2026 (10
   * errori in tutto lo store, zero ripetuti) ed e stato riverificato il
   * 04/09/2026 su uno snapshot dal vivo: nel frattempo il corpus e cresciuto
   * e una coppia e comparsa (`fs_read` sullo stesso path, stesso errore «no
   * such file», sei minuti e tre altre chiamate di distanza). Il buco era
   * reale; non lo si vede piu perche `identicalFailuresDone` adesso lo copre.
   */
  identicalCallsDone(turnId: string, tool: string, args: unknown): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM turn_tool_calls
         WHERE turn_id = ? AND tool = ? AND args_digest = ?
           AND ended_at IS NOT NULL AND is_error = 0`,
      )
      .get(turnId, tool, argsDigest(args)) as { n: number };
    return row.n;
  }

  /**
   * Quante volte questo turno ha **gia** fatto questa identica chiamata, con
   * lo stesso esito **cattivo**.
   *
   * La meta gemella di `identicalCallsDone`, con due differenze deliberate.
   *
   * **Nessun gate su `progress: 'idempotent_read'`.** Quel campo esiste per
   * distinguere, sul successo, una capability per cui rifare la stessa
   * chiamata e informazione ripetuta (`fs_read`) da una per cui e effetto o
   * tempo che passa (`fs_write`, `sys.wait` — vedi `core/policy/types.ts`).
   * Sul fallimento quella distinzione non si applica: un effetto fallito non
   * e mai atterrato, e un'attesa fallita non ha mai fatto passare il tempo
   * che l'avrebbe resa progresso. Un fallimento identico e privo di
   * progresso qualunque sia la capability, quindi qui non serve — e non
   * sarebbe corretto ereditare — l'opt-in che serve al caso riuscito.
   *
   * **Confronta anche il contenuto, non solo tool+argomenti.** Due chiamate
   * con lo stesso `args_digest` possono fallire per muri diversi — un
   * timeout e un permesso negato hanno la stessa chiamata e risposte
   * diverse, e la seconda e informazione nuova, non un giro a vuoto. Senza
   * questo confronto il rilevatore avviserebbe anche li, insegnando al
   * modello a ignorare l'avviso — il guasto che questo repo nomina per
   * primo. Il confronto usa `content` cosi come e gia scritto da
   * `endToolCall` (redatto a monte in `agent/loop.ts`): nessuna seconda
   * nozione di «stesso errore», nessuna colonna nuova.
   *
   * Stesso motivo di durevolezza di `identicalCallsDone`: legge le righe che
   * il turno scrive comunque, quindi sopravvive alla ripresa senza un
   * contatore in memoria che si azzererebbe a meta del giro a vuoto.
   */
  identicalFailuresDone(turnId: string, tool: string, args: unknown, content: string): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM turn_tool_calls
         WHERE turn_id = ? AND tool = ? AND args_digest = ? AND content = ?
           AND ended_at IS NOT NULL AND is_error = 1`,
      )
      .get(turnId, tool, argsDigest(args), content) as { n: number };
    return row.n;
  }

  /**
   * "It came back, and here is what it said." Written with the turn's taint in
   * one transaction, because a tier-3 result raises the taint of the turn and
   * the two facts must not be able to land separately: a crash between them
   * would leave a record that had read the web at a tier that says it had not.
   *
   * `tier` is mandatory in this signature — audit P05 (BLOCKER): it used to be
   * optional, so an omitted argument wrote a silent `NULL` and skipped the
   * taint bump below with no error anywhere. `ToolOutcome.tier` was already
   * required upstream (ADR-0044), but the guarantee lived in the caller, not
   * in this method's type — exactly the gap named by the owner directive
   * "repair at the root": stop at the level where the defect stops being
   * representable, and "the type permits the wrong state" is one of those
   * levels. That rule was dropped from `ORCHESTRATION.md` by the 2026-08-19
   * documentation refactor and has no current home; it is still readable with
   * `git show 451cd916:docs/ORCHESTRATION.md`.
   * Every real caller already passes it (`agent/loop.ts`'s success and
   * throw paths both do); a future one that does not now fails `tsc` instead
   * of shipping an underestimated taint.
   */
  endToolCall(turnId: string, callId: string, result: { content: string; isError: boolean; tier: TrustTier }): void {
    const now = this.clock().toISOString();
    const write = this.db.transaction(() => {
      this.outcomeStmt.run({
        turnId,
        callId,
        content: result.content,
        isError: result.isError ? 1 : 0,
        tier: result.tier,
        now,
      });
      this.taintStmt.run({ id: turnId, taint: result.tier, now });
    });
    write();
  }

  /**
   * D11's other half: `muffin undo` put these calls' files back, so the
   * history they are recorded in must stop reading as current.
   *
   * `content` is left exactly as the tool wrote it — the row is not a lie,
   * it is a **stale** truth, the same distinction `episodes.superseded_at`
   * and `facts.expired_at` already make in `core/memory`. Only `undone_at`
   * changes; a reader (`buildContext`, `recordedOutcomes`) decides what that
   * means for presentation, this method only says when it happened.
   *
   * The caller (`cli/undo.ts`) passes exactly the `callId`s the restore
   * actually put back — never "every call this turn made" — so a partial
   * restore marks only its own partial truth.
   */
  markUndone(turnId: string, callIds: readonly string[]): void {
    const now = this.clock().toISOString();
    const run = this.db.transaction(() => {
      for (const callId of new Set(callIds)) this.markUndoneStmt.run({ turnId, callId, now });
    });
    run();
  }

  /**
   * Which of these turns (named by `traceId`, the same identity `taintForIds`
   * resolves) have at least one call `muffin undo` has put back.
   *
   * One query for the whole reinjected window, same shape as `taintForIds`
   * right below — a long session can hand this dozens of `traceId`s, and this
   * is read on every turn `buildContext` assembles, not once at boot.
   */
  undoneTraceIds(traceIds: readonly string[]): Set<string> {
    const unique = [...new Set(traceIds)];
    if (unique.length === 0) return new Set();
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT turn_id AS turnId FROM turn_tool_calls
         WHERE turn_id IN (${placeholders}) AND undone_at IS NOT NULL`,
      )
      .all(...unique) as { turnId: string }[];
    return new Set(rows.map((r) => r.turnId));
  }

  /**
   * Rows claimed by a process that is gone, marked as what they are.
   *
   * Odysseus does the same thing at start-up and for the same reason
   * (`docs/evidence/runtime-di-processo-nei-peer.md`): a row left `running` by
   * a dead process is `aborted`, not `error` — the task is not to blame for an
   * infrastructure event. The status change is guarded on `status = 'running'`
   * and only rows this call actually changed are returned, so two processes
   * booting at the same moment report each interrupted turn exactly once
   * instead of both announcing it.
   *
   * It marks; it does not resume. The lane (`core/turns/lane.ts`) is what picks
   * an `interrupted` row back up, and the split is deliberate: marking happens
   * at boot in every process that opens the home, resuming happens in the one
   * process that owns the lane. Merging them would resume a turn inside
   * `buildRuntime`, i.e. inside `muffin doctor`.
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
   * The reader for DAY-1 requirement B8. Before this, a job whose delivery failed was
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
  health(options: { now?: Date; windowMs?: number } = {}): TurnHealth {
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
    const waiting = this.waitingStmt.get() as { n: number; oldest: string | null };
    const undeliverable = this.undeliverableCountStmt.get() as { n: number };
    return {
      total,
      // Not windowed, unlike `interrupted`: a crash from last month is old news,
      // but a turn still suspended from last month is a turn still owed — the
      // window would hide exactly the worst case.
      waiting: { count: waiting.n, oldestWakeAt: waiting.oldest },
      // Same reasoning, same absence of a window: a reply nobody could send
      // last month is still a reply nobody sent.
      undeliverable: { count: undeliverable.n },
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
): TurnHealth | null {
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
const DOCTOR_WINDOW_MS = 24 * 60 * 60 * 1000;
