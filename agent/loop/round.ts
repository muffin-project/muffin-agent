import { sleep } from '../../core/net/sleep.js';
import { replyCapability } from '../../core/policy/doors.js';
import type { CapabilityId, Decision, DecisionRequest } from '../../core/policy/types.js';
import { redactText, scrubResourceEchoes } from '../../core/tracing/redact.js';
import { ATTR } from '../../core/tracing/types.js';
import type { ContinuableClass } from '../../core/turns/store.js';
import { checkCompletion, completionNudge } from '../completion.js';
import type { TenantClass } from '../context/assemble.js';
import { compactToolResults } from '../context/compact.js';
import { type RecoveryFailure, recoveryStep } from '../profiles/recovery.js';
import {
  type ChatCall,
  type ChatResult,
  type ContentBlock,
  ProviderError,
  ProviderStreamError,
} from '../providers/types.js';
import { ReasoningConfigurationError, reasoningFromLegacyThinking } from '../providers/reasoning.js';
import { checkpoint, finish, releaseContinuable, suspendHere, type TurnScope } from './durability.js';
import { resolveConversationId } from './conversation.js';
import type { ExecutionAbortReason, ExecutionBudget, ModelCallLease, ModelCallTelemetry } from './execution-budget.js';
import { harnessMessage, isPartialMessage, ownerMessage, partialMessage, toolMessage } from './message-origin.js';
import { continuationDedup, drainStream, edgeTrimmer, resolveContinuationSuffix, retryDelayMs } from './stream.js';
import { runTool } from './tool-call.js';
import {
  ApprovalRequired,
  MAX_PROVIDER_EMPTY_RETRIES,
  MAX_TRANSPORT_RETRIES,
  MAX_TRUNCATION_CONTINUATIONS,
  TOOL_RESULT_BUDGET_CHARS,
  type TurnResult,
} from './types.js';

/**
 * The paid path: one round of the turn, repeated until something ends it.
 *
 * This is the half of `guidaIlTurno` that spends money and shows text. Slice 7
 * took the durable writes out; what was left in the closure was the loop
 * itself — the reply door, the `/steer` boundary, the model call, the stream
 * and its single non-streaming fallback, the completion gate, the answer, and
 * the batch of tool calls under the per-turn cap. It reads the same bindings
 * the durable writes do (`TurnScope`) plus seven the pre-loop resolved and
 * only it and this file share, so the two halves are named once and passed by
 * reference rather than reassembled per call.
 *
 * The order in here is the property, not a style. Three points of it are
 * load-bearing and are what this module is judged on:
 *
 *  - **The reply door is asked *before* the model call** (§4 inv. 7). A round's
 *    text streams out of that call as it is generated, so a decision taken
 *    after it would be taken about bytes already on the owner's screen. The
 *    `/steer` drain comes after the refusal for the mirror reason: draining
 *    first would eat the owner's correction into a transcript the refusal is
 *    about to discard.
 *  - **One fallback, never a second stream.** A broken stream falls back to a
 *    single plain `chat()` for *this* attempt. A transport retry is a different
 *    budget on a *later* iteration, which rebuilds `call` and may stream again
 *    — each attempt its own `muffin.chat_call` span. What must never exist is a
 *    second `chatStream` inside one attempt: the partial text of the first is
 *    already on a surface, and the surface is told `superseded` exactly once.
 *  - **The tool cap counts calls, not iterations.** Rounds continue while the
 *    turn is making progress; nothing upstream bounds how many `tool_use`
 *    blocks one completion carries, and a refused call still gets a
 *    `tool_result` because a hole in the batch is a protocol error every
 *    provider rejects.
 *
 * Owner-visible text is byte-identical to what the closure produced (§4 inv. 9):
 * every string in here moved without an edit.
 */
export type RoundScope = TurnScope & {
  readonly execution: ExecutionBudget;
  /**
   * The pre-loop's own bindings that the round reads. Not state — `run` is the
   * state (`agent/loop/run-state.ts`) — but values resolved once, before
   * anything was generated, and deliberately not recomputed per round: the
   * class and the doors are a pure function of the principal and the tenant
   * the gateway already resolved, and re-deriving them here would let what the
   * model just said change them.
   */
  readonly turnClass: TenantClass;
  readonly now: () => Date;
  /** The kernel, asked the way `runTool` asks it. Defined in the pre-loop because the episode write uses it too. */
  readonly door: (capability: CapabilityId, resource: DecisionRequest['resource']) => Decision;
  readonly doorRefusal: (decision: Decision) => Exclude<Decision, { effect: 'allow' }> | undefined;
  readonly refusalLabel: (refusal: Exclude<Decision, { effect: 'allow' }>) => string;
  readonly memoryDoorOpen: () => boolean;
};

/**
 * What the owner reads when the reply row itself refuses — a sentence the
 * kernel wrote, never one the model did. The shipped floor never produces it;
 * a sealed `rot/policy.json` that tightened the `reply` row does, and the
 * owner who tightened it is the one reading this.
 */
function replyRefusedText(decision: Exclude<Decision, { effect: 'allow' }>): string {
  const why = decision.effect === 'deny' ? `${decision.code}${decision.detail ? `: ${decision.detail}` : ''}` : decision.effect;
  return `La risposta è stata trattenuta dal kernel dei permessi (${why}). Una conversazione nuova riparte con il contesto pulito.`;
}

/**
 * Lease watchdog causes are continuable classes with one rename.
 *
 * `user_stop` never reaches here (it returns `aborted` above); the switch
 * stays exhaustive without a default so the next watchdog cause breaks the
 * build at this site instead of silently becoming a terminal error.
 */
function leaseAbortClass(reason: Exclude<ExecutionAbortReason, 'user_stop'>): ContinuableClass {
  switch (reason) {
    case 'model_first_activity_timeout':
      return 'model_first_activity_timeout';
    case 'model_stall':
      return 'model_stall';
    case 'model_deadline':
      return 'model_deadline';
    case 'turn_deadline':
      return 'turn_deadline';
    case 'active_model_budget_exhausted':
      return 'active_model_budget';
  }
}

/**
 * A completed response that failed before the model could say anything useful.
 *
 * Three classes, decided from the mapped stop reason plus the two facts a
 * success-shaped provider failure cannot fake — output tokens and observed
 * activity — and from nothing else:
 *
 * - `provider_empty`: `stopReason: 'error'`, no text, no calls, zero output
 *   tokens, no first activity. Measured 2026-09-18: ~30.0s upstream stalls
 *   arriving as completed responses (in=0/out=0, unmapped finish reason).
 *   The strictness is the point: a reasoning-only response carries tokens and
 *   activity, so it stays out of this bucket and keeps the semantic cascade.
 * - `truncated`: `max_tokens` with nothing to show for it — same bucket,
 *   different sentence.
 * - `refused`: the model refused with no text and no call. Re-asking a filter
 *   is futile, so this one is terminal immediately, never re-driven.
 *
 * Returns `undefined` for everything the semantic cascade still owns: genuine
 * empty completions, reasoning-only responses, malformed calls (which throw
 * earlier, inside the adapters).
 */
export type ProviderFailureClass = 'provider_empty' | 'truncated' | 'refused';

