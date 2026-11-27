import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  clampXaiReasoningEffort,
  OpenAICompatProvider,
  speaksXai,
  xaiCanDisableReasoning,
  xaiSpeaksReasoningEffort,
} from './openai-compat.js';
import type { ChatCall, StreamEvent } from './types.js';

const A_COMPLETION = {
  id: 'x',
  choices: [{ message: { content: 'ciao', tool_calls: [] }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 3000,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 2800, cache_write_tokens: 150 },
    completion_tokens_details: { reasoning_tokens: 3 },
  },
  model: 'grok-4.7',
};

const XAI = 'https://api.x.ai/v1';
const CALL: ChatCall = {
  model: 'grok-4.7',
  maxOutputTokens: 100,
  temperature: 0,
  stream: false,
  system: [{ type: 'text', text: 'Sei Muffin.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
};

function cacheKey(conversation: string): string {
  return createHash('sha256').update(conversation).digest('hex').slice(0, 32);
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const row = headers.find((entry) => entry[0]?.toLowerCase() === name.toLowerCase());
    return row?.[1];
  }
  const record = headers as Record<string, string>;
  const direct = record[name] ?? record[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const match = Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function xaiHarness(baseURL = XAI) {
  const bodies: Record<string, unknown>[] = [];
  const headerBags: Array<string | undefined> = [];
  const urls: string[] = [];
  const fetchFake = async (input: unknown, init?: RequestInit): Promise<Response> => {
    urls.push(
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input),
    );
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    headerBags.push(headerValue(init, 'x-grok-conv-id'));
    return new Response(JSON.stringify(A_COMPLETION), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = new OpenAICompatProvider('sk-test', baseURL, {}, { fetch: fetchFake as never });
  return { provider, bodies, headerBags, urls };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('speaksXai · hostname, not substring', () => {
  it('matches api.x.ai including trailing-dot and case, and rejects lookalikes', () => {
    expect(speaksXai('https://api.x.ai/v1')).toBe(true);
    expect(speaksXai('https://api.x.ai./v1')).toBe(true);
    expect(speaksXai('https://API.X.AI/v1')).toBe(true);
    expect(speaksXai('https://api.x.ai.evil.tld/v1')).toBe(false);
    expect(speaksXai('https://openrouter.ai/api/v1')).toBe(false);
    expect(speaksXai('http://localhost:11434/v1')).toBe(false);
    expect(speaksXai('not a url')).toBe(false);
    expect(speaksXai()).toBe(false);
  });
});

describe('xAI reasoning model detection', () => {
  it('accepts documented reasoning slugs and their aliases, and rejects the others', () => {
    for (const model of [
      'grok-4.7',
      'grok-4.7-latest',
      'Grok-4.7',
      'grok-4.6',
      'grok-4.5',
      'grok-4.3',
      'grok-4.20-multi-agent',
    ]) {
      expect(xaiSpeaksReasoningEffort(model)).toBe(true);
    }
    for (const model of [
      'grok-2',
      'grok-3',
      'grok-3-mini',
      'grok-4',
      'gpt-4o',
      'qwen/qwen3.8-27b',
    ]) {
      expect(xaiSpeaksReasoningEffort(model)).toBe(false);
    }
    expect(xaiCanDisableReasoning('grok-4.3')).toBe(true);
    expect(xaiCanDisableReasoning('grok-4.3-latest')).toBe(true);
    expect(xaiCanDisableReasoning('grok-4.7')).toBe(false);
    expect(clampXaiReasoningEffort('minimal')).toBe('low');
    expect(clampXaiReasoningEffort('max')).toBe('xhigh');
    expect(clampXaiReasoningEffort('high')).toBe('high');
  });
});

describe('openai-compat · api.x.ai reasoning_effort', () => {
  it('defaults the constructor from the endpoint without turning on the OpenRouter dialect', () => {
    const provider = new OpenAICompatProvider('k', XAI);
    expect(provider.xaiEndpoint).toBe(true);
    expect(provider.reasoningEffort).toBe(false);
    expect(provider.stickySession).toBe(false);
    expect(provider.explicitCache).toBe(false);
    expect(provider.reasoningDialect).toBeUndefined();
    expect(new OpenAICompatProvider('k', 'https://api.x.ai./v1').xaiEndpoint).toBe(true);
    expect(new OpenAICompatProvider('k', 'https://api.x.ai.evil.tld/v1').xaiEndpoint).toBe(false);
    expect(new OpenAICompatProvider('k', 'http://localhost:11434/v1').xaiEndpoint).toBe(false);
  });

  it('sends reasoning_effort low for adaptive/unset on grok-4.7, never the OpenRouter envelope', async () => {
    const h = xaiHarness();
    const unset = await h.provider.resolveReasoning({ ...CALL });
    expect(unset).toMatchObject({
      status: 'applied',
      capabilitySource: 'static-snapshot',
      effective: { mode: 'on', effort: 'low' },
    });
    await h.provider.chat({ ...CALL, thinking: 'adaptive' });
    expect(h.bodies[0]?.reasoning_effort).toBe('low');
    expect(h.bodies[0]).not.toHaveProperty('reasoning');
    expect(h.bodies[0]).not.toHaveProperty('session_id');
  });

  it('sends the profile effort when one is requested', async () => {
    const h = xaiHarness();
    await h.provider.chat({ ...CALL, reasoning: { mode: 'on', effort: 'medium' } });
    await h.provider.chat({ ...CALL, reasoning: { mode: 'on', effort: 'high' } });
    await h.provider.chat({ ...CALL, reasoning: { mode: 'on', effort: 'xhigh' } });
    expect(h.bodies.map((body) => body.reasoning_effort)).toEqual(['medium', 'high', 'xhigh']);
    const high = await h.provider.resolveReasoning({
      ...CALL,
      reasoning: { mode: 'on', effort: 'high' },
    });
    expect(high.status).toBe('applied');
    expect(high.effective).toEqual({ mode: 'on', effort: 'high' });
  });

  it('clamps off to low on grok-4.7 and does not send none', async () => {
    const h = xaiHarness();
    const resolution = await h.provider.resolveReasoning({ ...CALL, thinking: 'off' });
    expect(resolution.status).toBe('applied');
    expect(resolution.effective).toEqual({ mode: 'on', effort: 'low' });
    expect(resolution.reason).toMatch(/cannot be disabled/i);
    await h.provider.chat({ ...CALL, thinking: 'off' });
    expect(h.bodies[0]?.reasoning_effort).toBe('low');
  });

  it('sends none for off only on grok-4.3, which can disable reasoning', async () => {
    const h = xaiHarness();
    await h.provider.chat({ ...CALL, model: 'grok-4.3', thinking: 'off' });
    expect(h.bodies[0]?.reasoning_effort).toBe('none');
    const on = await h.provider.resolveReasoning({
      ...CALL,
      model: 'grok-4.3',
      reasoning: { mode: 'on', effort: 'low' },
    });
    expect(on.status).toBe('applied');
  });

  it('omits reasoning_effort on non-reasoning xAI models so they cannot 400', async () => {
    const h = xaiHarness();
    const resolution = await h.provider.resolveReasoning({
      ...CALL,
      model: 'grok-2',
      reasoning: { mode: 'on', effort: 'low' },
    });
    expect(resolution.status).toBe('omitted');
    expect(resolution.capabilitySource).toBe('endpoint-defaults');
    await h.provider.chat({ ...CALL, model: 'grok-2', reasoning: { mode: 'on', effort: 'low' } });
    expect(h.bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(h.bodies[0]).not.toHaveProperty('reasoning');
  });

  it('does not send reasoning_effort to a local OpenAI-compatible server', async () => {
    const h = xaiHarness('http://localhost:11434/v1');
    expect(h.provider.xaiEndpoint).toBe(false);
    await h.provider.chat({ ...CALL, reasoning: { mode: 'on', effort: 'low' } });
    expect(h.bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(h.bodies[0]).not.toHaveProperty('reasoning');
    const resolution = await h.provider.resolveReasoning({
      ...CALL,
      reasoning: { mode: 'on', effort: 'low' },
    });
    expect(resolution.status).toBe('omitted');
  });

  it('clamps minimal/max to documented xAI values', async () => {
    const h = xaiHarness();
    await h.provider.chat({ ...CALL, reasoning: { mode: 'on', effort: 'minimal' } });
    await h.provider.chat({ ...CALL, reasoning: { mode: 'on', effort: 'max' } });
    expect(h.bodies.map((body) => body.reasoning_effort)).toEqual(['low', 'xhigh']);
  });

  it('sends the same field on the stream path the turn actually uses', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFake = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      const payload = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'grok-4.7',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'ciao' }, finish_reason: 'stop' },
        ],
      };
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const provider = new OpenAICompatProvider('sk-test', XAI, {}, { fetch: fetchFake as never });
    await collect(provider.chatStream({ ...CALL, thinking: 'adaptive', stream: true }));
    expect(bodies[0]?.reasoning_effort).toBe('low');
    expect(bodies[0]).not.toHaveProperty('reasoning');
  });
});

describe('openai-compat · api.x.ai prompt cache key', () => {
  it('sends a session-stable prompt_cache_key and x-grok-conv-id derived from the conversation id', async () => {
    const h = xaiHarness();
    const conversation = 'sess-1#g0';
    await h.provider.chat({ ...CALL, conversation });
    await h.provider.chat({ ...CALL, conversation });
    const expected = cacheKey(conversation);
    expect(h.bodies[0]?.prompt_cache_key).toBe(expected);
    expect(h.bodies[1]?.prompt_cache_key).toBe(expected);
    expect(h.headerBags[0]).toBe(expected);
    expect(h.headerBags[1]).toBe(expected);
    expect(h.bodies[0]).not.toHaveProperty('session_id');
  });

  it('changes the key when the conversation changes, and omits it when none is given', async () => {
    const h = xaiHarness();
    await h.provider.chat({ ...CALL, conversation: 'sess-1#g0' });
    await h.provider.chat({ ...CALL, conversation: 'sess-1#g1' });
    await h.provider.chat({ ...CALL });
    expect(h.bodies[0]?.prompt_cache_key).not.toBe(h.bodies[1]?.prompt_cache_key);
    expect(h.headerBags[0]).not.toBe(h.headerBags[1]);
    expect(h.bodies[2]).not.toHaveProperty('prompt_cache_key');
    expect(h.headerBags[2]).toBeUndefined();
  });

  it('does not send the xAI cache fields to OpenRouter (which uses session_id instead)', async () => {
    const bodies: Record<string, unknown>[] = [];
    const headerBags: Array<string | undefined> = [];
    const fetchFake = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      headerBags.push(headerValue(init, 'x-grok-conv-id'));
      return new Response(JSON.stringify(A_COMPLETION), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = new OpenAICompatProvider(
      'sk-test',
      'https://openrouter.ai/api/v1',
      {},
      { fetch: fetchFake as never, discoverReasoning: false },
    );
    await provider.chat({ ...CALL, conversation: 'sess-1#g0' });
    expect(typeof bodies[0]?.session_id).toBe('string');
    expect(bodies[0]).not.toHaveProperty('prompt_cache_key');
    expect(headerBags[0]).toBeUndefined();
  });
});
