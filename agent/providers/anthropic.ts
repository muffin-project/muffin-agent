import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  type ChatCall,
  type ChatResult,
  type ContentBlock,
  type Provider,
  type StopReason,
  type ThinkingBlock,
} from './types.js';

/**
 * Anthropic native.
 *
 * Native rather than through the OpenAI-compatible surface because three things
 * we actually rely on do not survive the translation: explicit prompt caching
 * (write 1.25-2x, read -90%, which is the difference between a large stable
 * system prompt being affordable or not), reasoning continuity across a
 * tool-use turn, and the 1M context window.
 *
 * The middle one used to say "extended thinking budgets" and that was wrong in
 * both halves — see ADR-0037. Budgets are gone from the API, and what this
 * adapter has to carry is not a request knob but the *response*: the thinking
 * blocks, back out and back in unmodified.
 */
export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, baseURL?: string, opts: { fetch?: typeof globalThis.fetch } = {}) {
    // `fetch` is injectable for the same reason it is on the openai-compat
    // adapter: the thing worth testing here is the bytes on the wire, and the
    // only honest way to assert them without spending the owner's money is to
    // record the request. See anthropic.test.ts.
    this.client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    try {
      const response = await this.client.messages.create(
        {
          model: call.model,
          max_tokens: call.maxOutputTokens,
          // Spread, not `temperature: call.temperature`: on Opus 4.7 and later
          // the parameter was removed and any non-default value is a 400, so
          // the absent case has to be an absent *field*, not `undefined`.
          ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
          system: call.system.map(toSystemBlock),
          messages: call.messages.map((m) => ({
            role: m.role,
            content: m.content.map(toContentBlock),
          })),
          ...(call.tools && call.tools.length > 0
            ? {
                tools: call.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                })),
                tool_choice: { type: call.toolChoice === 'none' ? ('none' as const) : ('auto' as const) },
              }
            : {}),
          // `{type:'enabled', budget_tokens}` used to stand here. It is
          // deprecated on the 4.6 models and a 400 on 4.7 and later — Opus 5,
          // Sonnet 5, Fable 5, i.e. exactly the models frontier.json matches —
          // so the roadmap's old remedy ("the loop doesn't pass it") would have
          // broken every frontier turn the moment it was wired. `effort` is
          // deliberately not sent: `"high"` is the API default and sending the
          // default is identical to omitting it, so adding the field would only
          // give us a value to drift.
          ...(call.thinking
            ? { thinking: { type: call.thinking === 'off' ? ('disabled' as const) : ('adaptive' as const) } }
            : {}),
        },
        call.signal ? { signal: call.signal } : {},
      );

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      return {
        text: text.length > 0 ? text : null,
        toolCalls: response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, args: b.input })),
        // In response order and both kinds, because this filter is the exact
        // one the docs name as the way the protocol breaks: `type === 'thinking'`
        // alone silently drops `redacted_thinking`. `content` was previously
        // filtered to text+tool_use here and everything else fell on the floor.
        thinking: response.content.flatMap(toThinkingBlock),
        stopReason: mapStopReason(response.stop_reason),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        model: response.model,
      };
    } catch (error) {
      throw wrap(error);
    }
  }
}

function toSystemBlock(block: ContentBlock): Anthropic.TextBlockParam {
  if (block.type !== 'text') throw new ProviderError('system accepts text blocks only', false);
  return {
    type: 'text',
    text: block.text,
    ...(block.cache === 'stable' ? { cache_control: { type: 'ephemeral' as const } } : {}),
  };
}

/**
 * The reasoning blocks of one response, in the order the model emitted them.
 *
 * A `flatMap` over the whole content array rather than two filters, so the
 * relative order of `thinking` and `redacted_thinking` is whatever the model
 * produced — the docs' rule is on the *sequence*: "the sequence of consecutive
 * `thinking` blocks must match what the model generated in the original
 * request: you can't rearrange, edit, or partially drop them."
 */
function toThinkingBlock(block: Anthropic.ContentBlock): ThinkingBlock[] {
  if (block.type === 'thinking') {
    return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }];
  }
  if (block.type === 'redacted_thinking') return [{ type: 'redacted_thinking', data: block.data }];
  return [];
}

function toContentBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text,
        ...(block.cache === 'stable' ? { cache_control: { type: 'ephemeral' as const } } : {}),
      };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
    // Verbatim, field for field. Not `{...block}` — a spread would carry
    // whatever a future field adds and quietly send it back; naming the fields
    // means a change to the shape stops the build instead of the turn. Nothing
    // here normalises: an edited block is a 400, and `signature` is the only
    // thing that makes the block mean anything to the server.
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data };
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end';
  }
}

/**
 * Classifies rather than re-throwing: the loop's recovery cascade needs to know
 * whether waiting could possibly help. A 401 retried three times is three times
 * the same failure and a slower error message.
 */
function wrap(error: unknown): ProviderError {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const retryable = status === 429 || status >= 500;
    return new ProviderError(`${status} ${error.message}`, retryable, status);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('aborted', false);
  }
  // Network-level failures (DNS, reset, timeout) are worth one more try.
  return new ProviderError(error instanceof Error ? error.message : String(error), true);
}
