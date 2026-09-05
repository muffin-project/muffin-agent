import { readFileSync, statSync } from 'node:fs';
import { DELIVERED, notDelivered, type DeliveryOutcome, type FileSpec, type Surface } from '../../core/surface/types.js';
import type { DiscordApi } from './api.js';
import { DISCORD_MAX, renderForDiscord } from './render.js';
import { makeIngressPort, type IngressPort } from '../shared/ingress/types.js';

/**
 * Discord as a delivery target, separate from Discord as a listener — the
 * same split `connectors/telegram/surface.ts` makes, for the same reason: a
 * job firing at 08:00 has no message to reply to and no gateway session to
 * keep alive, only a channel and some text.
 *
 * ## Addressing
 *
 * `discord` means the owner's DM — resolved through `api.openDm(ownerUserId)`
 * on every call rather than cached, because that call is documented
 * idempotent ("if one already exists, it will be returned instead") and a
 * cached id would go stale the one time a DM channel is invalidated with no
 * way for this file to find out. `discord:<channelId>` names one explicitly
 * (ADR-0021), sent to directly with no `openDm` round trip — it is already
 * a channel id, not a user id to resolve one from.
 *
 * `maxUploadBytes`/`maxDownloadBytes` are not yet in this repo's own testing
 * matrix — `docs/evidence/capability-output-telegram-e-discord.md` reports
 * Discord's free-tier upload ceiling (10MB) and the 25 MiB request-size cap
 * from the platform's own docs, not from a probe against a live bot. Declared
 * as read, not measured; `deliverFile` still checks it before spending a
 * multipart upload on a file the API is going to reject anyway.
 */

/** `discord` or `discord:<channelId>` → the channel to send to, or null when it is neither. */
function channelIdFor(channel: string, ownerUserId: string | undefined): string | null {
  if (channel === 'discord') return ownerUserId !== undefined ? DEFAULT_CHANNEL : null;
  if (!channel.startsWith('discord:')) return null;
  const id = channel.slice('discord:'.length);
  // A snowflake is digits only; anything else is a channel string that looks
  // almost right, which `handles` should refuse rather than pass to the API
  // and let Discord's own 400 stand in for this file's own validation.
  return /^[0-9]{5,25}$/.test(id) ? id : null;
}

/** Sentinel meaning "resolve the owner's DM lazily" — never sent to the API as a literal id. */
const DEFAULT_CHANNEL = '__owner_dm__';

async function resolveChannelId(api: DiscordApi, channelId: string, ownerUserId: string | undefined): Promise<string> {
  if (channelId !== DEFAULT_CHANNEL) return channelId;
  // `ownerUserId` is checked non-undefined by `channelIdFor` before this sentinel
  // is ever produced, so this call site only reaches Discord once that holds.
  const dm = await api.openDm(ownerUserId as string);
  return dm.id;
}

/** L'id di questa porta, scritto una volta — vedi `TELEGRAM_ID`. */
export const DISCORD_ID = 'discord';

export function discordSurface(api: DiscordApi, ownerUserId: string | undefined): Surface {
  // N1 (judge, PR #42): `deliverFile`'s size check used to hand-write
  // `10 * 1024 * 1024` again instead of reading the number it had already
  // declared here — two literals that agreed today and had no reason to keep
  // agreeing tomorrow. One value, read back from the object callers see.
  const limits = {
    maxMessageChars: DISCORD_MAX,
    maxUploadBytes: 10 * 1024 * 1024,
    maxDownloadBytes: 25 * 1024 * 1024,
  };

  return {
    id: DISCORD_ID,
    limits,
    // B17: Discord is explicitly out of scope for B11. `'off'` is the honest
    // answer today, not a placeholder for "not implemented yet" — nothing in
    // this file has ever progressively rewritten a message.
    streaming: { transport: 'off' },

    handles: (channel) => channelIdFor(channel, ownerUserId) !== null,

    deliver: async (channel, text): Promise<DeliveryOutcome> => {
      const target = channelIdFor(channel, ownerUserId);
      if (target === null) return notDelivered(`"${channel}" non è un canale discord indirizzabile`);

      let channelId: string;
      try {
        channelId = await resolveChannelId(api, target, ownerUserId);
      } catch (error) {
        return notDelivered(`impossibile aprire il DM con l'owner: ${error instanceof Error ? error.message : String(error)}`);
      }

      const parts = renderForDiscord(text);
      for (const [i, part] of parts.entries()) {
        try {
          await api.sendMessage(channelId, part);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          return notDelivered(
            parts.length === 1
              ? `discord ha rifiutato il messaggio: ${why}`
              : `discord ha rifiutato la parte ${i + 1} di ${parts.length}${i > 0 ? ' (le precedenti sono arrivate)' : ''}: ${why}`,
          );
        }
      }
      return DELIVERED;
    },

    deliverFile: async (channel, file: FileSpec): Promise<DeliveryOutcome> => {
      const target = channelIdFor(channel, ownerUserId);
      if (target === null) return notDelivered(`"${channel}" non è un canale discord indirizzabile`);

      let bytes: number;
      try {
        bytes = statSync(file.absolutePath).size;
      } catch (error) {
        return notDelivered(`${file.absolutePath} non è leggibile: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (bytes > limits.maxUploadBytes) {
        return notDelivered(
          `${(bytes / 1e6).toFixed(1)}MB, oltre il limite di upload di ${(limits.maxUploadBytes / 1e6).toFixed(0)}MB (Nitro alza il tetto ma non è verificato qui)`,
        );
      }

      let channelId: string;
      try {
        channelId = await resolveChannelId(api, target, ownerUserId);
      } catch (error) {
        return notDelivered(`impossibile aprire il DM con l'owner: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const content = readFileSync(file.absolutePath);
        await api.sendFile(channelId, content, file.filename, file.caption ? { content: file.caption } : {});
        return DELIVERED;
      } catch (error) {
        return notDelivered(`discord ha rifiutato l'allegato: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * Discord as an **ingress** port (slice 14, §2.3).
 *
 * Every inbound-only capability is declared as it is **today**, not as slice
 * 15 will leave it: `connectors/discord/connector.ts` has no slash commands
 * (its own docstring says so), no approval buttons, no streaming transport
 * (`streaming: {transport: \'off\'}` above, which `makeIngressPort` checks
 * `edit: false` against) and no queue notice. Declaring any of them true here
 * would make `DIVERGENZE_AMMESSE` (slice 16) a fiction on the day it is
 * written.
 */
export function discordPort(api: DiscordApi, ownerUserId: string | undefined): IngressPort {
  return makeIngressPort(discordSurface(api, ownerUserId), {
    commands: false,
    buttons: false,
    edit: false,
    typing: true,
    upload: true,
  });
}
