import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import type { ChatCall } from './types.js';

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
