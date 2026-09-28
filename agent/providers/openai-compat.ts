import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { compileForOpenAI } from './compile.js';
import {
  ProviderError,
  ProviderStreamError,
  parseRetryAfterMs,
  type AudioMediaType,
  type ChatCall,
  type ChatResult,
  type ContentBlock,
  type Message,
  type ProviderMessageMetadata,
  type Provider,
  type StopReason,
  type StreamEvent,
} from './types.js';
import {
  ReasoningConfigurationError,
  reasoningRequest,
  resolveReasoningPolicy,
  type ReasoningCapabilities,
  type ReasoningResolution,
} from './reasoning.js';
import { OpenRouterReasoningDiscovery, type OpenRouterDiscoveryResult } from './openrouter-reasoning.js';

/**
 * OpenAI-compatible chat completions.
 *
 * This is the widest door in the ecosystem: Ollama, llama.cpp, vLLM,
 * OpenRouter, DeepSeek and most hosted providers all speak it. An open-source
 * project cannot demand one vendor, and this is how you avoid it without
 * paying for a framework.
 *
 * Reasoning is carried through the canonical provider-agnostic
 * `ChatCall.reasoning` intent. OpenRouter receives the supported subset; local
 * OpenAI-compatible endpoints omit the field because unknown request fields
 * are commonly rejected. Legacy `ChatCall.thinking` is normalized at the
 * boundary for direct callers.
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

/**
 * Whether this endpoint understands a request to stop reasoning.
 *
 * Same shape as `wantsExplicitCache` and for the same reason: the dialect is a
 * property of the endpoint, not of the caller. OpenRouter's chat-completion
 * schema carries `reasoning.effort`, and `"none"` is in its enum (their API
 * reference, verified 2026-08-27); Ollama, llama.cpp and vLLM know no such
 * field, and a strict parser 400s on one it does not know.
 *
 * Hostname, not substring, and the trailing dot folded — the argument is
 * `wantsExplicitCache`'s, unchanged: `openrouter.ai.evil.tld` must not flip
 * request shape.
 */
/**
 * Se questo endpoint sa tenere una conversazione sullo stesso provider a monte.
 *
 * Stesso argomento di `wantsExplicitCache` e `speaksReasoningEffort`, e stesso
 * hostname esatto col punto finale ripiegato: `session_id` è un campo del corpo
 * di OpenRouter, e un server che non lo conosce o lo ignora o 400a. Non è una
 * cosa che si prova mandandolo e vedendo.
 */
export function speaksStickySession(baseURL?: string): boolean {
  try {
    if (!baseURL) return false;
    const host = new URL(baseURL).hostname.toLowerCase().replace(/\.$/, '');
    return /(^|\.)openrouter\.ai$/.test(host);
  } catch {
    return false;
  }
}

function speaksReasoningEffort(baseURL?: string): boolean {
  try {
    if (!baseURL) return false;
    const host = new URL(baseURL).hostname.toLowerCase().replace(/\.$/, '');
    return /(^|\.)openrouter\.ai$/.test(host);
  } catch {
    return false;
  }
}

/** Small, dated capability snapshot; discovery is intentionally not per call. */
export function openRouterReasoningCapabilities(model: string, baseURL?: string): {
  capabilities: ReasoningCapabilities;
  source: 'static-snapshot' | 'endpoint-defaults' | 'unknown';
} {
  if (!speaksReasoningEffort(baseURL)) {
    return {
      capabilities: { support: 'unsupported', canDisable: true, supportsMaxTokens: false, mandatory: false },
      source: 'endpoint-defaults',
    };
  }
  if (model.toLowerCase() === 'qwen/qwen3.8-27b') {
    return {
      capabilities: {
        support: 'supported',
        canDisable: true,
        supportedEfforts: ['xhigh', 'medium', 'low'],
        defaultEnabled: true,
        defaultEffort: 'xhigh',
        supportsMaxTokens: false,
        mandatory: false,
      },
      source: 'static-snapshot',
    };
  }
  return {
    capabilities: { support: 'unknown', canDisable: false, supportsMaxTokens: false, mandatory: false },
    source: 'unknown',
  };
}

/**
 * Le preferenze di instradamento, coi **nostri** nomi.
 *
 * La traduzione verso i nomi di OpenRouter (`require_parameters`,
 * `data_collection`) sta in `routingBody`, qui sotto, e in nessun altro posto:
 * un nome del fornitore copiato in due punti diverge al primo cambio.
 */
