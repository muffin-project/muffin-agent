import type { Profile } from '../profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './types.js';

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
 *
 * ## Why a wrapper and not a parameter threaded through the three files
 *
 * Threading `sampling` and a spend callback through `extractFacts`,
 * `judgeContradiction` and `LlmReranker` fixes the three call sites that exist
 * today. It does nothing for the fourth. This repo's recorded failure is not a
 * wrong line, it is *a mechanism a later caller did not know to reach* — four
 * defences with correct logic and no caller (`AGENTS.md`). A boundary the light
 * provider is constructed behind cannot be forgotten by code that has not been
 * written yet: whatever calls `runtime.light.provider` is billed and is legal on
 * the wire, without knowing this file exists.
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
 * Wraps a provider so every call on the light lane is billed and carries the
 * sampling parameter its model accepts.
 *
 * Returns the provider unchanged in neither case — always a wrapper, even when
 * `record` is absent, because the sampling correction is not optional and a
 * conditional wrapper is a second code path that only the unconfigured install
 * exercises.
 */
export function lightLane(inner: Provider, options: LightLaneOptions): Provider {
  return {
    kind: inner.kind,
    async chat(call: ChatCall): Promise<ChatResult> {
      const result = await inner.chat(sampled(call, options.profile));
      // Billed after the call returns, like the loop: a call that threw cost
      // nothing we can measure, and inventing a number for it would make the
      // cap trip on failures.
      options.record?.({
        // `result.model` and not `call.model`: the provider is the authority on
        // what actually served the request, and the price table is keyed on it.
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
