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
 * Shared continuation-suffix rule for #615 multi-prior/full-prefix fix.
 *
 * ONE pure primitive used by BOTH durable acceptance (`round.ts` truncation
 * and final-answer paths) and live streaming (`continuationDedup` below), so
 * the two can never diverge again.
 *
 * Exact structural byte-prefix semantics only — never fuzzy, never paraphrase:
 * - try FULL current logical prefix first (`full` = concatenation of all
 *   accepted `partial` chunks). If the candidate starts with it, only the
 *   bytes beyond it are new. If the candidate is itself a strict prefix of
 *   it, it carries zero bytes beyond what is preserved.
 * - otherwise try LAST accepted partial chunk (`last`). Same exact rule.
 * - otherwise the candidate diverges from both: it is real new output whole,
 *   even the bytes that happen to overlap.
 * - if EITHER proof leaves zero new bytes (`''`), the candidate is
 *   no-progress: nothing new is lost (its bytes are already preserved) and
 *   the caller must drop it without budget burn or extra provider call.
 *
 * `undefined`/empty references disable that proof (ordinary first call).
 */
export function resolveContinuationSuffix(
  full: string | undefined,
  last: string | undefined,
  chunk: string,
): string {
  if (full !== undefined && full !== '') {
    const viaFull = stripRepeatedPrefix(full, chunk);
    if (viaFull === '') return '';
    if (viaFull !== chunk) return viaFull;
  }
  if (last !== undefined && last !== '') {
    const viaLast = stripRepeatedPrefix(last, chunk);
    if (viaLast === '') return '';
    if (viaLast !== chunk) return viaLast;
  }
  return chunk;
}

/**
 * Live-delta half of the exact-prefix continuation rule (#615 streaming
 * blocker, extended to multi-prior/full-prefix).
 *
 * A continuation call already has a structurally accepted logical prefix
 * `full` plus its last chunk `last` (both origin `partial`). The gate holds
 * candidate-duplicate bytes while the stream could still prove to be a repeat
 * of either, and publishes exactly `resolveContinuationSuffix(full, last, s)`
 * over the concatenation `s` seen so far — by construction the concatenation
 * of everything this gate publishes for a call always equals the durable
 * suffix for that call's final `result.text`.
 *
 * Implemented as accumulate-and-diff over the shared primitive above (not a
 * second matcher): `s` accumulates post-`edgeTrimmer` pieces, `cur` is the
 * shared suffix for `s`, and each `push` publishes `cur` minus what was
 * already published. While `s` is still a prefix of `full`/`last`, `cur` is
 * `''` so nothing is published; on full/last completion `cur` becomes the
 * bytes beyond it; on divergence from both `cur` becomes all of `s` (the held
 * bytes were real new output after all). Returns `null` when nothing is
 * showable yet, otherwise the exact bytes to publish (never `''`).
 *
 * Fed with post-`edgeTrimmer` pieces (whose concatenation is exactly the
 * result text the durable side strips), so both sides compute over the same
 * string. Single-argument form `continuationDedup(reference)` is the legacy
 * last-chunk-only shape preserved for existing unit callers: it behaves as
 * `full=reference, last=undefined`.
 */
export function continuationDedup(full: string, last?: string): {
  /** Next showable bytes, or `null` while holding a candidate duplicate. */
  push(piece: string): string | null;
  /** Bytes currently held as a candidate duplicate (for tests). */
  pending(): number;
} {
  const hasFull = full !== '';
  const hasLast = last !== undefined && last !== '';
  // Fast path preserved: ordinary single-reference callers (including the
  // pre-existing unit tests) keep the exact incremental matcher they had.
  // Two-reference callers go through the shared-primitive accumulate-and-diff
  // below, which is definitionally identical to durable acceptance.
  if (hasFull && !hasLast) {
    const reference = full;
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
  let seen = '';
  let published = '';
  let settled: 'holding' | 'complete' | 'diverged' = 'holding';
  return {
    push(piece: string): string | null {
      if (piece === '') return null;
      if (settled !== 'holding') return piece;
      seen += piece;
      const cur = resolveContinuationSuffix(
        hasFull ? full : undefined,
        hasLast ? (last as string) : undefined,
        seen,
      );
      // Still a prefix of full/last (or exact repeat with nothing after yet):
      // hold everything. `cur==='' ` is exactly the shared no-progress proof
      // for the stream seen so far.
      if (cur === '') return null;
      // `cur` is either the bytes beyond full/last (completion) or all of
      // `seen` (divergence proved real). Either way only the unpublished tail
      // is showable now; the rest was already published (divergence flush) or
      // is the suppressed repeat itself.
      if (cur === seen) {
        settled = 'diverged';
        const out = seen.slice(published.length);
        published = seen;
        return out === '' ? null : out;
      }
      settled = 'complete';
      published = cur;
      return cur;
    },
    pending(): number {
      return settled !== 'holding' ? 0 : seen.length;
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
