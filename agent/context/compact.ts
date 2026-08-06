import type { ContentBlock, Message } from '../providers/types.js';

/**
 * Keeping a long turn inside its context window.
 *
 * The cheapest measured intervention in this space is not summarisation: it is
 * **clearing old tool results**. You keep the `tool_use` — so the model still
 * knows it made the call, and what it asked for — and replace the *payload* with
 * a placeholder that says where it went. Anthropic's own numbers on the same
 * shape of workload: peak context from 335k tokens to 173k, −48%, with the same
 * eight files read and no behaviour lost.
 *
 * Why it works: a file read at iteration 2 is usually load-bearing for
 * iterations 3 and 4 and dead weight by iteration 20. And the placeholder is not
 * a lie the model has to work around — it names the tool and the arguments, so
 * re-reading is a call away. That is the difference between clearing a result
 * and losing one.
 *
 * Three rules that are not negotiable:
 *
 *  1. **A tool_use and its tool_result are one unit.** Every `tool_use` must keep
 *     a `tool_result` with a matching id or the request is malformed and the
 *     provider rejects the whole turn. So this never *removes* blocks — it only
 *     rewrites the content of a result in place.
 *  2. **Some results are the context.** Recalled memory is not scaffolding the
 *     model can re-fetch on a whim; clearing it deletes the reason the turn had
 *     any grounding. Tools say for themselves whether their output survives.
 *  3. **Errors are never cleared.** An error is short and it is exactly what the
 *     model needs to not repeat the mistake.
 *
 * Pure, so it is testable without a model and without a network.
 */

export type CompactOptions = {
  /**
   * Total characters of clearable tool-result payload to keep. Oldest go first.
   *
   * Characters, not a count of results: the pressure is bytes in a window, and
   * "keep the last five" treats a 40-character listing like a 200KB file.
   */
  budgetChars: number;
  /** True when this tool's output must survive. Asked per tool name. */
  keep?: (toolName: string) => boolean;
};

export type CompactResult = {
  messages: Message[];
  clearedCount: number;
  clearedChars: number;
};

/** What replaces a payload. Names the way back, so the model can take it. */
function placeholder(toolName: string | undefined, chars: number): string {
  const what = toolName ? `\`${toolName}\`` : 'questo tool';
  return `[risultato di ${what} rimosso dal contesto (${chars} caratteri) per fare spazio — richiamalo se ti serve ancora]`;
}

export function compactToolResults(messages: Message[], options: CompactOptions): CompactResult {
  const keep = options.keep ?? (() => false);

  // Which tool produced which result: the name lives on the `tool_use`, and the
  // placeholder is useless without it.
  const nameById = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') nameById.set(block.id, block.name);
    }
  }

  // Newest first: the budget is spent on the most recent results, which are the
  // ones the model is still reasoning about.
  const clearable: { block: Extract<ContentBlock, { type: 'tool_result' }>; chars: number }[] = [];
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    for (let b = messages[m]!.content.length - 1; b >= 0; b -= 1) {
      const block = messages[m]!.content[b]!;
      if (block.type !== 'tool_result') continue;
      if (block.isError === true) continue;
      const name = nameById.get(block.toolCallId);
      if (name !== undefined && keep(name)) continue;
      clearable.push({ block, chars: block.content.length });
    }
  }

  let budget = options.budgetChars;
  let clearedCount = 0;
  let clearedChars = 0;
  const cleared = new Map<string, string>();

  for (const { block, chars } of clearable) {
    if (chars <= budget) {
      budget -= chars;
      continue;
    }
    // Clearing something smaller than its own placeholder makes the context
    // bigger, which is the opposite of the point.
    const replacement = placeholder(nameById.get(block.toolCallId), chars);
    if (replacement.length >= chars) continue;
    cleared.set(block.toolCallId, replacement);
    clearedCount += 1;
    clearedChars += chars - replacement.length;
  }

  if (cleared.size === 0) return { messages, clearedCount: 0, clearedChars: 0 };

  // A copy: the caller's array is the transcript, and the transcript records
  // what happened rather than what we chose to send.
  const rewritten = messages.map((message) => ({
    ...message,
    content: message.content.map((block) =>
      block.type === 'tool_result' && cleared.has(block.toolCallId)
        ? { ...block, content: cleared.get(block.toolCallId)! }
        : block,
    ),
  }));

  return { messages: rewritten, clearedCount, clearedChars };
}
