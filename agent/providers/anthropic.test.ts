import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import { ProviderStreamError, type ChatCall, type StreamEvent } from './types.js';

/**
 * The Anthropic adapter, tested against the bytes it actually sends and the
 * blocks it actually returns.
 *
 * Two things this file exists to stop, both silent in production:
 *
 *  1. **Reasoning dropped at the boundary.** The response used to be filtered to
 *     `TextBlock` and `ToolUseBlock`, so `thinking` and `redacted_thinking` — and
 *     the `signature` that is the only thing making them mean anything to the
 *     server — never got past this file. The API's rule is *"Required: within a
 *     tool-use turn, pass thinking blocks back"*, and the penalty for breaking
 *     it is not an error: the server *"may strip thinking blocks that would
 *     create an invalid turn structure, or disable thinking"*.
 *  2. **A request shape that is a 400.** `{type:'enabled', budget_tokens}` is
 *     deprecated on the 4.6 models and rejected on 4.7 and later — every model
 *     `frontier.json` matches. It was written here and never called, so the
 *     defect was armed rather than firing: the moment anyone wired the profile's
 *     `thinking` flag, every frontier turn would have failed.
 *
 * Recorded, not measured against the live API: the request body is asserted
 * through an injected `fetch`, the same technique openai-compat.test.ts uses.
 * Nothing here proves the server accepts it — see ADR-0037 for exactly which
 * claims are read-from-docs.
 */

const A_MESSAGE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [
    { type: 'thinking', thinking: 'devo chiamare il tool', signature: 'sig-xyz' },
    { type: 'redacted_thinking', data: 'ENCRYPTED' },
    { type: 'text', text: 'ci penso' },
    { type: 'tool_use', id: 'toolu_1', name: 'demo_read', input: { q: 1 } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20 },
};

function harness(body: unknown = A_MESSAGE) {
  const sent: Record<string, unknown>[] = [];
  const fetchFake = async (_url: unknown, init?: { body?: string }): Promise<Response> => {
    sent.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = new AnthropicProvider('sk-test', 'https://api.anthropic.test', {
    fetch: fetchFake as never,
  });
  return { provider, sent };
}

const CALL: ChatCall = {
  model: 'claude-sonnet-5',
  maxOutputTokens: 4096,
  stream: false,
  system: [{ type: 'text', text: 'Sei Muffin.', cache: 'stable' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
};

describe('anthropic adapter · reasoning survives the boundary', () => {
  it('carries thinking AND redacted_thinking out, in response order', async () => {
    const h = harness();
    const result = await h.provider.chat(CALL);

    expect(result.thinking).toEqual([
      { type: 'thinking', thinking: 'devo chiamare il tool', signature: 'sig-xyz' },
      { type: 'redacted_thinking', data: 'ENCRYPTED' },
    ]);
    // The normalised fields are unchanged by the addition: the reasoning is a
    // third channel, not a reinterpretation of the other two.
    expect(result.text).toBe('ci penso');
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'demo_read', args: { q: 1 } }]);
  });

  it('sends them back verbatim, signature included', async () => {
    const h = harness({ ...A_MESSAGE, content: [{ type: 'text', text: 'fatto' }], stop_reason: 'end_turn' });
    await h.provider.chat({
      ...CALL,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'ciao' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'devo chiamare il tool', signature: 'sig-xyz' },
            { type: 'redacted_thinking', data: 'ENCRYPTED' },
            { type: 'tool_use', id: 'toolu_1', name: 'demo_read', input: { q: 1 } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: 'letto' }] },
      ],
    });

    const messages = h.sent[0]!.messages as { role: string; content: unknown[] }[];
    expect(messages[1]!.content[0]).toEqual({
      type: 'thinking',
      thinking: 'devo chiamare il tool',
      signature: 'sig-xyz',
    });
    expect(messages[1]!.content[1]).toEqual({ type: 'redacted_thinking', data: 'ENCRYPTED' });
  });
});

