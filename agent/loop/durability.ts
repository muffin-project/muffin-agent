import type { PermissionSnapshot } from '../../core/policy/types.js';
import { ATTR, type SpanHandle } from '../../core/tracing/types.js';
import type { DeliveryState, TurnOutcome, TurnRecord } from '../../core/turns/store.js';
import { encodeWaitFor, type WaitSpec } from '../../core/turns/wait.js';
import type { ContentBlock, Message } from '../providers/types.js';
import { harnessMessage, splitWorkEvidence } from './message-origin.js';
import type { TurnRun } from './run-state.js';
import { runTool } from './tool-call.js';
import {
  ApprovalRequired,
  MAX_TRANSPORT_RETRIES,
  type LoopDeps,
  type RegisteredTool,
  type ToolContext,
  type TurnInput,
  type TurnResult,
} from './types.js';

/**
 * The five durable choke points of a turn, and the row they all write.
 *
 * `checkpoint`, `suspendHere`, `reconcile`, `closeRecord`/`announceEnd`/`finish`
 * and `closeRow` were nested inside `guidaIlTurno`, held together by its
 * closure. A closure does not cross a module boundary, so the alternative to
 * this file is a signature that takes `deps`, `record`, `run`, `snapshot`,
 * `turn`, `input` and four more, one call at a time — and that is exactly the
 * place where `run.iterations` is passed where `run.toolCallsMade` was meant
 * and nothing turns red.
 *
 * So the closure becomes one value. `TurnScope` is *the same set of bindings*
 * the nested functions read before, named once and passed by reference: the
 * mutable half of it is `run` (`agent/loop/run-state.ts`), which is the object
 * slice 6 built for precisely this hand-off.
 *
 * What did **not** change, and is what this file is judged on:
 *
 *  - **The EFFECT WAL and `reconcile`'s three states** (§4 inv. 6). `reconcile`
 *    still reads the recorded outcome first (replay, tier included), then the
 *    uncertain intent (`rerunnable` decides, and only it), then falls through to
 *    `runTool` — which re-writes the intent row, so the kernel rules again.
 *  - **`checkpoint` returns `true` only when the write is not fenced out.** An
 *    exception is swallowed (stale row, next checkpoint overwrites it) and
 *    reports `true`; a fenced `changes === 0` reports `false`, and every caller
 *    stops the turn on it.
 *  - **`suspendHere` never swallows a failed `suspend`.** The steer corrections
 *    it drained are handed back to the funnel (`recupero.push`) before it falls
 *    through to `finish`, because the drain is destructive and the row nobody
 *    wrote would have eaten them.
 *  - **Owner-visible text byte-identical** (§4 inv. 9).
 *
 * One shape change, and it removes a hazard rather than adding one: `finish`
 * took `span`, `iters` and `used` as parameters, and all thirteen call sites
 * passed `turn`, `run.iterations` and `run.usage` — the three values already on
 * the scope. They are read from it now, so there is no longer a way to hand
 * `finish` a counter that disagrees with the row it is about to write.
 */
export type TurnScope = {
  readonly deps: LoopDeps;
  readonly record: TurnRecord;
  /** The turn's span. `finish` ends it; nothing else here does. */
  readonly turn: SpanHandle;
  readonly input: TurnInput;
  /** Everything that changes during the turn. See `agent/loop/run-state.ts`. */
  readonly run: TurnRun;
  readonly snapshot: PermissionSnapshot;
  /**
   * `/steer` corrections that already left the connector's door and found no
   * row to land on — `suspendHere` pushes here when its own write fails, and
   * `drive` is the one that renders them. See `drive` in `agent/loop.ts`.
   */
  readonly recupero: string[];
  /** What this turn was shown; `reconcile` re-runs tool calls through it. */
  readonly exposed: RegisteredTool[];
  readonly toolContext: ToolContext;
  /**
   * The sensitive-resource echo collector. A repaired call reads a resource
   * exactly like a fresh one does, so a repair must feed the same sink.
   */
  readonly noteSensitiveResourceEcho: (call: { name: string; args: unknown }, outcome: ContentBlock) => void;
};

