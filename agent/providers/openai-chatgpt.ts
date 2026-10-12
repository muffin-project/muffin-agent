import OpenAI, { APIError } from 'openai';
import type { ChatGPTModel } from '../../core/config/chatgpt-oauth.js';
import { isThinkingEffort } from '../../core/config/thinking.js';
import { compileForOpenAI } from './compile.js';
import {
  ReasoningConfigurationError,
  type ReasoningResolution,
  reasoningRequest,
  resolveReasoningPolicy,
} from './reasoning.js';
import {
  type ChatCall,
  type ChatResult,
  type ContentBlock,
  type Message,
  type Provider,
  ProviderError,
  type ProviderMessageMetadata,
  ProviderStreamError,
  parseRetryAfterMs,
  type StreamEvent,
  type ToolSpec,
} from './types.js';

const BASE_URL = 'https://api.openai.com/v1';
const MODEL_CATALOG_TTL_MS = 60_000;
const UNKNOWN_REASONING_CAPABILITIES = {
  support: 'unknown',
  canDisable: false,
  supportsMaxTokens: false,
  mandatory: false,
} as const;

export type ChatGPTConnection = {
  accessToken(signal?: AbortSignal): Promise<string>;
  listModels(signal?: AbortSignal): Promise<ChatGPTModel[]>;
};

export type ChatGPTProviderOptions = {
  fetch?: typeof fetch;
};

/**
 * ChatGPT plan inference over the public Responses API. Each call creates a
 * short-lived SDK client from the current OAuth access token, pins the public
 * endpoint, and requires the stream's own `response.completed` terminal event.
 *
 * The plan-usage preview does not accept `max_output_tokens`; `ChatCall` still
 * carries that field for other providers, but this adapter cannot express it
 * as a remote quota. Runtime deadlines remain the only local bound.
 * The same preview rejects sampling controls: this adapter omits temperature
 * and sampling overrides rather than claiming they were applied.
 */
export class OpenAIChatGPTProvider implements Provider {
  readonly kind = 'openai-chatgpt' as const;

  constructor(
    private readonly connection: ChatGPTConnection,
    private readonly options: ChatGPTProviderOptions = {},
  ) {}

  private modelCatalog: { expiresAt: number; models: ChatGPTModel[] } | undefined;

  async resolveReasoning(call: ChatCall): Promise<ReasoningResolution> {
    const request = reasoningRequest(call);
    if (request === undefined || request.mode === 'adaptive')
      return resolveReasoningPolicy(request, UNKNOWN_REASONING_CAPABILITIES, 'unknown');
    if (request.mode === 'on' && request.effort === undefined) {
      const policy = resolveReasoningPolicy(request, UNKNOWN_REASONING_CAPABILITIES, 'unknown');
      return policy.status === 'unsupported'
        ? policy
        : {
            requested: request,
            status: 'omitted',
            capabilitySource: 'unknown',
            reason:
              'Responses has no enable-only reasoning setting; model default remains in control',
          };
    }

    let model: ChatGPTModel | undefined;
    try {
      model = await this.findModel(call.model, call.signal);
    } catch {
      if (call.signal?.aborted) throw new ProviderError('aborted', false);
      return {
        requested: request,
        status: 'unsupported',
        capabilitySource: 'unknown',
        reason:
          'reasoning capability is unknown; refusing off or an exact effort until account catalog metadata is available',
      };
    }
    const capabilities =
      model?.supportedReasoningLevels === undefined
        ? UNKNOWN_REASONING_CAPABILITIES
        : {
            support: 'supported' as const,
            canDisable: model.supportedReasoningLevels.includes('none'),
            supportedEfforts: model.supportedReasoningLevels.filter(isThinkingEffort),
            ...(model.defaultReasoningLevel !== undefined &&
            model.defaultReasoningLevel !== 'none' &&
            isThinkingEffort(model.defaultReasoningLevel)
              ? { defaultEffort: model.defaultReasoningLevel }
              : {}),
            supportsMaxTokens: false,
            mandatory: false,
          };

    if (request.mode === 'on' && request.effort !== undefined && capabilities.support === 'unknown')
      return {
        requested: request,
        status: 'unsupported',
        capabilitySource: 'unknown',
        reason:
          'reasoning capability is unknown; refusing an exact effort until account catalog metadata is available',
      };

    const policy = resolveReasoningPolicy(
      request,
      capabilities,
      model === undefined ? 'unknown' : 'account-catalog',
    );
    if (policy.status === 'unsupported' || request.mode === 'off') return policy;
    // Responses has no boolean "enable reasoning" switch. Without an effort,
    // omission is the only honest representation of the model default.
    return policy;
  }