describe('anthropic adapter · the request shape the 5-series accepts', () => {
  it('spells thinking as adaptive, with no budget_tokens anywhere', async () => {
    const h = harness();
    await h.provider.chat({ ...CALL, thinking: 'adaptive' });

    expect(h.sent[0]!.thinking).toEqual({ type: 'adaptive' });
    // The whole body, because a budget could only come back by someone
    // reinstating the deprecated branch — and that is a 400 on every model this
    // adapter is pointed at.
    expect(JSON.stringify(h.sent[0])).not.toContain('budget_tokens');
    // `effort` is deliberately absent: 'high' is the API default, so sending it
    // is identical behaviour with one more value free to drift.
    expect(h.sent[0]).not.toHaveProperty('output_config');
  });

  it("spells 'off' as disabled, because omitting the field means thinking is ON", async () => {
    const h = harness();
    await h.provider.chat({ ...CALL, thinking: 'off' });
    expect(h.sent[0]!.thinking).toEqual({ type: 'disabled' });
  });

  it('says nothing about thinking when the caller says nothing', async () => {
    const h = harness();
    await h.provider.chat(CALL);
    expect(h.sent[0]).not.toHaveProperty('thinking');
  });

  it('omits temperature entirely when the profile did not ask for one', async () => {
    // Not `temperature: undefined` — an absent field. On Opus 4.7 and later any
    // non-default sampling value is a 400, and `muffin init` writes
    // claude-sonnet-5 by default, so this is the shape of the default install.
    const h = harness();
    await h.provider.chat(CALL);
    expect(h.sent[0]).not.toHaveProperty('temperature');
  });

  it('sends temperature when a profile does ask for one', async () => {
    const h = harness();
    await h.provider.chat({ ...CALL, temperature: 0 });
    expect(h.sent[0]!.temperature).toBe(0);
  });
});

/**
 * `chatStream` — B11. SSE wire format (`event: <type>` / `data: <json>`,
 * blank line between events) verified against
 * platform.claude.com/docs/en/api/messages-streaming, 2026-08-16.
 *
 * A fake `fetch` that answers with real SSE bytes rather than a stubbed
 * `AsyncIterable`: what is worth testing here is that this adapter's own
 * accumulation of the SDK's raw events reconstructs the same `ChatResult`
 * `chat()` gets from one JSON blob — a hand-built iterable would test the
 * accumulation without ever exercising the framing it accumulates from.
 */
/** One `event:`/`data:` pair per array element, so a test can break the connection between two specific events. */
function sseEvents(events: { event: string; data: unknown }[]): string[] {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

function sse(events: { event: string; data: unknown }[]): string {
  return sseEvents(events).join('');
}

/** A `Response` whose body streams `chunks` one at a time, then optionally errors instead of closing. */
function streamedResponse(chunks: string[], breakAfter?: number): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    // `async` and a tick between each `enqueue`, not a synchronous loop: a
    // spec-conformant `ReadableStream` discards its queued-but-unread chunks
    // the moment `controller.error()` runs (verified with a throwaway probe
    // against the real SDK, 2026-08-16 — the synchronous version delivered
    // zero events before throwing, every time, regardless of `breakAfter`).
    // The delay lets the SDK's reader actually pull each chunk before the
    // next one arrives, so a `breakAfter` in the middle of the list genuinely
    // exercises "some events arrived, then the connection died" instead of
    // "died before anything did."
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
  return new AnthropicProvider('sk-test', 'https://api.anthropic.test', { fetch: fetchFake as never });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const FULL_STREAM_EVENTS: { event: string; data: unknown }[] = [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 1 },
      },
    },
  },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ciao' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' mondo' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
];
const FULL_STREAM = sse(FULL_STREAM_EVENTS);

