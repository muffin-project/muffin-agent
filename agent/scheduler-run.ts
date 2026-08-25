import { randomBytes } from 'node:crypto';
import type { JobFireStore } from '../core/scheduler/job-fires.js';
import type { Job } from '../core/scheduler/jobs.js';
import type { FireDeferred, FireSettleOnly, JobOutcome, RunJob } from '../core/scheduler/scheduler.js';
import type { TurnRecord } from '../core/turns/store.js';
import { runTurn, type LoopDeps, type TurnResult } from './loop.js';

/**
 * The bridge from a scheduled job to a real turn.
 *
 * A job runs as the scheduler principal — `{ kind: 'system', source:
 * 'scheduler' }` — so the kernel treats it as itself, not as the owner: a
 * high-risk capability it would ask the owner for becomes an ASK queued for the
 * owner's return (threat model §3), and `outward.*` / `config.ratchet` are
 * denied outright. It never inherits the owner's column. Each fire gets a fresh
 * session: a daily brief is not one growing conversation.
 *
 * It does get the **owner-class context** (`agent/context/assemble.ts`), and
 * that is not the same statement as inheriting the owner's column: the job runs
 * on the host tenant, over the owner's own memory, and its output is for the
 * owner. Handing it the group prompt would produce a daily brief written by a
 * guest in someone else's room. The class follows from the pair it already
 * passes — `system` principal, `host` tenant — so there is nothing to keep in
 * sync here; a job ever armed for a group tenant moves to the group class on
 * its own.
 *
 * ## B7 — the one decision this file makes
 *
 * This is also where `job_fires` (`core/scheduler/job-fires.ts`) turns into a
 * choice of what to run, which is the "one piece with a decision in it" this
 * docstring already claimed before there was a decision to make. Owner
 * directive, verbatim: *"ogni occorrenza stabile `(job_id, scheduled_for)`
 * deve mappare a UNA sola identità durevole di lavoro/turno; dopo crash Muffin
 * continua o conclude quella stessa identità, non crea un secondo turn e non
 * abbandona il primo."*
 *
 * `makeJobRunner` resolves the fire *before* it decides whether to touch the
 * model at all:
 *
 *  1. `fires.claim` — the occurrence exists, idempotently (fault point 1).
 *  2. Already bound to a turn? Look it up.
 *     - Missing (a crash landed between the bind and the turn actually being
 *       written) → finish creating it, with the *same* id (fault point 2).
 *     - `done` → the model already ran; recover the outcome and hand
 *       `Scheduler` either a normal delivery or a settle-only sentinel,
 *       depending on whether something already delivered it (fault points 5
 *       and 6).
 *     - anything else (`runnable`/`running`/`waiting`/`interrupted`) → not
 *       this call's turn to touch; say so and let the turn lane's own
 *       machinery finish it (fault point 4, unchanged).
 *  3. Not yet bound → mint an id, bind it *before* the turn is created or the
 *     model is ever called (fault point 3's precondition), then run.
 */

/**
 * Map a turn's end to a delivery. Kept pure and separate from the runner so the
 * one piece with a decision in it — what the owner sees when the kernel queued
 * an ASK — is tested without a model.
 */
export function jobOutcomeFromTurn(result: TurnResult): JobOutcome {
  /**
   * A job's turn may now suspend, and that is neither an answer nor a failure.
   *
   * The row is `waiting`, the lane owns it, and it will come back and deliver
   * on its own. The text is written even though `Scheduler` does not deliver it
   * (see the guard there), because the day something does deliver it the string
   * must already be true rather than empty — an empty answer sent to the owner
   * reads as a job that produced nothing.
   */
  if (result.stopped === 'suspended') {
    return {
      stopped: 'suspended',
      text:
        `Il job si è sospeso fino a ${result.suspendedUntil?.wakeAt ?? '?'}: ` +
        `il turno resta registrato e riprende da solo.`,
      // Required on `JobOutcome` since PR #42 landed on dev — `Scheduler`
      // reads it to write the delivery outcome onto the same row `finish`
      // wrote. A suspended turn is not delivered here (see the guard in
      // `Scheduler.run`), but the id still identifies which row this fire was.
      turnId: result.turnId,
    };
  }
  if (result.stopped === 'ask' && result.pending) {
    const on = result.pending.resource ? ` su ${result.pending.resource}` : '';
    // Same two facts the REPL approver shows (D12-min): the concrete action,
    // and — when untrusted content already steered the turn — why the ask
    // deserves suspicion. Taint 0 stays silent; it is the unremarkable case.
    const why = result.pending.taint > 0 ? ` (turno a taint ${result.pending.taint})` : '';
    return {
      stopped: 'ask',
      text: `In coda per te: "${result.pending.capability}"${on}${why} — ${result.pending.prompt}`,
      turnId: result.turnId,
    };
  }
  return { stopped: result.stopped, text: result.text, turnId: result.turnId };
}

