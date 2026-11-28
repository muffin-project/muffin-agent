import OpenAI, { APIConnectionError, APIError } from 'openai';
import {
  type ChatGPTModel,
  ChatGPTModelCatalogUnavailable,
  ChatGPTReauthenticationRequired,
} from '../../core/config/chatgpt-oauth.js';
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
  type ToolSpec,
} from './types.js';

const BASE_URL = 'https://api.openai.com/v1';
const PLAN_USAGE_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded';
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
  /** Optional: remember a plan usage-limit refusal until a reply succeeds. */
  recordPlanUsage?(limited: boolean): Promise<void>;
};

type HostedSearchHit = { title: string; url: string; snippet: string };

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
    } catch (error) {
      if (call.signal?.aborted)
        throw new ProviderError('aborted', false, undefined, 'transport', undefined, false, {
          receivedAnyEvent: false,
        });
      if (error instanceof ChatGPTReauthenticationRequired) throw reauthenticationError(error);
      if (error instanceof ChatGPTModelCatalogUnavailable) {
        // The chain can try a fall-back provider. With no usable fallback,
        // stop the turn instead of repeatedly fetching the same metadata.
        throw new ProviderError(
          'ChatGPT model catalog is temporarily unavailable',
          false,
          error.status,
          'transport',
          undefined,
          false,
          {
            ...(error.status === undefined ? { connection: true } : {}),
            reasoningCatalogUnavailable: true,
            receivedAnyEvent: false,
          },
        );
      }
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
    try {
      const { response, refusal, firstTextMs } = await this.complete(call);
      const result = resultFromResponse(
        response,
        refusal,
        new Set((call.tools ?? []).map((tool) => tool.name)),
      );
      await this.notePlanUsage(false);
      return firstTextMs === undefined ? result : { ...result, firstTextMs };
    } catch (error) {
      if (error instanceof ProviderError && error.details?.quota === 'chatgpt-plan')
        await this.notePlanUsage(true);
      // Incomplete SSE must not expose partial text or local tool calls.
      if (error instanceof ProviderStreamError)
        throw new ProviderError(error.message, true, undefined, 'transport');
      throw error;
    }
  }

  /** Called only by the selected search backend after ordinary query authorization. */
  async searchWeb(
    model: string,
    query: string,
    signal: AbortSignal,
    options: { maxResults?: number | undefined; beforeSend?: () => void } = {},
  ): Promise<HostedSearchHit[]> {
    try {
      const { response, refusal } = await this.complete(
        {
          model,
          system: [
            {
              type: 'text',
              text: 'Use hosted web search for the supplied query. Return a brief answer with citations to the sources found.',
            },
          ],
          messages: [{ role: 'user', origin: 'owner', content: [{ type: 'text', text: query }] }],
          // The plan API has no remote output-token control. The caller supplies the deadline.
          maxOutputTokens: 0,
          stream: false,
          signal,
        },
        options,
      );
      if (
        refusal ||
        !response.output.some(
          (item) => item.type === 'web_search_call' && item.status === 'completed',
        )
      ) {
        throw new ProviderError('ChatGPT returned no completed web search', false);
      }
      return webCitations(response, options.maxResults ?? 5);
    } catch (error) {
      // A plan-limit refusal keeps its quota classification for the owner.
      if (error instanceof ProviderError && error.details?.quota === 'chatgpt-plan') {
        await this.notePlanUsage(true);
        throw error;
      }
      // The server may already have performed a search when transport or
      // parsing fails. An automatic retry could charge the connected plan again.
      const detail =
        error instanceof ProviderError || error instanceof ProviderStreamError
          ? error.message
          : 'ChatGPT returned an unreadable web search result';
      throw new ProviderError(detail, false);
    }
  }

  /** Diagnostics only: failing to record must not change the turn's outcome. */
  private async notePlanUsage(limited: boolean): Promise<void> {
    try {
      await this.connection.recordPlanUsage?.(limited);
    } catch {
      // The reply or the original error is what the caller needs.
    }
  }

  // No public chatStream: the loop's non-stream fallback would issue another
  // request on this streaming-only route. Both operations require a terminal.
  private async complete(
    call: ChatCall,
    hostedSearch?: { beforeSend?: () => void },
  ): Promise<{
    response: OpenAI.Responses.Response;
    refusal: boolean;
    firstTextMs: number | undefined;
  }> {
    if (call.signal?.aborted)
      throw new ProviderError('aborted', false, undefined, 'transport', undefined, false, {
        receivedAnyEvent: false,
      });
    const params = await this.requestBody(call);
    if (hostedSearch) {
      params.tools = [{ type: 'web_search', external_web_access: true }];
      params.tool_choice = 'auto';
    }

    let receivedAnyEvent = false;
    let terminal: OpenAI.Responses.Response | undefined;
    let refusal = false;
    let firstTextMs: number | undefined;
    const completedOutputItems = new Map<number, OpenAI.Responses.ResponseOutputItem>();
    const allowedTools = new Set((call.tools ?? []).map((tool) => tool.name));

    let accessToken: string;
    try {
      accessToken = await this.connection.accessToken(call.signal);
    } catch (error) {
      if (call.signal?.aborted)
        throw new ProviderError('aborted', false, undefined, 'transport', undefined, false, {
          receivedAnyEvent: false,
        });
      if (error instanceof ChatGPTReauthenticationRequired) throw reauthenticationError(error);
      // Credential acquisition is not an inference-stream failure. Preserve
      // its non-retryable boundary without exposing OAuth error details.
      throw new ProviderError(
        'ChatGPT access token unavailable',
        false,
        undefined,
        'transport',
        undefined,
        false,
        {
          credentials: 'unavailable',
        },
      );
    }

    try {
      call.signal?.throwIfAborted();
      hostedSearch?.beforeSend?.();
      const client = new OpenAI({
        apiKey: accessToken,
        baseURL: BASE_URL,
        maxRetries: 0,
        fetchOptions: { redirect: 'error' },
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      });
      const requestStartedAt = performance.now();
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
          case 'response.refusal.delta':
            if (event.type === 'response.refusal.delta') refusal = true;
            if (firstTextMs === undefined && event.delta.trim() !== '') {
              firstTextMs = Math.round(performance.now() - requestStartedAt);
            }
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
              if (hostedSearch) {
                throw new ProviderError('ChatGPT returned an unexpected web search item', false);
              }
              responseToolName(item, allowedTools);
            }
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
      if (call.signal?.aborted)
        throw new ProviderError('aborted', false, undefined, 'transport', undefined, false, {
          receivedAnyEvent,
        });
      if (error instanceof APIError) throw apiProviderError(error);
      throw new ProviderStreamError('ChatGPT Responses stream failed', receivedAnyEvent);
    }

    if (call.signal?.aborted)
      throw new ProviderError('aborted', false, undefined, 'transport', undefined, false, {
        receivedAnyEvent,
      });
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
    return { response: resultResponse, refusal, firstTextMs };
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

