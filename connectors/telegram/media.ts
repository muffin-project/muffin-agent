import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Message } from '@grammyjs/types';
import type { TelegramApiLike } from './api.js';

/**
 * Files in and files out.
 *
 * Two things here are attacker-controlled and both have been the shape of a real
 * vulnerability somewhere: **the filename**, which arrives from whoever sent the
 * message, and **the download URL**, which contains the bot token and must never
 * reach a log, a trace or an error message.
 *
 * The filename is not sanitised, it is *replaced*. Taking a name like
 * `../../.ssh/authorized_keys` and trying to clean it means reasoning about
 * every encoding of `..` that a filesystem might accept; constructing a new name
 * from a known-safe alphabet means not having that conversation. The original is
 * kept as metadata, where it is a string nobody resolves.
 */

/** The public Bot API refuses to serve anything larger, whatever the path says. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export type MediaSpec = {
  fileId: string;
  /** What the sender called it. Recorded, never used as a path. */
  originalName: string;
  bytes: number;
  kind: 'photo' | 'document' | 'audio' | 'voice' | 'video';
};

/**
 * What is attached to this message, if anything.
 *
 * Photos arrive as an array of sizes, smallest first; the last is the largest
 * Telegram kept. Taking the last rather than the first is the difference between
 * indexing a thumbnail and indexing the picture.
 */
export function attachmentOf(message: Message): MediaSpec | null {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      originalName: message.document.file_name ?? 'documento',
      bytes: message.document.file_size ?? 0,
      kind: 'document',
    };
  }
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    return { fileId: largest.file_id, originalName: 'foto.jpg', bytes: largest.file_size ?? 0, kind: 'photo' };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      originalName: message.audio.file_name ?? 'audio',
      bytes: message.audio.file_size ?? 0,
      kind: 'audio',
    };
  }
  if (message.voice) {
    return { fileId: message.voice.file_id, originalName: 'vocale.ogg', bytes: message.voice.file_size ?? 0, kind: 'voice' };
  }
  if (message.video) {
    return {
      fileId: message.video.file_id,
      originalName: message.video.file_name ?? 'video.mp4',
      bytes: message.video.file_size ?? 0,
      kind: 'video',
    };
  }
  return null;
}

/**
 * A filename built from scratch, not cleaned.
 *
 * Everything outside `[a-z0-9._-]` goes, the extension is kept only if it is
 * plausible, and the result is prefixed with the date and the update id — which
 * makes it unique without a collision check and puts the vault in chronological
 * order when listed.
 *
 * Leading dots are stripped: the vault refuses to index dotfiles, and a sender
 * who names their attachment `.env` should not get to decide that.
 */
export function safeVaultName(originalName: string, updateId: number, date: string): string {
  const ext = extname(basename(originalName)).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const stem = basename(originalName, extname(originalName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
  return `${date.slice(0, 10)}-${updateId}-${stem || 'file'}${safeExt}`;
}

export type Downloaded = {
  /** Relative to the vault root: what goes in the database. */
  vaultPath: string;
  bytes: number;
};

/**
 * Downloads an attachment into the vault's `inbox/`.
 *
 * Size is checked twice — against what Telegram declared and against what
 * actually arrived — because the declared size is a number in a message and the
 * real one is what lands on the disk.
 */
export async function downloadToVault(
  api: TelegramApiLike,
  vaultRoot: string,
  spec: MediaSpec,
  updateId: number,
  receivedAt: string,
): Promise<Downloaded> {
  if (spec.bytes > MAX_DOWNLOAD_BYTES) {
    throw new MediaTooLarge(spec.bytes);
  }

  const url = await api.fileUrl(spec.fileId);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    // The URL carries the bot token. It never appears in an error, a log or a
    // trace — the message says what failed, not where it was fetched from.
    throw new Error(`download fallito: ${error instanceof Error ? error.name : 'errore'}`);
  }
  if (!response.ok) throw new Error(`download fallito: HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) throw new MediaTooLarge(buffer.byteLength);

  const name = safeVaultName(spec.originalName, updateId, receivedAt);
  const relative = `inbox/${name}`;
  writeFileSync(join(vaultRoot, relative), buffer);
  return { vaultPath: relative, bytes: buffer.byteLength };
}

class MediaTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`${(bytes / 1e6).toFixed(1)}MB, oltre il limite di ${MAX_DOWNLOAD_BYTES / 1e6}MB del Bot API pubblico`);
    this.name = 'MediaTooLarge';
  }
}

/**
 * Sends a file, as multipart.
 *
 * Node has `FormData` and `Blob` natively since 18, so this is the whole reason
 * the transport does not need a library: the one thing a wrapper is usually kept
 * around for is four lines.
 *
 * **Its production caller does not exist yet, on purpose.** Sending a file is an
 * outward action, and outward actions arrive with the outward module and its
 * approval path — not as a CLI verb bolted on to give this function something to
 * call it (that verb existed for a day and taught the lesson). Until then the
 * test exercises the composition. This is a deferred wiring recorded as a
 * decision, which is different from a forgotten one.
 */
export async function sendDocument(
  api: TelegramApiLike,
  chatId: number,
  absolutePath: string,
  options: { caption?: string; filename?: string } = {},
): Promise<void> {
  const body = new FormData();
  body.append('chat_id', String(chatId));
  body.append('document', new Blob([readFileSync(absolutePath)]), options.filename ?? basename(absolutePath));
  if (options.caption) {
    // Captions cap at 1024, and a truncated caption is better than a rejected
    // upload of a file that took a minute to read.
    body.append('caption', options.caption.slice(0, 1024));
    body.append('parse_mode', 'HTML');
  }
  await api.upload('sendDocument', body);
}
