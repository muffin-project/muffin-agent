import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  type ChatCall,
  type ChatResult,
  type ContentBlock,
  type Provider,
  type StopReason,
} from './types.js';

/**
 * Anthropic native.
 *
 * Native rather than through the OpenAI-compatible surface because three things
 * we actually rely on do not survive the translation: explicit prompt caching
 * (write 1.25-2x, read -90%, which is the difference between a large stable
 * system prompt being affordable or not), extended thinking budgets, and the
 * 1M context window.
 */
export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    try {
      const response = await this.client.messages.create(
        {
          model: call.model,
          max_tokens: call.maxOutputTokens,
          temperature: call.temperature,
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
          ...(call.thinking
            ? { thinking: { type: 'enabled' as const, budget_tokens: call.thinking.budgetTokens } }
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
