import type { Message } from './types.js';

/**
 * Typed semantic context → provider-safe message sequence.
 *
 * The one seam between what the loop means and what each wire accepts. The
 * core context is never shaped like OpenAI or Anthropic messages: it is
 * shaped like provenance (`MessageOrigin`), and each adapter compiles the
 * same semantic items into its own valid request. Nothing here invents a
 * framework — two small functions, one shared validation, called at the top
 * of each adapter's `requestBody`.
 *
 * What the seam guarantees so the adapters cannot lose it:
 *
 * - **provenance**: `origin` travels on the compiled messages untouched. The
 *   wire may force a tool result to look like `role: 'user'` (Anthropic) or
 *   `role: 'tool'` (OpenAI-compatible); what it IS stays readable here.
 * - **block semantics**: thinking/redacted_thinking keep order and payload
 *   byte-identical; merge (below) only ever concatenates whole blocks.
 * - **ordering constraints**: every `tool_result` must answer a preceding
 *   `tool_use` with the same id, and every `tool_use` must be answered — a
 *   hole is a 400 on both wires, so it fails HERE with a name instead of at
 *   the provider with a status.
 * - **tool-result identity**: results stay in `role: 'user'` messages (the
 *   only home Anthropic accepts) and the OpenAI adapter maps those same
 *   messages to `role: 'tool'` with `tool_call_id` — one semantic item, two
 *   valid renderings, asserted by both adapters' request-body tests.
 *
 * Phase 0 contract it rests on (openai 7.9.0, @anthropic-ai/sdk 0.115.0,
 * current platform docs):
 *
 * | internal semantic kind | OpenAI wire | Anthropic wire |
 * |---|---|---|
 * | system/constitutional | `role: 'system'` (NOT `developer`: generic compat endpoints — Ollama, llama.cpp, vLLM — may 400 an unknown role; `system` stays valid everywhere including OpenRouter) | top-level `system` array (never a message role) |
 * | owner dialogue (current input) | `role: 'user'`, text/media parts | `role: 'user'` content blocks |
 * | assistant dialogue | `role: 'assistant'`, text or null | `role: 'assistant'` content blocks |
 * | tool_use | `assistant.tool_calls[]` {id, function:{name, arguments}} | `tool_use` block in assistant content |
 * | tool_result (origin tool) | own `role: 'tool'` message + `tool_call_id` | `tool_result` block inside a `role: 'user'` message (+ `tool_use_id`) |
 * | harness/control text | `role: 'user'` text (protocol has no control slot) | `role: 'user'` text block |
 * | memory/runtime/work evidence | `role: 'user'` text (own messages, own origins) | `role: 'user'` text blocks |
 * | thinking continuity | dropped (no wire slot; history from another model is stripped on switch) | thinking + redacted_thinking verbatim, in order, beside the `tool_use` they came with |
 * | prompt-cache prefix | stable system string; `cache_control` parts only toward OpenRouter (`explicitCache`) | `cache_control: ephemeral` on stable blocks (≤4 breakpoints per request) |
 * | conversation identity | `session_id`: opaque sha256 of `ChatCall.conversation`, OpenRouter only | n/a (stateless messages; warmth comes from the stable prefix) |
 *
 * A violation throws `CompileError`: a programming defect, fail-fast, never a
 * retryable transport failure. `requestBody` callers wrap it like any other
 * throw, but no retry budget will ever fix a malformed transcript — the name
 * in the message is the whole point.
 */

export class CompileError extends Error {
  constructor(message: string) {
    super(`uncompilable context: ${message}`);
    this.name = 'CompileError';
  }
}

/**
 * The checks both wires share. Pure: returns nothing, throws `CompileError`
 * naming the first defect.
 */
export function assertCompilable(messages: readonly Message[]): void {
  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.content.length === 0) {
      throw new CompileError(`message ${index} (${message.role}) carries no content block`);
    }
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (message.role !== 'assistant') {
          throw new CompileError(`tool_use ${block.id} sits in a ${message.role} message (must be assistant)`);
        }
        if (uses.has(block.id)) throw new CompileError(`duplicate tool_use id ${block.id}`);
        uses.set(block.id, index);
      }
      if (block.type === 'tool_result') {
        if (message.role !== 'user') {
          throw new CompileError(`tool_result ${block.toolCallId} sits in a ${message.role} message (must be user)`);
        }
        results.set(block.toolCallId, index);
      }
      if ((block.type === 'thinking' || block.type === 'redacted_thinking') && message.role !== 'assistant') {
        throw new CompileError(`${block.type} sits in a ${message.role} message (must be assistant)`);
      }
    }
  });
  for (const [id, at] of results) {
    const use = uses.get(id);
    if (use === undefined) throw new CompileError(`tool_result ${id} (message ${at}) answers no tool_use`);
    if (use > at) throw new CompileError(`tool_result ${id} precedes its tool_use`);
  }
  for (const [id, at] of uses) {
    if (!results.has(id)) throw new CompileError(`tool_use ${id} (message ${at}) has no tool_result`);
  }
}

/**
 * For the OpenAI-compatible wire. Validation only, no merge: the server
 * tolerates consecutive same-role user messages, and the adapter maps each
 * tool-carrying user message to its own `role: 'tool'` messages downstream —
 * merging here would fold tool evidence into neighbouring text before the
 * adapter ever sees the boundary.
 */
export function compileForOpenAI(messages: readonly Message[]): Message[] {
  assertCompilable(messages);
  return [...messages];
}

/**
 * For the Anthropic wire. Same validation, plus deterministic folding of
 * consecutive same-role messages — exactly the "combined into a single turn"
 * semantics the Messages API documents, applied client-side so the block
 * order is ours rather than the server's guess.
 *
 * Folded ONLY when role AND origin both match: a harness notice followed by
 * replayed history stays two messages (merging would launder control into
 * evidence or drop evidence as control on the next continuation split).
 * Thinking blocks are concatenated whole, never rewritten: their order is
 * the model's and their bytes are opaque.
 */
export function compileForAnthropic(messages: readonly Message[]): Message[] {
  assertCompilable(messages);
  const out: Message[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === message.role && last.origin === message.origin) {
      last.content.push(...message.content);
      continue;
    }
    out.push({ ...message, content: [...message.content] });
  }
  return out;
}
