import { statSync } from 'node:fs';
import { DELIVERED, notDelivered, type DeliveryOutcome, type FileSpec, type Surface } from '../../core/surface/types.js';
import type { TelegramApi } from './api.js';
import { MAX_DOWNLOAD_BYTES, sendDocument } from './media.js';
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
 * (ADR-0021, "ogni job schedulato dichiara il proprio target"). Nothing else
 * is accepted: a channel string that looks *almost* right is refused by
 * `handles`, so the registry reports "nessuna superficie serve" rather than this
 * file guessing which chat was meant.
 */

/** `telegram` or `telegram:<chatId>` → the chat, or null when it is neither. */
function chatIdFor(channel: string, ownerChatId: number | undefined): number | null {
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
  // N1 (judge, PR #42): `deliverFile`'s size check used to hand-write
  // `50 * 1024 * 1024` again instead of reading the number it had already
  // declared here — two literals that agreed today and had no reason to keep
  // agreeing tomorrow. One value, read back from the object callers see.
  const limits = {
    maxMessageChars: TELEGRAM_MAX,
    // sendDocument's ceiling on the public Bot API. Photos are 10MB but a
    // document is how anything that must survive byte-for-byte goes out
    // (`research/m3-connector-capabilities-telegram-discord.md`: sendPhoto
    // always recompresses to JPEG), so the document limit is the honest one.
    maxUploadBytes: 50 * 1024 * 1024,
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
  };

  return {
    id: 'telegram',
    limits,
    // Always 'edit', for both transports the connector ends up choosing
    // between (`connectors/telegram/presence.ts`): a business draft in a
    // private chat, `editMessageText` on a placeholder in a group. Neither
    // is this object's own job — `deliver`/`deliverFile` below always send
    // the whole finished text, out of band, with nothing to progressively
    // rewrite — this field only declares what the *live* turn path
    // (`TelegramConnector.handle`) is capable of.
    streaming: { transport: 'edit' },

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

    /**
     * `sendDocument` (`media.ts`) was written and tested with no production
     * caller — "sending a file is an outward action, and outward actions
     * arrive with the outward module and its approval path", its own
     * docstring says. This is that caller.
     */
    deliverFile: async (channel, file: FileSpec): Promise<DeliveryOutcome> => {
      const chatId = chatIdFor(channel, ownerChatId);
      if (chatId === null) return notDelivered(`"${channel}" non è un canale telegram indirizzabile`);

      let bytes: number;
      try {
        bytes = statSync(file.absolutePath).size;
      } catch (error) {
        return notDelivered(`${file.absolutePath} non è leggibile: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Checked here, before a multipart upload is even built: failing fast on
      // a file the Bot API would reject anyway is cheaper than discovering it
      // after reading the bytes into memory and opening the connection.
      if (bytes > limits.maxUploadBytes) {
        return notDelivered(
          `${(bytes / 1e6).toFixed(1)}MB, oltre il limite di ${(limits.maxUploadBytes / 1e6).toFixed(0)}MB di sendDocument`,
        );
      }

      try {
        await sendDocument(api, chatId, file.absolutePath, { filename: file.filename, ...(file.caption ? { caption: file.caption } : {}) });
        return DELIVERED;
      } catch (error) {
        return notDelivered(`telegram ha rifiutato l'allegato: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
