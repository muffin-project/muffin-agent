import type { DiscordApi } from './api.js';

/**
 * Showing that something is happening, for as long as it happens.
 *
 * The Discord half of the keepalive trap ADR-0025 names for Telegram: a typing
 * indicator that Discord itself expires after **ten seconds**, so a real turn
 * with tool calls (15-35s, often longer) needs it renewed, not sent once.
 *
 * Simpler than `connectors/telegram/presence.ts` on purpose, not by omission:
 * Discord has nothing equivalent to `sendMessageDraft`'s editable bubble, in a
 * DM or anywhere else — there is no placeholder message to create and later
 * edit, only the typing indicator itself. So there is no `editMessageId` to
 * carry and no group/private branch; a DM-only connector has exactly one case.
 */

/** Discord expires typing after ~10s; renew comfortably inside that. */
const TYPING_RENEW_MS = 8_000;

export type Presence = {
  /** Always called, exactly once, including when the turn throws. */
  stop(): Promise<void>;
};

/**
 * Starts showing "typing…" and returns how to stop it.
 *
 * Every failure here is swallowed on purpose: a typing indicator that takes
 * the turn down with it has inverted its own priority. It is decoration on a
 * real answer, and the real answer is what the owner is waiting for.
 */
export function startPresence(api: DiscordApi, channelId: string): Presence {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    api.typing(channelId).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, TYPING_RENEW_MS);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