export type Routing = {
  // `| undefined` esplicito su ogni campo: sotto `exactOptionalPropertyTypes`
  // «assente» e «presente e undefined» sono due tipi diversi, e ciò che arriva
  // da uno schema zod è il secondo. Senza, il config non è assegnabile qui e la
  // manopola resterebbe una manopola scollegata.
  only?: readonly string[] | undefined;
  order?: readonly string[] | undefined;
  ignore?: readonly string[] | undefined;
  sort?: 'price' | 'throughput' | 'latency' | undefined;
  requireParameters?: boolean | undefined;
  dataCollection?: 'allow' | 'deny' | undefined;
  allowFallbacks?: boolean | undefined;
  quantizations?: readonly string[] | undefined;
};

/**
 * Le preferenze nella forma del corpo di OpenRouter, o `undefined` se non c'è
 * niente da dire.
 *
 * `undefined` per un oggetto vuoto e non `{}`: mandare un `provider: {}` vuoto
 * è un campo in più che non chiede niente, e su un endpoint che non lo conosce
 * è un campo in più su cui può inciampare.
 */
export function routingBody(r: Routing | undefined): Record<string, unknown> | undefined {
  if (!r) return undefined;
  const fuori: Record<string, unknown> = {
    ...(r.only ? { only: [...r.only] } : {}),
    ...(r.order ? { order: [...r.order] } : {}),
    ...(r.ignore ? { ignore: [...r.ignore] } : {}),
    ...(r.sort !== undefined ? { sort: r.sort } : {}),
    ...(r.requireParameters !== undefined ? { require_parameters: r.requireParameters } : {}),
    ...(r.dataCollection !== undefined ? { data_collection: r.dataCollection } : {}),
    ...(r.allowFallbacks !== undefined ? { allow_fallbacks: r.allowFallbacks } : {}),
    ...(r.quantizations ? { quantizations: [...r.quantizations] } : {}),
  };
  return Object.keys(fuori).length > 0 ? fuori : undefined;
}

export class OpenAICompatProvider implements Provider {
  readonly kind = 'openai-compat' as const;
  private readonly client: OpenAI;
  /** Public because the wiring is the part of this feature that must be provable. */
  readonly explicitCache: boolean;
  /** Se mandare `session_id` per tenere la conversazione sullo stesso provider a monte. */
  readonly stickySession: boolean;
  /** Le preferenze di instradamento dell'owner, già nella forma del corpo. */
  private readonly routing: Record<string, unknown> | undefined;
  /** Endpoint che smista fra più provider a monte (OpenRouter). */
  private readonly openRouter: boolean;
  /**
   * L'owner ha inchiodato la rotta (`only`/`order`)? Se sì, il re-drive dopo
   * risposte vuote non deve ignorare l'unico provider ammesso: renderebbe il
   * tentativo impossibile invece che diverso.
   */
  private readonly routingPinned: boolean;
  private readonly baseURL: string | undefined;
  private readonly reasoningDiscovery: OpenRouterReasoningDiscovery | undefined;
  private discoveredReasoning: OpenRouterDiscoveryResult | undefined;
  /** Public for the same reason: the wiring is the part that must be provable. */
  readonly reasoningEffort: boolean;