/**
 * Test-only pause, a no-op unless a scenario sets the env var — the same
 * precedent as `MUFFIN_GATEWAY_TICK_MS` (`cli/gateway.ts`). The two windows it
 * can widen are real production races (a real `SIGKILL` between two writes),
 * but each is microseconds wide in normal operation: too narrow for an
 * external test process to land a kill on reliably without this. Never set
 * outside `evals/acceptance`.
 */
async function testStall(envVar: string): Promise<void> {
  const ms = Number(process.env[envVar]);
  if (Number.isFinite(ms) && ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The text a live turn would have delivered, reconstructed for one a later
 * tick found already `done`.
 *
 * `TurnRecord.messages` does not hold it: `drive` (`agent/loop.ts`) only
 * appends the model's final text-only round to the **session file**
 * (`deps.sessions.append`, the `'answered'` branch) — the in-turn transcript
 * stops at the last tool round, because nothing needs to feed a finished
 * turn's own answer back into its own next model call. The session file is
 * exactly what that branch wrote, verbatim, so reading it back is not a
 * reconstruction for the common case — it is the same string.
 *
 * For any other outcome (`ask`, `error`, `cap`, `budget`) the original wording
 * genuinely is not recoverable this way — `ask`'s "In coda per te…" text, for
 * one, is built from `ApprovalRequest`, which is never persisted — and
 * inventing a plausible-looking one would be exactly the kind of claim
 * `docs/JUDGE.md` asks not to make. Named honestly instead.
 */
function recoveredText(deps: LoopDeps, record: TurnRecord): string {
  if (record.outcome === 'answered') {
    const ref = deps.sessions.open(record.sessionId);
    const messages = deps.sessions.read(ref);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === 'assistant' && m.content.trim() !== '') return m.content;
    }
  }
  return (
    `Il job ha concluso con esito "${record.outcome ?? 'sconosciuto'}" prima che la consegna fosse ` +
    `registrata; il testo originale non è stato recuperato dopo un riavvio.`
  );
}

/**
 * Create (or finish creating) the turn for an occurrence whose fire is
 * already bound to `turnId`, and run it. The only path in this file that ever
 * calls the model.
 */
