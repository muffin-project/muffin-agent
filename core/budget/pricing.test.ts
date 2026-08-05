import { describe, expect, it } from 'vitest';
import { costUsd, priceOf } from './pricing.js';

describe('pricing', () => {
  it('charges nothing for a model running on this machine', () => {
    // Billing a local model would trip the cap on the one configuration where
    // spending is not a risk.
    expect(priceOf('qwen3.6:27b', 'http://127.0.0.1:11434/v1')).toBeNull();
    expect(costUsd('gemma4:26b', { inputTokens: 1e6, outputTokens: 1e6 }, 'http://localhost:11434')).toBe(0);
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

  it('adds input and output', () => {
    expect(costUsd('anthropic/claude-haiku-4.5', { inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(6, 5);
  });
});
