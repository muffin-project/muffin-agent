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

/** `cache: 'stable'` marks the end of a cacheable prefix. Positional, not a flag. */
export type ContentBlock =
  | { type: 'text'; text: string; cache?: 'stable' }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type Message = { role: Role; content: ContentBlock[] };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema. Validated before the kernel ever sees the arguments. */
  inputSchema: Record<string, unknown>;
};

export type ChatCall = {
  model: string;
  system: ContentBlock[];
  messages: Message[];
  tools?: ToolSpec[];
  /** Never 'required' by default: forcing a tool breaks legitimate short answers. */
  toolChoice?: 'auto' | 'none';
  maxOutputTokens: number;
  temperature: number;
  thinking?: { budgetTokens: number };
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
  stopReason: StopReason;
  usage: Usage;
  model: string;
};

export interface Provider {
  readonly kind: 'anthropic' | 'openai-compat';
  chat(call: ChatCall): Promise<ChatResult>;
}

/** Carries what the recovery cascade needs to decide, instead of a bare string. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
