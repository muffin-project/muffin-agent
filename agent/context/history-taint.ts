import type { TrustTier } from '../../core/policy/types.js';
import type { SessionMessage } from '../../core/session/store.js';

/**
 * What a session's own transcript is allowed to launder.
 *
 * `SessionStore` is Evidence (ADR-0045 §Revisione 17/08) and `buildContext`
 * reads it straight into a later turn's request, as text. Read alone, that is
 * the seam that ADR revision names: a transcript used directly as Context with
 * no tier travelling alongside it. MANDATO-DAY-1 invariant 2 states the
 * property this file exists to hold: *"qualunque byte fisicamente presente nel
 * nuovo context conserva il massimo trust tier delle fonti da cui deriva. Una
 * sessione/transcript non è una lavanderia del taint."*
 *
 * Two eras of data coexist in the same JSONL file, so a message's tier has
 * three sources, tried in order — never guessed, never left at the caller's
 * default:
 *
 *  1. `SessionMessage.tier`, written by `agent/loop.ts` at every
 *     `sessions.append` call site from this slice onward. Authoritative when
 *     present.
 *  2. `traceId` resolved against `turns.taint` (`TurnStore.taintForIds`, one
 *     query for the whole reinjected set, never one per row) — a row written
 *     after `traceId` existed but before `tier` did.
 *  3. Fail-closed, for a row with neither: `0` for `user` (this store holds
 *     one tenant's own session; an old user line is the owner's — or the
 *     turn-init rule's `member` — own words by construction, never a byte the
 *     turn read from somewhere else), and the scale's own ceiling for
 *     `assistant`/`tool` — doubt raises, never lowers (repo-wide rule,
 *     ADR-0044's "Alternative scartate"), and an assistant or tool line with
 *     no traceable origin at all could be a summary of anything up to and
 *     including a poisoned page. `DISK_TIER` (2) was the right fail-closed
 *     answer for a file, whose `stat` genuinely cannot tell the owner's own
 *     notes from a stranger's; a session row with no `tier` and no resolvable
 *     `traceId` carries no comparable floor, so this file takes the top of the
 *     scale instead, not the disk's middle.
 */

/** The scale's own top (`core/policy/types.ts`) — see the module docstring, case 3. */
const FAIL_CLOSED_CEILING: TrustTier = 3;

/** One message's tier, resolved through the three sources above. */
export function messageTier(message: SessionMessage, taintByTrace: ReadonlyMap<string, TrustTier>): TrustTier {
  if (message.tier !== undefined) return message.tier;
  const fromTrace = message.traceId !== undefined ? taintByTrace.get(message.traceId) : undefined;
  if (fromTrace !== undefined) return fromTrace;
  return message.role === 'user' ? 0 : FAIL_CLOSED_CEILING;
}

/**
 * The max tier physically present across these messages.
 *
 * Same shape as `recallTaint` (`core/memory/recall.ts`) and `planTaint`
 * (`core/turns/todo.ts`) — a `reduce` over `0`, never a guess and never a
 * default that could read as "nothing to report" when the input was empty
 * versus "checked, and clean". Callers pass the **already-filtered,
 * already-sliced** set — see `reinjectedHistory` below — never the whole
 * session: a message that will not physically reach the model cannot taint
 * the request it is not part of.
 */
export function historyTaint(
  messages: readonly SessionMessage[],
  taintByTrace: ReadonlyMap<string, TrustTier>,
): TrustTier {
  return messages.reduce<TrustTier>((max, m) => {
    const t = messageTier(m, taintByTrace);
    return t > max ? t : max;
  }, 0);
}

export type ReinjectedHistory = {
  /** What survives the cut, oldest first — exactly what `buildContext` renders. */
  kept: SessionMessage[];
  /** How many spoken messages were cut from the front. */
  dropped: number;
};

/**
 * What a turn is about to reinject, before it is rendered.
 *
 * Single source of truth for "what's reinjected" — `agent/loop.ts`'s `drive`
 * calls this once, raises taint from `kept`, and passes the same `kept` into
 * `buildContext` for rendering, rather than each computing its own slice of
 * `deps.sessions.read(...)`. Two independent slices of the same session would
 * be exactly the class of defect `docs/JUDGE.md` calls a cucitura: correct
 * separately, and silently able to disagree the day one of them changes.
 *
 * Tool-role rows are excluded (`buildContext` never shows a raw tool result as
 * history — only `user`/`assistant` text), and the cut keeps only the most
 * recent `maxTurns` of what remains: a message old enough to be cut is not
 * physically in the request, so `historyTaint` over `kept` must not see it
 * either (MANDATO-DAY-1 invariant 2 is scoped to what is reinjected, not to
 * the session's whole past).
 */
export function reinjectedHistory(history: readonly SessionMessage[], maxTurns: number): ReinjectedHistory {
  const spoken = history.filter((m) => m.role === 'user' || m.role === 'assistant');
  const kept = spoken.slice(-maxTurns);
  return { kept, dropped: spoken.length - kept.length };
}
