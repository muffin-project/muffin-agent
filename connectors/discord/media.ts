import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeVaultName } from '../telegram/media.js';
import type { DiscordApi, DiscordAttachment } from './api.js';

/**
 * Files in, for Discord.
 *
 * Simpler than Telegram's `media.ts` in one real way and identical in the two
 * that matter. Simpler: an attachment already carries a direct, signed CDN
 * `url` (`DiscordAttachment.url`) — there is no `getFile` round trip and no
 * bot-token-bearing URL to keep out of a log, because the URL Discord hands
 * back is itself the credential and is not ours. Identical: the filename is
 * attacker-controlled and is **replaced**, not sanitised (`safeVaultName`,
 * reused from `connectors/telegram/media.ts` rather than re-implemented —
 * this is security-relevant string handling, and a second copy is a second
 * chance for the two to drift), and the size is checked against what actually
 * arrived, never only against what the payload declared.
 */

/**
 * No Bot-API-wide cap like Telegram's 20MB (attachments live on Discord's CDN,
 * not behind the same download endpoint). This is an operational ceiling, not
 * a platform one — set to the free-tier upload limit's rough order of
 * magnitude (`research/m3-connector-capabilities-telegram-discord.md`: 10MB
 * free / up to 500MB with boosts) plus headroom, so an ordinary attachment
 * never trips it while a runaway one still cannot exhaust the vault.
 */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export type Downloaded = {
  /** Relative to the vault root: what goes in the database. */
  vaultPath: string;
  bytes: number;
};

/**
 * Downloads an attachment into the vault's `inbox/`.
 *
 * Discord's own `size` field is trusted for the pre-flight check only; the
 * buffer that actually lands on disk is measured again, because the declared
 * size is a number in a message a stranger sent and the real one is what the
 * CDN returned.
 */
export async function downloadToVault(
  api: DiscordApi,
  vaultRoot: string,
  attachment: DiscordAttachment,
  messageId: string,
  receivedAt: string,
): Promise<Downloaded> {
  if (attachment.size > MAX_DOWNLOAD_BYTES) {
    throw new MediaTooLarge(attachment.size);
  }

  const buffer = await api.download(attachment.url, MAX_DOWNLOAD_BYTES);

  // `messageId` (a snowflake) stands in for Telegram's numeric update id: both
  // are monotonically-ish increasing and unique enough to keep the vault in
  // arrival order without a collision check.
  const name = safeVaultName(attachment.filename, hashToInt(messageId), receivedAt);
  const relative = `inbox/${name}`;
  writeFileSync(join(vaultRoot, relative), buffer);
  return { vaultPath: relative, bytes: buffer.byteLength };
}

/**
 * `safeVaultName` takes a `number` (Telegram's `update_id` is a 32-bit int);
 * a Discord snowflake is a 64-bit id carried as a string specifically because
 * it does not fit a JS number without losing precision (`connector.ts`
 * explains why every Discord id in this connector is a string, never
 * `Number(id)`). Hashing to a small int here is fine — this value is only
 * ever a disambiguating prefix in a filename, never compared, stored as an
 * identifier, or round-tripped back into a snowflake.
 */
function hashToInt(snowflakeId: string): number {
  let h = 0;
  for (let i = 0; i < snowflakeId.length; i++) {
    h = (Math.imul(31, h) + snowflakeId.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export class MediaTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`${(bytes / 1e6).toFixed(1)}MB, oltre il limite operativo di ${MAX_DOWNLOAD_BYTES / 1e6}MB`);
    this.name = 'MediaTooLarge';
  }
}
