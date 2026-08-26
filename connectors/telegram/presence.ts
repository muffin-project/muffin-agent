import type { TelegramApiLike } from './api.js';
import { renderForTelegram } from './render.js';

/**
 * Showing that something is happening, for as long as it happens — and, since
 * M5-BIS B11, showing the answer itself as it forms.
 *
 * This file started as one of the three traps recorded in ADR-0025: a
 * `sendMessageDraft` bubble that expires if nothing renews it, so the
 * keepalive below has existed since this file's first line rather than being
 * added back after production found the gap the hard way (the previous
 * system's own history, ADR-133 → ADR-138). What changed with B11 is that the
 * same draft is no longer only a heartbeat: `streamText` feeds it the turn's
 * growing text, and
 * once that starts, the heartbeat stops on its own (Hermes's rule, verbatim:
 * the draft **is** the activity indicator, no pulsing typing underneath it —
 * old Muffin's own regression test, `streaming_callbacks.test.ts`, exists
 * because that rule was violated once already, elsewhere).
 *
 * Groups have no draft (`sendMessageDraft` is documented for private chats
 * only — see `api.ts`). A real placeholder cannot be safe on the Bot API: if
 * Telegram accepts it but its response is lost, there is no message id to edit
 * or delete after recovery. Groups therefore use only the self-expiring chat
 * action; their final answer goes through the durable delivery owner.
 */

/** The draft's own preview window is undocumented in its exact renewal
 * behaviour (see `api.ts#sendMessageDraft`'s docstring) — comfortably inside
 * any reading of "30 seconds" either way. */
const DRAFT_RENEW_MS = 22_000;
/** `sendChatAction` self-cancels after ~5s. */
const ACTION_RENEW_MS = 4_000;
/**
 * The floor between two live draft/edit calls — B11, applied uniformly to
 * both transports. Not measured against the real Bot API: this environment
 * has no token to probe with, and PRACTICES §2's own rule for exactly that
 * case is not to assume the number but to drop the dependency on it — so
 * this is the conservative value the slice's own brief specifies, not a
 * tuned one. Old Muffin's `telegram_draft.ts` used 2.5s for its own,
 * finer-grained per-token approach; this design releases a round's text in
 * one burst (see `agent/loop.ts`'s `TurnInput.onDelta` docstring), so the
 * two numbers are not measuring the same thing. `TelegramApi.call`'s
 * existing `retry_after` backoff is the safety net regardless of which
 * turns out to be closer to the server's real limit.
 */
const MIN_LIVE_UPDATE_MS = 1_000;

let draftCounter = 0;
/**
 * A fresh non-zero `draft_id` per presence instance. The Bot API requires
 * non-zero (`api.ts`'s own verified contract) and reuses one id across the
 * calls that update a single ongoing preview — a module-level counter rather
 * than, say, the chat id or a timestamp, because it only has to be distinct
 * *within this process*, and a counter cannot collide with itself.
 */
function nextDraftId(): number {
  draftCounter = (draftCounter % 0x7fffffff) + 1;
  return draftCounter;
}

export type Presence = {
  /**
   * Feed the turn's growing text — B11. Rate-limited to at most one live
   * update per `MIN_LIVE_UPDATE_MS` and coalescing: a call that arrives
   * before the window opens is not dropped, it replaces what the next
   * allowed tick sends, so the owner always ends up seeing the latest text,
   * never a stale intermediate one frozen by bad timing.
   *
   * No-ops once this session has degraded — the accumulated text no longer
   * fits Telegram's one-message limit (the render needs more than the first
   * `renderForTelegram` chunk), or an earlier live update already failed
   * once. Either way the normal finalisation after the turn ends still
   * delivers the whole, correctly-split answer; only the live preview stops.
   */
  streamText: (accumulated: string) => void;
  /**
   * The raw text of the last update actually sent live, or `undefined` if
   * none was. Lets the caller (`connector.ts`) skip re-sending an identical
   * final edit once the turn's real answer matches what streaming already
   * showed.
   */
  lastStreamedRaw: () => string | undefined;
  /**
   * Cancels any pending live update and stops every heartbeat. **Idempotent**
   * — the caller invokes it once explicitly, right before finalising the
   * turn's real answer (so a coalesced update cannot race the final edit and
   * land after it), and once more from its own `finally` as a safety net for
   * every path that never reaches finalisation at all (a suspended turn, a
   * thrown error). The second call is then a no-op by construction.
   */
  stop(): Promise<void>;
};

export type PresenceOptions = {
  isPrivate: boolean;
  /** Legacy caller input. Groups deliberately do not materialise it. */
  placeholder?: string;
  now?: () => number;
};

/**
 * Starts showing presence and returns how to stop it.
 *
 * Every failure here is swallowed on purpose: a typing indicator that takes the
 * turn down with it has inverted its own priority. It is decoration on a real
 * answer, and the real answer is what the owner is waiting for. The one
 * exception is a *live streaming* update, where a failure is not swallowed —
 * it is the signal that turns streaming off for the rest of this session
 * (below), because a bubble that silently stops updating and then jumps to
 * the finished answer at the end is a worse experience than one that never
 * tried, and Hermes's own design names this exact rule: the first failed
 * edit disables streaming for that session, without flooding retries at
 * whatever just failed.
 */
