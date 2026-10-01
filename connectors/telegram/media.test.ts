import type { Message } from '@grammyjs/types';
import { describe, expect, it } from 'vitest';
import { attachmentOf, formatoSticker, safeVaultName } from './media.js';

/**
 * The filename is written by whoever sent the message, and it becomes a path.
 * That is the whole reason this file has tests: everything else here is plumbing.
 */

const msg = (over: Record<string, unknown>): Message =>
  ({ message_id: 1, date: 0, chat: { id: 1, type: 'private' }, ...over }) as Message;

describe('safe vault names', () => {
  it('cannot escape the vault, whatever the sender called the file', () => {
    // Not sanitised — replaced. Cleaning a hostile name means reasoning about
    // every encoding of `..` a filesystem might accept; building one from a
    // known alphabet means not having that conversation.
    for (const hostile of [
      '../../.ssh/authorized_keys',
      '/etc/passwd',
      '..\\..\\windows\\system32',
      'a/../../b.txt',
    ]) {
      const name = safeVaultName(hostile, 7, '2026-08-06T10:00:00Z');
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain('..');
    }
  });

  it('refuses to produce a dotfile', () => {
    // The vault will not index dotfiles, and a sender does not get to decide
    // that their attachment is called `.env`.
    const name = safeVaultName('.env', 7, '2026-08-06T10:00:00Z');
    expect(name.startsWith('.')).toBe(false);
    expect(name).toContain('env');
  });

  it('is unique without needing a collision check', () => {
    // Date and update id in front: two files called `documento.pdf` from
    // different messages never overwrite each other, and a listing is in order.
    const a = safeVaultName('documento.pdf', 7, '2026-08-06T10:00:00Z');
    const b = safeVaultName('documento.pdf', 8, '2026-08-06T10:00:00Z');
    expect(a).not.toBe(b);
    expect(a).toBe('2026-08-06-7-documento.pdf');
  });

  it('keeps a plausible extension and drops a hostile one', () => {
    expect(safeVaultName('note.md', 1, '2026-08-06T00:00:00Z')).toMatch(/\.md$/);
    // Not an extension, a second path component pretending to be one.
    expect(safeVaultName('x.tar.gz/../../y', 1, '2026-08-06T00:00:00Z')).not.toContain('/');
  });

  it('survives a name made entirely of characters it strips', () => {
    expect(safeVaultName('🧁🧁🧁', 3, '2026-08-06T00:00:00Z')).toBe('2026-08-06-3-file');
  });

  it('does not let a very long name become a very long path', () => {
    const name = safeVaultName(`${'a'.repeat(500)}.pdf`, 1, '2026-08-06T00:00:00Z');
    expect(name.length).toBeLessThan(90);
  });
});

describe('reading an attachment', () => {
  it('takes the largest photo, not the thumbnail', () => {
    // Telegram sends sizes smallest first. Taking the first indexes a thumbnail.
    const photo = attachmentOf(
      msg({
        photo: [
          { file_id: 'piccola', file_unique_id: 'a', width: 90, height: 90, file_size: 1000 },
          { file_id: 'grande', file_unique_id: 'b', width: 1280, height: 1280, file_size: 200000 },
        ],
      }),
    );
    expect(photo).toMatchObject({ fileId: 'grande', kind: 'photo', bytes: 200000 });
  });

  it('recognises a document, a voice note and a video', () => {
    expect(attachmentOf(msg({ document: { file_id: 'd', file_unique_id: 'x', file_name: 'contratto.pdf' } })))
      .toMatchObject({ kind: 'document', originalName: 'contratto.pdf' });
    expect(attachmentOf(msg({ voice: { file_id: 'v', file_unique_id: 'x', duration: 3 } })))
      .toMatchObject({ kind: 'voice' });
    expect(attachmentOf(msg({ video: { file_id: 'z', file_unique_id: 'x', width: 1, height: 1, duration: 1 } })))
      .toMatchObject({ kind: 'video' });
  });

  it('says there is nothing rather than inventing something', () => {
    expect(attachmentOf(msg({ text: 'solo testo' }))).toBeNull();
    expect(attachmentOf(msg({ photo: [] }))).toBeNull();
  });

  it('copes with a document that has no name', () => {
    expect(attachmentOf(msg({ document: { file_id: 'd', file_unique_id: 'x' } })))
      .toMatchObject({ originalName: 'documento' });
  });

  it('recognises a sticker, whose format is read from the bytes later', () => {
    // Stickers carry no usable name and no caption: the format (webp, webm,
    // tgs) is sniffed after the download, never trusted from flags.
    expect(attachmentOf(msg({ sticker: { file_id: 's', file_unique_id: 'x', width: 512, height: 512, is_animated: false, is_video: false } })))
      .toMatchObject({ fileId: 's', kind: 'sticker', originalName: 'sticker' });
  });

  it('animation and video notes are videos with their own names', () => {
    // GIF e videomessaggi tondi sono mp4 anche loro: stessa strada, nome suo.
    expect(attachmentOf(msg({ animation: { file_id: 'g', file_unique_id: 'x', width: 100, height: 100, duration: 2 } })))
      .toMatchObject({ fileId: 'g', kind: 'video' });
    expect(attachmentOf(msg({ video_note: { file_id: 'n', file_unique_id: 'x', length: 100, duration: 5 } })))
      .toMatchObject({ fileId: 'n', kind: 'video', originalName: 'video-nota.mp4' });
  });
});

describe('reading a sticker format', () => {
  it('webp statica, webm video, tgs compresso, resto sconosciuto', () => {
    const webp = Buffer.concat([Buffer.from('RIFF____WEBP', 'latin1'), Buffer.alloc(16)]);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
    const tgs = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(16)]);
    expect(formatoSticker(webp)).toBe('webp');
    expect(formatoSticker(webm)).toBe('webm');
    expect(formatoSticker(tgs)).toBe('tgs');
    expect(formatoSticker(Buffer.alloc(16))).toBe('sconosciuto');
    expect(formatoSticker(Buffer.alloc(0))).toBe('sconosciuto');
  });
});