/**
 * The turn's state, saved at a point where nothing is in flight.
 *
 * An **exception** is still swallowed, and this is the one place in this
 * file where swallowing it is the right call — with the reason, because
 * "caught and ignored" is how guards here have died before. A checkpoint
 * that throws leaves the row **stale**, not wrong: the next one overwrites
 * it, and a process that dies before then is reclaimed as interrupted,
 * which is exactly what it was. Rethrowing would instead take down a turn
 * that is still perfectly able to answer, over a write whose only job is to
 * make a *future* failure cheaper. `Gateway.drain` closing the database
 * under a long turn is not hypothetical — it is the measured crash in
 * `core/scheduler/scheduler.ts:174-181`. The failure is on the span, so
 * "the record stopped being written" is visible in a trace instead of being
 * inferred from a stale row.
 *
 * A **fenced-out write** (P19) is a different fact and is not swallowed: it
 * means another process's claim is on this row now, not that the write
 * merely failed. Returns `false`, and every caller checks it — a checkpoint
 * that could not land is the caller's cue to stop the turn without any
 * further effect, not to keep iterating against a row it no longer owns.
 */
export function checkpoint(scope: TurnScope): boolean {
  const { deps, record, run, snapshot, turn } = scope;
  try {
    return deps.turns.checkpoint(
      record.id,
      { messages: run.messages, taint: snapshot.currentTaint(), counters: run.counters() },
      record.claimToken,
    );
  } catch (error) {
    turn.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
    return true;
  }
}

/**
 * The turn releases the runtime. **Not** an ending — see `TurnStopped`.
 *
 * The write is a single statement (`TurnStore.suspend`) for ADR-0035's
 * reason, restated on this table: one write advances the state, so a second
 * writer added later cannot move a turn past a suspension nobody recorded.
 * A failure here is the one case that must **not** be swallowed the way a
 * checkpoint is: if the row did not become `waiting`, nothing will ever wake
 * it, and returning `suspended` would be a promise made to a caller that
 * cannot be kept. So it falls back to finishing the turn and saying so.
 */
