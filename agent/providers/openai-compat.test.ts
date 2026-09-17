import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider, wantsExplicitCache } from './openai-compat.js';
import { ProviderError, ProviderStreamError, type ChatCall, type StreamEvent } from './types.js';

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
    completion_tokens_details: { reasoning_tokens: 3 },
  },
  model: 'anthropic/claude-sonnet-5',
};

/** A provider whose network is a recorder: returns the body it would have sent. */
function harness(explicitCache: boolean, reasoningEffort = false, completion: unknown = A_COMPLETION) {
  const bodies: unknown[] = [];
  const fetchFake = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
    explicitCache,
    reasoningEffort,
    discoverReasoning: false,
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

describe('experimental sampling overrides', () => {
  it('translate every Qwen sampling field to the OpenAI-compatible wire names', async () => {
    const h = harness(false, false);
    await h.provider.chat({
      ...CALL,
      sampling: { temperature: 1, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repetitionPenalty: 1 },
    });
    expect(h.bodies[0]).toMatchObject({ temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repetition_penalty: 1 });
  });
});

describe('OpenRouter model router', () => {
  it('keeps openrouter/free an ordinary OpenAI-compatible model with tools', async () => {
    const h = harness(false, false, {
      ...A_COMPLETION,
      model: 'openrouter/free',
      choices: [{ message: { content: 'uso il tool', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'demo_read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    });
    const result = await h.provider.chat({
      ...CALL,
      model: 'openrouter/free',
      tools: [{ name: 'demo_read', description: 'read', inputSchema: { type: 'object' } }],
    });
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'demo_read', args: {} }]);
    expect(h.bodies[0]).toMatchObject({
      model: 'openrouter/free',
      tools: [{ type: 'function', function: { name: 'demo_read' } }],
    });
  });

  it('does not reject the conservative off request when the router omits reasoning metadata', async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      metadataFetch: async () => new Response(JSON.stringify({ data: { id: 'openrouter/free' } }), { status: 200 }),
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? init.body : '{}';
        bodies.push(JSON.parse(body));
        return new Response(JSON.stringify(A_COMPLETION), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    await provider.chat({ ...CALL, model: 'openrouter/free', thinking: 'off' });
    expect(bodies[0]).not.toHaveProperty('reasoning');
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
    const h = harness(false, true);
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

  it('puts the requested output ceiling on the wire', async () => {
    const h = harness(true);
    await h.provider.chat(CALL);
    expect(h.bodies[0]).toMatchObject({ max_tokens: 100 });
  });

  it('preserves the provider-reported reasoning subset instead of calling it plain completion', async () => {
    const h = harness(true);
    const result = await h.provider.chat(CALL);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.reasoningTokens).toBe(3);
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
  return new OpenAICompatProvider('sk-test', 'https://openrouter.test/v1', {}, { fetch: fetchFake as never, reasoningEffort: true, discoverReasoning: false });
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
  it('reconstructs reasoning_details chunks without emitting them to the text surface', async () => {
    const details = [{ type: 'reasoning.text', id: 'r1', text: 'prima' }, { type: 'reasoning.text', id: 'r1', text: ' poi' }];
    const events = await collect(
      streamHarness(
        streamedResponse([
          sseLine(CHUNK({ role: 'assistant', reasoning_details: [details[0]] })),
          sseLine(CHUNK({ reasoning_details: [details[1]], content: 'risposta' }, 'stop')),
          sseLine({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'qwen/qwen3.8-27b', choices: [], usage: { prompt_tokens: 1, completion_tokens: 3 } }),
          'data: [DONE]\n\n',
        ]),
      ).chatStream(CALL),
    );

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('unreachable');
    expect(done.result.providerMetadata).toEqual({ reasoning: { provider: 'openrouter', details } });
    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(1);
    expect((events.find((event) => event.type === 'text_delta') as { text: string }).text).toBe('risposta');
  });

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

/**
 * Errori in-band di OpenRouter su HTTP 200.
 *
 * Dalla documentazione primaria (openrouter.ai/docs, errori e debug): il 200
 * viene inviato appena il provider accetta la richiesta, prima che il modello
 * produca un token — ogni fallimento dopo quel punto viaggia DENTRO la
 * risposta, con un oggetto `error` top-level e `finish_reason: "error"`, e lo
 * status resta 200. Chi controlla solo lo status legge un successo.
 *
 * Misurato sull'installazione viva il 16/09/2026: cinque chiamate di fila da
 * 30,00 secondi, tutte 200 con contenuto vuoto, zero retry consumati, quattro
 * nudge sprecati a sgridare un modello innocente e poi `error`. Il fornitore
 * aveva fallito; l'adapter lo aveva ribattezzato "risposta vuota".
 */
describe('openai-compat · errori in-band del provider su 200', () => {
  it('stream: un chunk con error top-level lancia ProviderError transport retryable, non un done vuoto', async () => {
    const provider = streamHarness(
      streamedResponse([
        sseLine({
          ...CHUNK({ content: '' }, 'error'),
          error: { code: 504, message: 'upstream timeout', metadata: { error_type: 'timeout' } },
        }),
        'data: [DONE]\n\n',
      ]),
    );
    let caught: unknown;
    try {
      await collect(provider.chatStream(CALL));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).not.toBeInstanceOf(ProviderStreamError);
    expect((caught as ProviderError).retryable).toBe(true);
    expect((caught as ProviderError).source).toBe('transport');
  });

  it('stream: un 401 in-band non è retryable — bruciare 10 retry su una chiave morta è peggio', async () => {
    const provider = streamHarness(
      streamedResponse([
        sseLine({
          ...CHUNK({ content: '' }, 'error'),
          error: { code: 401, message: 'invalid key', metadata: {} },
        }),
        'data: [DONE]\n\n',
      ]),
    );
    let caught: unknown;
    try {
      await collect(provider.chatStream(CALL));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
  });

  it('non-stream: finish_reason error con contenuto vuoto lancia invece di chiudere end', async () => {
    const completion = {
      ...A_COMPLETION,
      choices: [{ message: { content: '', tool_calls: [] }, finish_reason: 'error' }],
    };
    const { provider } = harness(false, false, completion);
    await expect(provider.chat(CALL)).rejects.toBeInstanceOf(ProviderError);
  });

  it("una finish reason sconosciuta non diventa end: il default è error, mai un successo presunto", async () => {
    const completion = {
      ...A_COMPLETION,
      choices: [{ message: { content: 'ciao', tool_calls: [] }, finish_reason: 'ragione-futura-sconosciuta' }],
    };
    const { provider } = harness(false, false, completion);
    const result = await provider.chat(CALL);
    expect(result.stopReason).toBe('error');
  });
});

/**
 * Chiedere di NON ragionare.
 *
 * Misurato sull'installazione viva il 27/08, stesso prompt, `qwen/qwen3.8-27b`:
 * senza il campo **204** token in uscita, con `reasoning: {effort:'none'}`
 * **85**. Non è il testo del reasoning che si perdeva a costare — è il
 * reasoning stesso, fatturato per una risposta che il profilo aveva già
 * dichiarato di non volere.
 */
describe("thinking:'off' smette di essere un no-op, dove l'endpoint capisce", () => {
  it("manda reasoning.effort 'none' quando la corsia chiede di non ragionare", async () => {
    const h = harness(false, true);
    await h.provider.chat({ ...CALL, model: 'qwen/qwen3.8-27b', thinking: 'off' });
    expect((h.bodies[0] as { reasoning?: unknown }).reasoning).toEqual({ effort: 'none' });
  });

  it('uses the canonical reasoning intent and requires routed providers to support it', async () => {
    const h = harness(false, true);
    await h.provider.chat({ ...CALL, model: 'qwen/qwen3.8-27b', reasoning: { mode: 'on', effort: 'low' } });
    expect((h.bodies[0] as { reasoning?: unknown }).reasoning).toEqual({ effort: 'low' });
    expect((h.bodies[0] as { provider?: unknown }).provider).toEqual({ require_parameters: true });
  });

  it('rejects an exact reasoning token budget when the model snapshot does not support it', async () => {
    const h = harness(false, true);
    await expect(h.provider.chat({ ...CALL, model: 'qwen/qwen3.8-27b', reasoning: { mode: 'on', maxTokens: 2048 } })).rejects.toThrow(
      'exact reasoning token budget',
    );
    expect(h.bodies).toHaveLength(0);
  });

  it('falls back to the known snapshot when live metadata is unavailable', async () => {
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      reasoningEffort: true,
      metadataFetch: async () => { throw new Error('metadata unavailable'); },
      fetch: async () => new Response(JSON.stringify(A_COMPLETION), { status: 200 }) as never,
    });
    expect((await provider.resolveReasoning({ ...CALL, model: 'qwen/qwen3.8-27b', reasoning: { mode: 'on', effort: 'low' } })).capabilitySource).toBe('static-snapshot');
  });

  it('lets fresh live metadata override the static snapshot', async () => {
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      reasoningEffort: true,
      metadataFetch: async () => new Response(JSON.stringify({ data: { id: 'qwen/qwen3.8-27b', reasoning: { mandatory: false, supported_efforts: ['low'], default_effort: 'low' } } }), { status: 200 }),
      fetch: async () => new Response(JSON.stringify(A_COMPLETION), { status: 200 }),
    });
    const resolution = await provider.resolveReasoning({ ...CALL, model: 'qwen/qwen3.8-27b', reasoning: { mode: 'on', effort: 'xhigh' } });
    expect(resolution.capabilitySource).toBe('openrouter-live');
    expect(resolution.status).toBe('unsupported');
  });

  it("non manda niente per 'adaptive': è già ciò che significa non mandare niente", async () => {
    const h = harness(false, true);
    await h.provider.chat({ ...CALL, thinking: 'adaptive' });
    expect(h.bodies[0]).not.toHaveProperty('reasoning');
  });

  it('tace del tutto dove il campo non è capito, perché lì un campo ignoto è un 400', async () => {
    // Ollama, llama.cpp e vLLM sono metà dell'ecosistema di questo adapter, e
    // sono esattamente i server del profilo `consumer-local`. Il tetto di
    // `REASONING_HEADROOM` resta per loro: lì `off` è ancora un no-op.
    const h = harness(false, false);
    await h.provider.chat({ ...CALL, model: 'qwen/qwen3.8-27b', thinking: 'off' });
    expect(h.bodies[0]).not.toHaveProperty('reasoning');
  });

  it("il default viene dall'endpoint, non da chi costruisce il provider", () => {
    // L'argomento è quello di `wantsExplicitCache`, e la storia pure: due
    // harness di eval avevano dimenticato il flag e pagato pieno in silenzio.
    expect(new OpenAICompatProvider('k', 'https://openrouter.ai/api/v1').reasoningEffort).toBe(true);
    expect(new OpenAICompatProvider('k', 'https://openrouter.ai./api/v1').reasoningEffort).toBe(true);
    expect(new OpenAICompatProvider('k', 'http://localhost:11434/v1').reasoningEffort).toBe(false);
    expect(new OpenAICompatProvider('k', 'https://openrouter.ai.evil.tld/v1').reasoningEffort).toBe(false);
    expect(new OpenAICompatProvider('k').reasoningEffort).toBe(false);
  });

  it('vale sullo stream come sulla chiamata secca — ed è lo stream che il turno usa', async () => {
    // Il turno dell'owner è streamato (`agent/loop.ts`), ed è l'unico posto che
    // legge `profile.thinking`: se il corpo dei due percorsi divergesse, la
    // corsia dove il campo conta di più sarebbe quella scoperta.
    const bodies: unknown[] = [];
    const provider = new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      fetch: (async (_u: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}'));
        return streamedResponse(FULL_STREAM_CHUNKS);
      }) as never,
      discoverReasoning: false,
      reasoningEffort: true,
    });
    await collect(provider.chatStream({ ...CALL, model: 'qwen/qwen3.8-27b', thinking: 'off', stream: true }));
    expect((bodies[0] as { reasoning?: unknown }).reasoning).toEqual({ effort: 'none' });
  });
});

describe('openrouter reasoning continuity', () => {
  it('preserves opaque reasoning_details through a non-stream tool round-trip', async () => {
    const details = [{ type: 'reasoning.encrypted', id: 'r1', data: 'opaque' }];
    const h = harness(false, true, {
      ...A_COMPLETION,
      choices: [{ message: { content: 'uso il tool', reasoning_details: details, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'demo_read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    });

    const first = await h.provider.chat({ ...CALL, model: 'qwen/qwen3.8-27b' });
    expect(first.providerMetadata).toEqual({ reasoning: { provider: 'openrouter', details } });

    await h.provider.chat({
      ...CALL,
      model: 'qwen/qwen3.8-27b',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'leggi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'uso il tool' },
            { type: 'tool_use', id: 'call_1', name: 'demo_read', input: {} },
          ],
          ...(first.providerMetadata === undefined ? {} : { providerMetadata: first.providerMetadata }),
        },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'letto' }] },
      ],
    });

    expect((h.bodies[1] as { messages: Record<string, unknown>[] }).messages[2]).toMatchObject({ reasoning_details: details });
  });
});

/**
 * Un'immagine, nella forma che questo lato del filo vuole.
 *
 * `image_url` con un data URL — OpenRouter documenta entrambe le sorgenti
 * (`https://…` e `data:image/jpeg;base64,…`), letto il 28/08/2026. Noi mandiamo
 * solo la seconda, e non è una semplificazione: la prima farebbe scaricare
 * l'immagine **al provider**, che è un'uscita di rete che il kernel non vede e
 * non può negare, e obbligherebbe un'immagine privata a essere pubblicamente
 * raggiungibile.
 *
 * Il modo in cui questo si rompe non è un 400. Se un'immagine finisse in
 * `flatten`, diventerebbe stringa vuota e sparirebbe: il modello risponderebbe
 * lo stesso, su un'immagine che non ha mai visto. Questi test contano le
 * **parti**, che è l'unica cosa che distingue i due casi.
 */
describe("openai-compat · un'immagine non può sparire in silenzio", () => {
  const IMG = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAB' };

  it("manda l'immagine come parte image_url con un data URL", async () => {
    const h = harness(false);
    await h.provider.chat({
      ...CALL,
      messages: [{ role: 'user', content: [IMG, { type: 'text', text: 'cosa vedi?' }] }],
    });

    const user = (h.bodies[0] as Body).messages[1]!;
    expect(Array.isArray(user.content)).toBe(true);
    const parti = user.content as { type: string; image_url?: { url: string }; text?: string }[];
    expect(parti[0]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } });
  });

  /**
   * L'immagine **prima** del testo: entrambe le API lo raccomandano, e non
   * costa niente.
   */
  it("e il testo viene dopo l'immagine, non prima", async () => {
    const h = harness(false);
    await h.provider.chat({
      ...CALL,
      messages: [{ role: 'user', content: [IMG, { type: 'text', text: 'cosa vedi?' }] }],
    });
    const parti = (h.bodies[0] as Body).messages[1]!.content as { type: string }[];
    expect(parti.map((p) => p.type)).toEqual(['image_url', 'text']);
  });

  /**
   * Senza immagini la forma resta **la stringa**, non un array di parti con una
   * sola voce: Ollama, llama.cpp e vLLM ricevono byte identici a prima, che è
   * la stessa garanzia che la cache esplicita ha dovuto dare.
   */
  it('e senza immagini un messaggio resta la stringa di sempre', async () => {
    const h = harness(false);
    await h.provider.chat(CALL);
    expect((h.bodies[0] as Body).messages[1]!.content).toBe('ciao');
  });
});

