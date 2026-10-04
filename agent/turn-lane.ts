import type { LaneEvent, LaneRun } from '../core/turns/lane.js';
import { isSchedulerAutonomous, MAX_AUTONOMOUS_LEASES, type TurnRecord } from '../core/turns/store.js';
import { continueTurn, resumeTurn, type LoopDeps, type ResumeStream } from './loop.js';
import { harnessMessage } from './loop/message-origin.js';
import type { Message } from './providers/types.js';

/**
 * The bridge from a row in `turns` to a real turn, and from a finished turn to
 * the surface that is owed the answer.
 *
 * `core/turns/lane.ts` decides *which* row and *when*; this decides what running
 * one means. The split is the same one `agent/scheduler-run.ts` has against
 * `core/scheduler/scheduler.ts`, and for the same reason: the lane must not
 * learn what a chat id is, and the loop must not learn what a lane is.
 *
 * ## The delivery seam, named (ADR-0047 §Reversibilità)
 *
 * `deliver` is where the second half of B2 attaches — *"un turno lungo torna
 * entro ~500 ms e consegna dopo"*. The address is already durable: the Telegram
 * connector has been writing `replyTo` onto the row since the record slice, with
 * a comment saying it was written for the day the lane delivers instead of the
 * connector. This is that day for a turn the lane resumed; the connector's own
 * in-band send is untouched, because `slice/superfici` is rewriting `Deliver`
 * and two slices editing one send is a merge war rather than a suture.
 *
 * The shape is deliberately **not** `Deliver` (`(channel, text)`): a turn's
 * address is an opaque record, not a channel string, and flattening it here
 * would force every surface to encode its shape into a string that something
 * else has to parse back. When `slice/superfici` lands its typed outcome, the
 * change here is the return type of this one function.
 */

/**
 * Where a resumed turn's answer goes. Throwing means the delivery failed, and
 * the failure is recorded on the row — never merged with how the *turn* ended,
 * which is a second question and never the same one.
 */
export type LaneDeliver = (turn: TurnRecord, text: string) => Promise<void | 'possibly_sent'>;

/**
 * Opens a live sink for a row the lane is about to resume, addressed at its
 * own durable `replyTo` — the wiring
 * `docs/evidence/forma-delle-superfici-2026-09-03.md` §4.3 found missing.
 *
 * Returns `undefined` for a surface with nothing to attach (no connector for
 * `record.surface` came up in this process — a `NO_SURFACE` process, or a
 * turn addressed to a surface this boot never connected). `stop`, when given,
 * is awaited once execution ends, win or lose, exactly the way `runFresh` on
 * each surface already calls `presence.stop()`/`transcript.stop()` in its own
 * `finally` — a resumed turn owes its sink the same close.
 */
export type AttachStream = (record: TurnRecord) => (ResumeStream & { stop?: () => Promise<void> }) | undefined;

/**
 * A surface with nowhere to send. Used by a runtime that has no connector
 * attached: the turn still runs, still records, and the answer is reported as
 * undeliverable rather than silently dropped.
 */
export const NO_SURFACE: LaneDeliver = async (turn) => {
  throw new Error(`nessuna superficie cablata per ${turn.surface}`);
};

/**
 * The per-job spend counter behind an autonomous continuation grant.
 *
 * Read-only by construction: the lane never records spend, it only asks
 * whether the next lease may start. `BudgetEngine` implements both halves;
 * a fake with the same two methods is a valid counter in tests, the same
 * way `JobExec` is for the executor in `agent/scheduler-run.ts`.
 */
export type AutonomousBudget = {
  /** The job's own ceiling, or `null` when the owner set none (or the job is gone). */
  jobCap: (jobId: string) => number | null;
  /** What the job has spent this month — the counter `jobCap` gates. */
  jobMonthUsd: (jobId: string) => number;
};