export function suspendHere(scope: TurnScope, spec: WaitSpec): TurnResult {
  const { deps, input, record, recupero, run, snapshot, turn } = scope;
  /**
   * `/steer` pendente al momento della sospensione (ADR-0054 §2,
   * emendamento 03/09b).
   *
   * Un turno sospeso **non è finito**: ha rilasciato il runtime e gli è
   * dovuto un risveglio. Quindi la correzione non va nella sessione per il
   * turno *dopo* — va consegnata a **questo** turno quando si sveglia, che è
   * letteralmente «il prossimo confine di giro» che la conferma promette.
   *
   * La strada è la riga: `suspend` persiste `messages`, e un turno ripreso
   * riparte da `[...record.messages]`. Perciò la correzione entra
   * nell'array che sta per essere scritto, e la prima chiamata al modello
   * del risveglio la vede.
   *
   * Drenato **qui** e non in cima al giro perché la barriera si onora prima
   * di quel drain, nello stesso giro: una correzione arrivata durante il
   * giro N veniva saltata quando il turno si sospendeva in cima al giro N+1,
   * e `suspendHere` — a differenza di `finish` — non svuotava mai la porta.
   * Il `finally` del connettore cancella la voce `vivi` (con il suo array di
   * correzioni) appena `runTurn` torna: nessuno dei due casi promessi
   * all'owner avveniva, e la correzione spariva.
   *
   * `messages` non viene mutato: il ramo che fallisce la scrittura non deve
   * proseguire con una correzione che non è su nessuna riga, e su quello che
   * riesce si torna subito.
   */
  const correzioniPendenti = input.steer?.() ?? [];
  const conCorrezioni: Message[] =
    correzioniPendenti.length === 0
      ? run.messages
      : [...run.messages, ...correzioniPendenti.map((testo): Message => ({ role: 'user', content: [{ type: 'text', text: testo }] }))];

  const wrote = (() => {
    try {
      return deps.turns.suspend(
        record.id,
        {
          messages: conCorrezioni,
          taint: snapshot.currentTaint(),
          counters: run.counters(),
          wakeAt: spec.wakeAt,
          waitFor: spec.waitFor === null ? null : encodeWaitFor(spec.waitFor),
        },
        record.claimToken,
      );
    } catch (error) {
      turn.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
      return false;
    }
  })();

  if (!wrote) {
    // Covers two different facts with one fallback, and that is deliberate:
    // a genuine write failure (the pre-existing case) and a fenced-out write
    // — the claim is gone (P19) — both mean "the wait cannot be honoured",
    // and `finish` below independently re-checks its own fencing. If the
    // claim really is gone, `finish`'s own write fails too and it returns
    // the honest lost-claim result instead of this text — so the message
    // here only ever reaches an owner when the *first* case is what happened.
    //
    // Le correzioni drenate qui sopra sono già uscite dall'array del
    // connettore — il drain è distruttivo — e sono finite in un `messages`
    // che nessuno ha scritto: l'imbuto (`drive`) troverebbe la porta vuota e
    // la correzione svanirebbe proprio dove il codice sta già ammettendo di
    // aver fallito. Rese all'imbuto invece di scritte qui: è l'unico punto
    // che parla alla conversazione, ed è lo stesso che sa dirlo all'owner
    // nel testo del turno se **quella** scrittura fallisce a sua volta.
    recupero.push(...correzioniPendenti);
    return finish(
      scope,
      'error',
      'Volevo sospendermi e aspettare, ma non sono riuscito a salvare lo stato del turno: ' +
        'se aspettassi comunque non mi sveglierebbe nessuno. Mi fermo qui e te lo dico.',
    );
  }

  turn.setAttributes({
    [ATTR.stopReason]: 'suspended',
    [ATTR.turnIteration]: run.iterations,
    'muffin.turn.wake_at': spec.wakeAt,
    ...(spec.waitFor === null ? {} : { 'muffin.turn.wait_for': encodeWaitFor(spec.waitFor) }),
  });
  turn.end({ status: 'ok' });
  // No `announceEnd`: the memory lane is told when a turn *ends*, and this
  // one has not. Waking the consolidator here would mean extracting from a
  // half-finished conversation every time the agent decided to wait.
  return {
    text: '',
    iterations: run.iterations,
    traceId: turn.traceId,
    turnId: record.id,
    stopped: 'suspended',
    // Reported even with no text, and it is the same value that just went to
    // disk. A suspended turn has climbed as far as it has climbed, and a
    // caller deriving anything from it — a presence line, a log entry — is
    // owed the tier of what was in its context, not a `0` standing in for
    // "nothing was said yet".
    taint: snapshot.currentTaint(),
    usage: run.usage,
    suspendedUntil: spec,
  };
}

/**
 * Repair a transcript a crash left mid-batch, using the two-phase tool record.
 *
 * The tail test is exact rather than heuristic: the loop pushes the results
 * of a batch as **one** user message after the whole batch, so a transcript
 * whose last message is an assistant turn carrying `tool_use` blocks is
 * precisely a batch that was never answered. There is no partial results
 * message to disambiguate.
 *
 * Three states, from the pair of rows, and the third is the one that only
 * exists because the intent row does (`ADR-0042`):
 *
 *  - **done** — an outcome was recorded. Replay it. This is Temporal's
 *    property in our own words: during replay the recorded result is reused,
 *    not recomputed. Its tier is replayed too, or a turn that had read the
 *    web would come back believing it had not.
 *  - **maybe done** — an intent row, no outcome. `rerunnable` decides, and
 *    nothing else may: `reversible` answers a different question (`fs.write`
 *    is `undoable` and perfectly safe to repeat; a message is neither).
 *    Where it says no, the turn resumes **declaring** that the call may have
 *    landed — never pretending it did not, and never claiming it did.
 *  - **not started** — neither row. Run it, through the same kernel path as
 *    any other call, because the permission matrix may have tightened while
 *    the turn was dead and a resume should inherit that.
 *
 * Returns `null` to continue normally, or a `TurnResult` when its own final
 * checkpoint discovers the claim is gone (P19): the repair above may itself
 * have run tool calls with real effects, so by the time that is discovered
 * there is nothing left to do but stop and say so, exactly like the
 * checkpoints in the main loop.
 */