/**
 * Una nota vocale, nella forma che questo lato del filo vuole.
 *
 * `input_audio` con il base64 **nudo** e la sigla del formato — docs OpenRouter
 * «Audio Inputs», lette il 28/08/2026. Qui la forma è l'opposto di quella delle
 * immagini, che vogliono un data URL, e la regola che per le immagini ci
 * eravamo dati noi (solo base64, mai un URL) qui è anche la loro: per l'audio
 * gli URL non sono proprio supportati.
 *
 * Si rompe come si rompono le immagini, cioè **in silenzio**: un blocco audio
 * che finisse in `flatten` diventerebbe stringa vuota, e il modello
 * risponderebbe a una nota vocale che non ha mai sentito. Contare le parti è
 * l'unica cosa che distingue i due casi.
 */
describe('openai-compat · una nota vocale non può sparire in silenzio', () => {
  const VOCE = { type: 'audio' as const, mediaType: 'audio/ogg' as const, data: 'T2dnUw==' };

  it("manda l'audio come parte input_audio, base64 nudo e formato a parte", async () => {
    const h = harness(false);
    await h.provider.chat({
      ...CALL,
      messages: [{ role: 'user', content: [VOCE, { type: 'text', text: 'che ti ho detto?' }] }],
    });

    const parti = (h.bodies[0] as Body).messages[1]!.content as {
      type: string;
      input_audio?: { data: string; format: string };
    }[];
    expect(parti[0]).toMatchObject({ type: 'input_audio', input_audio: { data: 'T2dnUw==', format: 'ogg' } });
    // Nudo davvero: nessun `data:` davanti, che è la forma dell'altra colonna.
    expect(parti[0]?.input_audio?.data.startsWith('data:')).toBe(false);
  });

  /**
   * `ogg` è proprio il formato di una nota vocale di Telegram, e il tipo
   * dell'SDK OpenAI ammette solo `wav|mp3`: restringere a ciò che l'SDK sa
   * nominare vorrebbe dire riconvertire ogni nota in wav per un fatto del tipo
   * e non del filo — cioè triplicarne i byte per niente.
   */
  it('e ogni media type che sappiamo produrre ha la sua sigla', async () => {
    const sigle: [string, string][] = [
      ['audio/ogg', 'ogg'],
      ['audio/mpeg', 'mp3'],
      ['audio/mp4', 'm4a'],
      ['audio/wav', 'wav'],
    ];
    for (const [media, sigla] of sigle) {
      const h = harness(false);
      await h.provider.chat({
        ...CALL,
        messages: [
          { role: 'user', content: [{ type: 'audio', mediaType: media as typeof VOCE.mediaType, data: 'AAAA' }] },
        ],
      });
      const parti = (h.bodies[0] as Body).messages[1]!.content as { input_audio?: { format: string } }[];
      expect(parti[0]?.input_audio?.format).toBe(sigla);
    }
  });

  /** Senza audio la forma resta la stringa, byte identici a prima. */
  it('e un messaggio senza audio non diventa un array di parti', async () => {
    const h = harness(false);
    await h.provider.chat({ ...CALL, messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }] });
    expect((h.bodies[0] as Body).messages[1]!.content).toBe('ciao');
  });
});

