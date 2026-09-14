import { ProviderStreamError, type ChatResult, type StreamEvent } from '../providers/types.js';

/**
 * Exponential backoff with full jitter. `attempt` is 1-based.
 *
 * Full jitter rather than a fixed multiple: when several turns are throttled at
 * the same moment, a deterministic delay makes them retry in lockstep and the
 * limit trips again on the same tick.
 */
export function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(120_000, 500 * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/**
 * The loop's one and only extraction point for `Provider.chatStream` — every
 * caller of a provider's stream goes through this, so "what counts as a text
 * delta" and "what does `done` mean" are answered once.
 *
 * `onChunk` receives each `text_delta` in the exact granularity the provider
 * yielded it, and `requestChatResult` above forwards it to `input.onDelta`
 * there and then. `thinking_delta`, `tool_call_delta` and `usage` events
 * are consumed and dropped here: nothing downstream of this function has ever
 * needed a tool call before it is complete (the loop reads `result.toolCalls`,
 * already parsed, off the `done` event), and a surface receives text only —
 * see `TurnDelta`.
 */
export async function drainStream(
  events: AsyncIterable<StreamEvent>,
  onChunk: (text: string) => void,
  onActivity?: (kind: 'thinking' | 'text' | 'tool_call') => void,
): Promise<ChatResult> {
  for await (const event of events) {
    if (event.type === 'text_delta') {
      onActivity?.('text');
      onChunk(event.text);
    }
    if (event.type === 'thinking_delta') onActivity?.('thinking');
    if (event.type === 'tool_call_delta') onActivity?.('tool_call');
    if (event.type === 'done') return event.result;
  }
  // A well-behaved provider's last event is always `done` (its own contract —
  // see `Provider.chatStream`'s docstring). An iterable that ends without one
  // is exactly the shape of transport this repo has no other name for than a
  // broken stream, so it takes the same door: the caller's one-time fallback
  // to `chat()`, `partial: true` because getting this far means every event up
  // to the missing `done` did arrive.
  throw new ProviderStreamError('provider stream ended without a done event', true);
}

/**
 * `String.prototype.trim`, for a string you are only ever handed one piece at
 * a time. Returns the next piece to emit, or `null` when there is nothing to
 * say yet — and concatenating everything it returns gives exactly `full.trim()`.
 *
 * Two rules, and they are the two halves of `trim` itself:
 *
 * - leading whitespace is swallowed until the first real character, because
 *   `trim` would have removed it and nobody can un-print it later;
 * - trailing whitespace is **held**, not emitted, until a real character
 *   proves it was internal after all. A blank line the model wrote on purpose
 *   is internal and comes out; the two spaces at the very end never do,
 *   because nothing ever follows them.
 *
 * Held whitespace that the round ends on is simply dropped: the caller never
 * flushes, and that is the point. This is what keeps `result.text` — which
 * both adapters `.trim()` once at the end — byte-identical to what a surface
 * concatenated live, the guarantee `cli/repl.test.ts` checks directly.
 */
export function edgeTrimmer(): (chunk: string) => string | null {
  let started = false;
  let held = '';
  return (chunk) => {
    let buf = held + chunk;
    held = '';
    if (!started) {
      buf = buf.trimStart();
      if (buf === '') return null; // ancora solo spazio: il testo non è cominciato
      started = true;
    }
    const body = buf.trimEnd();
    if (body === '') {
      held = buf; // tutto spazio: potrebbe essere interno, lo sapremo dopo
      return null;
    }
    held = buf.slice(body.length);
    return body;
  };
}