export async function reconcile(scope: TurnScope): Promise<TurnResult | null> {
  const { deps, exposed, input, noteSensitiveResourceEcho, record, run, snapshot, toolContext, turn } = scope;
  const last = run.messages[run.messages.length - 1];
  if (last === undefined || last.role !== 'assistant') return null;
  const pending = last.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
  if (pending.length === 0) return null;

  const recorded = deps.turns.recordedOutcomes(record.id);
  const uncertain = new Map(deps.turns.uncertainCalls(record.id).map((c) => [c.callId, c]));
  const repaired: ContentBlock[] = [];
  turn.setAttributes({ 'muffin.turn.reconciled': pending.length });

  for (const block of pending) {
    const done = recorded.get(block.id);
    if (done !== undefined) {
      // The taint the recorded result carried has to come back with it: this
      // is the same "the two facts must not land apart" the outcome write
      // enforces in a transaction.
      if (done.tier !== null) snapshot.raiseTaint(done.tier, 'un risultato ripreso dal record di questo turno');
      repaired.push({
        type: 'tool_result',
        toolCallId: block.id,
        content: done.content,
        ...(done.isError ? { isError: true } : {}),
      });
      continue;
    }

    const open = uncertain.get(block.id);
    if (open !== undefined && !open.rerunnable) {
      repaired.push({
        type: 'tool_result',
        toolCallId: block.id,
        content:
          `Questa chiamata a ${block.name} era partita quando il processo è morto, e non è dichiarata ` +
          `ri-eseguibile: **non è possibile sapere se ha avuto effetto**. Non l'ho rifatta. ` +
          `Verifica lo stato prima di riprovarla, e dillo a chi ti ha chiesto la cosa.`,
        isError: true,
      });
      continue;
    }

    // Either re-runnable and uncertain, or never started at all. Both go
    // through `runTool`, so the kernel rules on them again and the intent row
    // is written again — `ON CONFLICT DO NOTHING` absorbs the second write.
    try {
      const call = { id: block.id, name: block.name, args: block.input };
      const outcome = await runTool(deps, snapshot, turn, call, input, exposed, toolContext);
      repaired.push(outcome);
      noteSensitiveResourceEcho(call, outcome);
    } catch (error) {
      // An `ask` that cannot be asked on this surface is not a reason to
      // abandon a repair half-done: the block gets an honest result and the
      // turn continues to the normal `ask` handling on its next call.
      repaired.push({
        type: 'tool_result',
        toolCallId: block.id,
        content: error instanceof ApprovalRequired
          ? `Ripresa: ${block.name} vuole un'approvazione che qui non posso chiedere.`
          : error instanceof Error
            ? error.message
            : String(error),
        isError: true,
      });
    }
  }

  run.messages.push({ role: 'user', content: repaired });
  return checkpoint(scope) ? null : finish(scope, 'error', '');
}

/**
 * The current lease's audit close, for terminal finishes (P0-B authority).
 *
 * `contextBuilt` gating lives with the callers: only a lease that started
 * executing folds anything into lifetime. Transport spent assumes the lease
 * allowance starts at MAX_TRANSPORT_RETRIES — true for fresh rows
 * (`freshCounters` in `entry.ts`) and enforced for granted leases by
 * `grantContinuation`. Delivery is the row's snapshot at close time (best
 * effort: the send usually lands after the finish, via the port's own
 * bookkeeping).
 */
