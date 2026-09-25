import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Message } from '../../agent/providers/types.js';
import { ensureColumn, heldBy, pidAlive } from '../lock/durable.js';
import type { Principal, TrustTier } from '../policy/types.js';
import { redactText } from '../tracing/redact.js';
import {
  type EffectMetadata,
  type EffectsFilter,
  type EffectsReport,
  readEffects,
} from './effects.js';

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
 *  - `continuable` — the execution lease ended on a recoverable failure, the
 *    work itself did not. Written by `releaseContinuable`, read by
 *    `continuableFor`, claimed only by `grantContinuation`. Never picked up
 *    by the lane (`due`/`armed` exclude it), never reclaimed as `interrupted`,
 *    never auto-retried: only an explicit owner continuation mints the next
 *    lease. A `waiting` row must never become `continuable` (its barrier is
 *    still pending) and a `done` row never comes back.
 *
 * The last two arrived with the consumers (`slice/turno-sospeso`) and were in
 * the `CHECK` before them, which is the whole reason this list was written for
 * the consumers that were coming rather than for the one writer that existed:
 * adding them now cost nothing, and after day 1 of the fourteen it would have
 * cost a table rebuild.
 *
 * `continuable` is that rebuild, arriving late: a sixth status on an
 * installed database costs the `migrateContinuable` copy below (one
 * transaction, all columns explicit, new columns defaulted). The alternative —
 * overloading `done` or `waiting` — was rejected: `resumeTurn` structurally
 * refuses every `done` row, and `waiting` means a known wake condition exists.
 */
export type TurnStatus = 'runnable' | 'running' | 'waiting' | 'interrupted' | 'done' | 'continuable';

/** How the turn itself ended. The `stopped` value of `TurnResult`, verbatim. */
export type TurnOutcome = 'answered' | 'cap' | 'budget' | 'aborted' | 'error' | 'ask';

/**
 * How a *step* of a turn stopped — the outcomes above, plus the ones that are
 * not an ending at all.
 *
 * `suspended` is deliberately **not** a `TurnOutcome`: `turn_outcome` is the
 * column that says how the turn ended, and a suspended turn has not ended. It
 * has released the runtime and is owed a resume. Keeping the two unions apart
 * is what stops `finish` from ever writing an outcome for a turn that is coming
 * back.
 *
 * `continuable` joins it for the same reason: the execution lease ended on a
 * recoverable failure and the work is owed a new lease on explicit owner
 * continuation. Surfaces deliver its diagnostic text like any answer; the
 * lane never picks it up on its own.
 *
 * Declared here, in `core`, because it had grown **three** literal copies —
 * `TurnResult['stopped']`, `JobOutcome['stopped']` and this file's own
 * `TurnOutcome` — and the design that produced this table named the divergence
 * as this repo's typical defect (`docs/evidence/turno-sospendibile.md` §Domanda 6,
 * row 9). One reference each now; adding an arm reaches every consumer.
 */
export type TurnStopped = TurnOutcome | 'suspended' | 'continuable';

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
export type DeliveryState =
  | 'pending'
  | 'sent'
  | 'possibly_sent'
  | 'undeliverable'
  | `failed:${string}`;

/**
 * Counter ownership across execution leases — the P0-B reset contract.
 *
 * - turn-cumulative (never reset, monotonic): `iterations`. No profile caps
 *   iterations, and cumulative numbering keeps `muffin.chat_call` spans
 *   unambiguous across leases.
 * - lease-local (profile-fresh at every grant): `recoveriesUsed`,
 *   `transportRetriesLeft`, `toolCallsMade`, `nudgedForCompletion`, `usage`,
 *   `spentUsd`, `activeModelMs`. The grant caller builds them; the store
 *   persists them. A new lease that inherited the old lease's spent recovery
 *   budget would start already-exhausted.
 * - derived-lifetime (folded, never written directly): `lifetime.*` — see
 *   the AUTHORITY note on `turn_leases`.
 * - durable-once (preserved verbatim): `contextBuilt`, taint, model,
 *   messages (evidence half), the tool WAL, approvals, replyTo, jobId.
 * - crash/wait budget (untouched by continuation): `resumes`.
 *   `MAX_RESUMES` bounds a resume loop that keeps killing the process
 *   (`spendeIlBudget`: attempts *in the presence of failures*). An
 *   owner-granted continuation is the opposite of a failure — explicit,
 *   authenticated, human-rate-limited — and resetting `resumes` there would
 *   erase crash evidence across continuations, the exact anti-pattern the
 *   suspend path was forbidden (`agent/loop/permissions.ts`). Granted
 *   leases are counted separately, in `lifetime.leases`.
 */
export type TurnCounters = {
  iterations: number;
  recoveriesUsed: number;
  transportRetriesLeft: number;
  /**
   * Accepted `max_tokens` partial continuations in this lease (#615).
   *
   * The spent side of `MAX_TRUNCATION_CONTINUATIONS`: incremented once per
   * accepted prefix chunk, checkpointed with the chunk itself, so a crash
   * between two continuations resumes against the same total instead of
   * resetting it. Reset only by an explicit owner-granted new lease
   * (`buildFreshCounters`), which is human-rate-limited. Read defensively:
   * rows written before this field existed have no value for it.
   */
  truncationsUsed: number;
  toolCallsMade: number;
  nudgedForCompletion: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
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
  /** Cumulative provider-invocation time spent by this turn's execution budget. */
  activeModelMs?: number;
};

/**
 * The closed vocabulary of recoverable lease endings — the only classes that
 * may release a row as `continuable`.
 *
 * A durable carrier of "the lease ended, the work did not", and deliberately
 * not `TurnOutcome`: the outcome column says how the turn ended, and a
 * continuable turn has not ended. Anything not in this union (answered,
 * aborted, denied, spent, refused, non-retryable provider failure, uncertain
 * effect) stays terminal through `finish`.
 */
export type ContinuableClass =
  | 'provider_empty'
  | 'truncated'
  | 'provider_transport'
  | 'model_first_activity_timeout'
  | 'model_stall'
  | 'model_deadline'
  | 'turn_deadline'
  | 'active_model_budget'
  | 'recovery_exhausted';

/** Typed durable evidence carried by a `continuable` row. Never message content, never secrets. */
export type ContinuableReason = {
  class: ContinuableClass;
  /** Which lease ended (0-based). */
  lease: number;
  /** Consecutive failed attempts behind the release, when the class counts them. */
  attempts?: number;
  /** Provider request ids behind the release, for the OpenRouter dashboard. */
  requestIds?: string[];
  /** What the ended lease had completed. */
  completed?: { toolCalls: number };
  at: string;
};

/**
 * One row of a pending ambiguity question's ordered candidate list.
 *
 * Structurally identical to `agent/loop/continuation.ts`'s
 * `ContinuationCandidate`; declared here so the durable home (this store) does
 * not import from the loop. The loop aliases it.
 */
export type StoredContinuationCandidate = { id: string; updatedAt: string; summary: string };

