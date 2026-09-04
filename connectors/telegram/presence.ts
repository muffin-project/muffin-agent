import type { TelegramApiLike } from './api.js';

/**
 * Showing that something is happening, before there is anything real to show.
 *
 * Until 2026-09-04 this file also streamed the turn's growing text into a
 * `sendMessageDraft` bubble — DAY-1 requirement B11. That bubble is a Bot API
 * "temporary 30-second preview", not a message in the chat's own history, and
 * it needs a live process renewing it at least that often to stay visible.
 * `docs/evidence/turno-sospendibile.md` names the failure mode precisely:
 * *«due meccanismi che dicono la stessa cosa a ritmi diversi»* — this file's
 * timer racing `transcript.ts`'s own real, durable message for the same
 * turn. Measured in production (2026-09-04T02:31Z, same evidence file): a
 * SIGTERM mid-turn stopped the renewal for good, the preview the owner was
 * reading expired on its own a few seconds later, and the real answer only
 * arrived minutes afterward when the turn resumed — "written, then deleted,
 * then rewritten", the owner's own words.
 *
 * B11 did not go away — it moved. `transcript.ts#live()` now streams the
 * answer as it forms into the *same* real message the tool trail already
 * owns (`connector.ts`'s `onDelta` feeds it there instead of here). A real
 * message cannot expire out from under a dead process, which is the one
 * property a "temporary preview" can never have no matter how disciplined
 * its renewal is.
 *
 * What is left here is the one thing an expiring preview was never wrong
 * for: `sendChatAction`, Telegram's own "typing…" indicator, self-cancelling
 * after ~5s by design and carrying no information worth losing. It exists
 * purely to cover the gap before the model's first token arrives — an
 * ordinary UI nicety, not a state anything downstream depends on.
 */

/** `sendChatAction` self-cancels after ~5s. */
const ACTION_RENEW_MS = 4_000;

export type Presence = {
  /**
   * Cancels the heartbeat. **Idempotent** — the caller invokes it once
   * explicitly, right before finalising the turn's real answer, and once
   * more from its own `finally` as a safety net for every path that never
   * reaches finalisation at all (a suspended turn, a thrown error). The
   * second call is then a no-op by construction.
   */
  stop(): Promise<void>;
};

/**
 * Starts the "typing…" heartbeat and returns how to stop it.
 *
 * Every failure here is swallowed on purpose: a typing indicator that takes
 * the turn down with it has inverted its own priority. It is decoration on a
 * real answer, and the real answer is what the owner is waiting for.
 *
 * No `isPrivate` parameter (unlike before B11's retirement): `sendChatAction`
 * behaves identically in a private chat and a group, so there is nothing left
 * here for a chat kind to change.
 */
export async function startPresence(api: TelegramApiLike, chatId: number): Promise<Presence> {
  let stopped = false;

  const safely = async (work: () => Promise<unknown>): Promise<void> => {
    if (stopped) return;
    try {
      await work();
    } catch {
      // Decoration — see the file docstring.
    }
  };

  // Works everywhere, including groups, and costs nothing.
  await safely(() => api.sendChatAction(chatId));
  const actionTimer: NodeJS.Timeout = setInterval(() => void safely(() => api.sendChatAction(chatId)), ACTION_RENEW_MS);

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(actionTimer);
    },
  };
}
