/**
 * The single internal shape for talking to a model.
 *
 * One interface, two implementations: `anthropic` native and `openai-compat`
 * (which covers Ollama, llama.cpp, vLLM, OpenRouter, DeepSeek and most of the
 * cloud). No framework — the whole field hand-rolls this, and an abstraction
 * layer would level everything down to the minimum common denominator exactly
 * where the differences matter: prompt caching, thinking budgets, long context.
 *
 * See docs/adr/0008.
 */

export type Role = 'user' | 'assistant';

/**
 * `cache: 'stable'` marks the end of a cacheable prefix. Positional, not a
 * flag — and bounded: Anthropic and OpenRouter accept at most FOUR
 * `cache_control` blocks per request, and a fifth is a 400. Both adapters mark
 * every stable block they see, so whoever marks blocks is holding the budget.
 */
/**
 * A reasoning block, carried through untouched.
 *
 * Opaque on purpose — nothing above the adapter reads `signature` or `data`, and
 * nothing may rewrite them. The API rule is not advisory: *"Pass every
 * `thinking` block back to the API complete and unmodified, alongside the
 * `tool_use` block it accompanied"* … *"Required: within a tool-use turn, pass
 * thinking blocks back"* (Anthropic, "Thinking with tool use", read 2026-08-13).
 *
 * The asymmetry is why this is a type and not a comment. A **modified** block is
 * a loud 400. A **dropped** one is silent: the server *"may strip thinking blocks
 * that would create an invalid turn structure, or disable thinking when the
 * conversation history is incompatible with thinking being enabled"* — so the
 * only symptom of losing them is a slightly worse agent and a colder cache.
 *
 * `redacted_thinking` is the same rule with a different payload, and it is the
 * one a type filter loses first: the docs call out `block.type == "thinking"`
 * by name as the filter that "silently drops `redacted_thinking` blocks and
 * breaks the multi-turn protocol". Both live in one union so a `switch` has to
 * answer for both.
 */
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export type ContentBlock =
  | { type: 'text'; text: string; cache?: 'stable' }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | ThinkingBlock;

export type Message = { role: Role; content: ContentBlock[] };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema. Validated before the kernel ever sees the arguments. */
  inputSchema: Record<string, unknown>;
};

/**
 * How much reasoning to ask for — in the only vocabulary the API still has.
 *
 * There is no budget any more. `thinking: {type:'enabled', budget_tokens: N}` is
 * deprecated on the 4.6 models and **returns a 400 on 4.7 and later**, which is
 * every model `agent/profiles/frontier.json` matches (Sonnet 5, Opus 5, Fable 5)
 * — verified on the extended-thinking page, 2026-08-13. What replaced it is a
 * mode plus `output_config.effort`, and `effort` has no per-request meaning for
 * us: `"high"` is the API default, so sending it is identical to omitting it.
 * Hence two values and no number. A knob the API does not have is a knob that
 * lies about what it controls.
 *
 * `'off'` is `{type:'disabled'}` at the wire, not "send nothing": on a 5-series
 * model sending nothing means thinking is **on**, so the old `'off'` was a
 * declaration the request contradicted. Not universal, though: Claude Fable 5
 * and Claude Mythos 5 have no disable switch at all — thinking is always on
 * and both `{type:'enabled'}` and `{type:'disabled'}` are a 400 (per-model
 * table, read 2026-08-13). `Profile.thinking`'s third value, `'unset'`, is for
 * exactly that model shape: the field omitted, never sent as `'off'`.
 *
 * N3 (judge, 2026-08-13): Claude Haiku 4.5 has no honest value in this type at
 * all — it supports only manual extended thinking (the `budget_tokens` shape
 * this vocabulary deliberately has no number for) and returns a 400 on
 * `{type:'adaptive'}`. Do not add it to a profile's `match` list that declares
 * `thinking: 'adaptive'`. Harmless today only because the light lane — the one
 * place Haiku 4.5 runs — never consults a profile at all.
 */
export type ThinkingMode = 'adaptive' | 'off';

export type ChatCall = {
  model: string;
  system: ContentBlock[];
  messages: Message[];
  tools?: ToolSpec[];
  /** Never 'required' by default: forcing a tool breaks legitimate short answers. */
  toolChoice?: 'auto' | 'none';
  maxOutputTokens: number;
  /**
   * Optional because "do not send it" is a value the caller must be able to say.
   * On Opus 4.7 and later — Opus 5, Sonnet 5, Fable 5 — `temperature`, `top_p`
   * and `top_k` were removed, and any non-default value is a 400 (migration
   * guide, read 2026-08-13). Absent means the model's own default, and it is
   * the only shape those models accept.
   */
  temperature?: number;
  thinking?: ThinkingMode;
  stream: boolean;
  signal?: AbortSignal;
};

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'error';

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ChatResult = {
  text: string | null;
  /** Arguments already parsed: a tool call that will not parse is an error here, not downstream. */
  toolCalls: { id: string; name: string; args: unknown }[];
  /**
   * The reasoning blocks this response opened with, in the order received.
   *
   * Separate from `text` and `toolCalls` because those are *normalised* — text
   * joined and trimmed, arguments parsed — and these must survive the trip
   * byte-identical. The loop's only job is to put them back at the head of the
   * assistant turn it echoes; it must not read, merge or reformat them.
   *
   * Optional, and an adapter that has nothing to carry says so with `[]` rather
   * than by omission — see the openai-compat adapter, where the gap is real and
   * currently inert.
   */
  thinking?: ThinkingBlock[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
};

export interface Provider {
  readonly kind: 'anthropic' | 'openai-compat';
  chat(call: ChatCall): Promise<ChatResult>;
}

/**
 * Which side of the call produced the failure.
 *
 * Two families were travelling under one type and the loop could not tell them
 * apart: a 429 and "the model emitted arguments that will not parse" both
 * arrive as `retryable: true`, so unparseable JSON was answered with
 * exponential backoff. Waiting cannot improve output the model has already
 * produced — that one belongs to the profile's recovery cascade, where
 * `strictJson` is the step written for it.
 *
 * Defaults to `transport`, so every construction site that does not say
 * otherwise keeps the behaviour it had.
 */
export type ProviderErrorSource = 'transport' | 'output';
// Producibility is asymmetric on purpose: only the openai-compat adapter can
// emit 'output' today, because it is the only one that parses tool arguments
// from a string (the Anthropic SDK returns them structured — there is no
// JSON.parse to fail). Do not hunt for the missing Anthropic branch; it has
// nothing to mislabel.

/** Carries what the recovery cascade needs to decide, instead of a bare string. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly source: ProviderErrorSource = 'transport',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