/**
 * #615: max_tokens with partial text is NOT a provider failure in the
 * zero-output sense above — it is an incomplete success that must continue
 * the SAME logical answer. Returns true only for the observed slice:
 * non-empty text, zero tool calls, truncated stop.
 *
 * Tool-call + max_tokens is deliberately OUT of scope here: openai-compat
 * maps any present tool calls to `tool_use` regardless of finish_reason, so
 * that shape never arrives as `max_tokens` with calls; Anthropic maps solely
 * on stop_reason and could legally carry completed calls alongside
 * `max_tokens`. That boundary is characterized, not guessed — this path
 * leaves it on the current tool-call handling.
 */
export function isTruncatedPartial(result: ChatResult): boolean {
  return result.stopReason === 'max_tokens' && (result.text?.length ?? 0) > 0 && result.toolCalls.length === 0;
}

/**
 * Durable prefix of the current logical answer: the concatenation of accepted
 * truncation partials, and ONLY those.
 *
 * Explicit structural identity, never inference: a partial counts iff
 * `isPartialMessage` (origin `partial`, written by `partialMessage` below).
 * Role, absence of `tool_use`, text contents and historical position are NOT
 * consulted — reinjected session history carries a legacy absent origin on
 * purpose, tool-use assistant messages carry none, so neither can ever be
 * mistaken for the current answer. Survives checkpoint/crash (it is the
 * transcript) and a granted new lease (evidence, not harness control).
 */
export function collectTruncationPrefix(messages: readonly import('../providers/types.js').Message[]): string {
  let out = '';
  for (const m of messages) {
    if (!isPartialMessage(m)) continue;
    for (const b of m.content) {
      if (b.type === 'text') out += b.text;
    }
  }
  return out;
}

/**
 * Live-delta gate for a continuation call, or `undefined` for an ordinary
 * first call. The references are the FULL current logical prefix plus the
 * last structurally accepted partial chunk (shared `resolveContinuationSuffix`
 * semantics: full first, then last); with no accepted partial there is nothing
 * a repeat could duplicate, so the stream stays byte-for-byte identical to
 * before this rule existed.
 */
function dedupForContinuation(
  messages: readonly import('../providers/types.js').Message[],
): ReturnType<typeof continuationDedup> | undefined {
  const full = collectTruncationPrefix(messages);
  if (full === '') return undefined;
  const previous = lastPartialChunk(messages);
  return continuationDedup(full, previous);
}

/**
 * The most recently accepted partial chunk, for no-progress detection below.
 * Structural like the prefix: only `partial` origin counts.
 */
function lastPartialChunk(messages: readonly import('../providers/types.js').Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!isPartialMessage(m)) continue;
    return m.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return undefined;
}

/**
 * Harness continuation instruction for the next model call after a truncated
 * partial. Harness origin (not owner words): archived — never behaviorally
 * active — on continuation to a new lease, where the durable prefix plus the
 * owner's grant carries the continuation instead. Provider-neutral: no
 * provider-native continue primitive is assumed.
 */
export const TRUNCATION_CONTINUE_PROMPT =
  'La risposta precedente si è interrotta per limite di output. Continua esattamente da dove si è interrotta, ' +
  'aggiungendo solo il testo nuovo senza ripetere il prefisso già prodotto.';

export function classifyProviderFailure(
  result: ChatResult,
  telemetry: ModelCallTelemetry | undefined,
): { class: ProviderFailureClass; finishReason: string | null } | undefined {
  if (result.text || result.toolCalls.length > 0) return undefined;
  const noOutput = result.usage.outputTokens === 0;
  const noActivity = telemetry?.firstActivityAt === undefined;
  switch (result.stopReason) {
    case 'error':
      if (noOutput && noActivity) return { class: 'provider_empty', finishReason: result.finishReason ?? null };
      return undefined;
    case 'max_tokens':
      if (noOutput && noActivity) return { class: 'truncated', finishReason: result.finishReason ?? null };
      return undefined;
    case 'refusal':
      return { class: 'refused', finishReason: result.finishReason ?? null };
    default:
      return undefined;
  }
}

/**
 * One step down the cascade the profile declared, or false when it is spent.
 *
 * Attempt N runs strategy N, in the order the JSON lists them. What each
 * strategy *does* is in `agent/profiles/recovery.ts`; nothing here knows a
 * strategy by name. Provider-side failures never reach this function — they
 * are classified by `classifyProviderFailure` above and re-driven on the
 * transport budget instead.
 */
export function recover(scope: TurnScope, failure: RecoveryFailure): boolean {  const { deps, exposed, run, turn } = scope;
  const strategy = deps.profile.recovery[run.recoveriesUsed];
  if (strategy === undefined) return false;
  run.recoveriesUsed += 1;
  // The wire half of `requireTool`: the next attempt demands a call. The
  // message half is in `recoveryStep` below; both travel together.
  if (strategy === 'requireTool') {
    run.requireToolOnce = true;
    turn.setAttributes({ 'muffin.recovery.tool_choice': 'required' });
  }  const step = recoveryStep(strategy, { failure, tools: exposed.map((t) => t.spec.name) });
  if (step.message !== undefined) {
    // Lease-local control, not conversation: marked so a continuation to a
    // new lease can drop it without touching evidence (`message-origin.ts`).
    run.messages.push(harnessMessage('user', [{ type: 'text', text: step.message }]));
  }
  turn.setAttributes({
    'muffin.recovery.attempt': run.recoveriesUsed,
    'muffin.recovery.strategy': strategy,
    'muffin.recovery.failure': failure,
  });
  return true;
}

/**
 * The turn's rounds, from the first model call to whatever ends them.
 *
 * Called inside `guidaIlTurno`'s own `try`, so an exception still reaches the
 * one `catch` that closes the record and tells the memory lane — this function
 * ends a turn only through `finish`/`suspendHere`, never by swallowing a throw.
 */
