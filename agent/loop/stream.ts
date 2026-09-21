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
 * Strip an exact repeated prefix from a length-continuation chunk (#615
 * streaming blocker).
 *
 * Deterministic byte-prefix handling, never fuzzy overlap: when the model
 * restarts a continuation by repeating the previously accepted chunk `R` and
 * then continues (`R + B`), only `B` is new output. Returns `B`; returns the
 * chunk unchanged when it diverges from `R` (a divergent chunk is real new
 * output, even the bytes that happen to overlap); returns `''` for an exact
 * whole repeat AND for a chunk that is itself a strict prefix of `R` — both
 * carry zero bytes beyond what is already preserved, which the caller reads
 * as no-progress. An absent or empty reference disables the rule (ordinary
 * first-call streaming).
 *
 * The exact mirror of `continuationDedup` below, which applies the same rule
 * incrementally to the live deltas: both must agree, or visible and durable
 * diverge.
 */
export function stripRepeatedPrefix(reference: string | undefined, chunk: string): string {
  if (reference === undefined || reference === '') return chunk;
  if (chunk.startsWith(reference)) return chunk.slice(reference.length);
  if (reference.startsWith(chunk)) return '';
  return chunk;
}

/**
 * Live-delta half of the exact-prefix continuation rule (#615 streaming
 * blocker).
 *
 * A continuation call already has a structurally accepted previous chunk `R`
 * (origin `partial`). While the newly streamed response still exactly matches
 * the beginning of `R`, those candidate-duplicate bytes are HELD, never
 * published: emitting them would show the owner bytes the durable answer will
 * not contain, and `releaseContinuable()` retracts nothing.
 *
 * - the stream diverges before fully matching `R`: the held bytes were real
 *   new output after all — flush them plus the divergent remainder;
 * - the stream matches all of `R`: suppress the repeated prefix; bytes that
 *   follow are the only new output and pass through;
 * - the stream ends having matched all of `R` with nothing after: the caller
 *   sees an empty suffix via `stripRepeatedPrefix` and treats it as
 *   no-progress, having shown nothing twice.
 *
 * Fed with post-`edgeTrimmer` pieces (whose concatenation is exactly the
 * result text the durable side strips), so both sides compute over the same
 * string. Returns `null` when nothing is showable yet, otherwise the exact
 * bytes to publish (never `''`). Pass-through when the caller has no
 * reference: ordinary non-continuation streaming never constructs this.
 */
export function continuationDedup(reference: string): {
  /** Next showable bytes, or `null` while holding a candidate duplicate. */
  push(piece: string): string | null;
  /** Bytes currently held as a candidate duplicate (for tests). */
  pending(): number;
} {
  let matched = 0;
  let diverged = false;
  let complete = reference === '';
  return {
    push(piece: string): string | null {
      if (piece === '') return null;
      if (diverged || complete) return piece;
      const rest = reference.slice(matched);
      let k = 0;
      while (k < piece.length && k < rest.length && piece[k] === rest[k]) k += 1;
      matched += k;
      if (matched >= reference.length) {
        // The whole previous chunk just repeated: suppress it, emit only
        // bytes beyond it (possibly none yet — the stream may still end here,
        // which the caller reads as no-progress).
        complete = true;
        const extra = piece.slice(k);
        return extra === '' ? null : extra;
      }
      if (k < piece.length) {
        // Diverged before matching R: the held bytes were real new output —
        // flush them with the divergent remainder.
        diverged = true;
        return reference.slice(0, matched) + piece.slice(k);
      }
      return null;
    },
    pending(): number {
      return diverged || complete ? 0 : matched;
    },
  };
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