function reauthenticationError(error: ChatGPTReauthenticationRequired): ProviderError {
  return new ProviderError(error.message, false, undefined, 'transport', undefined, false, {
    reauthentication: 'chatgpt',
  });
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

function webCitations(response: OpenAI.Responses.Response, maxResults: number): HostedSearchHit[] {
  const hits = new Map<string, HostedSearchHit>();
  for (const item of response.output) {
    if (item.type === 'reasoning' || item.type === 'web_search_call') continue;
    if (item.type !== 'message' || item.status !== 'completed') {
      throw new ProviderError('ChatGPT returned an unexpected web search item', false);
    }
    for (const part of item.content) {
      if (part.type === 'refusal') throw new ProviderError('ChatGPT refused the web search', false);
      if (part.type !== 'output_text') continue;
      for (const citation of part.annotations) {
        if (citation.type !== 'url_citation' || typeof citation.title !== 'string') continue;
        const url = URL.parse(citation.url);
        if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) continue;
        if (url.username || url.password || hits.has(url.href) || hits.size >= maxResults) continue;
        const title = citation.title.trim().slice(0, 300);
        hits.set(url.href, { title: title || url.hostname, url: url.href, snippet: '' });
      }
    }
  }
  return [...hits.values()];
}

function responseFailure(error: unknown, requestId: string | undefined): ProviderError {
  const detail =
    error !== null && typeof error === 'object' ? (error as { code?: unknown }) : undefined;
  const rawCode = typeof detail?.code === 'string' ? detail.code : 'unknown_error';
  const code = /^[a-zA-Z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : 'unknown_error';
  const safeRequestId =
    requestId !== undefined && /^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ? requestId : undefined;
  const message = `ChatGPT Responses failed (${code})${safeRequestId ? ` [${safeRequestId}]` : ''}`;
  if (code === PLAN_USAGE_LIMIT_CODE) {
    const retryAt = declaredResetAt(detail);
    return new ProviderError(message, false, undefined, 'transport', undefined, false, {
      quota: 'chatgpt-plan',
      ...(retryAt === undefined ? {} : { retryAt }),
    });
  }
  const retryable =
    /^(rate_limit_exceeded|server_error|temporarily_unavailable|timeout|internal_error)$/i.test(
      code,
    );
  return new ProviderError(message, retryable);
}

/**
 * The reset instant a usage-limit body declares, in epoch ms. Codex-style
 * bodies carry `resets_at` (epoch seconds) or `resets_in_seconds`; anything
 * else, or a value that is not a plausible future instant, is undeclared.
 */
export function declaredResetAt(body: unknown, now = Date.now()): number | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as { resets_at?: unknown; resets_in_seconds?: unknown; error?: unknown };
  if (typeof record.resets_at === 'number' && Number.isFinite(record.resets_at)) {
    const at = record.resets_at * 1000;
    return at > now ? at : undefined;
  }
  if (
    typeof record.resets_in_seconds === 'number' &&
    Number.isFinite(record.resets_in_seconds) &&
    record.resets_in_seconds > 0
  ) {
    return now + record.resets_in_seconds * 1000;
  }
  if (record.error !== undefined && record.error !== body)
    return declaredResetAt(record.error, now);
  return undefined;
}

function apiProviderError(error: APIError): ProviderError {
  const status = error.status;
  const requestId =
    error.requestID && /^[a-zA-Z0-9_-]{1,100}$/.test(error.requestID) ? error.requestID : undefined;
  // The plan limit arrives either as HTTP 429 or inside an already open
  // stream, where the SDK raises an APIError with no status. Both are the
  // same quota, and neither is helped by retrying soon.
  if ((status === 429 || status === undefined) && error.code === PLAN_USAGE_LIMIT_CODE) {
    const retryAt = declaredResetAt(error.error);
    return new ProviderError(
      'ChatGPT plan usage limit exceeded',
      false,
      status,
      'transport',
      undefined,
      false,
      {
        quota: 'chatgpt-plan',
        ...(requestId === undefined ? {} : { requestId }),
        ...(retryAt === undefined ? {} : { retryAt }),
      },
    );
  }
  const retryable =
    error instanceof APIConnectionError ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500);
  return new ProviderError(
    `ChatGPT Responses HTTP request failed${status === undefined ? '' : ` (${status})`}${requestId ? ` [${requestId}]` : ''}`,
    retryable,
    status,
    'transport',
    parseRetryAfterMs(error.headers),
    false,
    error instanceof APIConnectionError ? { connection: true } : undefined,
  );
}
