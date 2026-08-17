import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider, wantsExplicitCache } from './openai-compat.js';
import { ProviderStreamError, type ChatCall, type StreamEvent } from './types.js';

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

describe('wantsExplicitCache · the endpoint decides, and the default is the decision', () => {
  it('defaults from the endpoint, so a caller that forgets the flag cannot silently pay full price', () => {
    // The first version made every caller pass the flag; two eval harnesses
    // immediately built the provider without it and ran extraction rounds at
    // full price against the very endpoint the flag exists for. The default is
    // the fix, and this is the only test that exercises it: every other site
    // passes the value explicitly, which is how a flipped default stayed green.
    expect(new OpenAICompatProvider('k', 'https://openrouter.ai/api/v1').explicitCache).toBe(true);
    expect(new OpenAICompatProvider('k', 'http://localhost:11434/v1').explicitCache).toBe(false);
    expect(new OpenAICompatProvider('k').explicitCache).toBe(false);
  });

  it('matches the endpoint, not the spelling', () => {
    // The trailing-dot form is the same endpoint in DNS and a different string
    // in a regex — and a miss here does not fail, it pays 10× forever.
    expect(wantsExplicitCache('https://openrouter.ai./api/v1')).toBe(true);
    expect(wantsExplicitCache('https://OPENROUTER.AI/api/v1')).toBe(true);
    expect(wantsExplicitCache('https://openrouter.ai.evil.tld/v1')).toBe(false);
    expect(wantsExplicitCache('not a url')).toBe(false);
  });
});

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

/**
 * `chatStream` — B11. Wire format (`data: {...}` lines, no `event:` prefix,
 * terminated by the wire's own `data: [DONE]`) verified against
 * developers.openai.com's chat-completions streaming-events reference and the
 * installed SDK's own `Stream<ChatCompletionChunk>` (`node_modules/openai`
 * v7.4.0), 2026-08-16.
 */
function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** A `Response` whose body streams `chunks` one at a time (a tick apart — see anthropic.test.ts's twin for why), then optionally errors instead of closing. */
function streamedResponse(chunks: string[], breakAfter?: number): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [i, chunk] of chunks.entries()) {
        if (breakAfter !== undefined && i === breakAfter) {
          controller.error(new Error('socket hang up'));
          return;
        }
        controller.enqueue(encoder.encode(chunk));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function streamHarness(response: Response) {
  const fetchFake = async (): Promise<Response> => response;
  return new OpenAICompatProvider('sk-test', 'https://openrouter.test/v1', {}, { fetch: fetchFake as never });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const CHUNK = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'anthropic/claude-sonnet-5',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const FULL_STREAM_CHUNKS: string[] = [
  sseLine(CHUNK({ role: 'assistant', content: '' })),
  sseLine(CHUNK({ content: 'ciao' })),
  sseLine(CHUNK({ content: ' mondo' })),
  sseLine(CHUNK({}, 'stop')),
  sseLine({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'anthropic/claude-sonnet-5', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } } }),
  'data: [DONE]\n\n',
];

describe('openai-compat · chatStream (B11)', () => {
  it('yields text deltas as they arrive and a done event with the same ChatResult chat() would return', async () => {
    const provider = streamHarness(streamedResponse(FULL_STREAM_CHUNKS));
    const events = await collect(provider.chatStream(CALL));

    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual(['ciao', ' mondo']);
    const done = events[events.length - 1]!;
    expect(done.type).toBe('done');
    if (done.type !== 'done') throw new Error('unreachable');
    expect(done.result).toMatchObject({
      text: 'ciao mondo',
      toolCalls: [],
      stopReason: 'end',
      model: 'anthropic/claude-sonnet-5',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('reconstructs a tool call from index-keyed argument fragments, id/name arriving once on the first fragment', async () => {
    const chunks = [
      sseLine(CHUNK({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'demo_read', arguments: '' } }] })),
      sseLine(CHUNK({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] })),
      sseLine(CHUNK({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] })),
      sseLine(CHUNK({}, 'tool_calls')),
      'data: [DONE]\n\n',
    ];
    const provider = streamHarness(streamedResponse(chunks));
    const events = await collect(provider.chatStream(CALL));

    const deltas = events.filter((e) => e.type === 'tool_call_delta') as Extract<StreamEvent, { type: 'tool_call_delta' }>[];
    expect(deltas[0]).toMatchObject({ index: 0, id: 'call_1', name: 'demo_read' });
    expect(deltas.map((d) => d.argsDelta).filter(Boolean).join('')).toBe('{"q":1}');
    const done = events[events.length - 1]!;
    if (done.type !== 'done') throw new Error('unreachable');
    expect(done.result.toolCalls).toEqual([{ id: 'call_1', name: 'demo_read', args: { q: 1 } }]);
    expect(done.result.stopReason).toBe('tool_use');
  });

  it('breaks the connection mid-stream and throws ProviderStreamError, not a retryable ProviderError', async () => {
    const provider = streamHarness(streamedResponse(FULL_STREAM_CHUNKS, 2));
    let caught: unknown;
    try {
      for await (const _ of provider.chatStream(CALL)) {
        /* drain until the break */
      }
      throw new Error('expected a throw');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderStreamError);
    expect((caught as ProviderStreamError).partial).toBe(true);
  });

  it('a request that never starts streaming (no bytes at all) fails as an ordinary ProviderError, not ProviderStreamError', async () => {
    const fetchFake = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { message: 'bad key', type: 'invalid_request_error' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const provider = new OpenAICompatProvider('sk-bad', 'https://openrouter.test/v1', {}, { fetch: fetchFake as never });
    await expect(collect(provider.chatStream(CALL))).rejects.not.toBeInstanceOf(ProviderStreamError);
  });

  it('sets stream_options.include_usage, or a streamed call would report zero usage forever', async () => {
    const bodies: unknown[] = [];
    const fetchFake = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return streamedResponse(FULL_STREAM_CHUNKS);
    };
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.test/v1', {}, { fetch: fetchFake as never });
    await collect(provider.chatStream(CALL));
    expect((bodies[0] as { stream_options?: { include_usage?: boolean } }).stream_options).toEqual({ include_usage: true });
  });
});