function closeLeasePatch(
  deps: LoopDeps,
  record: TurnRecord,
  state: { messages: readonly Message[]; transportRetriesLeft: number },
): {
  startedAt: string;
  harnessMessages: Message[];
  transportUsed: number;
  delivery: DeliveryState | null;
} {
  return {
    startedAt: deps.turns.leaseStartedAt(record.id, record.leaseIndex) ?? record.createdAt,
    harnessMessages: splitWorkEvidence(state.messages).harness,
    transportUsed: Math.max(0, MAX_TRANSPORT_RETRIES - state.transportRetriesLeft),
    delivery: record.delivery,
  };
}

/**
 * The single write that ends the row. Same exception-swallow, same reason,
 * one caveat — and, since P19, a second return path that is not swallowed.
 *
 * Returns whether the write actually landed. `false` means fenced out: the
 * claim on this row belongs to someone else now, and `finish` (below) turns
 * that into the honest lost-claim result instead of returning a `TurnResult`
 * that claims an outcome this row does not, in fact, record.
 */
export function closeRecord(scope: TurnScope, outcome: TurnOutcome): boolean {
  const { deps, record, run, snapshot, turn } = scope;
  try {
    return deps.turns.finish(
      record.id,
      { outcome, messages: run.messages, taint: snapshot.currentTaint(), counters: run.counters() },
      record.claimToken,
      // A terminal finish folds the current lease into lifetime exactly when
      // it started executing (`contextBuilt` is "this turn has already
      // started", per `resumeTurn`): a lease that never got going folds
      // nothing and counts nothing. Same transaction as the finish itself —
      // the audit never depends on a second write landing later.
      ...(run.contextBuilt ? [closeLeasePatch(deps, record, run)] : []),
    );
  } catch (error) {
    // The caveat: unlike a checkpoint, nothing comes after this one. The row
    // stays `running` and the next boot reclaims it as interrupted — a turn
    // that answered, reported as "we cannot say". That is the safe direction
    // of the two, and it is not silent: the attribute below is the trace's
    // record that the outcome could not be written. An exception is treated
    // as "could not write" (the pre-existing behaviour, `true`), never as
    // "lost the claim" — those are different facts and only the second one
    // is what a fenced `changes === 0` means.
    turn.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
    return true;
  }
}

/**
 * Tells the background lane a turn is over, and refuses to let it matter.
 *
 * Swallowed rather than propagated: this hook exists to start work *after*
 * the answer, and a background lane that can turn a good turn into an
 * exception would be a worse bug than the one it fixes. There is nothing for
 * the owner to do about it either, which is the test for whether an error
 * belongs on their screen.
 */
export function announceEnd(scope: TurnScope, stopped: TurnOutcome): void {
  const { deps, input } = scope;
  try {
    deps.onTurnEnd?.({ tenant: input.tenant, principal: input.principal, stopped });
  } catch {
    /* a lane that runs after the reply may not take the reply down with it */
  }
}