async function runFresh(
  deps: LoopDeps,
  job: Job,
  turnId: string,
  signal: AbortSignal | undefined,
): Promise<JobOutcome> {
  // Fault point 2, made observable: a real `SIGKILL` here lands after the
  // fire is bound and before the turn row exists at all.
  await testStall('MUFFIN_JOB_FIRES_STALL_AFTER_BIND_MS');
  const session = deps.sessions.open(`job-${job.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`);
  const result = await runTurn(deps, {
    principal: { kind: 'system', source: 'scheduler' },
    tenant: 'host',
    surface: job.channel,
    session,
    text: job.goal,
    // The identity `fires.bind` already committed, threaded in so the row
    // this call writes is the row the fire is already pointing at — never a
    // second, competing one.
    id: turnId,
    /**
     * Every job turn delivers **out of band**, including one whose channel is
     * `cli`, and the address is the channel itself.
     *
     * This is the field that makes B8 checkable rather than a promise, and it
     * is also what `slice/turno-sospeso` needed for its own reason: a job
     * whose turn calls `wait` returns `suspended`, the scheduler stops (it
     * has nothing to say yet), and the lane finishes the turn later — in a
     * process with no stack to return to. With no address on the row,
     * `agent/turn-lane.ts` had nothing to deliver to and dropped the answer
     * in silence. A turn created without `replyTo` gets `delivery = NULL`,
     * which `core/turns/store.ts` defines as *"this surface delivers in band
     * — the caller of `runTurn` has the text in its hand and there is no
     * separate step that can fail"*. For a job that is simply false:
     * `Scheduler.run` calls `deliver` afterwards and that call can fail. So
     * the row started out asserting the one thing that made the failure
     * invisible. With the address on it the row starts at `pending`, and a
     * fire whose delivery is never settled stays `pending` where `muffin
     * doctor` can see it — which is a different and more useful fact than
     * "no record either way".
     */
    replyTo: { channel: job.channel },
    // `job.channel` is already a `SurfaceRegistry` address — the exact same
    // string `Deliver` uses — so a tool call mid-job (`send_file`) reaches
    // the same destination the job's own text answer will.
    replyChannel: job.channel,
    ...(signal ? { signal } : {}),
  });
  // Fault point 5, made observable: a real `SIGKILL` here lands after the
  // turn reaches `done` and before `Scheduler` ever calls `deliver`/`markRan`.
  // Skipped for a turn that suspended — there is nothing "done" about it yet,
  // and `Scheduler`'s own suspended branch does not call `deliver` either.
  if (result.stopped !== 'suspended') await testStall('MUFFIN_JOB_FIRES_STALL_AFTER_DONE_MS');
  return jobOutcomeFromTurn(result);
}

/**
 * Resolve a `turn_id` already bound to this occurrence — whether `job_fires`
 * has carried it since a previous tick, or this call just won the bind race a
 * moment ago.
 */
async function resolveBound(
  deps: LoopDeps,
  job: Job,
  turnId: string,
  signal: AbortSignal | undefined,
): Promise<JobOutcome | FireDeferred | FireSettleOnly> {
  const existing = deps.turns.get(turnId);
  // The bind landed, but the row it points at does not exist — a crash
  // between the two (fault point 2). Nothing has run yet, so this is not a
  // duplicate: finish exactly what was interrupted, with the same identity.
  if (existing === null) return runFresh(deps, job, turnId, signal);
  if (existing.status !== 'done') return { deferred: true };
  // `done`, and delivery already resolved by someone else (a live run's own
  // `Scheduler.settle`, or a completed one this same check is re-observing) —
  // never call `deliver` again for text that already went out or already
  // failed for a recorded reason (fault point 6).
  if (existing.delivery !== null && existing.delivery !== 'pending') {
    return {
      settleOnly: true,
      turnId: existing.id,
      outcome: existing.outcome ?? 'error',
      delivered: existing.delivery === 'sent',
    };
  }
  // `done`, delivery still `pending` — the model already ran and produced an
  // outcome, but nothing has told the channel yet (fault point 5, the crash
  // between a turn finishing and `Scheduler.settle` running at all). Recover
  // the text and hand back a normal outcome: `Scheduler` delivers and settles
  // exactly as it would for a live run, never calling `runJob` a second time.
  return { stopped: existing.outcome ?? 'error', text: recoveredText(deps, existing), turnId: existing.id };
}

export function makeJobRunner(deps: LoopDeps, fires: JobFireStore): RunJob {
  return async (job: Job, signal): Promise<JobOutcome | FireDeferred | FireSettleOnly> => {
    // The occurrence that is due, not the moment this process noticed it —
    // `job.nextFireAt` as `due()` returned it, read once here and never
    // recomputed later in this call.
    const scheduledFor = job.nextFireAt.toISOString();
    const fire = fires.claim(job.id, scheduledFor);
    if (fire.turnId !== null) return resolveBound(deps, job, fire.turnId, signal);

    const minted = randomBytes(16).toString('hex');
    const winner = fires.bind(job.id, scheduledFor, minted);
    // Lost the race: some other bind landed first. There is no turn to run —
    // `minted` was never written anywhere — so this resolves the winner's id
    // exactly as if it had found it already bound at the top of this call.
    if (winner !== minted) return resolveBound(deps, job, winner, signal);
    return runFresh(deps, job, winner, signal);
  };
}
