import { statSync } from 'node:fs';
import { DELIVERED, fileModeFor, notDelivered, type DeliveryOutcome, type FileSpec, type Surface } from '../../core/surface/types.js';
import { negoziazioneTelegram, stanzaDi, TELEGRAM_PLACES } from './negoziazione.js';
import type { TelegramApiLike } from './api.js';
import { MAX_DOWNLOAD_BYTES, sendDocument } from './media.js';
import { renderForTelegram, TELEGRAM_MAX } from './render.js';
import { RICH_MAX_CHARS } from './rich.js';
import { makeIngressPort, type IngressPort } from '../shared/ingress/types.js';

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
 * (ADR-0021, "ogni job schedulato dichiara il proprio target") and
 * `telegram:<chatId>#<threadId>` names one **inside a forum topic** — the
 * sotto-conversazione `IncomingIdentity.threadId` already distinguishes. Le due
 * forme senza `#` restano valide per ogni riga già installata e per una DM.
 * Nothing else is accepted: a channel string that looks *almost* right is
 * refused by `handles`, so the registry reports "nessuna superficie serve"
 * rather than this file guessing which room was meant.
 */

/** `telegram`, `telegram:<chatId>` or `telegram:<chatId>#<threadId>` → the room, or null when it is neither. */
function indirizzoPer(
  channel: string,
  ownerChatId: number | undefined,
): { chatId: number; threadId?: number } | null {
  if (channel === 'telegram') return ownerChatId === undefined ? null : { chatId: ownerChatId };
  if (!channel.startsWith('telegram:')) return null;
  const raw = channel.slice('telegram:'.length);
  const hash = raw.indexOf('#');
  const chatRaw = hash === -1 ? raw : raw.slice(0, hash);
  const threadRaw = hash === -1 ? undefined : raw.slice(hash + 1);
  // A chat id is an integer and group ids are negative, so `Number` is right and
  // `parseInt` is not: `parseInt('123abc')` is 123, which would deliver to a
  // chat nobody named. Empty string coerces to 0, which is not a real chat.
  const chatId = Number(chatRaw);
  if (!Number.isInteger(chatId) || chatId === 0) return null;
  if (threadRaw === undefined) return { chatId };
  // Un `#` senza un id di topic (vuoto, non numerico, zero) non è una stanza:
  // rifiutare un canale storto è meglio che consegnare nel posto sbagliato.
  const threadId = Number(threadRaw);
  if (!Number.isInteger(threadId) || threadId <= 0) return null;
  return { chatId, threadId };
}

/**
 * L'id di questa porta, scritto una volta.
 *
 * Letto da `Surface.id` qui sotto e dalla tabella `INGRESS_PORTS`
 * (`cli/surface.ts`): finché è una costante sola, la riga `turns.surface` che
 * lo stadio `work` scrive e la chiave sotto cui `doors`/`streams`/`approvers`
 * registrano non possono divergere (§4 invariante 1).
 */
export const TELEGRAM_ID = 'telegram';