export function finish(scope: TurnScope, stopped: TurnOutcome, text: string, reason?: string): TurnResult {
  const { record, run, snapshot, turn: span } = scope;
  span.setAttributes({ [ATTR.stopReason]: stopped, [ATTR.turnIteration]: run.iterations });
  if (reason !== undefined) span.setAttributes({ 'muffin.turn.stop_reason': reason });
  // Nessun drain di `/steer` qui, ed è la differenza fra questa versione e
  // le tre riparazioni site-specific che l'hanno preceduta. `finish` era uno
  // dei siti che svuotavano la porta da sé, e il rethrow del provider non
  // passa mai da qui: l'unica svuotata adesso è quella dell'imbuto
  // (`drive`), che vede **tutte** le strade — questa compresa, perché ogni
  // `return finish(...)` in questo file torna attraverso di lì. Vedi
  // ADR-0054 §2, emendamento 03/09c.
  // Before the span ends and before the hook fires: the row is the durable
  // half, and a background lane must never be able to run while the record
  // still says a live process is executing this turn.
  const written = closeRecord(scope, stopped);
  if (!written) {
    // The claim is gone (P19): every caller of `finish` above already
    // detected this from its *own* fenced write (a checkpoint, a suspend
    // that fell back here) or is discovering it only now, right at the end.
    // Either way the row does not, in fact, say what `stopped`/`text` claim
    // — some other process's write is what is really on it — so neither may
    // be returned. No `announceEnd`: the process that now owns this row is
    // the one whose job it is to say the turn ended, not this one.
    span.setAttributes({ 'muffin.turn.lost_claim': true });
    span.end({ status: 'error' });
    return {
      text: '',
      iterations: run.iterations,
      traceId: span.traceId,
      turnId: record.id,
      stopped: 'error',
      taint: snapshot.currentTaint(),
      usage: run.usage,
    };
  }
  span.end({ status: stopped === 'error' ? 'error' : 'ok' });
  // Last thing before the return, so the span is closed and the result is
  // built: the hook is not allowed to see a half-finished turn, and it is not
  // allowed to delay this return.
  announceEnd(scope, stopped);
  return {
    text,
    iterations: run.iterations,
    traceId: span.traceId,
    // `record.id`, not `span.traceId`. On a fresh turn the two are the same
    // value by construction; on a **resumed** one the span is a child of a
    // remote parent and its own trace id would name the trace, not the row —
    // so a surface recording the delivery would address a turn that does not
    // exist. The row's identity is the one thing a resume must not lose.
    turnId: record.id,
    stopped,
    ...(reason === undefined ? {} : { reason }),
    // Read here rather than at any earlier point, because the whole property
    // is that it can still rise: a tool result on the last iteration taints
    // the answer exactly as much as one on the first.
    taint: snapshot.currentTaint(),
    usage: run.usage,
  };
}

/**
 * Close a row from outside the engine, for the two refusals that happen before
 * it starts.
 *
 * A refused resume has no transcript to write and no counters to advance — it
 * has a row that must stop being picked up, and a reason the owner can read. It
 * writes the reason into the transcript so the surface delivering the turn has
 * something to say, which is the difference between "the turn ended" and "the
 * turn vanished".
 */
export function closeRow(
  deps: LoopDeps,
  span: SpanHandle,
  record: TurnRecord,
  outcome: TurnOutcome,
  detail: string,
): void {
  try {
    // `record.claimToken` is the one `claim()` just handed back a moment ago
    // in `resumeTurn` — both callers of this function run immediately after a
    // winning claim, before anything could plausibly steal it. If something
    // did (an exceptionally narrow race), the write is fenced out the same as
    // anywhere else: `changes === 0`, nothing overwritten, and there is
    // nothing further this function needs to do about it — the refusal it
    // reports to its own caller does not depend on this write having landed.
    // The refusal report joins the transcript first, so the lease archive
    // below sees the same array the row keeps — including the report itself
    // (harness-marked, so it archives as control, not as model output).
    const closed = [...record.messages, harnessMessage('assistant', [{ type: 'text', text: detail }])];
    deps.turns.finish(
      record.id,
      {
        outcome,
        // Harness control (a refusal report, not model output): marked so no
        // future reader mistakes it for something the model said.
        messages: closed,
        taint: record.taint,
        counters: record.counters,
      },
      record.claimToken,
      // A refused resume can still close a lease that ran: same started-lease
      // rule as `closeRecord`, read off the row instead of a live run.
      ...(record.counters.contextBuilt
        ? [closeLeasePatch(deps, record, { messages: closed, transportRetriesLeft: record.counters.transportRetriesLeft })]
        : []),
    );
  } catch (error) {
    span.setAttributes({ 'muffin.turn.record_error': error instanceof Error ? error.message : String(error) });
  }
}