/**
 * Lifetime audit across leases. `counters` (`TurnCounters`) is the CURRENT
 * lease's capacity and work-in-progress; this is what finished leases spent
 * and did.
 *
 * DERIVED, not independently mutable: folded from exactly one closed lease
 * at a time — at `grantContinuation` (previous lease) and at terminal
 * `finish`/`closeRow` (current lease, when it started) — in the same
 * transaction as the `turn_leases` row it summarizes. `recomputeLifetime`
 * re-derives it from those rows; on any inconsistency the rows win.
 *
 * `iterations` is intentionally absent: it stays cumulative on the lease
 * counters (no profile caps iterations, and monotonic numbering keeps
 * `muffin.chat_call` spans unambiguous across leases).
 */
export type LifetimeCounters = {
  /** Finished leases folded in so far. */
  leases: number;
  toolCallsMade: number;
  recoveriesUsed: number;
  transportRetriesUsed: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  spentUsd: number;
  activeModelMs: number;
};

export function zeroLifetime(): LifetimeCounters {
  return {
    leases: 0,
    toolCallsMade: 0,
    recoveriesUsed: 0,
    transportRetriesUsed: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    activeModelMs: 0,
  };
}

/**
 * Fold one closed lease into a lifetime rollup (P0-B authority).
 *
 * The single arithmetic both `grantContinuation` callers and terminal
 * `finish` share: `turns.lifetime` is always this function applied to the
 * previous value plus exactly one closed lease — never an independent
 * computation, so the stored fold and `recomputeLifetime` cannot disagree
 * by construction. (`iterations` stays out on both sides: cumulative on the
 * row, absent from the rollup.)
 */
export function foldLifetime(
  base: LifetimeCounters,
  closed: TurnCounters,
  transportUsed: number,
): LifetimeCounters {
  return {
    leases: base.leases + 1,
    toolCallsMade: base.toolCallsMade + closed.toolCallsMade,
    recoveriesUsed: base.recoveriesUsed + closed.recoveriesUsed,
    transportRetriesUsed: base.transportRetriesUsed + transportUsed,
    usage: {
      inputTokens: base.usage.inputTokens + closed.usage.inputTokens,
      outputTokens: base.usage.outputTokens + closed.usage.outputTokens,
      cacheReadTokens: base.usage.cacheReadTokens + closed.usage.cacheReadTokens,
      cacheWriteTokens: base.usage.cacheWriteTokens + closed.usage.cacheWriteTokens,
    },
    spentUsd: base.spentUsd + closed.spentUsd,
    activeModelMs: base.activeModelMs + (closed.activeModelMs ?? 0),
  };
}

/** Rows written before `lifetime` existed read as "no finished lease yet". */
function toLifetime(raw: string | null): LifetimeCounters {
  const base = zeroLifetime();
  if (raw === null) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<LifetimeCounters>;
    return {
      leases: Number.isFinite(parsed.leases) ? (parsed.leases as number) : 0,
      toolCallsMade: Number.isFinite(parsed.toolCallsMade) ? (parsed.toolCallsMade as number) : 0,
      recoveriesUsed: Number.isFinite(parsed.recoveriesUsed) ? (parsed.recoveriesUsed as number) : 0,
      transportRetriesUsed: Number.isFinite(parsed.transportRetriesUsed) ? (parsed.transportRetriesUsed as number) : 0,
      usage: {
        inputTokens: Number.isFinite(parsed.usage?.inputTokens) ? (parsed.usage?.inputTokens as number) : 0,
        outputTokens: Number.isFinite(parsed.usage?.outputTokens) ? (parsed.usage?.outputTokens as number) : 0,
        cacheReadTokens: Number.isFinite(parsed.usage?.cacheReadTokens) ? (parsed.usage?.cacheReadTokens as number) : 0,
        cacheWriteTokens: Number.isFinite(parsed.usage?.cacheWriteTokens) ? (parsed.usage?.cacheWriteTokens as number) : 0,
      },
      spentUsd: Number.isFinite(parsed.spentUsd) ? (parsed.spentUsd as number) : 0,
      activeModelMs: Number.isFinite(parsed.activeModelMs) ? Math.max(0, parsed.activeModelMs as number) : 0,
    };
  } catch {
    return base;
  }
}

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
    truncationsUsed: Number.isFinite(parsed.truncationsUsed) ? (parsed.truncationsUsed as number) : 0,
    resumes: Number.isFinite(parsed.resumes) ? parsed.resumes : 0,
    contextBuilt: parsed.contextBuilt === true,
    ...(Number.isFinite(parsed.activeModelMs) ? { activeModelMs: Math.max(0, parsed.activeModelMs as number) } : {}),
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
  /**
   * Il job schedulato di cui questo turno è un'occorrenza, o `null`.
   *
   * Sta **sulla riga** e non solo nel `TurnInput`, e la ragione è misurata:
   * `drive` non riceve il `TurnInput` originale — lo *ricostruisce* dal record
   * (`agent/loop.ts`, `guidaIlTurno`), quindi qualunque cosa passata solo a
   * `runTurn` sparisce fra le due funzioni senza un errore. È già successo per
   * le immagini e per l'audio; qui sarebbe sparita l'attribuzione della spesa,
   * e un tetto per-job che legge un contatore fermo a zero è un tetto che non
   * scatta mai.
   *
   * Ed è anche ciò che la fa sopravvivere a una ripresa: un turno di job che
   * si sospende su `wait` viene ripreso dalla lane in un altro processo, e la
   * spesa di quella metà deve contare per lo stesso job.
   */
  jobId: string | null;
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
  /**
   * Which execution lease this row is on (0-based; the first lease is 0).
   * A new lease is minted only by `grantContinuation`, never by a crash
   * resume — `resumes` keeps counting those, this counts owner-granted ones.
   */
  leaseIndex: number;
  /** Typed reason while `status` is `continuable`; `null` otherwise. */
  continuableReason: ContinuableReason | null;
  /** What finished leases spent and did — folded at grant and at terminal finish, never reset. */
  lifetime: LifetimeCounters;
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
   * Turns whose lease ended recoverably and nobody continued yet (P0-B).
   * Unwindowed like `waiting`: a continuable row is owed work, however old —
   * the resolver's own TTL decides eligibility, not this inventory.
   */
  continuable: { count: number; oldest: string | null };
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

/** One finished execution lease, as `turn_leases` reads back. */
export type LeaseAuditRow = {
  turnId: string;
  leaseIndex: number;
  startedAt: string;
  endedAt: string | null;
  /** ContinuableClass while the turn went continuable, TurnOutcome on terminal finish. */
  outcome: string | null;
  /** Harness control archived off the live transcript at grant time. */
  harnessMessages: Message[];
  /** Counters as the lease left them. */
  counters: TurnCounters | null;
  /** Transport retries this lease spent. */
  transportUsed: number | null;
  /** Transport allowance the lease started with (from the live counters at open). */
  transportAllowance: number | null;
  delivery: DeliveryState | null;
};

/**
 * Same speaker, by identity fields rather than JSON bytes: `owner` by
 * connector+external id, `member` additionally by tenant, `system` by source.
 * Key order in the stored JSON must never split one speaker in two.
 */