export function telegramSurface(api: TelegramApiLike, ownerChatId: number | undefined): Surface {
  // N1 (judge, PR #42): `deliverFile`'s size check used to hand-write
  // `50 * 1024 * 1024` again instead of reading the number it had already
  // declared here — two literals that agreed today and had no reason to keep
  // agreeing tomorrow. One value, read back from the object callers see.
  const limits = {
    // Legacy mode: 4096 rendered HTML characters per message, split
    // post-render (`render.ts`). The proven fallback — NOT the platform fact.
    maxMessageChars: TELEGRAM_MAX,
    // Rich mode, Bot API 10.1+ (this surface targets
    // `rich.ts#TELEGRAM_BOT_API_TARGET`, floor `TELEGRAM_BOT_API_RICH_FLOOR`
    // for the rich lane): 32768 UTF-8 characters / 500 blocks in ONE message
    // (`rich.ts`). Separate mode, separate limit — see `SurfaceLimits`.
    maxRichMessageChars: RICH_MAX_CHARS,
    // sendDocument's ceiling on the public Bot API. Photos are 10MB but a
    // document is how anything that must survive byte-for-byte goes out
    // (`docs/evidence/capability-output-telegram-e-discord.md`: sendPhoto
    // always recompresses to JPEG), so the document limit is the honest one.
    maxUploadBytes: 50 * 1024 * 1024,
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
  };

  return {
    id: TELEGRAM_ID,
    limits,
    // Always 'edit', for both transports the connector ends up choosing
    // between (`connectors/telegram/presence.ts`): a business draft in a
    // private chat, `editMessageText` on a placeholder in a group. Neither
    // is this object's own job — `deliver`/`deliverFile` below always send
    // the whole finished text, out of band, with nothing to progressively
    // rewrite — this field only declares what the *live* turn path
    // (`TelegramConnector.handle`) is capable of.
    streaming: { transport: 'edit' },

    // La tabella `(porta, stanza)` del 06/09/2026, letta da `negoziazione.ts`
    // e da nessun letterale qui: chi consuma la negoziazione (la trascrizione
    // del turno vivo) e chi la verifica (`assertNegotiable`, `parita.test.ts`)
    // guardano lo stesso oggetto.
    places: TELEGRAM_PLACES,
    negotiate: negoziazioneTelegram,

    handles: (channel) => indirizzoPer(channel, ownerChatId) !== null,

    deliver: async (channel, text): Promise<DeliveryOutcome> => {
      const indirizzo = indirizzoPer(channel, ownerChatId);
      if (indirizzo === null) {
        // Reachable only if a caller skipped `handles`. Refusing is right: the
        // alternative is inventing a destination for a message.
        return notDelivered(`"${channel}" non è un canale telegram indirizzabile`);
      }
      // Un canale con `#<threadId>` è una stanza dentro la stanza: il testo di
      // un job nato in un topic deve restare lì, non suonare in *General*.
      const topic = indirizzo.threadId === undefined ? {} : { threadId: indirizzo.threadId };

      // Convert first, split second. The limit is on the rendered HTML, and
      // splitting the markdown at 4000 then expanding it produced messages over
      // the limit that Telegram rejected whole — a shipped, high-severity bug
      // that lost real messages (`render.ts`).
      const parts = renderForTelegram(text);
      for (const [i, part] of parts.entries()) {
        try {
          await api.sendMessage(indirizzo.chatId, part, topic);
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
      const indirizzo = indirizzoPer(channel, ownerChatId);
      if (indirizzo === null) return notDelivered(`"${channel}" non è un canale telegram indirizzabile`);
      // Il thread vale per tutte e due le uscite di questa funzione — il
      // documento vero e la notifica «è troppo grande»: un file prodotto in un
      // topic che finisse in *General*, in un modo o nell'altro, sarebbe la
      // degradazione silenziosa che questa forma esiste per chiudere.
      const topic = indirizzo.threadId === undefined ? {} : { threadId: indirizzo.threadId };
      const chatId = indirizzo.chatId;

      let bytes: number;
      try {
        bytes = statSync(file.absolutePath).size;
      } catch (error) {
        return notDelivered(`${file.absolutePath} non è leggibile: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Checked here, before a multipart upload is even built: failing fast on
      // a file the Bot API would reject anyway is cheaper than discovering it
      // after reading the bytes into memory and opening the connection.
      // La catena `files` decide, e per un file troppo grande la stanza
      // risponde `'say'`: prima del 06/09/2026 la risposta era
      // `{delivered:false}`, cioè «non te lo do» senza dire dove sta.
      const modo = fileModeFor(negoziazioneTelegram(stanzaDi({ isPrivate: chatId > 0 })), limits, bytes);
      if (modo !== 'native') {
        const dove =
          `${file.filename} è pronto ma pesa ${(bytes / 1e6).toFixed(1)}MB, oltre il limite di ` +
          `${(limits.maxUploadBytes / 1e6).toFixed(0)}MB di sendDocument: sta in ${file.absolutePath}`;
        try {
          await api.sendMessage(chatId, dove, topic);
          return DELIVERED;
        } catch (error) {
          return notDelivered(`telegram ha rifiutato anche il messaggio con il percorso: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      try {
        await sendDocument(api, chatId, file.absolutePath, {
          filename: file.filename,
          ...(file.caption ? { caption: file.caption } : {}),
          ...topic,
        });
        return DELIVERED;
      } catch (error) {
        return notDelivered(`telegram ha rifiutato l'allegato: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * Telegram as an **ingress** port (slice 14, §2.3): the same `Surface` above,
 * plus the handful of inbound-only facts `Surface` has no field for.
 *
 * Built through `makeIngressPort` rather than as an object literal so the
 * declaration cannot contradict the `Surface` it contains: `edit: true` here
 * and `streaming.transport: 'edit'` above are the same fact, and the
 * constructor refuses a port where they disagree.
 */
export function telegramPort(api: TelegramApiLike, ownerChatId: number | undefined): IngressPort {
  return makeIngressPort(telegramSurface(api, ownerChatId), {
    commands: true,
    buttons: true,
    edit: true,
    typing: true,
    upload: true,
  });
}
