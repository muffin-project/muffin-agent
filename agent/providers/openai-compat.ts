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
 * What it does not carry: thinking budgets — that is why the Anthropic adapter
 * exists next to it rather than instead of it.
 *
 * Prompt-cache breakpoints it DOES carry now, behind `explicitCache`, and the
 * history of that flag is the reason it exists. This file used to say
 * breakpoints were left out "by design", reasoning that compat surfaces cache
 * implicitly. OpenRouter broke the assumption: it is a compat surface where
 * Anthropic and Alibaba models cache **only if asked** — `cache_control` on a
 * content block, 0.1× reads (their docs, verified 2026-08-11). The production
 * install is exactly that setup, so the design decision was silently costing
 * ~10× on every cacheable token, invisibly, because `cacheWriteTokens` was
 * hardcoded 0 and read as "cache unavailable".
 *
 * The flag defaults off because the other half of the ecosystem is the
 * opposite: Ollama, llama.cpp and vLLM cache implicitly, and an unknown field
 * on a strict parser is a 400 in production. Off means byte-identical to what
 * this adapter always sent — a plain string — not "parts without the field".
 *
 * Scope note: the inference is per-ENDPOINT while the justification is
 * per-model-family. Through openrouter.ai the markers also reach models that
 * cache implicitly upstream (deepseek, gemma, gpt-oss) — OpenRouter's docs say
 * unsupported markers are normalized rather than rejected, which is the
 * assumption this rests on. If a routed model ever 400s on cache_control, the
 * gate needs a model-id clause too, and this is the sentence to delete.
 */
/**
 * Whether this endpoint wants explicit cache breakpoints.
 *
 * Exported and used as the constructor's own default, because the first version
 * kept the inference in `buildRuntime` — and two eval harnesses then built the
 * provider without it and silently paid full price against the same endpoint.
 * The endpoint→dialect decision is a property of the endpoint, and the provider
 * already holds the endpoint; a caller that has to remember to pass it is a
 * caller that will forget.
 *
 * Hostname, not substring — `openrouter.ai.evil.tld` must not flip request
 * shape — and the trailing-dot form of a hostname is folded before matching,
 * because `https://openrouter.ai./api/v1` is the same endpoint and a silent
 * miss here pays 10× forever (ADR-0008: degrade declaredly, never silently).
 */
export function wantsExplicitCache(baseURL?: string): boolean {
  try {
    if (!baseURL) return false;
    const host = new URL(baseURL).hostname.toLowerCase().replace(/\.$/, '');
    return /(^|\.)openrouter\.ai$/.test(host);
  } catch {
    return false;
  }
}

export class OpenAICompatProvider implements Provider {
  readonly kind = 'openai-compat' as const;
  private readonly client: OpenAI;
  /** Public because the wiring is the part of this feature that must be provable. */
  readonly explicitCache: boolean;

  constructor(
    apiKey: string,
    baseURL?: string,
    private readonly headers: Record<string, string> = {},
    opts: { explicitCache?: boolean; fetch?: typeof globalThis.fetch } = {},
  ) {
    this.explicitCache = opts.explicitCache ?? wantsExplicitCache(baseURL);
    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      defaultHeaders: headers,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: call.model,
          max_tokens: call.maxOutputTokens,
          temperature: call.temperature,
          messages: [this.systemMessage(call), ...call.messages.flatMap(toChatMessages)],
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
          // `output`, not transport: the model wrote this, and no amount of
          // waiting rewrites it. The loop routes it to the profile's cascade.
          throw new ProviderError(`malformed tool arguments from ${tc.function.name}`, true, undefined, 'output');
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
          cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          // On the SDK's own type since v7 (CompletionUsage). The hardcoded 0
          // that stood here is how a missing feature stayed invisible: zero
          // reads as "cache unavailable" when the truth was "never requested".
          cacheWriteTokens: response.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
        },
        model: response.model,
      };
    } catch (error) {
      throw wrap(error);
    }
  }

  /**
   * The system message, in one of two dialects — and the split is load-bearing,
   * not cosmetic. With `explicitCache` the stable blocks become content parts
   * carrying `cache_control` (OpenRouter's documented shape for the providers
   * that only cache on request); without it, the same plain string as always,
   * because the servers that cache implicitly include ones that 400 on fields
   * they do not know.
   */
  private systemMessage(call: ChatCall): OpenAI.Chat.ChatCompletionMessageParam {
    // One block in, and the two dialects carry identical text — which is all
    // production sends today (every caller marks a single system block). At two
    // or more the dialects DIVERGE: the string dialect joins with '\n\n', the
    // parts dialect concatenates with no separator, so the model reads
    // different bytes depending on the flag and the cache cannot warm across
    // the flip. Whoever adds a second system block decides that on purpose.
    if (!this.explicitCache) {
      return { role: 'system', content: call.system.map(flatten).join('\n\n') };
    }
    const parts = call.system.map((block) => ({
      type: 'text' as const,
      text: flatten(block),
      // The breakpoint sits on the stable block only. Marking the volatile tail
      // too would mint a fresh cache entry every turn — 1.25× writes for 0
      // reads, worse than no cache at all.
      ...(block.type === 'text' && block.cache === 'stable'
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }));
    return { role: 'system', content: parts as OpenAI.Chat.ChatCompletionContentPartText[] };
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
