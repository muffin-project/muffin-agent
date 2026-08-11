import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from './openai-compat.js';
import type { ChatCall } from './types.js';

/**
 * The adapter's caching contract, tested against the bytes it actually sends.
 *
 * The stakes are money, not correctness: the production install talks to
 * OpenRouter routing Anthropic and Qwen models, and on both of those the cache
 * is **not** automatic — it exists only if the request carries `cache_control`
 * on a content block (verified on OpenRouter's own docs, 2026-08-11; Alibaba's
 * wording is identical to Anthropic's). This adapter received the `cache:
 * 'stable'` marker from the loop and dropped it, so every turn paid full input
 * price on ~3k system tokens the provider would have served at 0.1×. Invisible,
 * because `cacheWriteTokens` was hardcoded 0 and read as "cache unavailable".
 *
 * The other half of the contract matters as much: vanilla OpenAI-compatible
 * servers (Ollama, llama.cpp, vLLM) must keep receiving byte-identical requests
 * — a plain string system message — because their caching is implicit and an
 * unknown field on a strict server is a 400 in production.
 */

const A_COMPLETION = {
  id: 'x',
  choices: [{ message: { content: 'ciao', tool_calls: [] }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 3000,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 2800, cache_write_tokens: 150 },
  },
  model: 'anthropic/claude-sonnet-5',
};

/** A provider whose network is a recorder: returns the body it would have sent. */
function harness(explicitCache: boolean) {
  const bodies: unknown[] = [];
  const fetchFake = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify(A_COMPLETION), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
    explicitCache,
    fetch: fetchFake as never,
  });
  return { provider, bodies };
}

const CALL: ChatCall = {
  model: 'anthropic/claude-sonnet-5',
  maxOutputTokens: 100,
  temperature: 0,
  stream: false,
  system: [{ type: 'text', text: 'Sei Muffin.', cache: 'stable' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
};

type SystemPart = { type: string; text: string; cache_control?: { type: string } };
type Body = { messages: { role: string; content: string | SystemPart[] }[] };

describe('openai-compat · explicit prompt caching', () => {
  it('carries the stable marker as a cache_control breakpoint when the endpoint understands it', async () => {
    const h = harness(true);
    await h.provider.chat(CALL);

    const system = (h.bodies[0] as Body).messages[0]!;
    expect(system.role).toBe('system');
    // Parts, not a string — and the breakpoint on the stable block, in the
    // exact shape OpenRouter documents for Anthropic and Alibaba models.
    expect(Array.isArray(system.content)).toBe(true);
    const parts = system.content as SystemPart[];
    expect(parts[parts.length - 1]).toMatchObject({
      type: 'text',
      text: 'Sei Muffin.',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('sends vanilla servers exactly what it always sent', async () => {
    // Ollama, llama.cpp, vLLM: implicit caching, strict-ish parsers. The
    // default is off, and off means a plain string — not parts without the
    // field, which some servers also reject.
    const h = harness(false);
    await h.provider.chat(CALL);

    const system = (h.bodies[0] as Body).messages[0]!;
    expect(system.content).toBe('Sei Muffin.');
  });

  it('reports cache writes instead of hardcoding them to zero', async () => {
    // The hardcoded 0 was how a whole missing feature stayed invisible: the
    // owner reads "0 cached" as "cache unavailable" when the truth was "never
    // requested".
    const h = harness(true);
    const result = await h.provider.chat(CALL);

    expect(result.usage.cacheReadTokens).toBe(2800);
    expect(result.usage.cacheWriteTokens).toBe(150);
  });

  it('a block without the marker gets no breakpoint', async () => {
    const h = harness(true);
    await h.provider.chat({
      ...CALL,
      system: [
        { type: 'text', text: 'Sei Muffin.', cache: 'stable' },
        { type: 'text', text: `adesso sono le ${new Date().toISOString()}` },
      ],
    });

    const parts = ((h.bodies[0] as Body).messages[0]!.content) as SystemPart[];
    // The volatile tail rides after the breakpoint, uncached — marking it too
    // would burn a new cache entry every turn, which is worse than no cache.
    expect(parts[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(parts[1]?.cache_control).toBeUndefined();
  });
});
