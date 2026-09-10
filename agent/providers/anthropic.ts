import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  ProviderStreamError,
  type ChatCall,
  type ChatResult,
  type ContentBlock,
  type Provider,
  type StopReason,
  type StreamEvent,
  type ThinkingBlock,
} from './types.js';
import {
  ReasoningConfigurationError,
  reasoningRequest,
  resolveReasoningPolicy,
  type ReasoningCapabilities,
  type ReasoningResolution,
} from './reasoning.js';

/**
 * Anthropic native.
 *
 * Native rather than through the OpenAI-compatible surface because three things
 * we actually rely on do not survive the translation: explicit prompt caching
 * (write 1.25-2x, read -90%, which is the difference between a large stable
 * system prompt being affordable or not), reasoning continuity across a
 * tool-use turn, and the 1M context window.
 *
 * The request side uses the canonical reasoning intent and resolves it against
 * the model shape this adapter knows. The response side still carries thinking
 * blocks back out and back in unmodified for tool-use continuity.
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
      maxRetries: 0,
      ...(baseURL ? { baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  resolveReasoning(call: ChatCall): ReasoningResolution {
    return resolveAnthropicReasoning(call);
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    try {
      const response = await this.client.messages.create(requestBody(call), call.signal ? { signal: call.signal } : {});
      return toChatResult(response);
    } catch (error) {
      throw wrap(error);
    }
  }

  /**
   * SSE, over the SDK the file already depends on rather than hand-parsed
   * bytes: `messages.create({..., stream: true})` returns
   * `Stream<RawMessageStreamEvent>` — the SDK owns framing (`event: <type>` /
   * `data: <json>` lines, verified against
   * platform.claude.com/docs/en/api/messages-streaming, 2026-08-16) and this
   * function owns only the six-member union
   * (`message_start | content_block_start | content_block_delta |
   * content_block_stop | message_delta | message_stop` —
   * `RawMessageStreamEvent`, `node_modules/@anthropic-ai/sdk` v0.115.0). A
   * `ping` event exists on the wire and is filtered out before it reaches
   * this loop — the union has no case for it, so there is nothing to ignore
   * on purpose here.
   *
   * Reconstructs content blocks by hand rather than using the SDK's own
   * `client.messages.stream()` accumulator (which would hand back exactly
   * this for free via `.finalMessage()`): that helper owns its own
   * `AbortController` and event-listener machinery, and mixing two stream
   * abstractions in one adapter — one for `chat()`'s signal handling, a
   * different one here — is its own source of drift. `create({stream:true})`
   * keeps this method's request-shape and signal-passing identical to
   * `chat()`'s, which is the boundary that matters.
   */
  async *chatStream(call: ChatCall): AsyncIterable<StreamEvent> {
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(
        { ...requestBody(call), stream: true },
        call.signal ? { signal: call.signal } : {},
      );
    } catch (error) {
      // Nothing was ever streamed — this is `chat()`'s own failure shape
      // (a 401, a refused connection), not the stream breaking mid-flight, so
      // it takes `chat()`'s door: the loop's ordinary transport-retry cascade,
      // never the one-time stream→non-stream fallback that exists for a
      // *different* failure (see `ProviderStreamError`).
      throw wrap(error);
    }

    // Reconstructed by index, the same key every event in the union uses to
    // say which block it is about. `unknown` blocks (a future content type
    // this file does not model, e.g. `citations_delta`'s block) are left as
    // whatever `content_block_start` gave them — the same content the
    // non-streaming path already drops silently (`toContentBlock` below has
    // no case for it either).
    const blocks: Anthropic.ContentBlock[] = [];
    // `input_json_delta` fragments, kept apart from `blocks` because a tool's
    // `input` is typed as the *parsed* value — concatenating into it directly
    // would mean parsing partial, invalid JSON on every delta instead of once,
    // at the block's `content_block_stop`, which is where `chat()`'s own
    // non-streaming JSON already gets its one parse.
    const toolJson = new Map<number, string>();
    let stopReason: string | null = null;
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let model = call.model;
    // See `ProviderStreamError.partial`: the only fact that changes how a
    // failure below is classified.
    let receivedAnyEvent = false;

    try {
      for await (const event of stream) {
        receivedAnyEvent = true;
        switch (event.type) {
          case 'message_start':
            model = event.message.model;
            usage.input_tokens = event.message.usage.input_tokens;
            // Cache token counts are decided before generation starts, so they
            // are already final on message_start — required for toChatResult's
            // normalization below to see anything but zero on this path (P35).
            usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens ?? 0;
            usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens ?? 0;
            break;
          case 'content_block_start':
            blocks[event.index] = event.content_block;
            if (event.content_block.type === 'tool_use') {
              toolJson.set(event.index, '');
              yield { type: 'tool_call_delta', index: event.index, id: event.content_block.id, name: event.content_block.name };
            }
            break;
          case 'content_block_delta': {
            const block = blocks[event.index];
            const delta = event.delta;
            if (delta.type === 'text_delta' && block?.type === 'text') {
              block.text += delta.text;
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'thinking_delta' && block?.type === 'thinking') {
              block.thinking += delta.thinking;
              yield { type: 'thinking_delta', text: delta.thinking };
            } else if (delta.type === 'signature_delta' && block?.type === 'thinking') {
              block.signature += delta.signature;
            } else if (delta.type === 'input_json_delta' && block?.type === 'tool_use') {
              toolJson.set(event.index, (toolJson.get(event.index) ?? '') + delta.partial_json);
              yield { type: 'tool_call_delta', index: event.index, argsDelta: delta.partial_json };
            }
            // `citations_delta` has no slot in `ContentBlock` — dropped here,
            // same as the non-streaming path has always dropped citations.
            break;
          }
          case 'content_block_stop': {
            const block = blocks[event.index];
            if (block?.type === 'tool_use') {
              const raw = toolJson.get(event.index) ?? '';
              try {
                block.input = raw.length > 0 ? JSON.parse(raw) : {};
              } catch {
                // The model's own doing, not the transport's — routed to the
                // profile's recovery cascade exactly like a non-streaming
                // malformed tool call (`openai-compat.ts`'s own JSON.parse),
                // never to the stream→non-stream fallback below.
                throw new ProviderError(`malformed tool arguments from ${block.name}`, true, undefined, 'output');
              }
            }
            break;
          }
          case 'message_delta':
            stopReason = event.delta.stop_reason;
            usage.output_tokens = event.usage.output_tokens;
            yield { type: 'usage', usage: { outputTokens: event.usage.output_tokens } };
            break;
          case 'message_stop':
            break;
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderStreamError(error instanceof Error ? error.message : String(error), receivedAnyEvent, error);
    }

    yield {
      type: 'done',
      result: toChatResult({
        content: blocks,
        stop_reason: stopReason,
        usage,
        model,
      }),
    };
  }
}

