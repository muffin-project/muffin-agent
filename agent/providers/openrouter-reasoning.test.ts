import { describe, expect, it } from 'vitest';
import { OpenRouterReasoningDiscovery } from './openrouter-reasoning.js';

const BASE = 'https://openrouter.ai/api/v1';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('OpenRouter reasoning discovery', () => {
  it('fetches once, then serves a fresh cache hit', async () => {
    let calls = 0;
    const discovery = new OpenRouterReasoningDiscovery({
      fetch: async () => {
        calls += 1;
        return response({ id: 'qwen/qwen3.8-27b', reasoning: { mandatory: false, default_enabled: true, default_effort: 'xhigh', supported_efforts: ['xhigh', 'medium', 'low'] } });
      },
      now: () => 100,
      ttlMs: 1_000,
    });

    const first = await discovery.resolve(BASE, 'qwen/qwen3.8-27b');
    const second = await discovery.resolve(BASE, 'qwen/qwen3.8-27b');

    expect(calls).toBe(1);
    expect(first.source).toBe('openrouter-live');
    expect(second.source).toBe('openrouter-cache');
    expect(second.capabilities.supportedEfforts).toEqual(['xhigh', 'medium', 'low']);
  });

  it('expires cached metadata and does not turn a discovery error into unsupported', async () => {
    let now = 100;
    let calls = 0;
    const discovery = new OpenRouterReasoningDiscovery({
      fetch: async () => {
        calls += 1;
        if (calls === 1) return response({ reasoning: { mandatory: false, supported_efforts: ['low'] } });
        throw new Error('metadata unavailable');
      },
      now: () => now,
      ttlMs: 10,
    });

    expect((await discovery.resolve(BASE, 'vendor/model')).source).toBe('openrouter-live');
    now = 111;
    const expired = await discovery.resolve(BASE, 'vendor/model');

    expect(expired.source).toBe('unknown');
    expect(expired.capabilities.support).toBe('unknown');
    expect(calls).toBe(2);
  });

  it('rejects malformed model keys before making a request', async () => {
    const discovery = new OpenRouterReasoningDiscovery({ fetch: async () => response({}) });
    const result = await discovery.resolve(BASE, 'not-canonical');

    expect(result.source).toBe('unknown');
    expect(result.capabilities.support).toBe('unknown');
  });

  it('treats openrouter/free as a dynamic router without a fixed reasoning capability', async () => {
    const discovery = new OpenRouterReasoningDiscovery({ fetch: async () => response({ id: 'openrouter/free' }) });
    const result = await discovery.resolve(BASE, 'openrouter/free');

    expect(result.capabilities.support).toBe('unsupported');
    expect(result.source).toBe('openrouter-live');
  });
});
