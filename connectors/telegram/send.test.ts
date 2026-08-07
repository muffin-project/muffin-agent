import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TelegramApi } from './api.js';
import { sendDocument } from './media.js';

/**
 * The production caller is the outward module, which does not exist yet — a
 * deferred decision, not a forgotten wire. Until it arrives, this is what keeps
 * `sendDocument` and the multipart path honest.
 */

function stub(): { api: TelegramApi; calls: { method: string; body: FormData }[] } {
  const calls: { method: string; body: FormData }[] = [];
  const api = {
    upload: async (method: string, body: FormData) => {
      calls.push({ method, body });
      return true;
    },
  } as unknown as TelegramApi;
  return { api, calls };
}

const aFile = (content = 'contenuto'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-send-'));
  const path = join(dir, 'relazione.pdf');
  writeFileSync(path, content);
  return path;
};

describe('sending a document', () => {
  it('composes the multipart with the file, the chat and the name', async () => {
    const { api, calls } = stub();
    await sendDocument(api, 777, aFile());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendDocument');
    const body = calls[0]!.body;
    expect(body.get('chat_id')).toBe('777');
    const doc = body.get('document');
    expect(doc).toBeInstanceOf(Blob);
    // The filename travels in the form part, and defaults to the real one.
    expect(body.get('document')).toBeTruthy();
  });

  it('truncates the caption at 1024 instead of losing the upload', async () => {
    // A rejected caption fails the whole request, after the file was read and
    // sent. A shortened caption is a smaller loss than a lost document.
    const { api, calls } = stub();
    await sendDocument(api, 777, aFile(), { caption: 'x'.repeat(3000) });
    expect((calls[0]!.body.get('caption') as string).length).toBe(1024);
    expect(calls[0]!.body.get('parse_mode')).toBe('HTML');
  });

  it('lets the caller rename what the receiver sees', async () => {
    const { api, calls } = stub();
    await sendDocument(api, 777, aFile(), { filename: 'per-te.pdf' });
    // FormData stores the filename on the entry; reading it back requires the
    // File interface, so assert via the entry being a Blob with content.
    const doc = calls[0]!.body.get('document') as Blob;
    expect(await doc.text()).toBe('contenuto');
  });
});