  private async findModel(model: string, signal?: AbortSignal): Promise<ChatGPTModel | undefined> {
    const now = Date.now();
    if (this.modelCatalog !== undefined && this.modelCatalog.expiresAt > now)
      return this.modelCatalog.models.find((item) => item.slug === model);
    const models = await this.connection.listModels(signal);
    this.modelCatalog = { models, expiresAt: now + MODEL_CATALOG_TTL_MS };
    return models.find((item) => item.slug === model);
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    for await (const event of this.run(call)) {
      if (event.type === 'done') return event.result;
    }
    throw new ProviderStreamError('Responses stream ended without a completed result', true);
  }

  // No public chatStream: the loop's non-stream fallback would issue a second
  // SSE request on this streaming-only route. chat() consumes exactly one SSE.

  private async *run(call: ChatCall): AsyncIterable<StreamEvent> {
    if (call.signal?.aborted) throw new ProviderError('aborted', false);
    const params = await this.requestBody(call);

    let receivedAnyEvent = false;
    let terminal: OpenAI.Responses.Response | undefined;
    let refusal = false;
    const toolItems = new Map<number, { id?: string; callId?: string; name?: string }>();
    const completedOutputItems = new Map<number, OpenAI.Responses.ResponseOutputItem>();
    const allowedTools = new Set((call.tools ?? []).map((tool) => tool.name));

    try {
      const accessToken = await this.connection.accessToken(call.signal);
      call.signal?.throwIfAborted();
      const client = new OpenAI({
        apiKey: accessToken,
        baseURL: BASE_URL,
        maxRetries: 0,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      });
      const stream = await client.responses.create(
        params,
        call.signal ? { signal: call.signal } : {},
      );

      for await (const event of stream) {
        if (terminal !== undefined)
          throw new ProviderError(
            'ChatGPT Responses emitted an event after terminal completion',
            false,
            undefined,
            'output',
          );
        receivedAnyEvent = true;
        switch (event.type) {
          case 'response.output_text.delta':
            yield { type: 'text_delta', text: event.delta };
            break;
          case 'response.refusal.delta':
            refusal = true;
            yield { type: 'text_delta', text: event.delta };
            break;
          case 'response.output_item.added':
          case 'response.output_item.done': {
            const item = event.item;
            if (event.type === 'response.output_item.done') {
              if (completedOutputItems.has(event.output_index))
                throw new ProviderError(
                  'ChatGPT Responses completed duplicate output indexes',
                  false,
                  undefined,
                  'output',
                );
              if ('status' in item && item.status !== 'completed')
                throw new ProviderError(
                  'ChatGPT Responses emitted an unfinished completed output item',
                  false,
                  undefined,
                  'output',
                );
              completedOutputItems.set(event.output_index, item);
            }
            if (item.type === 'function_call') {
              const index = event.output_index;
              const current = toolItems.get(index) ?? {};
              if (item.id !== undefined) current.id = item.id;
              current.callId = item.call_id;
              current.name = responseToolName(item, allowedTools);
              toolItems.set(index, current);
              if (event.type === 'response.output_item.added') {
                yield {
                  type: 'tool_call_delta',
                  index,
                  ...(current.callId ? { id: current.callId } : {}),
                  ...(current.name ? { name: current.name } : {}),
                };
              }
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            const index = event.output_index;
            const current = toolItems.get(index) ?? {};
            toolItems.set(index, current);
            yield {
              type: 'tool_call_delta',
              index,
              ...(current.callId ? { id: current.callId } : {}),
              ...(current.name ? { name: current.name } : {}),
              argsDelta: event.delta,
            };
            break;
          }
          case 'response.failed':
            throw responseFailure(event.response.error, event.response.id);
          case 'response.incomplete': {
            const reason = event.response.incomplete_details?.reason;
            const safeReason =
              reason === 'max_output_tokens' || reason === 'content_filter' ? reason : undefined;
            throw new ProviderError(
              `ChatGPT Responses returned an incomplete response${safeReason ? ` (${safeReason})` : ''}`,
              false,
            );
          }
          case 'error':
            throw responseFailure(event, undefined);
          case 'response.completed':
            if (terminal !== undefined)
              throw new ProviderError(
                'ChatGPT Responses emitted more than one completed terminal event',
                false,
              );
            terminal = event.response;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (
        error instanceof ProviderError ||
        error instanceof ProviderStreamError ||
        error instanceof ReasoningConfigurationError
      )
        throw error;
      if (call.signal?.aborted) throw new ProviderError('aborted', false);
      if (error instanceof APIError) throw apiProviderError(error);
      throw new ProviderStreamError('ChatGPT Responses stream failed', receivedAnyEvent);
    }

    if (call.signal?.aborted) throw new ProviderError('aborted', false);
    if (terminal === undefined)
      throw new ProviderStreamError(
        'ChatGPT Responses stream ended without response.completed',
        receivedAnyEvent,
      );
    if (terminal.status !== 'completed')
      throw new ProviderError('ChatGPT Responses terminal payload was not completed', false);
    if (terminal.model !== call.model)
      throw new ProviderError(
        'ChatGPT Responses returned a model different from the pinned request model',
        false,
      );

    // Some plan Responses streams carry final output items on the individual
    // `response.output_item.done` events while the completed response envelope
    // has an empty `output`. Only reconstruct after we observed a completed
    // terminal and verified its pinned model; an EOF after partial/done items
    // still fails above and cannot expose a tool call to the runtime.
    const resultResponse =
      terminal.output.length === 0 && completedOutputItems.size > 0
        ? {
            ...terminal,
            output: [...completedOutputItems.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, item]) => item),
          }
        : terminal;
    const result = resultFromResponse(resultResponse, refusal, allowedTools);
    yield { type: 'done', result };
  }

  private async requestBody(
    call: ChatCall,
  ): Promise<OpenAI.Responses.ResponseCreateParamsStreaming> {
    const reasoning = await this.resolveReasoning(call);
    if (reasoning.status === 'unsupported') throw new ReasoningConfigurationError(reasoning);
    return {
      model: call.model,
      input: toInputItems(compileForOpenAI(call.messages)),
      instructions: call.system.map((block) => textOnly(block, 'system instruction')).join('\n\n'),
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      ...(call.tools && call.tools.length > 0 ? { tools: toolsForResponses(call.tools) } : {}),
      ...(call.tools && call.tools.length > 0
        ? {
            tool_choice:
              call.toolChoice === 'none'
                ? 'none'
                : call.toolChoice === 'required'
                  ? 'required'
                  : 'auto',
          }
        : {}),
      ...(reasoning.effective?.mode === 'off' ? { reasoning: { effort: 'none' } } : {}),
      ...(reasoning.effective?.mode === 'on' && reasoning.effective.effort !== undefined
        ? { reasoning: { effort: reasoning.effective.effort } }
        : {}),
    };
  }
}

function textOnly(block: ContentBlock, label: string): string {
  if (block.type !== 'text')
    throw new ProviderError(`ChatGPT Responses does not accept ${block.type} in ${label}`, false);
  return block.text;
}

function toInputItems(messages: readonly Message[]): OpenAI.Responses.ResponseInputItem[] {
  const input: OpenAI.Responses.ResponseInputItem[] = [];
  for (const message of messages) {
    const reasoning = reasoningItems(message.providerMetadata);
    input.push(...reasoning);
    const content: OpenAI.Responses.ResponseInputMessageContentList = [];
    const flushMessage = () => {
      if (content.length === 0) return;
      if (message.role === 'assistant') {
        const text = content
          .flatMap((part) => (part.type === 'input_text' ? [part.text] : []))
          .join('\n\n');
        if (text) input.push({ role: 'assistant', content: text });
      } else {
        input.push({
          role: message.origin === 'harness' ? 'developer' : 'user',
          content: [...content],
        });
      }
      content.length = 0;
    };

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          content.push({ type: 'input_text', text: block.text });
          break;
        case 'image':
          if (message.role !== 'user')
            throw new ProviderError(
              'ChatGPT Responses only accepts images in user messages',
              false,
            );
          content.push({
            type: 'input_image',
            image_url: `data:${block.mediaType};base64,${block.data}`,
            detail: 'auto',
          });
          break;
        case 'audio':
          throw new ProviderError('ChatGPT plan Responses does not support audio input', false);
        case 'tool_use':
          if (message.role !== 'assistant')
            throw new ProviderError(`tool_use ${block.id} is not in an assistant message`, false);
          flushMessage();
          input.push({
            type: 'function_call',
            namespace: 'muffin',
            call_id: block.id,
            name: block.name,
            arguments: jsonArguments(block.input, block.name),
          });
          break;
        case 'tool_result':
          if (message.role !== 'user')
            throw new ProviderError(
              `tool_result ${block.toolCallId} is not in a user message`,
              false,
            );
          flushMessage();
          input.push({
            type: 'function_call_output',
            call_id: block.toolCallId,
            output: block.content,
          });
          break;
        case 'thinking':
        case 'redacted_thinking':
          // Provider-owned reasoning is only passed back when it came from
          // this provider; another provider's continuation bytes are invalid.
          break;
      }
    }
    flushMessage();
  }
  return input;
}