  constructor(
    apiKey: string,
    baseURL?: string,
    private readonly headers: Record<string, string> = {},
    opts: {
      explicitCache?: boolean;
      reasoningEffort?: boolean;
      stickySession?: boolean;
      routing?: Routing;
      fetch?: typeof globalThis.fetch;
      metadataFetch?: typeof globalThis.fetch;
      reasoningDiscovery?: OpenRouterReasoningDiscovery;
      discoverReasoning?: boolean;
      routerMetadata?: boolean;
    } = {},
  ) {
    this.baseURL = baseURL;
    this.reasoningDiscovery = opts.discoverReasoning === false
      ? undefined
      : opts.reasoningDiscovery ?? (speaksReasoningEffort(baseURL)
        ? new OpenRouterReasoningDiscovery({ ...(opts.metadataFetch === undefined ? {} : { fetch: opts.metadataFetch }), headers })
        : undefined);
    this.explicitCache = opts.explicitCache ?? wantsExplicitCache(baseURL);
    this.stickySession = opts.stickySession ?? speaksStickySession(baseURL);
    // Le preferenze si mandano solo a chi smista. Su un Ollama locale non c'è
    // niente da instradare, e un campo che non conosce è un campo su cui può
    // inciampare — stesso argomento di `session_id` e `reasoning`.
    this.routing = speaksStickySession(baseURL) ? routingBody(opts.routing) : undefined;
    this.openRouter = speaksStickySession(baseURL);
    this.routingPinned = opts.routing?.only !== undefined || opts.routing?.order !== undefined;
    this.reasoningEffort = opts.reasoningEffort ?? speaksReasoningEffort(baseURL);
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      ...(baseURL ? { baseURL } : {}),
      defaultHeaders: { ...headers, ...(opts.routerMetadata === true ? { 'X-OpenRouter-Metadata': 'enabled' } : {}) },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async resolveReasoning(call: ChatCall): Promise<ReasoningResolution> {
    await this.discoverReasoning(call.model);
    return this.resolveReasoningFromCache(call);
  }

  private resolveReasoningFromCache(call: ChatCall): ReasoningResolution {
    if (this.discoveredReasoning !== undefined) return resolveReasoningPolicy(reasoningRequest(call), this.discoveredReasoning.capabilities, this.discoveredReasoning.source);
    const { capabilities, source } = openRouterReasoningCapabilities(call.model, this.baseURL);
    return resolveReasoningPolicy(reasoningRequest(call), capabilities, source);
  }

  private async discoverReasoning(model: string): Promise<void> {
    if (this.reasoningDiscovery === undefined || this.baseURL === undefined) return;
    this.discoveredReasoning = await this.reasoningDiscovery.resolve(this.baseURL, model);
    if (this.discoveredReasoning.capabilities.support === 'unknown') {
      const fallback = openRouterReasoningCapabilities(model, this.baseURL);
      if (fallback.source === 'static-snapshot') this.discoveredReasoning = { ...this.discoveredReasoning, ...fallback };
    }
  }

  private reasoningMetadata(message: unknown): ProviderMessageMetadata | undefined {
    if (!this.reasoningEffort || message === undefined || message === null || typeof message !== 'object') return undefined;
    const raw = message as { reasoning_details?: unknown; reasoning?: unknown; reasoning_content?: unknown };
    const details = Array.isArray(raw.reasoning_details) ? raw.reasoning_details : undefined;
    const content = typeof raw.reasoning === 'string' && raw.reasoning.length > 0 ? raw.reasoning : typeof raw.reasoning_content === 'string' && raw.reasoning_content.length > 0 ? raw.reasoning_content : undefined;
    if (details === undefined && content === undefined) return undefined;
    return { reasoning: { provider: 'openrouter', ...(details === undefined ? {} : { details }), ...(content === undefined ? {} : { content }) } };
  }

  async chat(call: ChatCall): Promise<ChatResult> {
    try {
      await this.discoverReasoning(call.model);
      const response = await this.client.chat.completions.create(this.requestBody(call), call.signal ? { signal: call.signal } : {});

      const choice = response.choices[0];
      if (!choice) throw new ProviderError('provider returned no choices', true);

      const text = (choice.message.content ?? '').trim();
      const toolCalls: RawToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
        // A tool call shaped wrong is an error here, where the recovery
        // cascade can see it, not three layers down inside a tool. Parsing
        // itself is deferred to `toChatResult`, the one place both this method
        // and `chatStream` turn accumulated JSON text into `args` — so a
        // malformed-arguments error is classified identically on both paths.
        if (!('function' in tc)) throw new ProviderError(`unsupported tool call type`, false);
        return { id: tc.id, name: tc.function.name, argsRaw: tc.function.arguments };
      });

      return toChatResult({
        text: text.length > 0 ? text : null,
        toolCalls,
        finishReason: choice.finish_reason,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          ...(response.usage?.completion_tokens_details?.reasoning_tokens === undefined
            ? {}
            : { reasoningTokens: response.usage.completion_tokens_details.reasoning_tokens }),
          cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          // On the SDK's own type since v7 (CompletionUsage). The hardcoded 0
          // that stood here is how a missing feature stayed invisible: zero
          // reads as "cache unavailable" when the truth was "never requested".
          cacheWriteTokens: response.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
        },
        upstream: upstreamOf(response),
        model: response.model,
        requestId: response.id,
        providerMetadata: this.reasoningMetadata(choice.message),
      });
    } catch (error) {
      throw wrap(error);
    }
  }

  /**
   * SSE `data: {...}` chunks over the SDK the file already depends on:
   * `chat.completions.create({..., stream: true})` returns
   * `Stream<ChatCompletionChunk>` (`AsyncIterable`, `node_modules/openai`
   * v7.4.0, `src/core/streaming.ts`), terminated by the wire's own `data:
   * [DONE]` — the SDK consumes that sentinel itself and simply ends iteration;
   * there is no `[DONE]` case in this switch because nothing here ever sees
   * one. Confirmed against `developers.openai.com`'s streaming-events
   * reference, 2026-08-16: `delta.content` accumulates per choice,
   * `delta.tool_calls[i]` carries `index` (never re-sent id/name after the
   * first fragment for that index) and incremental `function.arguments`
   * fragments, and the final `usage` chunk only arrives when the request sets
   * `stream_options.include_usage: true` — set below, or every streamed call
   * would report zero usage forever, the same silent-zero defect ADR-0008
   * exists to name.
   *
   * Tool-call parsing happens once, after the loop, unlike the Anthropic
   * adapter's per-block `content_block_stop`: OpenAI's wire has no equivalent
   * "this tool call is done" event mid-stream, only accumulation by index
   * until the stream itself ends — so there is nothing to parse until then.
   */
  async *chatStream(call: ChatCall): AsyncIterable<StreamEvent> {
    await this.discoverReasoning(call.model);
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        { ...this.requestBody(call), stream: true, stream_options: { include_usage: true } },
        call.signal ? { signal: call.signal } : {},
      );
    } catch (error) {
      // Nothing was ever streamed — `chat()`'s own failure shape, not the
      // stream breaking mid-flight. See the matching comment in
      // `anthropic.ts#chatStream`.
      throw wrap(error);
    }

    let text = '';
    const toolCalls = new Map<number, RawToolCall>();
    let finishReason: string | null = null;
    let usage: OpenAI.Chat.Completions.ChatCompletionChunk['usage'];
    let model = call.model;
    let requestId: string | undefined;
    // Lo smistatore mette `provider` su ogni chunk; basta l'ultimo che lo porta.
    let upstream: string | undefined;
    const reasoningDetails: unknown[] = [];
    let reasoningContent = '';
    // See `ProviderStreamError.partial`.
    let receivedAnyEvent = false;

    try {
      for await (const chunk of stream) {
        receivedAnyEvent = true;
        model = chunk.model;
        requestId = chunk.id ?? requestId;
        upstream = upstreamOf(chunk) ?? upstream;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;

        const delta = choice?.delta;
        const rawDelta = delta as unknown as { reasoning_details?: unknown[]; reasoning?: unknown; reasoning_content?: unknown } | undefined;
        if (Array.isArray(rawDelta?.reasoning_details)) reasoningDetails.push(...rawDelta.reasoning_details);
        if (typeof rawDelta?.reasoning === 'string') reasoningContent += rawDelta.reasoning;
        if (typeof rawDelta?.reasoning_content === 'string') reasoningContent += rawDelta.reasoning_content;
        if (delta?.content) {
          text += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const existing = toolCalls.get(tc.index);
          if (existing === undefined) {
            toolCalls.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', argsRaw: tc.function?.arguments ?? '' });
            yield {
              type: 'tool_call_delta',
              index: tc.index,
              ...(tc.id ? { id: tc.id } : {}),
              ...(tc.function?.name ? { name: tc.function.name } : {}),
            };
          } else if (tc.function?.arguments) {
            existing.argsRaw += tc.function.arguments;
          }
          if (tc.function?.arguments) yield { type: 'tool_call_delta', index: tc.index, argsDelta: tc.function.arguments };
        }
      }
    } catch (error) {
      /**
       * L'errore in-band di OpenRouter, riconosciuto da come l'SDK lo porta.
       *
       * La documentazione primaria (openrouter.ai/docs, errori e debug): il
       * 200 parte quando il provider accetta la richiesta, prima che il
       * modello produca un token — ogni fallimento dopo viaggia DENTRO la
       * risposta, con un oggetto `error` top-level e `finish_reason: "error"`,
       * e lo status resta 200. L'SDK solleva quel chunk come `APIError` prima
       * ancora di cederlo al loop, e lo si riconosce da `status ===
       * undefined`: un fallimento HTTP vero ha sempre uno status, uno
       * incorporato nello stream no (misurato contro l'SDK installato).
       *
       * Senza questo ramo l'errore cade nel `ProviderStreamError` qui sotto:
       * "stream rotto", un solo fallback non-streaming, e poi errore secco —
       * senza mai toccare il budget di trasporto. Invece è un fallimento del
       * fornitore con un codice, quindi `ProviderError` con la retryability
       * del codice: 408/429/5xx fanno backoff durevole, 4xx falliscono subito
       * invece di bruciare 10 retry su una chiave morta.
       *
       * Il caso gemello — `finish_reason: 'error'` senza oggetto top-level,
       * che l'SDK cede normalmente — lo intercetta `toChatResult` qui sotto.
       * Senza entrambi, un fallimento del fornitore attraversava il loop come
       * un completamento vuoto con `stopReason: 'end'` (misurato il
       * 16/09/2026: cinque vuoti da 30,00s, zero retry consumati, quattro
       * nudge sprecati e poi `error`).
       */
      if (error instanceof OpenAI.APIError && error.status === undefined) {
        const payload = (error as unknown as { error?: unknown }).error;
        throw providerErrorFromWire(
          payload !== undefined && payload !== null ? payload : { code: error.code, message: error.message },
          model,
          error.headers,
        );
      }
      // Un ProviderError resta tale: è già classificato (retryable o no,
      // transport o output) e il chiamante sa instradarlo. Avvolgerlo in un
      // ProviderStreamError lo degraderebbe a "stream rotto" con un solo
      // fallback — la stessa forma di mascheramento chiusa qui sopra.
      if (error instanceof ProviderError) throw error;
      throw new ProviderStreamError(error instanceof Error ? error.message : String(error), receivedAnyEvent, error);
    }

    yield {
      type: 'done',
      result: toChatResult({
        text: text.trim().length > 0 ? text.trim() : null,
        toolCalls: [...toolCalls.values()],
        finishReason,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          ...(usage?.completion_tokens_details?.reasoning_tokens === undefined
            ? {}
            : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }),
          cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
        },
        model,
        upstream,
        requestId,
        providerMetadata: this.reasoningMetadata({ reasoning_details: reasoningDetails, reasoning: reasoningContent }),
      }),
    };
  }

  /** The request body `chat()` and `chatStream()` share — everything but `stream` itself. */
  private requestBody(call: ChatCall): Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'stream'> {
    const reasoning = this.resolveReasoningFromCache(call);
    if (reasoning.status === 'unsupported') throw new ReasoningConfigurationError(reasoning);
    const effective = reasoning.effective;
    const explicitReasoningConstraint = effective !== undefined && (effective.mode === 'off' || effective.mode === 'on' || effective.effort !== undefined || effective.maxTokens !== undefined);
    const configuredRouting = this.routing;
    const baseRouting = explicitReasoningConstraint
      ? { ...(configuredRouting ?? {}), require_parameters: true }
      : configuredRouting;
    /**
     * Il re-drive dopo risposte vuote (P0-A) nomina il provider a monte che non
     * ha risposto niente: ignorarlo fa atterrare il tentativo su una macchina
     * diversa invece che sulla stessa. Solo su uno smistatore, e solo se l'owner
     * non ha inchiodato la rotta: con `only`/`order` ignorare l'unico provider
     * ammesso renderebbe il tentativo impossibile invece che diverso.
     */
    const ignore = call.providerIgnore ?? [];
    const existingIgnore = Array.isArray((baseRouting as { ignore?: unknown } | undefined)?.ignore)
      ? ((baseRouting as { ignore: unknown[] }).ignore)
      : [];
    const providerRouting =
      ignore.length > 0 && this.openRouter && !this.routingPinned
        ? { ...(baseRouting ?? {}), ignore: [...new Set([...existingIgnore, ...ignore])] }
        : baseRouting;
    return {
      model: call.model,
      max_tokens: call.maxOutputTokens,
      // Absent stays absent. Local servers want temperature 0 and get it;
      // a gateway fronting a model that removed sampling gets no field at
      // all rather than a `temperature: undefined` some strict parser will
      // reject. (OpenRouter drops unsupported parameters instead of 400ing
      // — `temperature` is not in claude-sonnet-5's supported_parameters
      // there — but "the gateway forgives us" is not a contract.)
      ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
      ...(call.sampling === undefined ? {} : {
        ...(call.sampling.temperature !== undefined ? { temperature: call.sampling.temperature } : {}),
        ...(call.sampling.topP !== undefined ? { top_p: call.sampling.topP } : {}),
        ...(call.sampling.topK !== undefined ? { top_k: call.sampling.topK } : {}),
        ...(call.sampling.minP !== undefined ? { min_p: call.sampling.minP } : {}),
        ...(call.sampling.presencePenalty !== undefined ? { presence_penalty: call.sampling.presencePenalty } : {}),
        ...(call.sampling.repetitionPenalty !== undefined ? { repetition_penalty: call.sampling.repetitionPenalty } : {}),
      }),
      // `thinking: 'off'` stops being a declared no-op here — but only where the
      // endpoint speaks the field. The measured cost of the no-op was not the
      // lost text: it was 1502 output tokens spent reasoning, per extraction,
      // for an empty `content` (see `REASONING_HEADROOM`). Asking for none is
      // therefore the cheap direction, not the expensive one.
      //
      // Not in the OpenAI SDK's types (v7.4.0 has no `reasoning` on the request),
      // so it goes through the same cast `cache_control` uses below. Only 'off'
      // is sent: 'adaptive' means "whatever the model does by default", which is
      // exactly what sending nothing already means.
      ...(this.reasoningEffort && effective?.mode === 'off' ? ({ reasoning: { effort: 'none' } } as Record<string, unknown>) : {}),
      ...(this.reasoningEffort && effective?.mode === 'on' && effective.maxTokens !== undefined
        ? ({ reasoning: { max_tokens: effective.maxTokens } } as Record<string, unknown>)
        : {}),
      ...(this.reasoningEffort && effective?.mode === 'on' && effective.maxTokens === undefined
        ? ({ reasoning: effective.effort === undefined ? { enabled: true } : { effort: effective.effort } } as Record<string, unknown>)
        : {}),
      // **Tieni questa conversazione sullo stesso provider a monte.**
      //
      // OpenRouter instrada già sticky per far prendere la cache, ma senza
      // questo campo deriva la chiave «dall'hash del primo messaggio di sistema
      // e del primo non-di-sistema» — e il nostro primo non-di-sistema è il
      // recall, che cambia a ogni turno. Chiave nuova, provider nuovo, cache
      // fredda: misurato, 0% su due turni consecutivi mentre dentro un turno
      // prendeva il 54%. Il campo esiste nella loro documentazione proprio per
      // «i flussi agentici multi-turno in cui i messaggi di apertura cambiano
      // fra una richiesta e l'altra», che è esattamente il nostro caso.
      //
      // **Non `provider.order`**, che sarebbe stato il rimedio ovvio e che la
      // stessa pagina dice disattivare lo sticky routing: un ordine esplicito
      // vince sulla stickiness e ci saremmo inchiodati al primo della lista
      // invece che a quello che ha la cache calda.
      //
      // Si manda l'**impronta**, non l'identificatore: la stickiness ha bisogno
      // di un valore stabile e opaco, non del nostro id di sessione, che porta
      // scritta la data. Stabile fra processi perché lo è l'id da cui nasce.
      //
      // Non nei tipi dell'SDK, quindi passa dal cast che `reasoning` e
      // `cache_control` usano già.
      // Dove instradare, quando l'owner l'ha detto. Vedi `config.provider.routing`:
      // un modello su uno smistatore non è una macchina, e chi risponde decide
      // prezzo, quantizzazione, politica sui dati e se la cache prende.
      ...(providerRouting !== undefined || explicitReasoningConstraint ? ({ provider: providerRouting ?? { require_parameters: true } } as Record<string, unknown>) : {}),
      ...(this.stickySession && call.conversation !== undefined && call.conversation !== ''
        ? ({ session_id: createHash('sha256').update(call.conversation).digest('hex').slice(0, 32) } as Record<
            string,
            unknown
          >)
        : {}),
      messages: [this.systemMessage(call), ...compileForOpenAI(call.messages).flatMap((message) => toChatMessages(message, this.reasoningEffort))],
      ...(call.tools && call.tools.length > 0
        ? {
            tools: call.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: call.toolChoice === 'none' ? ('none' as const) : call.toolChoice === 'required' ? ('required' as const) : ('auto' as const),
          }
        : {}),
    };
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

/** A tool call before parsing — the shape `chat()` and `chatStream()` both accumulate into. */
type RawToolCall = { id: string; name: string; argsRaw: string };

/**
 * One response, in the shape `chat()` and `chatStream()` both reduce to —
 * plain values rather than an SDK response object, because `chatStream`
 * assembles these from chunks and has no `ChatCompletion` to slice fields out
 * of. Parses tool-call JSON exactly once, here, so a malformed-arguments
 * `ProviderError` is the same error on both paths rather than two similar ones
 * that could drift.
 */
/**
 * Chi ha servito la richiesta, quando la risposta lo dice.
 *
 * OpenRouter mette `provider` nel corpo, e non sta nei tipi dell'SDK: si legge
 * col controllo, non col cast, perché un campo che un giorno cambia forma deve
 * sparire e non diventare `"[object Object]"` dentro una traccia.
 */
function upstreamOf(response: unknown): string | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  const p = (response as { provider?: unknown }).provider;
  return typeof p === 'string' && p !== '' ? p : undefined;
}