function sameSpeaker(a: Principal, b: Principal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'owner' && b.kind === 'owner') return a.connector === b.connector && a.externalId === b.externalId;
  if (a.kind === 'member' && b.kind === 'member')
    return a.connector === b.connector && a.externalId === b.externalId && a.tenantId === b.tenantId;
  return a.kind === 'system' && b.kind === 'system' && a.source === b.source;
}

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

/**
 * Il valore di `model` per un giro di job che si è fermato sul proprio tetto.
 *
 * Stessa famiglia di `SCRIPT_MODEL` e stessa ragione: la riga in `turns` esiste
 * — è ciò che rende il rifiuto durevole e leggibile invece che un messaggio
 * volato via — ma **il modello non l'ha mai vista**, quindi non c'è nessuna
 * inferenza da riprendere. Un discriminante nominato e non una stringa sparsa,
 * perché `agent/loop.ts` lo legge per rifiutarsi di riprendere col modello un
 * turno nato proprio dal non volerlo chiamare: riprenderlo significherebbe
 * spendere esattamente i soldi che il tetto ha appena rifiutato di spendere.
 */
export const CAPPED_MODEL = '(tetto per-job: nessun modello)';

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
  /** See `TurnRecord.jobId`. Absent on every turn that is not a job's fire. */
  jobId?: string | undefined;
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
  -- Il job di cui questo turno è un'occorrenza; NULL per ogni turno
  -- interattivo, che è la maggioranza. Additiva e nullable: nessuna riga già
  -- scritta acquisisce un'appartenenza che non aveva.
  job_id        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('runnable','running','waiting','interrupted','done','continuable')),
  wake_at       TEXT,
  wait_for      TEXT,
  claimed_by    INTEGER,
  claimed_at    TEXT,
  claim_token   TEXT,
  turn_outcome  TEXT,
  delivery      TEXT,
  -- P0-B: which execution lease the row is on (0-based). Additive with a
  -- zero default: every row written before leases existed is on lease 0.
  lease_index   INTEGER NOT NULL DEFAULT 0,
  -- P0-B: typed durable reason while status is 'continuable', else NULL.
  -- Additive and nullable: terminal history carries no lease evidence.
  continuable_reason TEXT,
  -- P0-B: lifetime audit across finished leases (JSON). Additive and
  -- nullable: old rows read as "no finished lease yet" (see toLifetime).
  lifetime      TEXT,
  -- The ordered candidate ids an ambiguity question offered, written on the
  -- question turn by askWhichContinuation. Additive and nullable; a
  -- continuation needs it only while it is still the newest question in the
  -- session. Durable on purpose: the in-RAM map it replaces lost the mapping
  -- on every gateway restart, so typing the number became ordinary
  -- conversation (2026-09-25).
  continuation_candidates TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_turns_due ON turns(status, wake_at);
-- P0-B: one audit row per finished execution lease. The turns row carries the
-- live lease; this table carries what ended leases spent, said as harness
-- control, and how they ended — so a continuation can strip lease-local
-- control from the live transcript without destroying evidence, and so
-- cumulative audit survives the counter reset a new lease requires.
--
-- AUTHORITY (with turns.lifetime): these rows are the source of truth for
-- per-lease detail; lifetime is their derived fold (same transaction,
-- never an independent write). On any inconsistency these rows win:
-- recomputeLifetime re-derives the fold from them. Every terminal finish
-- of a started lease and every grant closes exactly one row here.
--
-- Additive (CREATE TABLE IF NOT EXISTS): zero migration cost by construction.
CREATE TABLE IF NOT EXISTS turn_leases (
  turn_id     TEXT NOT NULL,
  lease_index INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  -- Terminal class of the ended lease: a ContinuableClass while the turn
  -- went continuable, a TurnOutcome when it finished outright.
  outcome     TEXT,
  -- Harness control messages archived off the live transcript at grant time
  -- (JSON array of Message). Evidence stays on the turns row; this keeps the
  -- directives that must not govern the next lease.
  harness_messages TEXT,
  -- Counters as the lease left them (JSON TurnCounters).
  counters    TEXT,
  -- Transport retries this lease spent. Derived at close time as
  -- allowance-minus-left, where the allowance is the persisted
  -- transport_allowance below — never re-derived from profile constants.
  -- NULL when the lease predates audit rows (backfilled close with no open
  -- row); the fold treats NULL as 0 rather than inventing a number.
  transport_used INTEGER,
  -- The allowance this lease started with (from the live counters at open:
  -- fresh rows and granted leases alike). The close needs it because only
  -- the remainder is observable at close time.
  transport_allowance INTEGER,
  -- Delivery state as the lease left it: the diagnostic went out under this
  -- lease even when the final answer goes out under a later one.
  delivery    TEXT,
  PRIMARY KEY (turn_id, lease_index)
);
CREATE INDEX IF NOT EXISTS idx_turn_leases_turn ON turn_leases(turn_id, lease_index);
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
  -- D15, il registro degli effetti. Quattro colonne su questa tabella e non
  -- un secondo store: ogni chiamata ne scrive gia' una riga, e un registro
  -- degli effetti tenuto altrove sarebbe libero di dire una cosa mentre
  -- questa ne dice un'altra -- la cucitura che docs/development/JUDGE.md chiama per nome,
  -- e che taintOrigin ha gia' rifiutato per il taint.
  --
  --  * effect_row   la riga della matrice (CapabilityDecl.effect) che ha
  --                 deciso il soffitto: e' *questa* che ha ammesso la
  --                 chiamata, non la classe di rischio (ADR-0053/0074).
  --  * reversible   la classe di reversibilita' dichiarata dalla capability.
  --  * resource     su cosa: il percorso/URL che il kernel ha giudicato, non
  --                 il digest degli argomenti -- args_digest confronta due
  --                 chiamate, non racconta nessuna delle due.
  --  * decision     allow | draft | ask: cio' che e' passato **senza domanda**
  --                 sono le prime due, ed e' la distinzione per cui D15
  --                 esiste. La tabella approvals registra solo cio' che e'
  --                 stato chiesto, quindi da sola non sa nominare il resto.
  --
  -- Additive come undone_at (ensureColumn sotto), quindi un database gia'
  -- popolato le acquisisce vuote: le righe scritte prima di questa versione
  -- restano leggibili e si dichiarano "non registrato" invece di fingere.
  effect_row  TEXT,
  reversible  TEXT,
  resource    TEXT,
  decision    TEXT,
  PRIMARY KEY (turn_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_tool_calls_open ON turn_tool_calls(turn_id, ended_at);
-- La lettura per giornata di D15 (readEffects) filtra su started_at; senza
-- indice sarebbe una scansione dell'intera tabella a ogni domanda dell'owner.
CREATE INDEX IF NOT EXISTS idx_turn_tool_calls_started ON turn_tool_calls(started_at);
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
  job_id: string | null;
  status: string;
  wake_at: string | null;
  wait_for: string | null;
  claimed_by: number | null;
  claimed_at: string | null;
  claim_token: string | null;
  turn_outcome: string | null;
  delivery: string | null;
  lease_index: number | null;
  continuable_reason: string | null;
  lifetime: string | null;
  created_at: string;
  updated_at: string;
};

