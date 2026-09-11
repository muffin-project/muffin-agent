import { describe, expect, it } from 'vitest';
import { costUsd, isOpenRouterFreeRoute, priceOf } from './pricing.js';

const OPENROUTER = 'https://openrouter.ai/api/v1';

describe('pricing', () => {
  it('charges nothing for a model running on this machine', () => {
    // Billing a local model would trip the cap on the one configuration where
    // spending is not a risk.
    expect(priceOf('qwen3.6:27b', 'http://127.0.0.1:11434/v1')).toBeNull();
    expect(costUsd('gemma4:26b', { inputTokens: 1e6, outputTokens: 1e6 }, 'http://localhost:11434')).toBe(0);
  });

  it('recognizes OpenRouter free routing as an explicit zero-price contract', () => {
    expect(isOpenRouterFreeRoute('openrouter/free', OPENROUTER)).toBe(true);
    expect(priceOf('openrouter/free', OPENROUTER)).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(costUsd('openrouter/free', { inputTokens: 1e6, outputTokens: 1e6 }, OPENROUTER)).toBe(0);
  });

  it('recognizes explicit :free variants only on the OpenRouter endpoint', () => {
    expect(isOpenRouterFreeRoute('qwen/qwen3.8-27b:free', OPENROUTER)).toBe(true);
    expect(costUsd('qwen/qwen3.8-27b:free', { inputTokens: 1e6, outputTokens: 1e6 }, OPENROUTER)).toBe(0);
    expect(isOpenRouterFreeRoute('qwen/qwen3.8-27b:free', 'https://example.invalid/v1')).toBe(false);
    expect(costUsd('qwen/qwen3.8-27b:free', { inputTokens: 1e6, outputTokens: 1e6 }, 'https://example.invalid/v1')).toBeCloseTo(8, 5);
  });

  it('does not confuse OpenRouter auto routing with the free router', () => {
    expect(isOpenRouterFreeRoute('openrouter/auto', OPENROUTER)).toBe(false);
    expect(priceOf('openrouter/auto', OPENROUTER)).toEqual({ inputPerMTok: 15, outputPerMTok: 75 });
  });

  it('charges an unknown model at the highest rate it knows', () => {
    // Wrong in the direction that trips the cap early rather than never.
    const unknown = costUsd('some-new-model-v9', { inputTokens: 1e6, outputTokens: 0 });
    const opus = costUsd('anthropic/claude-opus-4.7', { inputTokens: 1e6, outputTokens: 0 });
    expect(unknown).toBe(opus);
  });

  it('bills cache reads at the cached rate', () => {
    const cold = costUsd('anthropic/claude-sonnet-5', { inputTokens: 1e6, outputTokens: 0 });
    const warm = costUsd('anthropic/claude-sonnet-5', {
      inputTokens: 1e6,
      outputTokens: 0,
      cacheReadTokens: 1e6,
    });
    expect(cold).toBeCloseTo(3, 5);
    expect(warm).toBeCloseTo(0.3, 5);
  });

  it('bills the cache-write premium, in the direction the header calls safe', () => {
    // The premium was ignored with a comment claiming that was "the safe
    // direction" — but this file's header defines safe as charging HIGH so the
    // cap trips early. Under-charging trips it late, on an unattended budget.
    // 1M written at sonnet-5 rates: 3.00 base + 0.25 × 3.00 premium.
    const withWrites = costUsd('anthropic/claude-sonnet-5', {
      inputTokens: 1e6,
      outputTokens: 0,
      cacheWriteTokens: 1e6,
    });
    expect(withWrites).toBeCloseTo(3.75, 5);
  });

  it('adds input and output', () => {
    expect(costUsd('anthropic/claude-haiku-4.5', { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(6, 5);
  });
});

/**
 * Re-verified 2026-09-04 against `openrouter.ai` (the actual billing surface
 * for every non-Anthropic model, `agent/providers/openai-compat.ts`) — see
 * `pricing.ts`'s own docstring on `PRICES` for the per-family sources. Five
 * of the eight patterns were undercharging the family's own flagship/highest
 * priced host by 3×–20×, which is wrong in the direction this file's header
 * calls dangerous: an underpriced model lets an unattended budget run past
 * its real dollar cost before the cap notices.
 *
 * One assertion per family, each pinned to the exact new floor measured —
 * not "greater than the old value" (a mutation that halved the new price
 * would still pass that) but the specific number the research found, so a
 * silent drift back toward the old underestimate goes red here.
 */
describe('le cinque famiglie open-weight misurate 2026-09-04', () => {
  it('gpt-oss: $0.35/$0.75 (Cerebras, il host più caro per gpt-oss-120b)', () => {
    expect(costUsd('openai/gpt-oss-120b', { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(1.1, 5);
  });

  it('qwen3: $2/$6 (qwen3.8-max, il più caro della linea qwen3.x)', () => {
    expect(costUsd('qwen/qwen3.8-max', { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(8, 5);
  });

  it('gemma: $0.15/$0.6 (Gemma 4 26B-A4B su Google Vertex)', () => {
    expect(costUsd('google/gemma-4-26b-a4b-it', { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(0.75, 5);
  });

  it('glm: $1.4/$4.4 (GLM-5.3, il flagship — non la variante flash)', () => {
    expect(costUsd('z-ai/glm-5.3', { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(5.8, 5);
  });

  it('deepseek: $1.12/$3.35 (deepseek-v4-pro, non la tariffa "flash")', () => {
    expect(costUsd('deepseek/deepseek-v4-pro-0813', { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(4.47, 5);
  });
});