function toChatResult(response: {
  text: string | null;
  toolCalls: RawToolCall[];
  finishReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  model: string;
  upstream?: string | undefined;
  requestId?: string | undefined;
  providerMetadata?: ProviderMessageMetadata | undefined;
}): ChatResult {
  const toolCalls = response.toolCalls.map((tc) => {
    let args: unknown;
    try {
      args = JSON.parse(tc.argsRaw || '{}');
    } catch {
      // `output`, not transport: the model wrote this, and no amount of
      // waiting rewrites it. The loop routes it to the profile's cascade.
      throw new ProviderError(`malformed tool arguments from ${tc.name}`, true, undefined, 'output');
    }
    return { id: tc.id, name: tc.name, args };
  });

  // `finish_reason: tool_calls` with zero parsed calls is the serving-stack
  // bug measured on Gemma 4 / Qwen 3 (vLLM #53363, Particula matrix): the
  // router announces a call and delivers an empty array plus prose. Accepting
  // it as an answer closes the turn on a stall; `output`, not transport, so
  // the loop routes it to the profile's cascade instead of backing off.
  if (response.finishReason === 'tool_calls' && toolCalls.length === 0) {
    throw new ProviderError('tool_calls announced but no tool call parsed', true, undefined, 'output');
  }

  /**
   * La metà non-streaming dello stesso fallimento: una 200 con
   * `finish_reason: 'error'` e contenuto vuoto non è una risposta, è il
   * fornitore che ha fallito dopo aver accettato la richiesta (stessa
   * documentazione del controllo `wireError` nello stream). Chiuderla come
   * risposta alimenta la cascade dei vuoti invece del budget di trasporto.
   */
  if (response.finishReason === 'error' && response.text === null && toolCalls.length === 0) {
    throw new ProviderError('provider reported error finish reason with no content', true, undefined, 'transport');
  }

  return {
    text: response.text,
    toolCalls,
    // OpenAI-compatible reasoning is provider metadata rather than an
    // Anthropic-style thinking block. It is carried opaquely below when the
    // endpoint is OpenRouter; it is never exposed as user-visible text.
    thinking: [],
    stopReason: mapStopReason(response.finishReason, toolCalls.length > 0),
    // The verbatim wire reason, beside the mapped one: when the router
    // returns a reason nobody mapped (or none), `stopReason` reads `error`
    // while this is the only evidence of what actually arrived.
    finishReason: response.finishReason,
    usage: response.usage,
    model: response.model,
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    ...(response.upstream !== undefined ? { upstream: response.upstream } : {}),
    ...(response.providerMetadata === undefined ? {} : { providerMetadata: response.providerMetadata }),
  };
}

