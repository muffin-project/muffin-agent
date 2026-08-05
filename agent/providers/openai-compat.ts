import OpenAI from 'openai';
import {
  ProviderError,
  type ChatCall,
  type ChatResult,
  type ContentBlock,
  type Message,
  type Provider,
  type StopReason,
} from './types.js';

/**
 * OpenAI-compatible chat completions.
 *
 * This is the widest door in the ecosystem: Ollama, llama.cpp, vLLM,
 * OpenRouter, DeepSeek and most hosted providers all speak it. An open-source
 * project cannot demand one vendor, and this is how you avoid it without
 * paying for a framework.
 *
 * What it does not carry, by design: explicit prompt caching breakpoints and
 * thinking budgets. Those are why the Anthropic adapter exists next to it
 * rather than instead of it.
 */
export class OpenAICompatProvider implements Provider {
  readonly kind = 'openai-compat' as const;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    baseURL?: string,
    private readonly headers: Record<string, string> = {},
  ) {
    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      defaultHeaders: headers,
    });
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: call.model,
          max_tokens: call.maxOutputTokens,
          temperature: call.temperature,
          messages: [
            { role: 'system', content: call.system.map(flatten).join('\n\n') },
            ...call.messages.flatMap(toChatMessages),
          ],
          ...(call.tools && call.tools.length > 0
            ? {
                tools: call.tools.map((t) => ({
                  type: 'function' as const,
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
                tool_choice: call.toolChoice === 'none' ? ('none' as const) : ('auto' as const),
              }
            : {}),
        },
        call.signal ? { signal: call.signal } : {},
      );

      const choice = response.choices[0];
      if (!choice) throw new ProviderError('provider returned no choices', true);

      const text = (choice.message.content ?? '').trim();
      const toolCalls = (choice.message.tool_calls ?? []).map((tc) => {
        // A tool call whose arguments do not parse is an error here, where the
        // recovery cascade can see it, not three layers down inside a tool.
        if (!('function' in tc)) throw new ProviderError(`unsupported tool call type`, false);
        let args: unknown;
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          throw new ProviderError(`malformed tool arguments from ${tc.function.name}`, true);
        }
        return { id: tc.id, name: tc.function.name, args };
      });

      return {
        text: text.length > 0 ? text : null,
        toolCalls,
        stopReason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          // Implicit on this surface: reported when the provider bothers to.
          cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
        },
        model: response.model,
      };
    } catch (error) {
      throw wrap(error);
    }
  }
}

function flatten(block: ContentBlock): string {
  return block.type === 'text' ? block.text : '';
}

function toChatMessages(message: Message): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const text = message.content.filter((b) => b.type === 'text').map(flatten).join('\n');
  const toolUses = message.content.filter((b) => b.type === 'tool_use');
  const toolResults = message.content.filter((b) => b.type === 'tool_result');

  if (message.role === 'assistant') {
    out.push({
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(toolUses.length > 0
        ? {
            tool_calls: toolUses.map((b) => ({
              id: b.id,
              type: 'function' as const,
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            })),
          }
        : {}),
    });
  } else if (text.length > 0) {
    out.push({ role: 'user', content: text });
  }

  // Tool results are their own role here, unlike Anthropic where they are
  // blocks inside a user message.
  for (const result of toolResults) {
    out.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content });
  }
  return out;
}

function mapStopReason(reason: string | null, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end';
  }
}

function wrap(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return new ProviderError(`${status} ${error.message}`, status === 429 || status >= 500, status);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('aborted', false);
  }
  return new ProviderError(error instanceof Error ? error.message : String(error), true);
}
