import type { Message } from '@grammyjs/types';
import { describe, expect, it } from 'vitest';
import { attachmentOf, safeVaultName } from './media.js';

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
});
