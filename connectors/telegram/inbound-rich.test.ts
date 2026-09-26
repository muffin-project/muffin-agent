import type { Update } from '@grammyjs/types';
import { describe, expect, it } from 'vitest';
import { composeTurnText, parseUpdate } from './connector.js';
import { unknownRichPlaceholder } from './rich.js';

/**
 * Bot API 10.1+ inbound `Message.rich_message` (`rich.ts#normalizeInboundRich`
 * through `connector.ts#parseUpdate`).
 *
 * - J: a received or forwarded Rich Message reaches agent-readable input —
 *   paragraphs, headings, lists, tables, quotes, code, details, media
 *   descriptors — instead of vanishing in the contentless `return null`;
 * - K: unsupported block kinds get an explicit bounded placeholder, never
 *   silence and never invented content.
 */

const OWNER = 777001;

const base = (id: number, message: Record<string, unknown>): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      ...message,
    },
  }) as unknown as Update;

/** A forwarded rich message, as the server delivers it: origin + blocks, no `text`. */
const forwardedRich = (id: number): Update =>
  base(id, {
    forward_origin: {
      type: 'channel',
      chat: { id: -1001, title: 'Canale', type: 'channel' },
      message_id: 5,
    },
    rich_message: {
      blocks: [
        { type: 'heading', text: 'Listino', size: 2 },
        { type: 'paragraph', text: 'Prezzi di oggi.' },
        {
          type: 'table',
          cells: [
            [
              { text: 'voce', is_header: true, align: 'left', valign: 'top' },
              { text: 'prezzo', is_header: true, align: 'right', valign: 'top' },
            ],
            [
              { text: 'pane', align: 'left', valign: 'top' },
              { text: '2', align: 'right', valign: 'top' },
            ],
          ],
        },
        {
          type: 'list',
          items: [
            { blocks: [{ type: 'paragraph', text: 'da fare' }], has_checkbox: true },
            { blocks: [{ type: 'paragraph', text: 'fatto' }], has_checkbox: true, is_checked: true },
          ],
        },
        { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'parole citate' }] },
        { type: 'pre', text: 'echo ciao', language: 'sh' },
        {
          type: 'details',
          summary: 'Contesto',
          blocks: [{ type: 'paragraph', text: 'il resto della storia' }],
        },
        { type: 'photo', caption: { text: 'la vetrina' } },
      ],
    },
  });

describe('inbound rich · received rich messages do not disappear', () => {
  it('J: a rich-only message parses with its structure preserved', () => {
    const incoming = parseUpdate(forwardedRich(1));
    // Forwarded → the content rides `forwarded`, never `text`.
    expect(incoming).not.toBeNull();
    expect(incoming!.text).toBe('');
    const content = incoming!.forwarded!.content;
    expect(content).toContain('## Listino');
    expect(content).toContain('Prezzi di oggi.');
    expect(content).toContain('| voce | prezzo |');
    expect(content).toContain('| pane | 2 |');
    expect(content).toContain('- [ ] da fare');
    expect(content).toContain('- [x] fatto');
    expect(content).toContain('> parole citate');
    expect(content).toContain('```sh');
    expect(content).toContain('<summary>Contesto</summary>');
    expect(content).toContain('il resto della storia');
    expect(content).toContain('[foto: la vetrina]');
  });

  it('J: a backslash before a pipe cannot forge a table cell', () => {
    const incoming = parseUpdate(
      base(7, {
        rich_message: {
          blocks: [
            {
              type: 'table',
              cells: [
                [{ text: 'voce' }],
                // Literal `a\|b`: a naive `|` → `\|` escape leaves the pipe
                // live behind an escaped backslash, splitting the row into a
                // forged extra cell (CodeQL js/incomplete-sanitization).
                [{ text: 'a\\|b' }],
              ],
            },
          ],
        },
      }),
    );
    expect(incoming).not.toBeNull();
    // Escaped backslash + escaped pipe: three backslashes then the literal pipe.
    expect(incoming!.text).toContain('a\\\\\\|b');
  });

  it('J: a directly typed rich message becomes the turn text', () => {
    const incoming = parseUpdate(
      base(2, {
        rich_message: {
          blocks: [
            { type: 'heading', text: 'Domanda', size: 1 },
            { type: 'paragraph', text: 'quanto costa?' },
          ],
        },
      }),
    );
    expect(incoming).not.toBeNull();
    expect(incoming!.text).toContain('# Domanda');
    expect(incoming!.text).toContain('quanto costa?');
    const composed = composeTurnText(incoming!, null);
    expect(composed).toContain('quanto costa?');
  });

  it('J: a quoted rich message survives as citation, not as an empty quote', () => {
    const incoming = parseUpdate(
      base(3, {
        text: 'che ne pensi?',
        reply_to_message: {
          message_id: 9,
          date: 0,
          chat: { id: OWNER, type: 'private' },
          from: { id: OWNER, is_bot: false, first_name: 'o' },
          rich_message: { blocks: [{ type: 'paragraph', text: 'il listino di ieri' }] },
        },
      }),
    );
    expect(incoming).not.toBeNull();
    expect(incoming!.citato!.testo).toContain('il listino di ieri');
  });

  it('J: a media-only rich message arrives as a descriptor', () => {
    const incoming = parseUpdate(base(4, { rich_message: { blocks: [{ type: 'voice_note' }] } }));
    expect(incoming).not.toBeNull();
    expect(incoming!.text).toContain('[messaggio vocale]');
  });

  it('an empty rich message (no blocks) stays contentless, like empty text', () => {
    expect(parseUpdate(base(5, { rich_message: { blocks: [] } }))).toBeNull();
  });

  it('a malformed rich_message never throws the drain', () => {
    expect(parseUpdate(base(6, { rich_message: { blocks: 'nonsense' } }))).toBeNull();
    expect(parseUpdate(base(7, { rich_message: null }))).toBeNull();
  });
});

describe('inbound rich · unsupported blocks are named, not dropped', () => {
  it('K: an unknown block kind is a bounded placeholder inside otherwise good content', () => {
    const incoming = parseUpdate(
      base(8, {
        rich_message: {
          blocks: [{ type: 'paragraph', text: 'prima' }, { type: 'teletrasporto', frobnicate: 'x'.repeat(5000) }, { type: 'paragraph', text: 'dopo' }],
        },
      }),
    );
    expect(incoming).not.toBeNull();
    expect(incoming!.text).toContain('prima');
    expect(incoming!.text).toContain('dopo');
    expect(incoming!.text).toContain(unknownRichPlaceholder('teletrasporto'));
    expect(incoming!.text.length).toBeLessThan(1000);
  });

  it('K: a forwarded message made only of unknown blocks still arrives (as placeholders)', () => {
    const incoming = parseUpdate(
      base(9, {
        forward_origin: {
          type: 'channel',
          chat: { id: -1001, title: 'Canale', type: 'channel' },
          message_id: 6,
        },
        rich_message: { blocks: [{ type: 'teletrasporto' }] },
      }),
    );
    expect(incoming).not.toBeNull();
    expect(incoming!.forwarded!.content).toContain('non interpretato');
  });
});