function jsonArguments(input: unknown, name: string): string {
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) throw new Error('not JSON serializable');
    return serialized;
  } catch {
    throw new ProviderError(
      `historical tool arguments for ${name} are not JSON serializable`,
      false,
    );
  }
}

function reasoningItems(
  metadata: ProviderMessageMetadata | undefined,
): OpenAI.Responses.ResponseInputItem[] {
  if (metadata?.reasoning?.provider !== 'openai-chatgpt') return [];
  if (!Array.isArray(metadata.reasoning.details)) return [];
  return metadata.reasoning.details.filter(isReasoningItem) as OpenAI.Responses.ResponseInputItem[];
}

function isReasoningItem(value: unknown): value is OpenAI.Responses.ResponseReasoningItem {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'reasoning'
  );
}

function toolsForResponses(tools: readonly ToolSpec[]): OpenAI.Responses.Tool[] {
  const names = new Set<string>();
  const functions = tools.map((tool) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) {
      throw new ProviderError(`invalid or duplicate tool name ${tool.name}`, false);
    }
    names.add(tool.name);
    return {
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    };
  });
  return [{ type: 'namespace', name: 'muffin', description: 'Muffin tools', tools: functions }];
}

function responseToolName(
  tool: OpenAI.Responses.ResponseFunctionToolCall,
  allowedTools: ReadonlySet<string>,
): string {
  if (tool.namespace !== undefined && tool.namespace !== 'muffin') {
    throw new ProviderError(
      `unexpected function namespace ${tool.namespace}`,
      false,
      undefined,
      'output',
    );
  }
  const name = tool.name.startsWith('muffin.') ? tool.name.slice('muffin.'.length) : tool.name;
  if (name.includes('.') || !allowedTools.has(name))
    throw new ProviderError(`unexpected function name ${tool.name}`, false, undefined, 'output');
  return name;
}

