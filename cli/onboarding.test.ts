import { describe, expect, it } from 'vitest';
import { inferProvider, isOpenRouterKey, keyHint, OPENROUTER_BASE_URL } from './onboarding.js';

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
