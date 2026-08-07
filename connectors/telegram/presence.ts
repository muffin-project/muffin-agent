import type { TelegramApi } from './api.js';

/**
 * Showing that something is happening, for as long as it happens.
 *
 * This is one of the three traps recorded in ADR-0025, and the only one the
 * previous system fell into twice. `sendMessageDraft` puts an ephemeral bubble
 * in a private chat with a **fixed TTL of about thirty seconds, extended by
 * nothing** — not by calling it again with the same text, not by any parameter.
 * Real turns with tool calls run fifteen to thirty-five seconds and often
 * longer, so the bubble expires mid-turn and the owner is left looking at
 * nothing while the agent is still working.
 *
 * The previous system removed the keepalive on the assumption that answers land
 * inside the TTL, and restored it two weeks later after that assumption met
 * production. So the keepalive is here from the first line, not added when it
 * hurts.
 *
 * Groups have no draft at all (`TEXTDRAFT_PEER_INVALID`), so there the presence
 * is a message that becomes the answer: send a placeholder, edit it when the
 * real text arrives. One message instead of two, and no orphan left behind if
 * the turn dies.
 */

/** The draft dies at ~30s; renew comfortably inside that. */
const DRAFT_RENEW_MS = 22_000;
/** `sendChatAction` self-cancels after ~5s. */
const ACTION_RENEW_MS = 4_000;

export type Presence = {
  /**
   * Where the answer should go. In a group this is the placeholder message to
   * edit; in a private chat there is nothing to edit and the answer is sent new.
   */
  editMessageId?: number;
  /** Always called, exactly once, including when the turn throws. */
  stop(): Promise<void>;
};

export type PresenceOptions = {
  isPrivate: boolean;
  /** Shown in a group while the turn runs. Replaced by the answer. */
  placeholder?: string;
  now?: () => number;
};

/**
 * Starts showing presence and returns how to stop it.
 *
 * Every failure here is swallowed on purpose: a typing indicator that takes the
 * turn down with it has inverted its own priority. It is decoration on a real
 * answer, and the real answer is what the owner is waiting for.
 */
export async function startPresence(
  api: TelegramApi,
  chatId: number,
  options: PresenceOptions,
): Promise<Presence> {
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  const safely = async (work: () => Promise<unknown>): Promise<void> => {
    if (stopped) return;
    try {
      await work();
    } catch {
      /* presence is decoration; the answer is the point */
    }
  };

  // The action works everywhere, including groups, and costs nothing.
  await safely(() => api.sendChatAction(chatId));
  timers.push(setInterval(() => void safely(() => api.sendChatAction(chatId)), ACTION_RENEW_MS));

  let editMessageId: number | undefined;

  if (options.isPrivate) {
    // The draft: prettier than a placeholder message, and it leaves nothing
    // behind if the turn dies. But it needs renewing, which is the whole lesson.
    await safely(() => api.sendMessageDraft(chatId, ''));
    timers.push(setInterval(() => void safely(() => api.sendMessageDraft(chatId, '')), DRAFT_RENEW_MS));
  } else if (options.placeholder) {
    // No draft in groups. A message that becomes the answer: the edit replaces
    // it, so there is never a "sto pensando" left stranded above the reply.
    await safely(async () => {
      const sent = await api.sendMessage(chatId, options.placeholder!);
      editMessageId = sent.message_id;
    });
  }

  return {
    ...(editMessageId !== undefined ? { editMessageId } : {}),
    async stop() {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      // The draft is dismissed by the real message arriving, not by a call, so
      // there is nothing to undo here — and calling something to "close" it was
      // tried on the previous system and silently ignored by the server.
    },
  };
}