export async function startPresence(
  api: TelegramApiLike,
  chatId: number,
  options: PresenceOptions,
): Promise<Presence> {
  const now = options.now ?? Date.now;
  let stopped = false;
  /** Set on the first failed live update, or on overflow past one Telegram message. Never cleared — streaming does not resume mid-session. */
  let disabled = false;
  let hasStreamedLive = false;

  let pending: string | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let lastLiveAt = 0;
  let lastStreamedRaw: string | undefined;

  /** Returns whether `work` succeeded — the live-update path needs to know; the heartbeats do not and ignore it. */
  const safely = async (work: () => Promise<unknown>): Promise<boolean> => {
    if (stopped) return false;
    try {
      await work();
      return true;
    } catch {
      return false;
    }
  };

  let actionTimer: NodeJS.Timeout | undefined;
  let draftTimer: NodeJS.Timeout | undefined;

  // The action works everywhere, including groups, and costs nothing.
  await safely(() => api.sendChatAction(chatId));
  actionTimer = setInterval(() => void safely(() => api.sendChatAction(chatId)), ACTION_RENEW_MS);

  const draftId = nextDraftId();

  if (options.isPrivate) {
    // The draft: prettier than a placeholder message, and it leaves nothing
    // behind if the turn dies. But it needs renewing, which is the whole lesson.
    await safely(() => api.sendMessageDraft(chatId, draftId, ''));
    draftTimer = setInterval(() => void safely(() => api.sendMessageDraft(chatId, draftId, '')), DRAFT_RENEW_MS);
  }

  /** The activity IS the draft/edit now — the heartbeats that used to say "still here" would only fight it (Hermes's rule; see the file docstring). */
  function silenceHeartbeats(): void {
    if (actionTimer !== undefined) {
      clearInterval(actionTimer);
      actionTimer = undefined;
    }
    if (draftTimer !== undefined) {
      clearInterval(draftTimer);
      draftTimer = undefined;
    }
  }

  /**
   * The one place that actually calls Telegram with live content. Separate
   * from `flush()` (which decides *whether* now is a good time to call this)
   * because `stop()` below needs to send a still-pending update immediately,
   * bypassing the rate-limit wait entirely — a `stop` is not a cancellation
   * of streaming, it is streaming's *last* act.
   */
  async function sendLive(text: string): Promise<void> {
    const parts = renderForTelegram(text);
    if (parts.length > 1) {
      // Overflow past one Telegram message: stop live-updating for the rest
      // of this turn. Not a failure — the normal finalisation after the turn
      // ends still delivers the whole, correctly-split answer.
      disabled = true;
      return;
    }
    const rendered = parts[0] ?? '';
    lastLiveAt = now();

    // Groups deliberately have no material live message: their only presence
    // is the self-expiring chat action, so there is nothing durable to update.
    const ok = options.isPrivate ? await safely(() => api.sendMessageDraft(chatId, draftId, rendered)) : false;

    if (!ok) {
      disabled = true;
      return;
    }
    lastStreamedRaw = text;
    if (!hasStreamedLive) {
      hasStreamedLive = true;
      silenceHeartbeats();
    }
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    if (stopped || disabled || pending === null) return;
    const text = pending;
    pending = null;
    if (text === lastStreamedRaw) return; // nothing changed since the last live send
    await sendLive(text);
  }

  function streamText(accumulated: string): void {
    if (stopped || disabled) return;
    pending = accumulated;
    if (flushTimer !== null) return; // a flush is already scheduled; it reads `pending` fresh when it runs
    const wait = Math.max(0, MIN_LIVE_UPDATE_MS - (now() - lastLiveAt));
    flushTimer = setTimeout(() => void flush(), wait);
  }

  return {
    streamText,
    lastStreamedRaw: () => lastStreamedRaw,
    async stop() {
      if (stopped) return;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // Whatever `streamText` last accumulated goes out now, not abandoned —
      // and this has to run **before** `stopped` flips, because `safely()`
      // itself refuses to act once `stopped` is true (a guard written for
      // the heartbeats, which must not fire after a stop that raced them;
      // this send is the one call `stop()` is explicitly allowed to make).
      //
      // Found by `connectors/telegram/streaming.test.ts`: `streamText`'s
      // first call schedules its flush at `wait: 0`, but a bare
      // `setTimeout(fn, 0)` still means "next macrotask" — and nothing
      // between the delta burst (`agent/loop.ts`) and `connector.ts`'s
      // `await presence.stop()` yields to one (session/memory writes there
      // are synchronous `better-sqlite3` calls). So the scheduled flush
      // never got a turn to run before `stop()` cancelled it, and a fast
      // turn streamed *nothing at all* — silently, which is worse than
      // slow: the whole feature would have looked wired and shown no
      // symptom in anything but a real timing-sensitive test. Sending here
      // is what makes `TelegramApiLike` fake in the same test see the live
      // update it expects, and it is also strictly safer than the
      // alternative: this `await` still runs *before* connector.ts's
      // finalisation edit, so the ordering guarantee `stop()` exists for is
      // unchanged — nothing can fire after this function returns.
      if (pending !== null && !disabled) {
        const text = pending;
        pending = null;
        if (text !== lastStreamedRaw) await sendLive(text);
      }
      stopped = true;
      silenceHeartbeats();
      // The draft is dismissed by the real message arriving, not by a call, so
      // there is nothing to undo here — and calling something to "close" it was
      // tried on the previous system and silently ignored by the server.
    },
  };
}