function toRecord(row: Row): TurnRecord {
  let continuableReason: ContinuableReason | null = null;
  if (row.continuable_reason !== null) {
    try {
      continuableReason = JSON.parse(row.continuable_reason) as ContinuableReason;
    } catch {
      continuableReason = null;
    }
  }
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
    jobId: row.job_id ?? null,
    status: row.status as TurnStatus,
    wakeAt: row.wake_at,
    waitFor: row.wait_for,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    claimToken: row.claim_token,
    outcome: row.turn_outcome as TurnOutcome | null,
    delivery: row.delivery as DeliveryState | null,
    leaseIndex: Number.isFinite(row.lease_index) ? (row.lease_index as number) : 0,
    continuableReason,
    lifetime: toLifetime(row.lifetime),
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
  return createHash('sha256')
    .update(JSON.stringify(args ?? null))
    .digest('hex')
    .slice(0, 16);
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

/**
 * The sixth status, arriving late, on databases that already have rows.
 *
 * `status` carries a `CHECK`, and SQLite cannot alter one — so a value added
 * after day one costs a table rebuild. Exactly one transaction, columns
 * explicit on both sides, new columns defaulted (`lease_index` 0,
 * `continuable_reason`/`lifetime` NULL, which read as "first lease, no
 * finished lease yet"). Old statuses are a subset of the new CHECK, so no row
 * can fail the copy.
 *
 * Runs in the constructor like `ensureColumn`, and for the same reason: every
 * opener (gateway, REPL, `doctor`'s read-only handle) must see the same
 * table. A concurrent opener mid-copy hits `DROP TABLE IF EXISTS turns_new`
 * + transactional DDL; a lock failure re-reads, and only rethrows when the
 * table still lacks the value — so the loser of a boot race either proceeds
 * on the migrated table or fails loudly, never on a half copy.
 */
function migrateContinuable(db: Database.Database): void {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'`).get() as
    | { sql: string }
    | undefined;
  if (table === undefined || table.sql.includes("'continuable'")) return;
  const start = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS turns (');
  const end = SCHEMA.indexOf(');', start);
  if (start < 0 || end < 0) throw new Error('migrateContinuable: turns schema not found');
  const createNew = `${SCHEMA.slice(start, end)});`.replace(
    'CREATE TABLE IF NOT EXISTS turns (',
    'CREATE TABLE turns_new (',
  );
  const columns =
    'id, principal, tenant, surface, session_id, model, messages, taint, counters, ' +
    'reply_to, job_id, status, wake_at, wait_for, claimed_by, claimed_at, claim_token, ' +
    'turn_outcome, delivery, created_at, updated_at';
  const migrate = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS turns_new');
    db.exec(createNew);
    db.exec(
      `INSERT INTO turns_new (${columns}, lease_index, continuable_reason, lifetime) ` +
        `SELECT ${columns}, 0, NULL, NULL FROM turns`,
    );
    db.exec('DROP TABLE turns');
    db.exec('ALTER TABLE turns_new RENAME TO turns');
    db.exec('CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status, updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_turns_due ON turns(status, wake_at)');
  });
  try {
    migrate();
  } catch (error) {
    const again = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'`).get() as
      | { sql: string }
      | undefined;
    if (again !== undefined && again.sql.includes("'continuable'")) return;
    throw error;
  }
}

