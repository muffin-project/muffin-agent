import { sleep } from '../../core/net/sleep.js';
import { retryDelayMs } from '../loop/stream.js';
import { MAX_LIGHT_TRANSPORT_RETRIES } from '../loop/types.js';
import { DEFAULT_EXECUTION, type Profile } from '../profiles/profile.js';
import { ProviderError, type ChatCall, type ChatResult, type Provider } from './types.js';

/**
 * The light lane's missing half of the loop.
 *
 * `agent/loop.ts` does two things around every `provider.chat` that have nothing
 * to do with the loop: it bills the call, and it turns the profile's `sampling`
 * into what the wire is allowed to carry. The memory lane — extraction, the
 * contradiction judge, the reranker — is a **second entry point to the same
 * provider** and got neither, so both defects were real and both were invisible:
 *
 *  - **Spend.** `recordSpend` is a `LoopDeps` field called only from the loop.
 *    `/spend`, the monthly cap and the kernel's `budget_exhausted` branch all
 *    read zero from the memory lane. That was tolerable while the only caller
 *    was a hand-typed `muffin memory extract`; ADR-0038 makes consolidation run
 *    by itself, repeatedly, with nobody watching, and an unattended lane outside
 *    the cap is the shape of the $47 echo loop `core/budget/budget.ts` names.
 *  - **Sampling.** `core/memory/{extract,judge,rerank}.ts` each hardcode
 *    `temperature: 0` outside the profile system. Legal only because the shipped
 *    light model is haiku 4.5; a 400 on every consolidation the day
 *    `--light-model` points at anything 4.7 or later, and — the part that makes
 *    it worse than the loop's old hardcode — *no profile edit can reach it*,
 *    because that lane never loads a profile at all.
 *  - **Retry ownership.** Both SDKs are constructed with `maxRetries: 0` now,
 *    which is correct for the main loop because `RoundScope` owns an explicit
 *    transport-retry budget. The light lane does not enter that loop. Without
 *    an owner here, turning off SDK retries silently changes extraction/judge/
 *    rerank from three bounded wire attempts to one. This wrapper therefore
 *    owns a separate, smaller retry budget for this entry point — transport
 *    failures only, never malformed model output — and shares the main lane's
 *    backoff primitive without inheriting its longer interactive budget.
 *
 * ## Why a wrapper and not a parameter threaded through the three files
 *
 * Threading `sampling`, retry and a spend callback through `extractFacts`,
 * `judgeContradiction` and `LlmReranker` fixes the three call sites that exist
 * today. It does nothing for the fourth. This repo's recorded failure is not a
 * wrong line, it is *a mechanism a later caller did not know to reach* — four
 * defences with correct logic and no caller (`AGENTS.md`). A boundary the light
 * provider is constructed behind cannot be forgotten by code that has not been
 * written yet: whatever calls `runtime.light.provider` is billed, retried and
 * legal on the wire, without knowing this file exists.
 *
 * The three `temperature: 0` literals stay where they are and keep meaning what
 * they say — *this job wants determinism*. This boundary is where that request
 * meets what the model accepts, exactly as the loop's `profile.sampling` spread
 * does for the main lane. Neither side guesses at the other.
 */

export type LightSpend = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type LightLaneOptions = {
  /** The profile resolved for the *light* model id, not the main one. */
  profile: Profile;
  /**
   * Bills the call. Optional for the same reason `LoopDeps.recordSpend` is: a
   * test builds a lane without a budget engine. Absent in production means the
   * caps are decorative, which is what `doctor` reports.
   */
  record?: ((entry: LightSpend) => void) | undefined;
};

/**
 * One logical light-lane request with Muffin — not an SDK — owning retry.
 *
 * `ProviderError.source === 'output'` is deliberately excluded even when the
 * adapter marks it retryable: malformed tool/JSON output is a model-recovery
 * problem, and waiting before asking the same thing again cannot repair bytes
 * the model already generated. The main loop makes the identical distinction.
 *
 * `sleep` resolves when the signal aborts, so the explicit check immediately
 * after it is load-bearing: without it an owner stop during backoff would wake
 * the loop and launch one more paid request with an already-aborted signal.
 *
 * The whole logical request — attempts plus waits — lives under one deadline
 * (#497): the LIGHT profile's own `turnWallDeadlineMs`, combined with the
 * caller's signal. That field is the profile's total wall budget for the unit
 * it governs; on this lane the governed unit is one logical request, not a
 * turn, and `modelCallDeadlineMs` stays per-attempt — reusing it for the whole
 * request would silently change its meaning. The bound is independent from
 * main by construction: it is read from this lane's profile, never the main
 * one, with no shared governor and no lane mutex. A Retry-After longer than
 * the remaining request lifetime wakes at the lifetime and throws a
 * non-retryable deadline error — never another provider attempt, and never a
 * retryable transport failure for the caller to repeat.
 */