/**
 * Il testo di un blocco, vuoto per tutto il resto.
 *
 * **Non e' la via delle immagini ne' dell'audio.** `toChatMessages` le raccoglie a parte e le
 * manda come parti `image_url`; se un'immagine arrivasse qui verrebbe
 * appiattita in stringa vuota e sparirebbe senza un errore — il modello
 * risponderebbe lo stesso, su qualcosa che non ha visto. Il test
 * `openai-compat` che conta le parti esiste per tenere chiusa questa strada.
 */
function flatten(block: ContentBlock): string {
  return block.type === 'text' ? block.text : '';
}

/**
 * Thinking blocks are dropped here, and that is the correct behaviour rather
 * than the same defect twice: this wire format has no slot for them, and a
 * history that carries them came from another model — which the API's own rule
 * says to strip on a model switch ("thinking blocks are tied to the model that
 * produced them"). What would be wrong is dropping them on the *Anthropic*
 * path, which is what ADR-0037 fixed.
 */
function toChatMessages(message: Message, preserveReasoning: boolean): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const text = message.content.filter((b) => b.type === 'text').map(flatten).join('\n');
  const toolUses = message.content.filter((b) => b.type === 'tool_use');
  const toolResults = message.content.filter((b) => b.type === 'tool_result');
  const immagini = message.content.filter((b) => b.type === 'image');
  const audio = message.content.filter((b) => b.type === 'audio');

  if (message.role === 'assistant') {
    const reasoning = preserveReasoning ? message.providerMetadata?.reasoning : undefined;
    out.push({
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(reasoning?.details !== undefined ? ({ reasoning_details: reasoning.details } as Record<string, unknown>) : {}),
      ...(reasoning?.details === undefined && reasoning?.content !== undefined ? ({ reasoning: reasoning.content } as Record<string, unknown>) : {}),
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
  } else if (immagini.length > 0 || audio.length > 0) {
    // Con un'immagine il contenuto deve diventare un **array di parti**: la
    // forma a stringa non ha uno slot per un'immagine, e mandare la stringa
    // perderebbe l'immagine in silenzio — che e' peggio di un 400, perche' il
    // modello risponderebbe comunque, su un'immagine che non ha mai visto.
    //
    // Il testo va **dopo**, non prima: Anthropic lo raccomanda esplicitamente
    // («Claude works best when images come before text») e non costa niente
    // farlo anche qui.
    const parti: OpenAI.Chat.ChatCompletionContentPart[] = [
      ...immagini.map((b) => ({
        type: 'image_url' as const,
        // Il data URL e' la forma che vuole questo lato del filo; `ImageBlock`
        // tiene il base64 nudo perche' e' quella che vuole Anthropic, e
        // avvolgere qui costa una riga mentre spacchettare costerebbe un parser.
        image_url: { url: `data:${b.mediaType};base64,${b.data}` },
      })),
      ...audio.map((b) => ({
        type: 'input_audio' as const,
        // `data` base64 **nudo**, non un data URL: qui la forma e' l'opposto di
        // quella delle immagini qui sopra, ed e' il provider a volerla cosi'
        // (docs OpenRouter «Audio Inputs», lette il 28/08/2026). Gli URL per
        // l'audio non sono proprio supportati — cioe' la regola che per le
        // immagini ci eravamo dati noi, qui e' anche la loro.
        input_audio: { data: b.data, format: formatoAudio(b.mediaType) },
      })),
      ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    ];
    out.push({ role: 'user', content: parti });
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

/**
 * Da media type a `input_audio.format`, che vuole la sigla nuda.
 *
 * Il tipo dell'SDK OpenAI ammette solo `'wav' | 'mp3'`, ma l'insieme che
 * accetta OpenRouter e' piu' largo — `wav, mp3, aiff, aac, ogg, flac, m4a,
 * pcm16, pcm24`, dalla loro documentazione letta il 28/08/2026 — e `ogg` e'
 * proprio il formato di una nota vocale di Telegram. Restringere a cio' che
 * l'SDK sa nominare vorrebbe dire riconvertire ogni nota vocale in wav per un
 * fatto del *tipo* e non del filo, cioe' triplicarne i byte per niente.
 *
 * Il cast e' quindi deliberato e locale, e `AudioMediaType` resta chiuso: cio'
 * che finisce sul filo non e' una stringa qualunque, e' uno di quattro.
 */
function formatoAudio(media: AudioMediaType): 'wav' | 'mp3' {
  const sigla = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav' }[media];
  return sigla as 'wav' | 'mp3';
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
      // Mai 'end' presunto: una reason che nessuno conosce non è un successo,
      // è un fallimento con un nome nuovo (il caso `finish_reason: "error"`
      // non arriva fin qui — lo intercetta il controllo qui sopra — ma il
      // prossimo sì). `StopReason` ha il braccio `'error'` apposta; è solo
      // telemetria (il loop instrada su testo/tool call, mai su questo), ma
      // una telemetria che mente rende il prossimo debug come questo.
      return 'error';
  }
}

/**
 * La forma d'errore in-band di OpenRouter in un `ProviderError` instradabile.
 *
 * `{code, message, metadata}` sul chunk (streaming) o nel body (una 200 senza
 * choices la intercetta già `chat()`). Retryable per codice, con la stessa
 * regola di `wrap` sotto (429 o 5xx) più il 408 — e codice assente uguale
 * retryable: senza codice non si sa che non lo sia, e la direzione sicura è
 * il budget con backoff (finito il quale l'errore resta onesto), non il
 * silenzio. 400/401/402/403 non riprovano: una chiave morta o una richiesta
 * malformata non guariscono aspettando.
 */
function providerErrorFromWire(
  wireError: unknown,
  model: string,
  headers?: { get(name: string): string | null },
): ProviderError {
  const raw = (typeof wireError === 'object' && wireError !== null ? wireError : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const code = typeof raw.code === 'number' ? raw.code : undefined;
  const message = typeof raw.message === 'string' && raw.message !== '' ? raw.message : 'provider error';
  const retryable = code === undefined || code === 408 || code === 429 || code >= 500;
  return new ProviderError(
    `${code === undefined ? '' : `${code} `}${message} (${model})`,
    retryable,
    code,
    'transport',
    parseRetryAfterMs(headers ?? null),
  );
}

function wrap(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return new ProviderError(
      `${status} ${error.message}`,
      status === 429 || status >= 500,
      status,
      'transport',
      parseRetryAfterMs(error.headers),
    );
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('aborted', false);
  }
  return new ProviderError(error instanceof Error ? error.message : String(error), true);
}
