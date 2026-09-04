/**
 * What a call costs.
 *
 * This file is the reason the budget engine stopped being decorative. The
 * engine, its schema, its two caps and its five tests all existed and were
 * correct; nothing ever called `record()`, because nothing could turn tokens
 * into dollars. So `exhausted()` answered `false` for ever, the kernel's
 * `budget_exhausted` branch was unreachable, and `/spend` would have reported
 * $0.00 after a night of unattended looping.
 *
 * Prices are per million tokens, in USD, and they are **hardcoded on purpose**.
 * A tuning value that lives in the environment is a value that differs between
 * the laptop and the server and gets discovered wrong months later. When a
 * price changes, it changes here, in a diff, with a date.
 *
 * Being wrong here is not dangerous in the direction that matters: an unknown
 * model is charged at the highest known rate, so the cap trips early rather
 * than never.
 */

export type Price = { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number };

/**
 * Public list prices. Matched by substring, longest pattern first.
 *
 * **Re-verified 2026-09-04, from the source, not from memory or the previous
 * diff.** The three Claude rows were checked against
 * `platform.claude.com/docs/en/about-claude/pricing` (fetched directly) and
 * left as they were: `claude-haiku` matches Haiku 4.5 exactly ($1/$5), and
 * `claude-opus`/`claude-sonnet` sit ABOVE the current flagships (Opus 5 is
 * $5/$25, not $15/$75; Sonnet 5's $2/$10 launch price is now confirmed
 * permanent, not $3/$15) — stale toward the safe side this header already
 * names, so left alone rather than tightened.
 *
 * The five open-weight rows were a different measurement, and wrong in the
 * dangerous direction. These families have no single "official" price —
 * they are weights, hosted by whichever provider will run them — so the
 * number here has to answer "what does THIS install actually get billed",
 * which is whatever the OpenRouter-compatible endpoint charges
 * (`agent/providers/openai-compat.ts` is the door every non-Anthropic model
 * goes through). Fetched `openrouter.ai/api/v1/models` and the per-model
 * pricing pages directly, 2026-09-04, and took the highest rate any listed
 * host charged for the family's current generation — the same "charge HIGH"
 * rule this file already applies to `UNKNOWN`, now applied inside each
 * pattern too, because a family spans hosts at prices five to twenty times
 * apart and picking the cheap one is how five of these eight rows had gone
 * quietly wrong:
 *
 *   - `gpt-oss`: was $0.05/$0.2, measured $0.02–0.35/$0.10–0.75 across hosts
 *     for gpt-oss-120b/20b (`openrouter.ai/openai/gpt-oss-120b`) — Cerebras's
 *     $0.35/$0.75 is the ceiling used here, 7×/3.75× the old number.
 *   - `qwen3`: was $0.1/$0.3, measured $0.03–2.00/$0.13–6.00 across the
 *     qwen3.x line (`openrouter.ai/api/v1/models`) — the flagship
 *     qwen3.8-max ceiling is 20× the old number on both sides.
 *   - `gemma`: was $0.13/$0.4, measured up to $0.15/$0.60 for Gemma 4
 *     26B-A4B on Google Vertex (`openrouter.ai/google/gemma-4-26b-a4b-it`) —
 *     the smallest miss of the five, but still under the ceiling.
 *   - `glm`: was $0.1/$0.3, measured up to $1.40/$4.40 for GLM-5.3
 *     (`openrouter.ai/api/v1/models`) — 14×/~15× the old number.
 *   - `deepseek`: was $0.3/$1.1, measured up to $1.1154/$3.3462 for
 *     deepseek-v4-pro-0813 (`openrouter.ai/api/v1/models`), rounded up —
 *     the old number was tuned to the cheap "flash" tier and undercharged
 *     the "pro" tier this repo's own model comparison
 *     (`docs/evidence/economia-dei-modelli.md`) already flags as the one
 *     used for real capability.
 */
const PRICES: [pattern: string, price: Price][] = [
  ['claude-opus', { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 }],
  ['claude-sonnet', { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }],
  ['claude-haiku', { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1 }],
  ['gpt-oss', { inputPerMTok: 0.35, outputPerMTok: 0.75 }],
  ['qwen3', { inputPerMTok: 2, outputPerMTok: 6 }],
  ['gemma', { inputPerMTok: 0.15, outputPerMTok: 0.6 }],
  ['glm', { inputPerMTok: 1.4, outputPerMTok: 4.4 }],
  ['deepseek', { inputPerMTok: 1.12, outputPerMTok: 3.35 }],
];

/**
 * A model running on the local machine costs nothing to bill, and pretending
 * otherwise would make the cap fire on the one configuration where spending is
 * not a risk.
 */
const LOCAL_HINTS = ['ollama', 'localhost', '127.0.0.1', 'llama.cpp'];

/** The most expensive thing we know about, for models we do not recognise. */
const UNKNOWN: Price = { inputPerMTok: 15, outputPerMTok: 75 };

export function priceOf(model: string, baseUrl?: string): Price | null {
  const haystack = `${model} ${baseUrl ?? ''}`.toLowerCase();
  if (LOCAL_HINTS.some((h) => haystack.includes(h))) return null;
  const id = model.toLowerCase();
  for (const [pattern, price] of PRICES) {
    if (id.includes(pattern)) return price;
  }
  return UNKNOWN;
}

export type Tokens = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** Zero for a local model — not "unknown", zero, and the caller can tell. */
export function costUsd(model: string, tokens: Tokens, baseUrl?: string): number {
  const price = priceOf(model, baseUrl);
  if (price === null) return 0;
  const cached = tokens.cacheReadTokens ?? 0;
  const written = tokens.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, tokens.inputTokens - cached);
  // Cache reads bill at a fraction. Cache writes carry a 25% premium on
  // Anthropic and Alibaba, billed here as a surcharge on top of the input rate.
  // The earlier version ignored it "in the safe direction" — but this file's
  // own header defines safe as charging HIGH so the cap trips early, and
  // under-charging trips it late.
  //
  // The surcharge is exact only where inputTokens INCLUDES the written tokens,
  // which is true on the OpenRouter compat wire (prompt_tokens is the total).
  // On the native Anthropic adapter it is not: input_tokens there is the
  // uncached remainder, so written tokens bill at 0.25× against a true 1.25× —
  // an UNDER-count, in the direction this header calls dangerous. The fix is
  // normalizing at that adapter's boundary (sum the three usage fields), which
  // also repairs the pre-existing double-subtraction of cache reads below; it
  // touches a bug older than the cache slice and is filed, not smuggled in.
  const inputUsd =
    (fresh * price.inputPerMTok +
      cached * (price.cachedInputPerMTok ?? price.inputPerMTok) +
      written * 0.25 * price.inputPerMTok) /
    1e6;
  return inputUsd + (tokens.outputTokens * price.outputPerMTok) / 1e6;
}