describe('anthropic adapter · chatStream (B11)', () => {
  it('yields text deltas as they arrive and a done event with the same ChatResult chat() would return', async () => {
    const provider = streamHarness(streamedResponse([FULL_STREAM]));
    const events = await collect(provider.chatStream(CALL));

    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual(['ciao', ' mondo']);
    const done = events[events.length - 1]!;
    expect(done.type).toBe('done');
    if (done.type !== 'done') throw new Error('unreachable');
    expect(done.result).toMatchObject({
      text: 'ciao mondo',
      toolCalls: [],
      stopReason: 'end',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 25, outputTokens: 8 },
    });
  });

  it('reconstructs a tool call from input_json_delta fragments, parsed once at content_block_stop', async () => {
    const stream = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'demo_read', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const provider = streamHarness(streamedResponse([stream]));
    const events = await collect(provider.chatStream(CALL));

    const deltas = events.filter((e) => e.type === 'tool_call_delta') as Extract<StreamEvent, { type: 'tool_call_delta' }>[];
    expect(deltas[0]).toMatchObject({ index: 0, id: 'toolu_1', name: 'demo_read' });
    expect(deltas.map((d) => d.argsDelta).filter(Boolean).join('')).toBe('{"q":1}');
    const done = events[events.length - 1]!;
    if (done.type !== 'done') throw new Error('unreachable');
    expect(done.result.toolCalls).toEqual([{ id: 'toolu_1', name: 'demo_read', args: { q: 1 } }]);
    expect(done.result.stopReason).toBe('tool_use');
  });

  it('reconstructs a thinking block from thinking_delta/signature_delta fragments, matching the ChatResult chat() returns for the same content', async () => {
    // ADR-0038: a thinking block dropped or mangled at the streaming boundary
    // is exactly as bad as one dropped in `chat()` — the response the loop
    // echoes back must carry the same `signature`, or the server may strip
    // reasoning from the next turn (see the file docstring, point 1). This
    // test is that same guarantee, proven for `chatStream()` by building both
    // results from identical content and comparing them, not by asserting a
    // hand-typed literal that could drift from what `chat()` actually does.
    const THINKING = 'primo pensiero, poi secondo pensiero';
    const SIGNATURE = 'sig-stream-thinking';
    const TEXT = 'ecco la risposta';

    const nonStreamMessage = {
      id: 'msg_thinking_stream',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [
        { type: 'thinking', thinking: THINKING, signature: SIGNATURE },
        { type: 'text', text: TEXT },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 9 },
    };
    const nonStreamResult = await harness(nonStreamMessage).provider.chat(CALL);
    // The baseline itself has to be the non-trivial thing we think it is —
    // otherwise a match against it below would be vacuous.
    expect(nonStreamResult.thinking).toEqual([{ type: 'thinking', thinking: THINKING, signature: SIGNATURE }]);

    const stream = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'primo pensiero, ' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'poi secondo pensiero' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: TEXT } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const provider = streamHarness(streamedResponse([stream]));
    const events = await collect(provider.chatStream(CALL));

    const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta').map((e) => (e as { text: string }).text);
    expect(thinkingDeltas).toEqual(['primo pensiero, ', 'poi secondo pensiero']);

    const done = events[events.length - 1]!;
    if (done.type !== 'done') throw new Error('unreachable');
    // The point of this test: what the stream reconstructs is equal to what
    // the non-streaming call produces for the same content — not merely
    // plausible-looking, but the identical value chat() would hand the loop.
    expect(done.result.thinking).toEqual(nonStreamResult.thinking);
    expect(done.result).toEqual(nonStreamResult);
  });

  it('breaks the connection mid-stream and throws ProviderStreamError, not a retryable ProviderError', async () => {
    // A fresh Response per attempt: `Response.body` is a `ReadableStream` and
    // can only be consumed once, so a test that iterated the same one twice
    // would see the second attempt read nothing at all and misreport `partial`.
    const provider = streamHarness(streamedResponse(sseEvents(FULL_STREAM_EVENTS), 3));
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
    // Events did arrive (message_start, content_block_start, one delta)
    // before the socket dropped — the fallback path this error exists to
    // trigger is specifically for a stream that started, not one that
    // never got off the ground.
    expect((caught as ProviderStreamError).partial).toBe(true);
  });

  it('a request that never starts streaming (no bytes at all) fails as an ordinary ProviderError, not ProviderStreamError', async () => {
    const fetchFake = async (): Promise<Response> =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const provider = new AnthropicProvider('sk-bad', 'https://api.anthropic.test', { fetch: fetchFake as never });
    await expect(collect(provider.chatStream(CALL))).rejects.not.toBeInstanceOf(ProviderStreamError);
  });
});
