import { describe, expect, it } from 'vitest';
import {
  chooseProvider,
  describeProviderChoice,
  inferProvider,
  isOpenRouterKey,
  keyHint,
  looksLikeTelegramToken,
  OPENROUTER_BASE_URL,
} from './onboarding.js';

describe('provider inference from key shape', () => {
  it('reads an OpenRouter key as the openai-compat gateway', () => {
    expect(isOpenRouterKey('sk-or-v1-abc123')).toBe(true);
    expect(inferProvider('sk-or-v1-abc123')).toBe('openai-compat');
  });

  it('reads an Anthropic key as anthropic direct', () => {
    expect(isOpenRouterKey('sk-ant-api03-xyz')).toBe(false);
    expect(inferProvider('sk-ant-api03-xyz')).toBe('anthropic');
  });

  it('does not guess an unknown prefix, leaving the default to the caller', () => {
    expect(inferProvider('xoxb-not-a-model-key')).toBeUndefined();
    expect(inferProvider(undefined)).toBeUndefined();
  });
});

describe('telegram bot token detection', () => {
  it('flags a telegram bot token shape (the real mistake that hit onboarding)', () => {
    expect(looksLikeTelegramToken('8712345678:AAExampleBotTokenLooksLikeThis_abcdef')).toBe(true);
  });

  it('does not flag real model keys or empties', () => {
    expect(looksLikeTelegramToken('sk-or-v1-abc')).toBe(false);
    expect(looksLikeTelegramToken('sk-ant-api03-xyz')).toBe(false);
    expect(looksLikeTelegramToken(undefined)).toBe(false);
  });
});

describe('key hint', () => {
  it('points an OpenRouter user at the keys page', () => {
    expect(keyHint('openai-compat', undefined)).toContain('openrouter.ai/keys');
    expect(keyHint(undefined, OPENROUTER_BASE_URL)).toContain('openrouter.ai/keys');
  });

  it('points an Anthropic user at the console', () => {
    expect(keyHint('anthropic', undefined)).toContain('console.anthropic.com');
  });

  it('offers both routes when the provider is not yet known', () => {
    const hint = keyHint(undefined, undefined);
    expect(hint).toContain('sk-or-');
    expect(hint).toContain('sk-ant-');
  });
});

describe('chooseProvider — the decision cmdInit used to make in two different places', () => {
  it('an explicit --provider always wins, and never auto-fills a base URL', () => {
    // Regression for the bug ADR-0036 named: `firstRun()` → `cmdInit([])` →
    // `runInit` used to see `options.provider ?? 'anthropic'` with nothing
    // upstream ever having looked at the key — this is the function that now
    // owns that decision, called exactly where the bug lived.
    const choice = chooseProvider('anthropic', 'sk-or-v1-should-be-ignored', undefined);
    expect(choice).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'explicit' });
  });

  it('an explicit --provider openai-compat still needs an explicit --base-url', () => {
    // Preserves the original asymmetry: only *inference* auto-fills the
    // OpenRouter URL. An owner who names the provider by hand is trusted to
    // name a non-default endpoint by hand too.
    const choice = chooseProvider('openai-compat', 'sk-or-v1-abc', undefined);
    expect(choice.baseUrl).toBeUndefined();
  });

  it('infers openai-compat from an OpenRouter key and fills its base URL', () => {
    const choice = chooseProvider(undefined, 'sk-or-v1-abc123', undefined);
    expect(choice).toEqual({ provider: 'openai-compat', baseUrl: OPENROUTER_BASE_URL, reason: 'inferred' });
  });

  it('an explicit --base-url overrides the inferred OpenRouter default', () => {
    const choice = chooseProvider(undefined, 'sk-or-v1-abc123', 'https://my-proxy.example.com/v1');
    expect(choice).toEqual({
      provider: 'openai-compat',
      baseUrl: 'https://my-proxy.example.com/v1',
      reason: 'inferred',
    });
  });

  it('infers anthropic from an Anthropic key, with no base URL to fill', () => {
    const choice = chooseProvider(undefined, 'sk-ant-api03-xyz', undefined);
    expect(choice).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'inferred' });
  });

  it('falls back to anthropic when there is a key but its prefix is unknown', () => {
    const choice = chooseProvider(undefined, 'xoxb-not-a-model-key', undefined);
    expect(choice).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'default' });
  });

  it('falls back to anthropic when there is no key at all yet', () => {
    const choice = chooseProvider(undefined, undefined, undefined);
    expect(choice).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'default' });
  });

  it('inference works the same whether the key is fresh or already stored — the fix ADR-0039 wired for the persisted key', () => {
    // `cmdInit` computes the same `keyForInference` regardless of source; this
    // is the property that made the fix apply to both paths without a second
    // branch of logic.
    const fresh = chooseProvider(undefined, 'sk-or-v1-fresh', undefined);
    const stored = chooseProvider(undefined, 'sk-or-v1-stored-and-reread-from-disk', undefined);
    expect(fresh.provider).toBe('openai-compat');
    expect(stored.provider).toBe('openai-compat');
  });
});

describe('describeProviderChoice — say what was inferred, never decide silently', () => {
  it('announces an explicit provider', () => {
    const line = describeProviderChoice({ provider: 'anthropic', baseUrl: undefined, reason: 'explicit' }, 'sk-ant-x');
    expect(line).toContain('anthropic');
    expect(line).toContain('--provider');
  });

  it('announces an inferred openai-compat provider with its base URL, and shows only the prefix of the key', () => {
    const choice = { provider: 'openai-compat' as const, baseUrl: OPENROUTER_BASE_URL, reason: 'inferred' as const };
    const line = describeProviderChoice(choice, 'sk-or-v1-the-real-secret-must-not-appear');
    expect(line).toContain('openai-compat');
    expect(line).toContain(OPENROUTER_BASE_URL);
    expect(line).toContain('dedotto');
    expect(line).not.toContain('the-real-secret-must-not-appear');
  });

  it('announces an inferred anthropic provider', () => {
    const choice = { provider: 'anthropic' as const, baseUrl: undefined, reason: 'inferred' as const };
    expect(describeProviderChoice(choice, 'sk-ant-x')).toContain('dedotto');
  });

  it('names the unrecognised key as the reason for the default, distinct from having no key at all', () => {
    const choice = { provider: 'anthropic' as const, baseUrl: undefined, reason: 'default' as const };
    const withKey = describeProviderChoice(choice, 'xoxb-unknown-shape');
    const withoutKey = describeProviderChoice(choice, undefined);
    expect(withKey).not.toBe(withoutKey);
    expect(withKey).toMatch(/non è sk-or|non.*dedurre|default/);
    expect(withoutKey).toContain('nessuna chiave');
  });
});