describe('openai-compat · tool_choice escalation (ADR-0082)', () => {
  const TOOLS = [{ name: 'demo_read', description: 'read', inputSchema: { type: 'object' } }];

  it("auto di default: la forma di prima, byte identici quando nessuno chiede l'escalation", async () => {
    const h = harness(false);
    await h.provider.chat({ ...CALL, tools: TOOLS });
    expect(h.bodies[0]).toMatchObject({ tool_choice: 'auto' });
  });

  it('none resta none', async () => {
    const h = harness(false);
    await h.provider.chat({ ...CALL, tools: TOOLS, toolChoice: 'none' });
    expect(h.bodies[0]).toMatchObject({ tool_choice: 'none' });
  });

  it('required viaggia sul filo, solo quando il rung requireTool lo arma', async () => {
    const h = harness(false);
    await h.provider.chat({ ...CALL, tools: TOOLS, toolChoice: 'required' });
    expect(h.bodies[0]).toMatchObject({ tool_choice: 'required' });
  });

  it('finish_reason tool_calls senza call non chiude il turno: è output, va in cascade', async () => {
    // La forma del bug vLLM su Gemma 4: annuncia la call, array vuoto, prosa
    // nel content. Accettarlo come risposta chiudeva il turno sullo stallo.
    const h = harness(false, false, {
      ...A_COMPLETION,
      choices: [{ message: { content: 'ecco fatto', tool_calls: [] }, finish_reason: 'tool_calls' }],
    });
    const failed = await h.provider.chat({ ...CALL, tools: TOOLS }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ProviderError);
    expect((failed as ProviderError).source).toBe('output');
  });
});

/**
 * `Retry-After` del provider (#496), lato openai-compat: stessa pretesa del
 * gemello Anthropic — un 429 con finestra dichiarata arriva come
 * `retryAfterMs`, senza header non si inventa nulla.
 */
describe('openai-compat · Retry-After sopravvive a wrap', () => {
  function statusHarness(status: number, headers: Record<string, string>, body: unknown) {
    const fetchFake = async (): Promise<Response> =>
      new Response(JSON.stringify(body), { status, headers });
    return new OpenAICompatProvider('sk-test', 'https://openrouter.ai/api/v1', {}, {
      explicitCache: false,
      reasoningEffort: false,
      discoverReasoning: false,
      fetch: fetchFake as never,
    });
  }

  it('un 429 con retry-after: 45 porta retryAfterMs 45000', async () => {
    const provider = statusHarness(429, { 'retry-after': '45' }, { error: { message: 'lento', code: 429 } });
    const failed = await provider.chat(CALL).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ProviderError);
    expect((failed as ProviderError).retryable).toBe(true);
    expect((failed as unknown as { retryAfterMs?: number }).retryAfterMs).toBe(45_000);
  });
});
