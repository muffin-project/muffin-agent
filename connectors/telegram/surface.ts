import { DELIVERED, notDelivered, type DeliveryOutcome, type Surface } from '../../core/surface/types.js';
import type { TelegramApi } from './api.js';
import { MAX_DOWNLOAD_BYTES } from './media.js';
import { renderForTelegram, TELEGRAM_MAX } from './render.js';

/**
 * Telegram as a delivery target, separate from Telegram as a listener.
 *
 * The connector already knew how to answer a message it had just received. What
 * did not exist was a way for anything *else* — the scheduler, `muffin observe`
 * — to send to Telegram at all: all three `Deliver` implementations treated it
 * as "consegna remota da cablare". This is the wiring, and it is deliberately a
 * separate object from `TelegramConnector`: a job delivered at 08:00 has no
 * update to reply to, no presence to keep alive and no session to continue. It
 * has a chat id and some text.
 *
 * ## Addressing
 *
 * `telegram` means the owner's chat — the surface's default room, which is what
 * `surfaces.default` has always meant. `telegram:<chatId>` names one explicitly
 * (ADR-0021 §4, "ogni job schedulato dichiara il proprio target"). Nothing else
 * is accepted: a channel string that looks *almost* right is refused by
 * `handles`, so the registry reports "nessuna superficie serve" rather than this
 * file guessing which chat was meant.
 */

/** `telegram` or `telegram:<chatId>` → the chat, or null when it is neither. */
export function chatIdFor(channel: string, ownerChatId: number | undefined): number | null {
  if (channel === 'telegram') return ownerChatId ?? null;
  if (!channel.startsWith('telegram:')) return null;
  const raw = channel.slice('telegram:'.length);
  // A chat id is an integer and group ids are negative, so `Number` is right and
  // `parseInt` is not: `parseInt('123abc')` is 123, which would deliver to a
  // chat nobody named. Empty string coerces to 0, which is not a real chat.
  const id = Number(raw);
  return Number.isInteger(id) && id !== 0 ? id : null;
}

export function telegramSurface(api: TelegramApi, ownerChatId: number | undefined): Surface {
  return {
    id: 'telegram',
    limits: {
      maxMessageChars: TELEGRAM_MAX,
      // sendDocument's ceiling on the public Bot API. Photos are 10MB but a
      // document is how anything that must survive byte-for-byte goes out
      // (`research/m3-connector-capabilities-telegram-discord.md`: sendPhoto
      // always recompresses to JPEG), so the document limit is the honest one.
      maxUploadBytes: 50 * 1024 * 1024,
      maxDownloadBytes: MAX_DOWNLOAD_BYTES,
    },

    handles: (channel) => chatIdFor(channel, ownerChatId) !== null,

    deliver: async (channel, text): Promise<DeliveryOutcome> => {
      const chatId = chatIdFor(channel, ownerChatId);
      if (chatId === null) {
        // Reachable only if a caller skipped `handles`. Refusing is right: the
        // alternative is inventing a destination for a message.
        return notDelivered(`"${channel}" non è un canale telegram indirizzabile`);
      }

      // Convert first, split second. The limit is on the rendered HTML, and
      // splitting the markdown at 4000 then expanding it produced messages over
      // the limit that Telegram rejected whole — a shipped, high-severity bug
      // that lost real messages (`render.ts`).
      const parts = renderForTelegram(text);
      for (const [i, part] of parts.entries()) {
        try {
          await api.sendMessage(chatId, part);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          // Which part failed is the difference between "nothing arrived" and
          // "half of it did", and the owner needs to know which — a retry of the
          // whole message after a partial send delivers the first half twice.
          return notDelivered(
            parts.length === 1
              ? `telegram ha rifiutato il messaggio: ${why}`
              : `telegram ha rifiutato la parte ${i + 1} di ${parts.length}${i > 0 ? ' (le precedenti sono arrivate)' : ''}: ${why}`,
          );
        }
      }
      return DELIVERED;
    },
  };
}
