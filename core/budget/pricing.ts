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

/** Public list prices, 2026-08. Matched by substring, longest pattern first. */
const PRICES: [pattern: string, price: Price][] = [
  ['claude-opus', { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 }],
  ['claude-sonnet', { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }],
  ['claude-haiku', { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1 }],
  ['gpt-oss', { inputPerMTok: 0.05, outputPerMTok: 0.2 }],
  ['qwen3', { inputPerMTok: 0.1, outputPerMTok: 0.3 }],
  ['gemma', { inputPerMTok: 0.13, outputPerMTok: 0.4 }],
  ['glm', { inputPerMTok: 0.1, outputPerMTok: 0.3 }],
  ['deepseek', { inputPerMTok: 0.3, outputPerMTok: 1.1 }],
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