export async function runRounds(scope: RoundScope): Promise<TurnResult> {
  const {
    deps,
    door,
    doorRefusal,
    exposed,
    input,
    memoryDoorOpen,
    noteSensitiveResourceEcho,
    now,
    record,
    refusalLabel,
    run,
    execution,
    snapshot,
    toolContext,
    turn,
    turnClass,
  } = scope;

  while (true) {
    // Suspension point 1 (design §T3): nothing is in flight, so everything
    // worth keeping is in the variables above. This is where a `wait` armed
    // during the previous batch is honoured — the state goes to disk, the
    // status becomes `waiting`, and this function **returns**, which is the
    // half that distinguishes a wait from an `await sleep()`: the runtime is
    // released and nothing holds it while the deadline runs.
    if (run.barrier !== null) return suspendHere(scope, run.barrier);
    // Written every iteration rather than only at the end, because the state
    // this saves is the state a process that dies here would otherwise take
    // with it — the transcript, the taint it has climbed to, and how much of
    // each budget is spent.
    //
    // This is also the checkpoint most likely to catch a lost claim: it runs
    // once per iteration, so a turn stolen mid-flight (P19 — a live pid past
    // the hard horizon, or a genuine crash-and-reclaim elsewhere) discovers
    // it here, before the next model call rather than after it.
    if (!checkpoint(scope)) return finish(scope, 'error', '');
    if (deps.budgetExhausted(input.tenant)) {
      return finish(scope, 'budget', 'Budget esaurito: mi fermo prima di spendere altro.');
    }
    // An abort discovered here — e.g. the owner stopped during a retry wait,
    // which wakes and `continue`s into this guard — is a user stop with a
    // typed reason, not a silent one: the mid-call door below already reports
    // `user_stop`, and the two doors must agree (#497).
    if (input.signal?.aborted) {
      return finish(scope, 'aborted', 'Interrotto.', 'user_stop');
    }
    if (execution.expired()) {
      // The wall is a lease boundary, not a verdict on the work: release so
      // the owner may grant the next lease instead of reading a deadline as
      // a failure of what was done so far.
      return releaseContinuable(scope, 'turn_deadline', run.iterations);
    }
    /**
     * May what this round produces reach the channel? Asked **before** the
     * model call, because the text of a round streams out of it as it is
     * generated (`onDelta`): a decision taken after the call would be taken
     * about bytes already on the owner's screen. Everything the round's text
     * can derive from is already in context here — tool results raise the
     * taint before the next round, never during this one's streaming — so
     * the taint this decides at is the taint the text will carry.
     *
     * The notice is fixed text, not model output, which is why delivering it
     * does not contradict the refusal: the row gates what the model says,
     * and the kernel's own sentence is not that. `answered` and not
     * `error`: the turn ended the way the policy told it to, and the trace
     * carries the decision that ended it.
     *
     * **Before the `/steer` drain below**, deliberately. Draining first would
     * consume the owner's correction into a `messages` array this branch is
     * about to discard; refusing first leaves the queue full, and `finish`'s
     * own last drain (ADR-0054 §2, emendamento 03/09) puts the correction in
     * the session as the owner's words, where the next turn sees it.
     */
    const replyRefusal = doorRefusal(door(replyCapability.id, { kind: 'none' }));
    if (replyRefusal !== undefined) {
      turn.setAttributes({ 'muffin.reply.refused': refusalLabel(replyRefusal) });
      return finish(scope, 'answered', replyRefusedText(replyRefusal));
    }
    // `/steer` (ADR-0054 §2): l'owner ha corretto il turno mentre girava. Il
    // confine sicuro è **qui** — i tool del giro prima hanno finito, il
    // modello non è ancora stato chiamato — e la correzione entra come un
    // messaggio dell'owner, nel transcript che il checkpoint sopra
    // persiste, così un turno ripreso dopo un crash la ricorda. Mai a metà
    // di una tool call: un effect avviato non si finge non avvenuto.
    // Marcata owner: sono parole arrivate dalla superficie, non sintesi del loop.
    for (const correzione of input.steer?.() ?? []) {
      run.messages.push(ownerMessage([{ type: 'text', text: correzione }]));
    }
    run.iterations += 1;
    // Reports the number this line just committed to — the same counter
    // `muffin.chat_call` below is about to tag itself with
    // (`ATTR.turnIteration`). A retry re-enters this loop and increments it
    // again, so a recovered attempt is correctly seen as its own round, not
    // folded into the one it replaced.
    input.onProgress?.({ type: 'round', n: run.iterations });

    // Old tool payloads are cleared before the request, not after: what goes
    // out is smaller, what is on record is whole. Nothing is removed, so every
    // `tool_use` keeps its `tool_result` and the request stays well-formed.
    const compacted = compactToolResults(run.messages, {
      budgetChars: TOOL_RESULT_BUDGET_CHARS,
      keep: (name) => deps.tools.find((t) => t.spec.name === name)?.keepResult === true,
    });
    if (compacted.clearedCount > 0) {
      turn.setAttributes({
        'muffin.context.cleared_results': compacted.clearedCount,
        'muffin.context.cleared_chars': compacted.clearedChars,
      });
    }

    const reasoning = reasoningFromLegacyThinking(deps.profile.thinking);
    const call: ChatCall = {
      model: deps.model,
      system: [{ type: 'text', text: deps.systemPrompts[turnClass], cache: 'stable' }],
      messages: compacted.messages,
      // Quale conversazione è questa, per chi smista fra più provider a
      // monte: la sessione, che è già l'identità che dura quanto dura il
      // filo del discorso. Vedi `ChatCall.conversation` per cosa ci si
      // compra — una cache che, misurata, prendeva 0% fra un turno e
      // l'altro. Risolta in `conversation.ts`, mai dal principal e mai dal
      // turno: l'hash opaco verso `session_id` lo fa l'adapter.
      conversation: resolveConversationId(input.session),
      // One attempt, demanded by the `requireTool` rung (ADR-0082). `auto`
      // everywhere else: forcing a tool on a turn that needs none
      // manufactures an action the model never chose.
      ...(exposed.length > 0 ? { tools: exposed.map((t) => t.spec), toolChoice: (run.requireToolOnce ? 'required' as const : 'auto' as const) } : {}),
      maxOutputTokens: 4096,
      // The profile decides both, and until this slice neither reached the
      // wire: the profile's legacy `thinking` vocabulary is normalized into
      // canonical reasoning above, and `temperature: 0` was hardcoded here — a 400 on every model
      // frontier.json matches, on the config `muffin init` writes by default.
      //
      // Spread rather than `temperature: profile.sampling === ... ? 0 :
      // undefined`, because under exactOptionalPropertyTypes an explicit
      // `undefined` is not the same as an absent field, and the difference is
      // exactly what the newest models reject.
      ...(deps.profile.sampling === 'deterministic' ? { temperature: 0 } : {}),
      ...(deps.samplingOverride === undefined ? {} : { sampling: deps.samplingOverride }),
      // Backward-compatible profile/config vocabulary is normalized once at
      // the loop boundary. Adapters no longer need to interpret profile
      // strings; they receive the provider-agnostic reasoning intent.
      ...(reasoning === undefined ? {} : { reasoning }),
      // Dopo una risposta vuota, tenta su un'altra macchina invece che sulla
      // stessa: vedi `ChatCall.providerIgnore` e la streak qui sotto.
      ...(run.providerEmptyUpstreams.size > 0 ? { providerIgnore: [...run.providerEmptyUpstreams] } : {}),
      // B11: streaming is requested exactly when someone can hear it. A turn
      // with no `onDelta` sink (a job, a headless `muffin run`, a provider
      // that never implements `chatStream`) sends this `false`, the request
      // is byte-identical to before this field could ever be `true`, and
      // `requestChatResult` below never touches `chatStream` at all.
      stream: Boolean(input.onDelta && deps.provider.chatStream),
    };
    const chatSpan = deps.tracer.start(
      'muffin.chat_call',
      {
        [ATTR.requestModel]: deps.model,
        [ATTR.turnIteration]: run.iterations,
        'muffin.chat_call.requested_max_output_tokens': call.maxOutputTokens,
        'muffin.chat_call.reasoning_requested_mode': call.reasoning?.mode ?? 'unset',
        ...(call.reasoning?.effort === undefined ? {} : { 'muffin.chat_call.reasoning_requested_effort': call.reasoning.effort }),
        ...(call.reasoning?.maxTokens === undefined ? {} : { 'muffin.chat_call.reasoning_requested_max_tokens': call.reasoning.maxTokens }),
      },
      turn,
    );
    if (run.requireToolOnce) {
      chatSpan.setAttributes({ 'muffin.recovery.tool_choice': 'required' });
    }
    const reasoningResolution = await deps.provider.resolveReasoning?.(call);
    if (reasoningResolution !== undefined) {
      chatSpan.setAttributes({
        'muffin.chat_call.reasoning_capability_source': reasoningResolution.capabilitySource,
        'muffin.chat_call.reasoning_effective_mode': reasoningResolution.effective?.mode ?? 'omitted',
        ...(reasoningResolution.effective?.effort === undefined ? {} : { 'muffin.chat_call.reasoning_effective_effort': reasoningResolution.effective.effort }),
        ...(reasoningResolution.effective?.maxTokens === undefined ? {} : { 'muffin.chat_call.reasoning_effective_max_tokens': reasoningResolution.effective.maxTokens }),
        'muffin.chat_call.reasoning_constraint_degraded': reasoningResolution.status !== 'applied',
        ...(reasoningResolution.reason === undefined ? {} : { 'muffin.chat_call.reasoning_resolution_reason': reasoningResolution.reason }),
      });
    }
    // `chatSpan`'s own clock is not readable back from `SpanHandle` (it only
    // exposes `setAttributes`/`end`), so `ms` for the `model` progress event
    // below is timed here, at the same call site that starts the span it
    // describes — not a second stopwatch with its own idea of when the
    // request began.
    const chatCallStartedAt = Date.now();
    let modelLease: ModelCallLease | undefined;
    let lastAbortReason: ReturnType<ModelCallLease['reason']>;
    let lastTelemetry: ModelCallTelemetry | undefined;

    const recordTelemetry = (telemetry: ModelCallTelemetry): void => {
      const prefix = `muffin.chat_call.invocation.${telemetry.modelCallIndex}`;
      chatSpan.setAttributes({
        'muffin.chat_call.model_call_index': telemetry.modelCallIndex,
        'muffin.chat_call.active_model_ms_before': telemetry.activeModelMsBefore,
        'muffin.chat_call.active_model_ms_this_call': telemetry.durationMs,
        'muffin.chat_call.active_model_ms_after': telemetry.activeModelMsAfter,
        'muffin.chat_call.effective_deadline_ms': telemetry.effectiveDeadlineMs,
        'muffin.chat_call.effective_deadline_source': telemetry.effectiveDeadlineSource,
        [`${prefix}.started_at`]: telemetry.startedAt,
        [`${prefix}.duration_ms`]: telemetry.durationMs,
        [`${prefix}.active_model_ms_before`]: telemetry.activeModelMsBefore,
        [`${prefix}.active_model_ms_after`]: telemetry.activeModelMsAfter,
        ...(telemetry.activeModelBudgetMs === undefined ? {} : { 'muffin.chat_call.active_model_budget_ms': telemetry.activeModelBudgetMs }),
        ...(telemetry.activeModelMsRemaining === undefined ? {} : { 'muffin.chat_call.active_model_ms_remaining': telemetry.activeModelMsRemaining }),
        ...(telemetry.firstActivityAt === undefined
          ? {}
          : {
              'muffin.chat_call.first_activity_at': telemetry.firstActivityAt,
              'muffin.chat_call.ttft_ms': telemetry.ttftMs ?? Math.max(0, telemetry.firstActivityAt - telemetry.startedAt),
            }),
        ...(telemetry.lastActivityAt === undefined
          ? {}
          : { 'muffin.chat_call.last_activity_at': telemetry.lastActivityAt }),
      });
    };

    /**
     * This round's live text: forwarded to `input.onDelta` in the
     * granularity it arrives on the wire, and closed by a `boundary` if it
     * turns out not to be the answer.
     *
     * Both live inside the loop body on purpose. `emittedLive` is what tells
     * the answering round whether the surface already has the text (streamed)
     * or is still owed it in one piece (no sink, no `chatStream`, or a
     * fallback to `chat()`), and a fresh `trim` per attempt is what stops a
     * superseded draft's held-back trailing whitespace from prefixing the
     * text that replaces it.
     */
    let emittedLive = false;
    let trim = edgeTrimmer();

    /**
     * Draws the line under what the surface has already seen: it was not the
     * answer, and here is what it was. A no-op when nothing was shown —
     * there is nothing to close — which is also why a turn with no sink, or
     * one that never streamed, emits no boundaries at all.
     */
    const closeLive = (reason: 'tool-call' | 'superseded'): void => {
      if (!emittedLive || !input.onDelta) return;
      input.onDelta({ type: 'boundary', reason });
      emittedLive = false;
      trim = edgeTrimmer();
    };

    /**
     * One call, whichever door gets there. Streams when `call.stream` says
     * to and the provider can; a stream that breaks mid-flight falls back
     * to a single plain `chat()` for *this* attempt only — a transport
     * retry on a *later* iteration rebuilds `call` fresh and may stream
     * again, which is not "twice silently": each attempt is its own
     * `muffin.chat_call` span. A broken stream's partial text belongs to a
     * request that never finished, so what the surface already showed of it
     * is closed as `'superseded'` before the replacement starts arriving.
     */
    const invoke = async (stream: boolean): Promise<ChatResult> => {
      const lease = execution.beginModelCall(input.signal, (progress) => {
        input.onProgress?.({ type: 'model_status', ...progress });
      });
      modelLease = lease;
      const callWithBudget: ChatCall = { ...call, stream, signal: lease.signal };
      try {
        if (reasoningResolution?.status === 'unsupported') throw new ReasoningConfigurationError(reasoningResolution);
        // A lease can be born already exhausted. Do not call the provider just
        // to discover its signal is aborted: this is a governor decision, not
        // a transport failure and must not enter retry.
        if (lease.signal.aborted) throw new Error('model invocation not authorized by execution budget');
        if (!stream) return await deps.provider.chat(callWithBudget);
        // #615 streaming blocker: a continuation call already has a
        // structurally accepted previous chunk. While the new stream still
        // exactly matches the beginning of that chunk, hold the candidate
        // duplicate bytes instead of publishing them — publishing first and
        // detecting no-progress after would show bytes the durable answer
        // will never contain. First calls (no accepted partial) stream
        // byte-for-byte exactly as before.
        const dedup =
          input.onDelta === undefined ? undefined : dedupForContinuation(run.messages);
        return await drainStream(
          deps.provider.chatStream!(callWithBudget),
          (text) => {
            if (!input.onDelta) return;
            const out = trim(text);
            if (out === null) return; // finora solo spazio: non è ancora niente
            // NOTE: no `?? out` here — the gate reports "hold" as `null`,
            // and nullish coalescing would republish the held bytes.
            const shown = dedup === undefined ? out : dedup.push(out);
            if (shown === null) return; // candidate duplicate held, nothing showable
            emittedLive = true;
            input.onDelta({ type: 'text', text: shown });
          },
          (kind) => lease.activity(kind),
        );
      } finally {
        lastAbortReason = lease.reason();
        lease.release();
        lastTelemetry = lease.telemetry();
        recordTelemetry(lastTelemetry);
      }
    };

    const requestChatResult = async (): Promise<ChatResult> => {
      if (!call.stream || !deps.provider.chatStream) return invoke(false);
      try {
        return await invoke(true);
      } catch (error) {
        if (!(error instanceof ProviderStreamError)) throw error;
        closeLive('superseded');
        chatSpan.setAttributes({
          'muffin.stream.fell_back_to_non_stream': true,
          'muffin.stream.partial': error.partial,
        });
        return invoke(false);
      }
    };

    let result;
    try {
      result = await requestChatResult();
    } catch (error) {
      const abortReason = lastAbortReason;
      chatSpan.setAttributes({
        'muffin.chat_call.duration_ms': Date.now() - chatCallStartedAt,
        ...(abortReason === undefined ? {} : { 'muffin.chat_call.abort_reason': abortReason }),
      });
      chatSpan.end({ error });
      // Whatever door this takes below — a retry, the profile's cascade, or
      // out of the turn entirely — the text this attempt already put on a
      // surface is not the answer, and saying so is cheaper than a surface
      // guessing from the silence that follows.
      closeLive('superseded');
      // `/stop` (ADR-0054 §3) or Ctrl+C **during** the model call: the SDK
      // rejects the request with an `AbortError`, and until 03/09/2026 that
      // rejection fell through to `throw error` — the turn ended `error`
      // and the owner read «esito error» for a stop they had asked for.
      // The signal is the fact; the exception is only how it arrived.
      if (abortReason === 'user_stop' || input.signal?.aborted) return finish(scope, 'aborted', 'Interrotto.', 'user_stop');
      if (abortReason !== undefined) {
        // A spent lease is a yield, not an ending: the work checkpoints
        // durably and the owner may grant the next lease. Only an explicit
        // stop ends the work itself here.
        return releaseContinuable(scope, leaseAbortClass(abortReason), run.iterations);
      }
      // Two failures wearing one type, and they take different doors.
      //
      // `output` is the model's own doing — arguments the adapter could not
      // parse — so it goes to the profile's cascade, which is where the step
      // written for almost-JSON lives. Backing off would only wait for the
      // same JSON to come back.
      //
      // `transport` is a 429 or a 502, and it gets its own budget: the
      // recovery cascade lives in the profile because a weak model needs more
      // attempts than a strong one, and a rate limit is not a fact about the
      // model at all.
      if (error instanceof ProviderError && error.retryable) {
        if (error.source === 'output') {
          if (recover(scope, 'malformed')) continue;
        } else if (run.transportRetriesLeft > 0) {
          run.transportRetriesLeft -= 1;
          // Persist the reduced budget before waiting. If the gateway exits in
          // this gap, startup recovery resumes the same transcript with the
          // retries still owed; it cannot reset the counter and loop forever.
          if (!checkpoint(scope)) return finish(scope, 'error', '');
          // Full jitter keeps concurrent turns from retrying in lockstep. The
          // ceiling doubles from 500ms to two minutes.
          //
          // A provider-declared `Retry-After` wins over the blind backoff
          // when it is longer (#496): retrying inside the server's own
          // window burns attempts against a bucket that has not refilled —
          // the deadlock Hermes hit on rate-limited Anthropic accounts. The
          // window is parsed and capped at the adapter boundary
          // (`parseRetryAfterMs`); here it only ever lengthens the wait.
          //
          // The wait is turn-wall time, not model-active time (#497): the
          // failed lease already released — its active-model accounting
          // stopped there — and no new lease exists yet, so the wait must
          // neither consume `activeModelMs` nor inherit the old lease's
          // deadline. It ends on user cancellation OR the turn deadline,
          // whichever comes first: a Retry-After longer than the remaining
          // wall wakes at the wall, and the loop-top `execution.expired()`
          // guard then finishes `turn_deadline` before any new provider
          // attempt is built. The wait itself is never a transport failure
          // eligible for another retry.
          const attempt = MAX_TRANSPORT_RETRIES - run.transportRetriesLeft;
          const waitSignals = input.signal === undefined ? [execution.signal] : [input.signal, execution.signal];
          await sleep(Math.max(retryDelayMs(attempt), error.retryAfterMs ?? 0), AbortSignal.any(waitSignals));
          continue;
        }
      }
      throw error;
    }
    // Consumed: the escalation lasts exactly one provider response. A
    // transport retry that `continue`d above rebuilds `call` with the flag
    // still armed, so the retry keeps `required`.
    run.requireToolOnce = false;
    // Provider/result failure truth (P0-A): classify while this span is still
    // open, because the verdict belongs on it. Handled further down, after
    // usage accounting and the progress event — the classification never
    // moves, only the span closes.
    const providerFailure = classifyProviderFailure(result, lastTelemetry);
    if (providerFailure !== undefined) {
      chatSpan.setAttributes({
        'muffin.provider_failure.class': providerFailure.class,
        'muffin.provider_failure.finish_reason': providerFailure.finishReason ?? 'null',
      });
    }
    chatSpan.setAttributes({
      'muffin.chat_call.duration_ms': Date.now() - chatCallStartedAt,
      ...(lastTelemetry === undefined ? {} : { 'muffin.chat_call.active_model_ms_after': lastTelemetry.activeModelMsAfter }),
    });

    run.usage.inputTokens += result.usage.inputTokens;
    run.usage.outputTokens += result.usage.outputTokens;
    run.usage.cacheReadTokens += result.usage.cacheReadTokens;
    run.usage.cacheWriteTokens += result.usage.cacheWriteTokens;

    // Billed here, on every call, before anything else can go wrong with the
    // iteration. The engine, its caps and its tests all existed before this
    // line did, and without it `exhausted()` answered false for ever.
    const usd = deps.recordSpend?.({
      tenant: input.tenant,
      capability: 'llm.chat',
      model: result.model,
      // Attribuzione, non contabilità: la riga di spesa porta il job da cui
      // il turno è nato, così il tetto per-job ha un contatore da leggere.
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
    });
    if (usd !== undefined) {
      run.spentUsd += usd;
      // The budget is an input to the kernel, so a decision cached before the
      // cap was reached must not survive it.
      snapshot.invalidate();
    }
    chatSpan.setAttributes({
      [ATTR.responseModel]: result.model,
      ...(result.requestId === undefined ? {} : { 'muffin.chat_call.request_id': result.requestId }),
      // L'attributo era dichiarato in `core/tracing/types.ts` e **non lo
      // scriveva nessuno**: il difetto di serie di questa repo, un
      // meccanismo senza chiamante. Ora porta chi ha risposto davvero,
      // che è ciò che l'attributo significa e ciò che serviva il
      // 28/08/2026 per chiedersi perché la cache non prendeva — con dodici
      // provider a monte per lo stesso modello e una cache per ciascuno,
      // uno zero senza il nome di chi ha servito non è diagnosticabile.
      ...(result.upstream !== undefined ? { [ATTR.providerName]: result.upstream } : {}),
      [ATTR.usageInputTokens]: result.usage.inputTokens,
      [ATTR.usageOutputTokens]: result.usage.outputTokens,
      ...(result.usage.reasoningTokens === undefined
        ? {}
        : { 'muffin.chat_call.reasoning_tokens': result.usage.reasoningTokens }),
      [ATTR.cacheReadTokens]: result.usage.cacheReadTokens,
      // The attribute existed with zero writers while the adapter hardcoded
      // the value to 0. Honesty note: no test asserts chat-span attributes
      // (this one or any other) — the pinned path for this number is
      // TurnResult and the spend record, not the trace.
      [ATTR.cacheWriteTokens]: result.usage.cacheWriteTokens,
      [ATTR.stopReason]: result.stopReason,
      // The verbatim wire reason beside the mapped one above: when the
      // provider returns a reason nobody mapped (or none), `stopReason` reads
      // `error` while this is the only evidence of what actually arrived.
      // `'null'` names an absent reason explicitly — an absent attribute
      // would read as "not recorded" instead of "recorded as absent".
      ...(result.finishReason === undefined ? {} : { 'muffin.chat_call.finish_reason': result.finishReason ?? 'null' }),
    });
    chatSpan.end();
    // Same values as the attributes just above, read off the same `result`
    // — never recomputed — plus `ms` from the stopwatch started next to
    // this span's own creation. Only the completed call reaches here: a
    // request that threw took the `catch` above and either retried
    // (its own fresh `round` event covers that) or propagated, so there is
    // no "the model call finished, badly" progress event — the next
    // `round` (or the turn ending) already says that much.
    input.onProgress?.({
      type: 'model',
      model: result.model,
      ms: Date.now() - chatCallStartedAt,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      stopReason: result.stopReason,
    });

    // Provider/result failure truth (P0-A): the verdict computed above, before
    // the semantic empty check below. A provider-empty response must never
    // reach `recover(scope, 'empty')` merely because text and toolCalls are
    // empty — that path scolds an innocent model and burns all five rungs on
    // an upstream stall. The bounded re-drive below spends the transport
    // budget (provider flakiness), never the semantic cascade (model
    // misbehavior).
    if (providerFailure !== undefined) {
      if (result.requestId !== undefined) run.providerFailureRequestIds.push(result.requestId);
      if (providerFailure.class === 'refused') {
        return finish(
          scope,
          'error',
          `Il modello ha rifiutato di rispondere senza produrre testo né chiamate. Turno ${record.id.slice(0, 12)}.`,
          'refusal',
        );
      }
      if (run.providerEmptyStreak < MAX_PROVIDER_EMPTY_RETRIES && run.transportRetriesLeft > 0) {
        run.providerEmptyStreak += 1;
        run.transportRetriesLeft -= 1;
        // Name the upstream that just answered nothing, so the retry below is
        // built with `providerIgnore` instead of hammering the same machine.
        if (result.upstream !== undefined) run.providerEmptyUpstreams.add(result.upstream);
        turn.setAttributes({ 'muffin.provider_failure.attempt': run.providerEmptyStreak });
        // Persist the reduced budget before waiting: same reason as the
        // transport path below — a gateway exit in this gap must resume with
        // the retries still owed, never reset.
        if (!checkpoint(scope)) return finish(scope, 'error', '');
        // Same backoff vocabulary as transport retries: full jitter, doubling
        // ceiling. No server-declared window exists on this path (there was
        // no error response to carry one), so the blind backoff stands alone.
        const attempt = MAX_TRANSPORT_RETRIES - run.transportRetriesLeft;
        const waitSignals = input.signal === undefined ? [execution.signal] : [input.signal, execution.signal];
        await sleep(retryDelayMs(attempt), AbortSignal.any(waitSignals));
        continue;
      }
      // Bounded re-drive spent: the lease ends recoverably, with the work
      // intact and a truthful diagnostic — never the semantic cascade, never
      // a generic sentence.
      return releaseContinuable(scope, providerFailure.class, run.providerEmptyStreak + 1);
    }
    // Anything the provider actually produced resets the consecutive-empty
    // count: the streak bounds one stall cluster, not the lease.
    run.providerEmptyStreak = 0;

    // #615: max_tokens + partial text + zero tools is never a terminal
    // complete answer. Preserve the valid prefix as part of the SAME logical
    // Turn/answer (assistant evidence with explicit `partial` origin in durable
    // `run.messages`), continue from it with a bounded harness instruction,
    // append only new text. Streaming prefix already shown stays valid: no
    // `superseded` boundary here — that would retract bytes the owner already
    // read correctly. Bounded by the DEDICATED durable length-continuation
    // budget (`truncationsUsed`, never transport) plus the execution
    // wall/model budgets checked at the loop top; when spent the Turn yields
    // truthfully continuable, never `answered`.
    if (isTruncatedPartial(result)) {
      const currentChunk = result.text ?? '';
      const prefixSoFar = collectTruncationPrefix(run.messages);
      // Shared exact-prefix rule (`stream.ts:resolveContinuationSuffix`,
      // mirrored incrementally by the live `continuationDedup` gate above):
      // try FULL logical prefix first, then LAST accepted chunk. Either proof
      // leaving zero new bytes is no-progress. Both sides compute over the
      // same trimmed string, so visible and durable agree.
      const previous = lastPartialChunk(run.messages);
      const suffix = resolveContinuationSuffix(
        prefixSoFar === '' ? undefined : prefixSoFar,
        previous,
        currentChunk,
      );
      // No-progress rule: an empty suffix proves the model reproduced instead
      // of continuing. The chunk is dropped — nothing new is lost, its bytes
      // are already preserved — and the lease yields continuable with the
      // existing prefix. The live gate already suppressed the repeat, so the
      // surface showed nothing twice. Deterministic and falsifiable: repeat
      // the same chunk twice and the turn stops after exactly 2 calls.
      if (suffix === '') {
        turn.setAttributes({
          'muffin.truncation.no_progress': true,
          'muffin.truncation.prefix_chars': prefixSoFar.length,
          'muffin.truncation.chunk_chars': currentChunk.length,
        });
        return releaseContinuable(scope, 'truncated', run.truncationsUsed);
      }
      run.messages.push({
        ...partialMessage([
          ...(result.thinking ?? []),
          { type: 'text' as const, text: suffix },
        ]),
        ...(result.providerMetadata === undefined ? {} : { providerMetadata: result.providerMetadata }),
      });
      run.truncationsUsed += 1;
      if (result.requestId !== undefined) run.providerFailureRequestIds.push(result.requestId);
      turn.setAttributes({
        'muffin.truncation.continuation': true,
        'muffin.truncation.used': run.truncationsUsed,
        'muffin.truncation.prefix_chars': prefixSoFar.length,
        'muffin.truncation.chunk_chars': currentChunk.length,
        'muffin.truncation.suffix_chars': suffix.length,
      });
      if (run.truncationsUsed > MAX_TRUNCATION_CONTINUATIONS) {
        // Bound spent with every accepted chunk durably preserved: honestly
        // continuable for an owner-granted new lease (the evidence split keeps
        // the `partial` prefix as work evidence and drops only the harness
        // instruction), never a partial `answered`.
        return releaseContinuable(scope, 'truncated', run.truncationsUsed);
      }
      run.messages.push(harnessMessage('user', [{ type: 'text', text: TRUNCATION_CONTINUE_PROMPT }]));
      // Persist prefix + spent budget before the next model call: a crash here
      // resumes from the accepted prefix without loss or duplication, against
      // the same crash-safe total.
      if (!checkpoint(scope)) return finish(scope, 'error', '');
      continue;
    }

    // Nothing at all: recover rather than presenting silence as an answer.
    if (!result.text && result.toolCalls.length === 0) {
      if (recover(scope, 'empty')) continue;
      // The cascade is spent and the model still produced nothing usable. A
      // fresh lease with fresh recovery state may succeed where this one did
      // not — and only the owner grants it, so this releases instead of
      // closing the work as a failure.
      return releaseContinuable(scope, 'recovery_exhausted', run.recoveriesUsed);
    }

    if (result.toolCalls.length === 0) {
      /**
       * The one place the turn's final answer is computed, and the one
       * place both sinks the 03/09 corpus found unguarded — the reply
       * (`result.text`, read by every connector: CLI stdout, Telegram
       * `sendMessage`, Discord, `SurfaceRegistry.deliver`) and the memory
       * episode a few lines down — draw from the **same string**. Scrubbing
       * it here once, before either sink reads it, is a single choke point
       * instead of one call per connector: `redactText` already lived at
       * two of those doors (`core/surface/registry.ts#deliver`,
       * `core/memory/store.ts#addEpisode`) and at neither of the
       * connectors that actually carry a live turn's reply — measured
       * 2026-09-04, `grep -rn redactText cli/ connectors/` finds only
       * `cli/prompt-show.ts`, an unrelated command. `scrubResourceEchoes`
       * is the new floor (`core/tracing/redact.ts`): it strips a verbatim
       * copy of anything this turn read from a secret-flavoured resource
       * name, closing `s6-sink-risposta`/`s7-memoria-e-ricordo`'s shared
       * mechanic without adding a question anywhere (ROW_FLOOR keeps both
       * rows `allow`) and without depending on the model refusing to
       * repeat what it read.
       *
       * Known gap, stated rather than hidden: a **streaming** reply
       * (`input.onDelta`, used by the interactive REPL and by Telegram's
       * live-edited message) has already shown unscrubbed characters to the
       * screen by the time this line runs — this closes what is durably
       * written (the episode, the session transcript, a headless `muffin
       * run`'s stdout, and the final settled text of a streamed reply) and
       * does not retroactively unsend a frame that already rendered.
       *
       * #615: when prior iterations ended `max_tokens` with partial text,
       * `run.messages` already holds those accepted prefixes (explicit
       * `partial`-origin evidence, checkpointed — never inferred history).
       * The final answer is prefix + current chunk — ONE logical assistant
       * answer for Session/Memory — never the last chunk alone and never
       * multiple fake exchanges.
       */
      const prefixSoFar = collectTruncationPrefix(run.messages);
      const currentRaw = result.text ?? '';
      // Shared exact-prefix rule, same as the truncation path: FULL prefix
      // first, then LAST chunk. A final chunk that merely repeats already
      // accepted bytes adds nothing, and the live gate already suppressed it —
      // appending it here would diverge durable from visible.
      const suffix = resolveContinuationSuffix(
        prefixSoFar === '' ? undefined : prefixSoFar,
        lastPartialChunk(run.messages),
        currentRaw,
      );
      const fullRaw = prefixSoFar + suffix;
      const text = scrubResourceEchoes(redactText(fullRaw), run.sensitiveResourceEchoes);
      // Live fallback emission below must append, not duplicate: in streaming
      // mode the prefix was already shown via deltas, so a `chat()` fallback
      // for the final chunk owes only the new suffix. Durable `text` above
      // stays the scrubbed full concatenation either way.
      const currentText = scrubResourceEchoes(redactText(suffix), run.sensitiveResourceEchoes);

      // The completion gate: did the answer describe a call this turn never
      // made? Deterministic, tool-aware, and it only fires when *nothing* was
      // called — a denied or failed call is still a call, so a model saying
      // "non ho potuto usare fs_write" after a real refusal is out of scope.
      //
      // Its own flag, deliberately outside the profile's cascade: this check
      // is durable (07 classifies the profiles as impalcatura and says
      // nothing of it), it answers a false-success rate measured on every
      // model family including the reasoning ones, and a profile that
      // declares no crutches must still get it. One nudge, always available.
      const completion = checkCompletion({
        text,
        available: exposed.map((t) => t.spec.name),
        toolCallsMade: run.toolCallsMade,
      });
      if (!completion.ok) {
        turn.setAttributes({ 'muffin.completion.named_uncalled': completion.named.join(',') });
        if (run.nudgedForCompletion === false) {
          // One attempt, with the specific tools named. Vague feedback gets a
          // vague retry, and this is measured as the highest-value check in the
          // design — but it is a nudge, never a rewrite of what the agent said.
          // Harness control (see `recover` above), not owner words.
          run.nudgedForCompletion = true;
          closeLive('superseded');
          run.messages.push(harnessMessage('user', [{ type: 'text', text: completionNudge(completion.named) }]));
          continue;
        }
        // It stands. Recorded rather than corrected: silently editing the
        // answer would be a second dishonesty stacked on the first.
        turn.setAttributes({ 'muffin.completion.unresolved': true });
      }

      // This round answers, and no boundary will ever close it — which is
      // how a surface knows the text it has been receiving *is* the answer.
      //
      // The one thing left to do here is the round that asked to stream and
      // did not: a stream that broke and came back through `chat()`. It owes
      // the surface the whole text in one piece — the boundary above already
      // told the surface the partial draft was superseded, and without this
      // nothing would ever replace it.
      //
      // `call.stream` and not just `emittedLive`: a turn that never asked to
      // stream (no sink, or a provider with no `chatStream` at all) is left
      // exactly as it was, delivering its answer the way every surface
      // already handles — through `result.text`, not through this sink.
      //
      // #615: with a truncated prefix already shown via deltas, a `chat()`
      // fallback for the final chunk owes only that chunk — emitting the full
      // concatenation here would duplicate the visible prefix on the surface.
      if (input.onDelta && call.stream && !emittedLive && text !== '') {
        const emitText = prefixSoFar.length > 0 ? currentText : text;
        if (emitText !== '') input.onDelta({ type: 'text', text: emitText });
      }

      deps.sessions.append(input.session, {
        role: 'assistant',
        content: text,
        surface: input.surface,
        createdAt: now().toISOString(),
        traceId: turn.traceId,
        // The turn's *intrinsic* taint, not its ceiling (ADR-0044
        // §Riconciliazione 2026-08-28) — read the same way the memory episode
        // a few lines down does. Still everything this turn itself produced
        // or observed (a recall, a tool result this turn ran): 03 §2's rule
        // — an answer derived from tier-3 content is tier-3 the moment it is
        // written — is unchanged for that. What it excludes is a tier this
        // turn only *inherited* from reinjected history/plan: stamping that
        // here is what a *later*, unrelated turn's own clean reply would
        // reinject as if it, too, had derived from the tainted content —
        // the ratchet, not the provenance rule.
        tier: snapshot.intrinsicTaint(),
      });
      if (deps.memory && memoryDoorOpen()) {
        deps.memory.store.addEpisode({
          tenantId: input.tenant,
          connector: input.surface,
          threadKey: input.session.id,
          role: 'agent',
          kind: 'message',
          content: text,
          /**
           * The turn's own intrinsic tier, never a literal — and, since
           * ADR-0044 §Riconciliazione 2026-08-28, not the ceiling either.
           *
           * This line used to read `trustTier: 0`, and 03 §2 names exactly
           * what that is: «un riassunto di contenuto tier-3 è tier-3, sempre
           * — altrimenti la sintesi diventa una lavanderia del taint». The
           * model summarising a poisoned page into its reply is that summary,
           * and the whole of `raiseTaint` upstream was undone by one constant
           * on the way out. That argument still holds exactly as written —
           * `intrinsicTaint()` still rises for a page *this turn* read. What
           * it no longer inherits is a tier this turn only saw because an
           * unrelated old exchange was sitting in its reinjected history: a
           * plain "ciao" recalling a three-day-old note about a file read is
           * not a summary of that file, and stamping it as one is the second
           * defect the same date's fix named as still open.
           *
           * The laundering is not theoretical and it does not stop at the
           * write. `searchEpisodes` has no role filter and `indexBacklog`
           * indexes agent rows like any other, so tomorrow's recall fishes
           * this sentence back out; `recallTaint` takes the max over what it
           * found, sees 0, and raises nothing. What a web page said last week
           * would come back this week at the one tier that arms a proactive
           * trigger (`decideProactive` refuses tier > 1).
           *
           * *Chi* l'ha detto, invece, non si perde più, e questa riga lo
           * prediceva ancora: da `b9093ba` (19/08) `describeEpisodeSource`
           * (`core/memory/recall.ts`) separa lo speaker dal tier e rende un
           * episodio dell'agente come `Muffin`, su tutte e tre le vie di
           * recupero — non più «tu». Il codice si era mosso e il commento no;
           * una nota che predice un guasto già chiuso è il modo più efficiente
           * per farlo riaprire (memo continuità/provenienza 03/09 §6).
           *
           * Extraction is *not* what closes this: `ingest.ts` skips
           * `role: 'agent'` for its own reason (the agent's words are evidence
           * of what was said, never a source of facts), so no fact is ever
           * derived here and `trust_tier_raised` — which joins a fact to its
           * own episode — has nothing to fire on. The graph invariant cannot
           * see this defect at all. Recall can, and does.
           */
          trustTier: snapshot.intrinsicTaint(),
          createdAt: now().toISOString(),
          // Lo stesso `record.id` della riga dell owner qui sopra: le due
          // meta dello scambio portano un turno solo, che e la cosa che
          // rende "questo scambio e gia davanti al modello" una domanda con
          // risposta invece di un confronto di stringhe.
          turnId: record.id,
        });
      }
      return finish(scope, 'answered', text);
    }

    // Whatever this round said, it said it on the way to a tool call. The
    // boundary closes it as thinking aloud, and `onProgress`'s tool line
    // lands right under it.
    closeLive('tool-call');

    // Model's turn goes into the transcript before the results, so a crash
    // between the two leaves a record that explains itself.
    //
    // Reasoning first, unmodified, ahead of the `tool_use` blocks it came
    // with. This is the half the API calls **Required** — "within a tool-use
    // turn, pass thinking blocks back" — and the half that was missing: this
    // array used to be rebuilt from `text` + `toolCalls`, so whatever the
    // model thought was gone by iteration 2 of every tool-using turn. No 400
    // was ever going to tell us; the server strips or disables instead, so
    // the symptom was a worse agent and a colder cache, not an error.
    //
    // Spread of `result.thinking`, never a map or a filter: their order is
    // the model's and the contents are opaque. A `?? []` because an adapter
    // may legitimately have none (openai-compat says so with `[]`), not
    // because absence is expected here.
    run.messages.push({
      role: 'assistant',
      content: [
        ...(result.thinking ?? []),
        ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
        ...result.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args })),
      ],
      ...(result.providerMetadata === undefined ? {} : { providerMetadata: result.providerMetadata }),
    });
    // Checkpointed **here**, and not only at the top of the next iteration.
    //
    // This one line is what makes a resume able to tell a question from an
    // answer. Without it the persisted transcript stops at the start of the
    // iteration, so a process that dies mid-batch leaves a record with no
    // `tool_use` blocks in it — and `reconcile` below would have nothing to
    // repair, while the intent rows in `turn_tool_calls` described calls the
    // transcript did not contain. Two records of one batch, disagreeing.
    //
    // Checked before the tool calls below are allowed to run: a batch about
    // to have real effects is exactly the point `stillOwner`-style guards
    // exist for, and this table's own fencing is the one that reaches every
    // caller of `runTurn`/`resumeTurn`, not only the gateway's lanes.
    //
    // The residual window, named the way `core/scheduler/scheduler.ts`'s own
    // delivery check names its (judge, round 2, R4/R6): a claim stolen
    // *after* this line has already run is not seen here — this check only
    // sees a steal that happened before it — so the batch below can execute
    // under a claim that is taken from it moments later, and the loss is
    // only caught at the checkpoint that opens the next iteration of this
    // loop. Bounded by one batch's duration, and it is the effect the fenced
    // `checkpoint`/`finish`/`suspend` writes stop from *landing*, not one
    // that stops a tool call already in flight from completing.
    if (!checkpoint(scope)) return finish(scope, 'error', '');

    const results: ContentBlock[] = [];
    for (const call_ of result.toolCalls) {
      // Checked between tools, not only before the next model call: a Ctrl+C
      // during a run of tool calls used to do nothing visible until the batch
      // finished, which for a slow batch is indistinguishable from being
      // ignored.
      if (input.signal?.aborted) return finish(scope, 'aborted', 'Interrotto.');
      // The ceiling counts CALLS, not iterations. Nothing upstream bounds how
      // many `tool_use` blocks one completion carries — a single response
      // with 40 calls used to execute all 40 under a profile that promised 15
      // (E6, RETURN S3). Refused calls still get a tool_result: a hole in the
      // batch is a protocol error every provider rejects, and the model should
      // read why it was stopped instead of retrying blind.
      if (deps.profile.maxToolCallsPerTurn !== null && run.toolCallsMade >= deps.profile.maxToolCallsPerTurn) {
        results.push({
          type: 'tool_result',
          toolCallId: call_.id,
          content:
            `Tetto di ${deps.profile.maxToolCallsPerTurn} tool call per turno raggiunto: chiamata non eseguita. ` +
            `Chiudi il turno con quello che hai, o dì all'owner cosa resta da fare.`,
          isError: true,
        });
        continue;
      }
      run.toolCallsMade += 1;
      try {
        const outcome = await runTool(deps, snapshot, turn, call_, input, exposed, toolContext);
        results.push(outcome);
        noteSensitiveResourceEcho(call_, outcome);
      } catch (error) {
        if (error instanceof ApprovalRequired) {
          turn.setAttributes({ 'muffin.policy.approval': 'unavailable' });
          const stop = finish(
            scope,
            'ask',
            `Serve la tua approvazione per "${error.request.capability}"${error.request.resource ? ` su ${error.request.resource}` : ''}. Su questa superficie non posso chiederla.`,
          );
          return { ...stop, pending: error.request };
        }
        throw error;
      }
    }
    // Tool evidence, not owner words: the provider compiler may be forced to
    // render this as `role: 'user'` (Anthropic carries `tool_result` inside a
    // user message), but internally it stays tool-originated — `role` is never
    // the source of truth for what a block is.
    run.messages.push(toolMessage(results));
  }
}