async function chatWithTransportRetries(
  inner: Provider,
  call: ChatCall,
  requestDeadlineMs: number,
): Promise<ChatResult> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort('light_request_deadline'), requestDeadlineMs);
  // The request's own lifetime must bound the work, not keep an otherwise
  // finished process alive: like the turn wall timer, a pure observer.
  timer.unref?.();
  const requestSignal =
    call.signal === undefined ? deadline.signal : AbortSignal.any([call.signal, deadline.signal]);
  const deadlineExceeded = (): ProviderError =>
    new ProviderError(`light request exceeded its ${requestDeadlineMs}ms deadline without a usable reply`, false);
  try {
    let retriesLeft = MAX_LIGHT_TRANSPORT_RETRIES;
    while (true) {
      try {
        return await inner.chat({ ...call, signal: requestSignal });
      } catch (error) {
        // A deadline-aborted attempt is not a transport failure and not a
        // user stop: name it, and make it non-retryable so no caller repeats
        // a request whose lifetime is already over.
        if (deadline.signal.aborted && !(call.signal?.aborted ?? false)) throw deadlineExceeded();
        if (
          !(error instanceof ProviderError) ||
          !error.retryable ||
          error.source !== 'transport' ||
          retriesLeft <= 0
        ) {
          throw error;
        }
        retriesLeft -= 1;
        const attempt = MAX_LIGHT_TRANSPORT_RETRIES - retriesLeft;
        // Come la corsia main (`round.ts`): una finestra `Retry-After`
        // dichiarata dal provider allunga l'attesa oltre il backoff cieco
        // quando è più lunga (#496). Stessa semantica, tetto diverso (qui:
        // la lifetime logica della richiesta, non il muro del turno —
        // questa corsia non entra in quella gabbia).
        await sleep(Math.max(retryDelayMs(attempt), error.retryAfterMs ?? 0), requestSignal);
        if (call.signal?.aborted) throw error;
        if (deadline.signal.aborted) throw deadlineExceeded();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps a provider so every call on the light lane is billed, retried and
 * carries the sampling parameter its model accepts.
 *
 * Returns the provider unchanged in neither case — always a wrapper, even when
 * `record` is absent, because sampling and retry ownership are not optional and
 * a conditional wrapper is a second code path that only the unconfigured
 * install exercises.
 */
export function lightLane(inner: Provider, options: LightLaneOptions): Provider {
  // The logical request's own lifetime, from this lane's profile (§ sopra):
  // programmatic callers without an execution policy inherit the same floor
  // the loop falls back to, not an unbounded wait.
  const requestDeadlineMs =
    options.profile.execution?.turnWallDeadlineMs ?? DEFAULT_EXECUTION.turnWallDeadlineMs;
  return {
    kind: inner.kind,
    async chat(call: ChatCall): Promise<ChatResult> {
      const result = await chatWithTransportRetries(inner, sampled(call, options.profile), requestDeadlineMs);
      // Billed after the logical call returns, like the loop: retries are one
      // request outcome, not three charges invented from failures whose usage
      // the provider never returned.
      options.record?.({
        // `result.model` and not `call.model`: the price table is keyed on what served
        // the request, and the two differ on every alias.
        model: result.model || call.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
      });
      return result;
    },
  };
}

/**
 * Strips `temperature` when the light model's profile says the model refuses it.
 *
 * Deletion rather than `temperature: undefined`, for the reason `agent/loop.ts`
 * spells out at its own spread: under `exactOptionalPropertyTypes` an explicit
 * `undefined` can still be serialised as a key, and a present key is exactly
 * what the newest models reject.
 */
function sampled(call: ChatCall, profile: Profile): ChatCall {
  if (profile.sampling === 'deterministic') return call;
  if (call.temperature === undefined) return call;
  const { temperature: _dropped, ...rest } = call;
  return rest;
}