/** The request body `chat()` and `chatStream()` share — everything but `stream` itself. */
function requestBody(call: ChatCall): Omit<Anthropic.MessageCreateParamsNonStreaming, 'stream'> {
  const reasoning = resolveAnthropicReasoning(call);
  if (reasoning.status === 'unsupported') throw new ReasoningConfigurationError(reasoning);
  const effective = reasoning.effective;
  return {
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
    ...(effective?.mode === 'off'
      ? { thinking: { type: 'disabled' as const } }
      : effective?.maxTokens !== undefined
        ? { thinking: { type: 'enabled' as const, budget_tokens: effective.maxTokens } }
        : effective?.mode === 'on' || effective?.mode === 'adaptive'
          ? { thinking: { type: 'adaptive' as const } }
          : {}),
    ...(effective?.effort === undefined ? {} : ({ output_config: { effort: effective.effort } } as Record<string, unknown>)),
  };
}

function resolveAnthropicReasoning(call: ChatCall): ReasoningResolution {
  const capabilities: ReasoningCapabilities = {
    supported: true,
    canDisable: true,
    supportedEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    supportsMaxTokens: /claude-(?:haiku|sonnet|opus)-4[.-]5(?:$|[-:])/.test(call.model),
    mandatory: false,
  };
  return resolveReasoningPolicy(reasoningRequest(call), capabilities, 'endpoint-defaults');
}

/**
 * One response, in the shape both `chat()` and `chatStream()`'s reconstructed
 * blocks share — a `Message` for the first, a hand-assembled lookalike for the
 * second. Pulled out because it used to exist only inside `chat()`'s body,
 * which is exactly the code `chatStream()` needs and must not fork: streaming
 * is a delta side-channel, not a second way of computing `ChatResult`.
 */
/**
 * Deliberately not `Pick<Anthropic.Message, …>`: the SDK's own `Usage` type
 * carries fields (`cache_creation`, `service_tier`, …) that a real response
 * always has and a hand-assembled streaming one does not bother filling in,
 * because nothing here reads them — the four fields below are the ones
 * `ChatResult.usage` has room for. `mapStopReason` already takes `string |
 * null` rather than the SDK's own `StopReason` enum for the same reason:
 * decoupled from a type this file does not own the evolution of.
 */
type ResultSource = {
  id?: string;
  content: Anthropic.ContentBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  model: string;
};

function toChatResult(response: ResultSource): ChatResult {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;

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
      // core/budget/pricing.ts's costUsd() treats inputTokens as the GRAND
      // TOTAL of input processed (true of the OpenRouter-compat wire's
      // prompt_tokens). The native Anthropic API's input_tokens is only the
      // remainder AFTER the last cache breakpoint — it excludes both fields
      // below by definition (platform.claude.com, prompt caching, verified
      // 2026-08-17) — so it has to be normalized to that total here, at the
      // adapter boundary, or costUsd() double-subtracts the cache read and
      // undercounts the cache-write premium 5× (P35).
      inputTokens: response.usage.input_tokens + cacheReadTokens + cacheWriteTokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens,
      cacheWriteTokens,
    },
    model: response.model,
  };
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
    // `{type:'image', source:{type:'base64', media_type, data}}` — docs Vision,
    // lette il 28/08/2026. La sorgente `url` esiste e non si usa: vedi
    // `ImageBlock` in providers/types.ts per il perche'.
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
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
    // L'API Messages non accetta audio in ingresso, in nessuna forma. Un blocco
    // audio qui non e' un formato da tradurre: e' un instradamento sbagliato a
    // monte, perche' `audioAccettato` (providers/modalita.ts) deve aver gia'
    // deciso di trascrivere in casa invece di spedire i byte.
    //
    // Tira, e non lo lascia cadere. Filtrarlo in silenzio manderebbe il turno
    // senza la cosa che l'owner ha detto, e la risposta parlerebbe di un
    // messaggio vuoto senza che nessuno sappia perche'.
    case 'audio':
      throw new Error(
        "l'API Anthropic non accetta audio in ingresso: questo audio andava trascritto, non spedito (agent/providers/modalita.ts)",
      );
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