export function makeLaneRunner(
  deps: LoopDeps,
  deliver: LaneDeliver = NO_SURFACE,
  /**
   * Told when a finished turn had an answer and no address. Handed in rather
   * than logged here, because the lane owns the event stream and this file owns
   * the loop — and a `console.error` in a library is a report nobody can route.
   */
  onUndeliverable: (event: Extract<LaneEvent, { kind: 'undeliverable' }>) => void = () => {},
  /**
   * Absent means what it always meant: a resumed turn produces no live
   * updates, only its final answer at `deliver`. Given, it is asked for a
   * sink *before* `resumeTurn` runs — on the row as it stands right now, not
   * after — because the row is exactly what a connector needs to know which
   * chat, which message, which surface to open a fresh stream against.
   */
  attachStream?: AttachStream,
  /**
   * The spend counter behind autonomous continuation grants (#598 S2), and
   * `undefined` when nobody wired one.
   *
   * Absent means the lane cannot verify a scheduler turn's per-job ceiling,
   * so it does not grant autonomous leases at all — fail closed, in the same
   * direction as `agent/scheduler-run.ts` refusing to start a capped job it
   * cannot meter. Production (`cli/gateway.ts`) wires the real ledger; a
   * lane that only ever resumes owner/interrupted work never notices.
   */
  auto?: AutonomousBudget,
): LaneRun {
  return async (turnId) => {
    const before = deps.turns.get(turnId);
    const stream = before === null ? undefined : attachStream?.(before);
    let outcome: Awaited<ReturnType<typeof resumeTurn>>;
    try {
      if (before !== null && before.status === 'continuable' && isSchedulerAutonomous(before)) {
        return await runAutonomous(
          deps,
          before,
          (record, text) => sendAndRecord(deps, record, text),
          onUndeliverable,
          auto,
          stream,
        );
      }
      outcome = await resumeTurn(deps, turnId, stream);
    } finally {
      // Closed here and not inside `resumeTurn`: the sink is this file's own
      // dependency, and a stream left open past its turn is a message that
      // never gets its last, disciplined edit — the same promise `runFresh`
      // keeps on each surface with its own `finally`.
      try {
        await stream?.stop?.();
      } catch {
        /* the turn's own outcome already stands; a sink failing to close does not change it */
      }
    }
    if ('why' in outcome) {
      /**
       * A refused resume still owes the owner a sentence.
       *
       * `resumeTurn` has already closed the row and written the reason into its
       * transcript, so the turn has not vanished — but a Telegram message that
       * got no answer looks identical to one that is still being worked on. If
       * there is an address, the reason goes there.
       */
      const record = deps.turns.get(turnId);
      if (record?.replyTo != null) await sendAndRecord(deps, record, outcome.detail);
      return { refused: outcome.detail };
    }

    // A suspended turn has not produced anything to deliver, and saying so with
    // an empty message would be worse than saying nothing: the owner would read
    // it as an answer. It comes back on its own.
    if (outcome.stopped === 'suspended') return { stopped: outcome.stopped };

    const record = deps.turns.get(turnId);
    if (record?.replyTo != null && outcome.text !== '') {
      await sendAndRecord(deps, record, outcome.text);
      return { stopped: outcome.stopped };
    }
    /**
     * An answer with nowhere to go is **reported**, not dropped.
     *
     * A row with no address normally means the caller of `runTurn` was holding
     * the text itself — in band, no second step that can fail. But a turn the
     * *lane* finished has no such caller by construction, so here the same
     * absence means the opposite: somebody enqueued or suspended work without
     * saying where the answer goes, and the honest move is to say so rather
     * than to return quietly as if there had been nothing to deliver.
     *
     * D2 (judge round 2): the event alone reached only this process's stderr —
     * `cli/gateway.ts` was the one place that read it, and nothing else did.
     * The row is what survives the process: writing `undeliverable` on it is
     * what lets a restart, `doctor`, or the next boot's health check see that
     * this turn's answer never had anywhere to go, the same way `delivered`
     * already records `sent` and `failed:…`. Wrapped for the same measured
     * reason `sendAndRecord`'s own write is: a bookkeeping write must not turn
     * a turn that already produced its answer into an unhandled rejection.
     */
    if (record !== null && outcome.text !== '') {
      onUndeliverable({ kind: 'undeliverable', turnId, surface: record.surface, text: outcome.text });
      try {
        deps.turns.delivered(turnId, 'undeliverable');
      } catch {
        /* the answer was already produced; a bookkeeping write may not undo that */
      }
    }
    return { stopped: outcome.stopped };
  };

  /**
   * Send, then write how it went — and let neither of the two failures become
   * the other.
   *
   * A send that throws leaves `failed:…` on the row and rethrows nothing: the
   * turn is over and re-running it would repeat its tool calls, which is the
   * duplication the whole record exists to prevent. `Scheduler.run` learned the
   * same thing for jobs — *"a delivery failure does not re-run the job"*.
   *
   * The bookkeeping write is wrapped for the measured reason `recordDelivery` in
   * the Telegram connector is: a write against a database closed under a long
   * turn threw from a floating promise and took the gateway down with it.
   */
  async function sendAndRecord(d: LoopDeps, record: TurnRecord, text: string): Promise<void> {
    try {
      const outcome = await deliver(record, text);
      mark(d, record.id, outcome === 'possibly_sent' ? 'possibly_sent' : 'sent');
    } catch (error) {
      mark(d, record.id, `failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function mark(d: LoopDeps, turnId: string, state: 'sent' | 'possibly_sent' | `failed:${string}`): void {
    try {
      d.turns.delivered(turnId, state);
    } catch {
      /* a bookkeeping write may not undo a delivery that already happened */
    }
  }
}

/**
 * The grant message behind an autonomous lease (#598 S2).
 *
 * Harness-marked (`message-origin.ts`), never owner words: at the next
 * continuation `splitWorkEvidence` keeps it out of the new lease as control
 * (archived in `turn_leases`), and it is never replayed to the model as work
 * evidence. Names the lease so the transcript stays attributable.
 */
function autonomousGrantMessage(record: TurnRecord): Message {
  return harnessMessage('user', [
    {
      type: 'text',
      text:
        `Continuazione autonoma del turno ${record.id.slice(0, 12)} (lease ${record.leaseIndex + 1}, ` +
        `senza nuovo messaggio owner): la lease precedente è finita su una boundary recuperabile ` +
        `(${(record.continuableReason?.class ?? 'motivo ignoto')}). ` +
        `Continua lo stesso lavoro dallo stato durevole, senza ripetere gli effetti già registrati.`,
    },
  ]);
}

/**
 * Continue a scheduler-bound continuable turn without an owner message
 * (#598 S2) — the lane side of the autonomous due-inclusion in
 * `core/turns/store.ts`.
 *
 * Same identity, same WAL, same loop: `continueTurn` mints the next lease
 * (fresh lease-local budgets via `buildFreshCounters`, harness control
 * archived off the transcript) and `drive` replays recorded tool outcomes
 * instead of re-calling them (`reconcile` + the `ON CONFLICT DO NOTHING`
 * intent row in `agent/loop/tool-call.ts`). No new primitive, no second
 * loop: an owner saying "riprendi" takes the identical path with their own
 * words as the grant message.
 *
 * Three gates, all fail-closed, all before the grant:
 *
 * 1. `MAX_AUTONOMOUS_LEASES` — a recurrence that always lands continuable
 *    must not spend for ever; past the count the row stays continuable for
 *    an explicit owner grant.
 * 2. The tenant/monthly budget (`budgetExhausted`) — granting a lease that
 *    could not call the model would burn a lease to immediately finish
 *    `budget`.
 * 3. The job's own ceiling — `jobCap`/`jobMonthUsd` re-checked per lease, the
 *    same "do not start" shape `agent/scheduler-run.ts` enforces at fire
 *    time. Unverifiable (no reader wired) means no grant.
 *
 * Iteration and tool-call ceilings bind inside the lease exactly as on any
 * other: profile `maxToolCallsPerTurn`, execution deadlines and the monthly
 * seal all live in `drive`, which this path shares rather than bypasses.
 *
 * What it deliberately does not do:
 *
 * - consume approvals — an `ask` ending is delivered as the canonical
 *   question and stays open; #740 owns its resolution, and no threshold is
 *   encoded here;
 * - deliver while the work is still lane-owned — a lease that ends
 *   `suspended` or `continuable` again returns its stop without a message,
 *   the same silence the resumed path keeps for `suspended`. Delivering the
 *   "scrivi riprendi" diagnostic would page the owner for work that resumes
 *   on its own;
 * - touch owner/member/consolidation/ratchet rows — the caller checks
 *   `isSchedulerAutonomous` before arriving here, and this function asserts
 *   nothing beyond it.
 */
async function runAutonomous(
  deps: LoopDeps,
  record: TurnRecord,
  send: (record: TurnRecord, text: string) => Promise<void>,
  onUndeliverable: (event: Extract<LaneEvent, { kind: 'undeliverable' }>) => void,
  auto: AutonomousBudget | undefined,
  stream: (ResumeStream & { stop?: () => Promise<void> }) | undefined,
): Promise<Awaited<ReturnType<LaneRun>>> {
  if (record.leaseIndex >= MAX_AUTONOMOUS_LEASES) {
    return {
      refused:
        `il turno ${record.id.slice(0, 12)} ha già usato ${record.leaseIndex} lease e resta continuabile: ` +
        `non lo continuo da solo oltre il tetto. Riprendilo con un messaggio esplicito.`,
    };
  }
  if (deps.budgetExhausted(record.tenant)) {
    return {
      refused:
        `budget esaurito per ${record.tenant}: non apro una lease autonoma sul turno ${record.id.slice(0, 12)}. ` +
        `Resta continuabile finché il budget non lo permette.`,
    };
  }
  if (record.jobId !== null) {
    if (auto === undefined) {
      return {
        refused:
          `il turno ${record.id.slice(0, 12)} è il giro di un job ma il tetto per-job non è verificabile ` +
          `in questo processo: non lo continuo da solo. Resta continuabile.`,
      };
    }
    const cap = auto.jobCap(record.jobId);
    if (cap !== null && auto.jobMonthUsd(record.jobId) >= cap) {
      return {
        refused:
          `job "${record.jobId.slice(0, 8)}" fermato a lease autonoma: ha già speso ` +
          `$${auto.jobMonthUsd(record.jobId).toFixed(2)} questo mese, sul tetto per-job di $${cap}. ` +
          `Il lavoro resta continuabile nel turno ${record.id.slice(0, 12)}.`,
      };
    }
  }
  const channel = record.replyTo?.channel;
  const replyChannel = typeof channel === 'string' ? channel : undefined;
  const outcome = await continueTurn(deps, record.id, {
    message: autonomousGrantMessage(record),
    ...(stream?.signal ? { signal: stream.signal } : {}),
    ...(stream?.steer ? { steer: stream.steer } : {}),
    ...(stream?.onDelta ? { onDelta: stream.onDelta } : {}),
    ...(stream?.onProgress ? { onProgress: stream.onProgress } : {}),
    ...(replyChannel === undefined ? {} : { replyChannel }),
  });
  if ('why' in outcome) {
    // The grant raced (claimed elsewhere) or the row changed under the lane:
    // the row's own truth stands, nothing is delivered, the next beat retries.
    return { refused: outcome.detail };
  }
  // Still lane-owned: silence, like `suspended` on the resumed path — the
  // turn comes back on its own, and a message now would read as an answer.
  if (outcome.stopped === 'suspended' || outcome.stopped === 'continuable') {
    return { stopped: outcome.stopped };
  }
  const current = deps.turns.get(record.id);
  if (current?.replyTo != null && outcome.text !== '') {
    await send(current, outcome.text);
    return { stopped: outcome.stopped };
  }
  if (current !== null && outcome.text !== '') {
    onUndeliverable({ kind: 'undeliverable', turnId: record.id, surface: current.surface, text: outcome.text });
    try {
      deps.turns.delivered(record.id, 'undeliverable');
    } catch {
      /* the answer was already produced; a bookkeeping write may not undo that */
    }
  }
  return { stopped: outcome.stopped };
}