export class TurnStore {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly checkpointStmt: Database.Statement;
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
  private readonly reassignUnstartedModelStmt: Database.Statement;
  private readonly suspendStmt: Database.Statement;
  private readonly dueStmt: Database.Statement;
  private readonly armedStmt: Database.Statement;
  private readonly wakeStmt: Database.Statement;
  private readonly suspendedCountStmt: Database.Statement;
  private readonly outcomesStmt: Database.Statement;
  private readonly undeliverableCountStmt: Database.Statement;
  private readonly markUndoneStmt: Database.Statement;
  private readonly continuableCountStmt: Database.Statement;
  /**
   * P0-B statements, prepared lazily on first use rather than in the
   * constructor: they name `turn_leases` and the new `turns` columns, which
   * do not exist on a pre-migration database — and a genuinely read-only
   * handle (`{ readOnly: true }`, e.g. `doctor`) must open such a database
   * without tripping over a `prepare` that throws on a missing table. Any
   * caller that reaches these on a handle that cannot see them fails loudly
   * here instead of halfway through a write.
   */
  private leaseAreaCache?: {
    finish: Database.Statement;
    release: Database.Statement;
    grant: Database.Statement;
    open: Database.Statement;
    openRow: Database.Statement;
    close: Database.Statement;
    leases: Database.Statement;
    continuable: Database.Statement;
    setCandidates: Database.Statement;
    latestQuestion: Database.Statement;
  };

  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
    /** Injected so a test can exercise dead, live and reused holders. */
    private readonly alive: (pid: number) => boolean = pidAlive,
    /**
     * P0-B migration boundary: genuinely read-only consumers (`doctor`, boot
     * probes) must never trigger a write migration as a side effect of
     * looking. With `readOnly`, the constructor prepares statements but runs
     * no `exec`, no `ensureColumn`, no rebuild — reads tolerate old schemas
     * (`toRecord`/`toLifetime` default every additive field). Writers keep
     * the default: open, migrate, then work.
     */
    options: { readOnly?: boolean } = {},
  ) {
    // Read-only handles prepare statements below but run no schema write:
    // no exec, no ensureColumn, no rebuild (see the option's docstring).
    if (options.readOnly !== true) {
      db.exec(SCHEMA);
    // Additive, for a database written before `claim_token` existed — see
    // `ensureColumn`'s own docstring in `core/lock/durable.ts`.
    ensureColumn(db, 'turns', 'claim_token', 'claim_token TEXT');
    // Stessa rete, stessa ragione: `CREATE TABLE IF NOT EXISTS` non aggiunge
    // una colonna a una tabella che esiste già, e `turns` è scritta a ogni
    // turno — non solo dai job.
    ensureColumn(db, 'turns', 'job_id', 'job_id TEXT');
    // Additive, for a database written before D11's undo-realigns-the-turn
    // half existed. See the column's own comment in `SCHEMA` above.
    ensureColumn(db, 'turn_tool_calls', 'undone_at', 'undone_at TEXT');
    // D15: stessa rete, stessa ragione. Vedi il commento delle quattro colonne
    // dentro `SCHEMA` per cosa sono e perche' stanno qui e non altrove.
    ensureColumn(db, 'turn_tool_calls', 'effect_row', 'effect_row TEXT');
    ensureColumn(db, 'turn_tool_calls', 'reversible', 'reversible TEXT');
    ensureColumn(db, 'turn_tool_calls', 'resource', 'resource TEXT');
    ensureColumn(db, 'turn_tool_calls', 'decision', 'decision TEXT');
    // P0-B, additive columns first (an old table may predate even these),
    // then the status rebuild, which copies every column by name.
    ensureColumn(db, 'turns', 'lease_index', 'lease_index INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'turns', 'continuable_reason', 'continuable_reason TEXT');
    ensureColumn(db, 'turns', 'lifetime', 'lifetime TEXT');
    // The ambiguity question's candidate list (see the column's own comment).
    // Additive for the same reason: an installation written before this
    // feature simply has no pending question.
    ensureColumn(db, 'turns', 'continuation_candidates', 'continuation_candidates TEXT');
    ensureColumn(db, 'turn_leases', 'transport_allowance', 'transport_allowance INTEGER');
    migrateContinuable(db);
    }
    // `CREATE INDEX IF NOT EXISTS` in `SCHEMA` non basta per un database che
    // ha gia' la tabella e non la colonna: l'indice sopra nomina `started_at`,
    // che esiste da sempre, quindi qui non serve un secondo `ensureIndex`.
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
                          reply_to, job_id, status, claimed_by, claimed_at, claim_token, delivery, created_at, updated_at)
       VALUES (@id, @principal, @tenant, @surface, @sessionId, @model, @messages, @taint, @counters,
               @replyTo, @jobId, @status, @pid, @claimedAt, @claimToken, @delivery, @now, @now)`,
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
    // (Prepared in `leaseArea`, not here: it names the `lifetime` column.)
    this.deliveryStmt = db.prepare(
      `UPDATE turns SET delivery = @delivery, updated_at = @now WHERE id = @id`,
    );
    this.intentStmt = db.prepare(
      `INSERT INTO turn_tool_calls (turn_id, call_id, tool, capability, rerunnable, args_digest, started_at,
                                    effect_row, reversible, resource, decision)
       VALUES (@turnId, @callId, @tool, @capability, @rerunnable, @digest, @now,
               @effectRow, @reversible, @resource, @decision)
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
    // A queued turn that has never built context has no model-produced state
    // to pin. Let the newly selected main model own it, but only while it is
    // still runnable and untouched; a competing claim or a started turn wins.
    this.reassignUnstartedModelStmt = db.prepare(
      `UPDATE turns SET model = @nextModel, updated_at = @now
       WHERE id = @id AND model = @expectedModel AND status = 'runnable'
         AND json_extract(counters, '$.contextBuilt') = 0`,
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
    this.undeliverableCountStmt = db.prepare(
      `SELECT count(*) AS n FROM turns WHERE delivery = 'undeliverable'`,
    );
    // Guarded on `ended_at IS NOT NULL`: a call still open has no outcome to
    // mislabel yet, and `muffin undo` only ever names calls that finished
    // (the journal only records a snapshot for a capability that ran).
    this.markUndoneStmt = db.prepare(
      `UPDATE turn_tool_calls SET undone_at = @now
       WHERE turn_id = @turnId AND call_id = @callId AND ended_at IS NOT NULL`,
    );
    this.continuableCountStmt = db.prepare(
      `SELECT count(*) AS n, min(updated_at) AS oldest FROM turns WHERE status = 'continuable'`,
    );
  }

  /**
   * The P0-B statement group — see the field's own docstring for why this is
   * lazy rather than constructed.
   */
  private leaseArea(): {
    finish: Database.Statement;
    release: Database.Statement;
    grant: Database.Statement;
    open: Database.Statement;
    openRow: Database.Statement;
    close: Database.Statement;
    leases: Database.Statement;
    continuable: Database.Statement;
    setCandidates: Database.Statement;
    latestQuestion: Database.Statement;
  } {
    const hit = this.leaseAreaCache;
    if (hit !== undefined) return hit;
    const db = this.db;
    const built = {
      /**
       * The terminal write (see `finish`): sets `lifetime` alongside the
       * outcome because a terminal finish folds the current lease in the
       * same transaction. Lives in this lazy group — not the constructor —
       * because it names the `lifetime` column, which a pre-migration table
       * does not have; a read-only handle on such a table must still open.
       */
      finish: db.prepare(
        `UPDATE turns SET status = 'done', turn_outcome = @outcome, messages = @messages, taint = @taint,
                          counters = @counters, lifetime = @lifetime, claimed_by = NULL, claim_token = NULL, updated_at = @now
         WHERE id = @id AND claim_token = @claimToken`,
      ),
      /**
       * The write that ends a lease without ending the work (P0-B).
       *
       * Same fencing as `finish`/`suspend`, same claim release, one deliberate
       * difference: the row becomes `continuable` with a typed reason instead
       * of `done` with an outcome. Guarded on `running` so a `waiting` row
       * (barrier still pending) can never slide here, and a `done` row never
       * comes back. Folds the ended lease into `lifetime` in the same write
       * (see `releaseContinuable`).
       */
      release: db.prepare(
        `UPDATE turns SET status = 'continuable', turn_outcome = NULL, continuable_reason = @reason,
                          messages = @messages, taint = @taint, counters = @counters, lifetime = @lifetime,
                          claimed_by = NULL, claim_token = NULL, updated_at = @now
         WHERE id = @id AND status = 'running' AND claim_token = @claimToken`,
      ),
      /**
       * The claim half of `grantContinuation`, as one statement: only a
       * `continuable` row can be taken, and taking it clears the reason (the
       * row is work-in-progress again, not owed work). The full grant wraps
       * this with the counters reset and the lease-audit writes in one
       * transaction — see `grantContinuation`.
       */
      grant: db.prepare(
        `UPDATE turns SET status = 'running', claimed_by = @pid, claimed_at = @now, claim_token = @token,
                          messages = @messages, taint = @taint, counters = @counters,
                          lease_index = @leaseIndex, continuable_reason = NULL,
                          updated_at = @now
         WHERE id = @id AND status = 'continuable'`,
      ),
      open: db.prepare(
        `INSERT OR IGNORE INTO turn_leases (turn_id, lease_index, started_at, transport_allowance) VALUES (@turnId, @leaseIndex, @now, @allowance)`,
      ),
      /** The open row a close needs: when the lease started, and with what transport allowance. */
      openRow: db.prepare(
        `SELECT started_at AS startedAt, transport_allowance AS allowance FROM turn_leases WHERE turn_id = ? AND lease_index = ?`,
      ),
      /**
       * Close (or backfill) one lease audit row. `INSERT ... ON CONFLICT DO
       * UPDATE` because the opener and the closer are different moments: a
       * grant opens the new lease, the next grant or the terminal finish
       * closes it — and lease 0, which no grant ever opened, is backfilled by
       * its first close with `started_at` falling back to the row's birth.
       */
      close: db.prepare(
        `INSERT INTO turn_leases (turn_id, lease_index, started_at, ended_at, outcome, harness_messages, counters, transport_used, delivery)
         VALUES (@turnId, @leaseIndex, @startedAt, @now, @outcome, @harness, @counters, @transportUsed, @delivery)
         ON CONFLICT(turn_id, lease_index) DO UPDATE SET
           ended_at = excluded.ended_at, outcome = excluded.outcome,
           harness_messages = excluded.harness_messages, counters = excluded.counters,
           transport_used = excluded.transport_used, delivery = excluded.delivery`,
      ),
      started: db.prepare(
        `SELECT started_at AS startedAt FROM turn_leases WHERE turn_id = ? AND lease_index = ?`,
      ),
      /** Eligible continuable rows for one conversation, newest first. Principal matched in JS. */
      continuable: db.prepare(
        `SELECT id, principal, updated_at, continuable_reason FROM turns
         WHERE status = 'continuable' AND session_id = @session AND updated_at >= @since
         ORDER BY updated_at DESC`,
      ),
      leases: db.prepare(
        `SELECT turn_id AS turnId, lease_index AS leaseIndex, started_at AS startedAt, ended_at AS endedAt,
                outcome, harness_messages AS harnessMessages, counters, transport_used AS transportUsed,
                transport_allowance AS transportAllowance, delivery
         FROM turn_leases WHERE turn_id = ? ORDER BY lease_index`,
      ),
      /** The ambiguity question's candidate list — see `setContinuationCandidates`. */
      setCandidates: db.prepare(`UPDATE turns SET continuation_candidates = @json WHERE id = @id`),
      /**
       * The newest ambiguity question still in force for one conversation.
       * `created_at` is the question's birth, not `updated_at`: a later
       * `recover`/delivery touch must not extend its TTL.
       */
      latestQuestion: db.prepare(
        `SELECT id, continuation_candidates AS candidates FROM turns
         WHERE session_id = @session AND continuation_candidates IS NOT NULL AND created_at >= @since
         ORDER BY created_at DESC LIMIT 1`,
      ),
    };
    this.leaseAreaCache = built;
    return built;
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
    const tx = this.db.transaction(() => {
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
        // `?? null` esplicito: better-sqlite3 rifiuta un parametro nominato
        // assente dall'oggetto, e `undefined` non è un valore che sa legare.
        jobId: spec.jobId ?? null,
        // The address and the delivery state travel together: a turn nobody has
        // to deliver to has no delivery that can fail.
        delivery: spec.replyTo === undefined ? null : 'pending',
        status,
        pid,
        claimedAt: pid === null ? null : now,
        claimToken: token,
        now,
      });
      // Lease 0 opens with the row: the close needs the start allowance, and
      // only the remainder is observable at close time — so the allowance is
      // recorded here, from these exact counters, never re-derived later.
      this.leaseArea().open.run({
        turnId: spec.id,
        leaseIndex: 0,
        now,
        allowance: spec.counters.transportRetriesLeft,
      });
    });
    tx();
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

  /** Rebind only a queued row that has never entered the model context. */
  reassignUnstartedModel(id: string, expectedModel: string, nextModel: string): boolean {
    if (expectedModel === nextModel) return true;
    return (
      this.reassignUnstartedModelStmt.run({
        id,
        expectedModel,
        nextModel,
        now: this.clock().toISOString(),
      }).changes === 1
    );
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

  /** Rows the lane may pick up now: enqueued, expired, or left by a dead process.
   *
   * `continuable` is deliberately absent: no automatic pickup, ever — only an
   * explicit owner continuation mints the next lease (`grantContinuation`).
   */
  due(now: Date = this.clock(), limit = 20): TurnRecord[] {
    return (this.dueStmt.all({ now: now.toISOString(), limit }) as Row[]).map(toRecord);
  }

  /**
   * End the execution lease, keep the work (P0-B).
   *
   * One transaction does four things, because a finished lease must never
   * exist in only some of them: transition running→continuable with the
   * typed reason, close the current lease audit row (outcome = the release
   * class, harness control archived off the live transcript), fold the ended
   * lease into `lifetime` via the shared `foldLifetime`, and release the
   * claim. A turn that stays continuable forever still has its finished
   * lease in the declared source of truth — `turn_leases` — with `lifetime`
   * matching `recomputeLifetime` from that moment on.
   *
   * The fold is derived inside, from the persisted previous lifetime plus
   * the exact counters archived here: callers supply no lifetime and no
   * previous-lease summary, so no API shape can land mismatched counters
   * and lifetime for one transition. Transport spent is allowance-minus-left
   * against the persisted open row (NULL when the lease predates audit
   * rows — the fold treats it as 0 rather than inventing a number).
   *
   * Guarded on `running`, so a `waiting` row (barrier still pending) can
   * never slide here, and a `done` row never comes back.
   */
  releaseContinuable(
    id: string,
    patch: { messages: Message[]; taint: TrustTier; counters: TurnCounters; reason: ContinuableReason },
    claimToken: string | null,
  ): boolean {
    const at = this.clock().toISOString();
    let landed = 0;
    const tx = this.db.transaction(() => {
      const before = this.getStmt.get(id) as Row | undefined;
      if (before === undefined) return;
      const leaseIndex = Number.isFinite(before.lease_index) ? (before.lease_index as number) : 0;
      const open = this.leaseArea().openRow.get(id, leaseIndex) as
        | { startedAt: string; allowance: number | null }
        | undefined;
      const startedAt = open?.startedAt ?? before.created_at;
      const used = open?.allowance == null ? null : Math.max(0, open.allowance - patch.counters.transportRetriesLeft);
      const lifetime = JSON.stringify(foldLifetime(toLifetime(before.lifetime), patch.counters, used ?? 0));
      const r = this.leaseArea().release.run({
        id,
        reason: JSON.stringify(patch.reason),
        messages: serializzaMessaggi(patch.messages),
        taint: patch.taint,
        counters: JSON.stringify(patch.counters),
        lifetime,
        claimToken,
        now: at,
      });
      landed = r.changes;
      if (r.changes !== 1) return;
      this.leaseArea().close.run({
        turnId: id,
        leaseIndex,
        startedAt,
        now: at,
        outcome: patch.reason.class,
        harness: redactText(JSON.stringify(patch.messages.filter((m) => m.origin === 'harness'))),
        counters: JSON.stringify(patch.counters),
        transportUsed: used,
        delivery: before.delivery,
      });
    });
    tx();
    return landed === 1;
  }

  /**
   * Mint the next execution lease on an explicit owner continuation (P0-B).
   *
   * One transaction claims the row (continuable→running, reason cleared) and
   * opens the new lease audit row with the fresh transport allowance. It
   * deliberately does NOT close the previous lease and does NOT touch
   * `lifetime`: the previous lease was already closed and folded at release
   * time, so a grant that also folded would count it twice. The caller
   * (`agent/loop/continuation.ts`) owns the reset contract — fresh
   * lease-local counters, evidence filtered, owner message appended — and
   * this method persists that decision; it derives nothing. Returns `null`
   * when another process won the race, so two processes can never hold the
   * same continuation.
   */
  grantContinuation(
    id: string,
    patch: {
      messages: Message[];
      taint: TrustTier;
      counters: TurnCounters;
      newLeaseStartedAt: string;
    },
    pid: number = process.pid,
  ): TurnRecord | null {
    const at = this.clock().toISOString();
    const token = randomUUID();
    let record: TurnRecord | null = null;
    const tx = this.db.transaction(() => {
      const before = this.getStmt.get(id) as Row | undefined;
      if (before === undefined || before.status !== 'continuable') return;
      const leaseIndex = (Number.isFinite(before.lease_index) ? (before.lease_index as number) : 0) + 1;
      const r = this.leaseArea().grant.run({
        id,
        pid,
        token,
        now: at,
        messages: serializzaMessaggi(patch.messages),
        taint: patch.taint,
        counters: JSON.stringify(patch.counters),
        leaseIndex,
      });
      if (r.changes !== 1) return;
      this.leaseArea().open.run({
        turnId: id,
        leaseIndex,
        now: patch.newLeaseStartedAt,
        allowance: patch.counters.transportRetriesLeft,
      });
      record = this.get(id);
    });
    tx();
    return record;
  }

  /** Open a lease audit row without closing anything (used only by tests/seeds). */
  openLease(turnId: string, leaseIndex: number, startedAt: string, allowance: number | null): void {
    this.leaseArea().open.run({ turnId, leaseIndex, now: startedAt, allowance });
  }

  /** When a lease audit row started, if it was ever opened. */
  leaseStartedAt(turnId: string, leaseIndex: number): string | null {
    const row = this.leaseArea().openRow.get(turnId, leaseIndex) as
      | { startedAt: string; allowance: number | null }
      | undefined;
    return row?.startedAt ?? null;
  }

  /** Finished-lease audit for one turn, oldest first. */
  leasesFor(turnId: string): LeaseAuditRow[] {
    const rows = this.leaseArea().leases.all(turnId) as {
      turnId: string;
      leaseIndex: number;
      startedAt: string;
      endedAt: string | null;
      outcome: string | null;
      harnessMessages: string | null;
      counters: string | null;
      transportUsed: number | null;
      transportAllowance: number | null;
      delivery: string | null;
    }[];
    return rows.map((r) => ({
      turnId: r.turnId,
      leaseIndex: r.leaseIndex,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      outcome: r.outcome,
      harnessMessages: r.harnessMessages === null ? [] : (JSON.parse(r.harnessMessages) as Message[]),
      counters: r.counters === null ? null : (JSON.parse(r.counters) as TurnCounters),
      transportUsed: r.transportUsed,
      transportAllowance: r.transportAllowance,
      delivery: r.delivery as DeliveryState | null,
    }));
  }

  /**
   * Re-derive the lifetime fold from the lease audit rows (P0-B authority
   * proof).
   *
   * `turns.lifetime` is a derived cache, not a second truth: this function
   * recomputes exactly what `grantContinuation` and terminal `finish` fold
   * in, from the same rows. Tests assert stored equals recomputed after
   * every lifecycle; on any inconsistency these rows win and this function
   * is the repair.
   */
  recomputeLifetime(turnId: string): LifetimeCounters {
    const folded = zeroLifetime();
    for (const lease of this.leasesFor(turnId)) {
      if (lease.endedAt === null) continue;
      folded.leases += 1;
      folded.toolCallsMade += lease.counters?.toolCallsMade ?? 0;
      folded.recoveriesUsed += lease.counters?.recoveriesUsed ?? 0;
      folded.transportRetriesUsed += lease.transportUsed ?? 0;
      folded.usage.inputTokens += lease.counters?.usage.inputTokens ?? 0;
      folded.usage.outputTokens += lease.counters?.usage.outputTokens ?? 0;
      folded.usage.cacheReadTokens += lease.counters?.usage.cacheReadTokens ?? 0;
      folded.usage.cacheWriteTokens += lease.counters?.usage.cacheWriteTokens ?? 0;
      folded.spentUsd += lease.counters?.spentUsd ?? 0;
      folded.activeModelMs += lease.counters?.activeModelMs ?? 0;
    }
    return folded;
  }

  /**
   * Eligible continuable rows for one conversation, newest first (P0-B).
   *
   * The conversational resolver (`agent/loop/continuation.ts`) decides on
   * these; the principal is matched in JS on identity fields rather than raw
   * JSON equality, so key order can never split one speaker in two.
   */
  continuableFor(
    sessionId: string,
    principal: Principal,
    since: string,
  ): { id: string; updatedAt: string; reason: ContinuableReason | null }[] {
    const rows = this.leaseArea().continuable.all({ session: sessionId, since }) as {
      id: string;
      principal: string;
      updated_at: string;
      continuable_reason: string | null;
    }[];
    const out: { id: string; updatedAt: string; reason: ContinuableReason | null }[] = [];
    for (const row of rows) {
      let stored: Principal;
      try {
        stored = JSON.parse(row.principal) as Principal;
      } catch {
        continue;
      }
      if (!sameSpeaker(stored, principal)) continue;
      let reason: ContinuableReason | null = null;
      if (row.continuable_reason !== null) {
        try {
          reason = JSON.parse(row.continuable_reason) as ContinuableReason;
        } catch {
          reason = null;
        }
      }
      out.push({ id: row.id, updatedAt: row.updated_at, reason });
    }
    return out;
  }

  /**
   * Persist the ordered candidates an ambiguity question offered.
   *
   * Written on the *question* turn (the one `askWhichContinuation` creates and
   * finishes immediately), never on the continuable work: the question is
   * transient UI state, and a later `riprendi` simply writes a newer question
   * that shadows this one by `created_at`.
   *
   * Durable on purpose. The RAM map this replaces (`pendingBySession`) made
   * "reply with the number" fail whenever the gateway restarted between the
   * question and the answer, and the owner restarts his often.
   */
  setContinuationCandidates(turnId: string, candidates: readonly StoredContinuationCandidate[]): void {
    this.leaseArea().setCandidates.run({ id: turnId, json: JSON.stringify(candidates) });
  }

  /**
   * The newest ambiguity question still within `since` for one conversation,
   * with its frozen candidate list, or `null` when none is in force.
   *
   * Re-read from the database at answer time, so the mapping survives a restart
   * (or a second process over the same home) and cannot drift with the live
   * `continuableFor` set between question and answer.
   */
  latestContinuationQuestion(
    sessionId: string,
    since: string,
  ): { id: string; candidates: StoredContinuationCandidate[] } | null {
    const row = this.leaseArea().latestQuestion.get({ session: sessionId, since }) as
      | { id: string; candidates: string }
      | undefined;
    if (row === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.candidates);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const candidates = parsed.filter(
      (c): c is StoredContinuationCandidate =>
        c !== null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string',
    );
    if (candidates.length === 0) return null;
    return { id: row.id, candidates };
  }

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
  recordedOutcomes(
    turnId: string,
  ): Map<string, { content: string; isError: boolean; tier: TrustTier | null }> {
    const rows = this.outcomesStmt.all(turnId) as {
      callId: string;
      content: string | null;
      isError: number | null;
      tier: number | null;
    }[];
    return new Map(
      rows.map((r) => [
        r.callId,
        {
          content: r.content ?? '',
          isError: r.isError === 1,
          tier: (r.tier as TrustTier | null) ?? null,
        },
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
   * new holder has already recorded. Returns whether the write landed.
   *
   * P0-B: when the finished lease started executing (`contextBuilt`), the
   * same transaction also closes its lease audit row and folds it into
   * `lifetime` — derived inside from the row plus the exact counters
   * archived here, never from caller-supplied summaries. Rows that never
   * ran keep whatever lifetime they have: folding zeros would mint a
   * phantom lease.
   */
  finish(
    id: string,
    end: { outcome: TurnOutcome; messages: Message[]; taint: TrustTier; counters: TurnCounters },
    claimToken: string | null,
  ): boolean {
    const at = this.clock().toISOString();
    let landed = 0;
    const tx = this.db.transaction(() => {
      const before = this.getStmt.get(id) as Row | undefined;
      if (before === undefined) return;
      const started = end.counters.contextBuilt;
      const leaseIndex = Number.isFinite(before.lease_index) ? (before.lease_index as number) : 0;
      const open =
        started === true
          ? (this.leaseArea().openRow.get(id, leaseIndex) as
              | { startedAt: string; allowance: number | null }
              | undefined)
          : undefined;
      const used =
        open?.allowance == null ? null : Math.max(0, open.allowance - end.counters.transportRetriesLeft);
      const lifetime =
        started === true
          ? JSON.stringify(foldLifetime(toLifetime(before.lifetime), end.counters, used ?? 0))
          : (before.lifetime ?? null);
      const r = this.leaseArea().finish.run({
        id,
        outcome: end.outcome,
        messages: serializzaMessaggi(end.messages),
        taint: end.taint,
        counters: JSON.stringify(end.counters),
        lifetime,
        claimToken,
        now: at,
      });
      landed = r.changes;
      if (r.changes !== 1 || started !== true) return;
      this.leaseArea().close.run({
        turnId: id,
        leaseIndex,
        startedAt: open?.startedAt ?? before.created_at,
        now: at,
        outcome: end.outcome,
        harness: redactText(JSON.stringify(end.messages.filter((m) => m.origin === 'harness'))),
        counters: JSON.stringify(end.counters),
        transportUsed: used,
        delivery: before.delivery,
      });
    });
    tx();
    return landed === 1;
  }

  /** The other outcome. Never merged with the one above — see `DeliveryState`. */
  delivered(id: string, delivery: DeliveryState): void {
    this.deliveryStmt.run({ id, delivery, now: this.clock().toISOString() });
  }

  /**
   * "I am about to call this handler." Written before the effect can land.
   *
   * **`effect` è obbligatorio, non opzionale** (D15), e per la stessa ragione
   * per cui `tier` lo è diventato su `endToolCall`: un campo che si può
   * omettere scrive un `NULL` silenzioso, e nessuno se ne accorge finché
   * l'owner non chiede «cosa hai fatto oggi» e riceve una riga che non sa
   * dirlo. Un chiamante che non lo passa non compila.
   *
   * Nullable **dentro**, invece, e la differenza conta: una chiamata la cui
   * capability non è dichiarata (un tool MCP che sparisce fra la
   * registrazione e la chiamata) scrive `null` — «non registrato» — e il
   * lettore lo dice a parole. Ciò che il tipo vieta è dimenticare la domanda,
   * non rispondere «non lo so» quando è la verità.
   */
  startToolCall(
    turnId: string,
    call: {
      callId: string;
      tool: string;
      capability: string;
      rerunnable: boolean;
      args: unknown;
      effect: EffectMetadata;
    },
  ): void {
    this.intentStmt.run({
      turnId,
      callId: call.callId,
      tool: call.tool,
      capability: call.capability,
      rerunnable: call.rerunnable ? 1 : 0,
      digest: argsDigest(call.args),
      now: this.clock().toISOString(),
      effectRow: call.effect.row,
      reversible: call.effect.reversible,
      resource: call.effect.resource,
      decision: call.effect.decision,
    });
  }

  /**
   * Il registro degli effetti (D15), letto dall'unica query che lo sa leggere.
   *
   * Delega a `readEffects` invece di preparare uno statement proprio: la CLI
   * (`muffin effects`) e il tool `sys_effects` devono dare la stessa risposta,
   * e due query sono due risposte che divergono il giorno che una cambia —
   * la stessa regola che `sys_inspect` si è data («legge dalle stesse fonti
   * autorevoli») e che `orientamento-report.ts` già segue.
   */
  effects(filter: EffectsFilter): EffectsReport {
    return readEffects(this.db, filter);
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
   * `git show 451cd916:docs/development/ORCHESTRATION.md`.
   * Every real caller already passes it (`agent/loop.ts`'s success and
   * throw paths both do); a future one that does not now fails `tsc` instead
   * of shipping an underestimated taint.
   */
  endToolCall(
    turnId: string,
    callId: string,
    result: { content: string; isError: boolean; tier: TrustTier },
  ): void {
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
    const candidates = this.staleStmt.all() as {
      id: string;
      pid: number | null;
      takenAt: string | null;
    }[];
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
    return (
      this.undeliveredStmt.all({ since }) as {
        id: string;
        surface: string;
        tenant: string;
        startedAt: string;
        delivery: string;
      }[]
    ).map((r) => ({ ...r, delivery: r.delivery as DeliveryState }));
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
    const since =
      options.windowMs === undefined
        ? ''
        : new Date(now.getTime() - options.windowMs).toISOString();
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
      (r) =>
        r.status === 'interrupted' ||
        heldBy(r, now.getTime(), TURN_STALE_AFTER_MS, this.alive) === null,
    );
    const waiting = this.waitingStmt.get() as { n: number; oldest: string | null };
    const continuable = this.continuableCountStmt.get() as { n: number; oldest: string | null };
    const undeliverable = this.undeliverableCountStmt.get() as { n: number };
    return {
      total,
      // Not windowed, unlike `interrupted`: a crash from last month is old news,
      // but a turn still suspended from last month is a turn still owed — the
      // window would hide exactly the worst case.
      waiting: { count: waiting.n, oldestWakeAt: waiting.oldest },
      // Same reasoning: a lease that ended recoverably last month is still
      // continuable work until the owner says otherwise or the resolver TTL
      // excludes it.
      continuable: { count: continuable.n, oldest: continuable.oldest },
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
 *
 * Read-only by construction: the store is opened with `{ readOnly: true }`,
 * so looking never migrates, backfills, or otherwise writes — on an old
 * database this reports zeros for the new shapes instead of rebuilding the
 * table as a side effect of a diagnosis.
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
  return new TurnStore(db, () => new Date(), pidAlive, { readOnly: true }).health({ windowMs });
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
  return new TurnStore(db, () => new Date(), pidAlive, { readOnly: true }).undelivered({ windowMs });
}

/**
 * How far back a diagnosis looks for an interrupted turn.
 *
 * A day, because that is the horizon on which "something went wrong and I do
 * not know what" is still a live question for the owner. Older crashes stay in
 * the table — nothing is deleted — they simply stop being today's news.
 */
const DOCTOR_WINDOW_MS = 24 * 60 * 60 * 1000;