function resultFromResponse(
  response: OpenAI.Responses.Response,
  refusalEvent: boolean,
  allowedTools: ReadonlySet<string>,
): ChatResult {
  if (!Array.isArray(response.output))
    throw new ProviderError(
      'ChatGPT Responses completed without output items',
      false,
      undefined,
      'output',
    );
  const textParts: string[] = [];
  const toolCalls: ChatResult['toolCalls'] = [];
  let refusal = refusalEvent;
  const reasoning: OpenAI.Responses.ResponseReasoningItem[] = [];
  const callIds = new Set<string>();

  for (const item of response.output) {
    if (item.type === 'reasoning') {
      reasoning.push(item);
      continue;
    }
    if (item.type === 'function_call') {
      if (item.status !== undefined && item.status !== 'completed') {
        throw new ProviderError(
          'ChatGPT Responses completed with an unfinished function call',
          false,
          undefined,
          'output',
        );
      }
      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        throw new ProviderError(
          `invalid JSON arguments for tool ${item.name}`,
          false,
          undefined,
          'output',
        );
      }
      if (!item.call_id)
        throw new ProviderError(
          `function call ${item.name} has no call_id`,
          false,
          undefined,
          'output',
        );
      if (callIds.has(item.call_id))
        throw new ProviderError(
          `duplicate function call id ${item.call_id}`,
          false,
          undefined,
          'output',
        );
      callIds.add(item.call_id);
      toolCalls.push({ id: item.call_id, name: responseToolName(item, allowedTools), args });
      continue;
    }
    if (item.type === 'message') {
      if (item.status !== 'completed')
        throw new ProviderError(
          'ChatGPT Responses completed with an unfinished message',
          false,
          undefined,
          'output',
        );
      for (const part of item.content) {
        if (part.type === 'output_text') textParts.push(part.text);
        else if (part.type === 'refusal') {
          refusal = true;
          textParts.push(part.refusal);
        }
      }
      continue;
    }
    throw new ProviderError(
      `ChatGPT Responses returned unsupported output item ${item.type}`,
      false,
      undefined,
      'output',
    );
  }

  if (toolCalls.length > 0 && response.output.length === 0) {
    throw new ProviderError(
      'ChatGPT Responses completed with an empty tool result',
      false,
      undefined,
      'output',
    );
  }
  const text = textParts.join('').trim();
  const usage = response.usage;
  const providerMetadata: ProviderMessageMetadata | undefined =
    reasoning.length === 0
      ? undefined
      : { reasoning: { provider: 'openai-chatgpt', details: reasoning } };
  return {
    text: text || null,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : refusal ? 'refusal' : 'stop',
    stopReason: toolCalls.length > 0 ? 'tool_use' : refusal ? 'refusal' : 'end',
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      ...(usage?.output_tokens_details?.reasoning_tokens === undefined
        ? {}
        : { reasoningTokens: usage.output_tokens_details.reasoning_tokens }),
      cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: usage?.input_tokens_details?.cache_write_tokens ?? 0,
    },
    model: response.model,
    requestId: response.id,
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
  };
}

function responseFailure(error: unknown, requestId: string | undefined): ProviderError {
  const detail =
    error !== null && typeof error === 'object' ? (error as { code?: unknown }) : undefined;
  const rawCode = typeof detail?.code === 'string' ? detail.code : 'unknown_error';
  const code = /^[a-zA-Z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : 'unknown_error';
  const safeRequestId =
    requestId !== undefined && /^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ? requestId : undefined;
  const retryable =
    /^(rate_limit_exceeded|server_error|temporarily_unavailable|timeout|internal_error)$/i.test(
      code,
    );
  return new ProviderError(
    `ChatGPT Responses failed (${code})${safeRequestId ? ` [${safeRequestId}]` : ''}`,
    retryable,
  );
}

function apiProviderError(error: APIError): ProviderError {
  const status = error.status;
  const retryable =
    status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
  const requestId =
    error.requestID && /^[a-zA-Z0-9_-]{1,100}$/.test(error.requestID)
      ? ` [${error.requestID}]`
      : '';
  return new ProviderError(
    `ChatGPT Responses HTTP request failed${status === undefined ? '' : ` (${status})`}${requestId}`,
    retryable,
    status,
    'transport',
    parseRetryAfterMs(error.headers),
  );
}
