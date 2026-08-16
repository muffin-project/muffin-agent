import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from './extract.js';
import { MAX_OUTLINE_PARTS, MAX_PORTION_CHARS, outlineOf, partsOf, portionOf } from './outline.js';

/**
 * The compact view is allowed to leave things out. What it is not allowed to do
 * is leave them out **silently** — that is the difference between a view and a
 * summary, and the whole reason acquiring and compacting are two steps.
 *
 * So every test here is about the seam: an index that names what it did not
 * list, a portion that names what it held back, and a range that comes out of
 * the document's own text rather than out of the index.
 */

const pdf = (pages: string[], title: string | null = null): ExtractedDocument => ({
  format: 'pdf',
  text: pages.join('\n\n'),
  pages,
  title,
  chars: pages.join('\n\n').length,
});

describe('the index a document arrives with', () => {
  it('says what it is, that all of it is in, and how to open a page', () => {
    const doc = pdf(['Contratto di locazione\nfra le parti', 'Canone 850 euro'], 'Contratto');
    const outline = outlineOf(doc, 'inbox/contratto.pdf');

    expect(outline).toContain('inbox/contratto.pdf');
    expect(outline).toContain('«Contratto»');
    expect(outline).toContain('2 pagine');
    expect(outline).toContain('acquisito per intero');
    // The line without which an index is a summary: a model handed a list of
    // page titles and no way to open one answers from the list.
    expect(outline).toContain('document_read');
  });

  it('previews each page with the first line that has something on it', () => {
    const outline = outlineOf(pdf(['\n\n  Canone mensile 850 euro\naltro'], null), 'x.pdf');
    expect(outline).toContain('p. 1');
    expect(outline).toContain('Canone mensile 850 euro');
  });

  it('stops listing on a long document and says which pages it did not list', () => {
    const doc = pdf(Array.from({ length: 80 }, (_, i) => `pagina ${i + 1}\ntesto`));
    const outline = outlineOf(doc, 'tesi.pdf');

    const rows = outline.split('\n').filter((l) => l.trimStart().startsWith('p. '));
    expect(rows).toHaveLength(MAX_OUTLINE_PARTS);
    // Named, not dropped. An index that quietly ends at page 16 is a document
    // that quietly ends at page 16 as far as the reader can tell.
    expect(outline).toContain(`${MAX_OUTLINE_PARTS + 1}-80`);
    expect(outline).toContain('document_read');
  });

  it('does not promise page numbers a document without pages does not have', () => {
    const note: ExtractedDocument = {
      format: 'text',
      text: 'una nota lunga\n\n'.repeat(400),
      pages: ['ignored'],
      title: null,
      chars: 6800,
    };
    const outline = outlineOf(note, 'note/diario.md');
    expect(outline).toContain('parte 1');
    expect(outline).not.toContain('p. 1');
    expect(partsOf(note).length).toBeGreaterThan(1);
  });
});

describe('reading a portion back', () => {
  const doc = pdf(['prima pagina', 'seconda pagina', 'terza pagina', 'quarta pagina']);

  it('returns exactly the pages asked for, labelled', () => {
    const portion = portionOf(doc, 2, 3);
    expect(portion.text).toContain('[p. 2]');
    expect(portion.text).toContain('seconda pagina');
    expect(portion.text).toContain('terza pagina');
    expect(portion.text).not.toContain('prima pagina');
    expect(portion).toMatchObject({ from: 2, to: 3, heldBack: 0, total: 4 });
  });

  it('clamps a range that runs off the end instead of failing', () => {
    // A model asking for page 90 of a 4-page document should get page 4 and be
    // told, not an error it will spend an iteration retrying.
    expect(portionOf(doc, 90, 200)).toMatchObject({ from: 4, to: 4, total: 4 });
    expect(portionOf(doc, 0, 0)).toMatchObject({ from: 1, to: 1 });
    expect(portionOf(doc)).toMatchObject({ from: 1, to: 1 });
  });

  it('caps a huge range and says where to continue, instead of truncating', () => {
    // The cap is the whole reason the compact view is worth anything: without
    // it "read pages 1 to 80" puts the document straight back into the context.
    // What must not happen is a cut nobody mentions.
    const long = pdf(Array.from({ length: 40 }, (_, i) => `pagina ${i + 1} `.repeat(200)));
    const portion = portionOf(long, 1, 40);

    expect(portion.text.length).toBeLessThanOrEqual(MAX_PORTION_CHARS + 4_000);
    expect(portion.to).toBeLessThan(40);
    expect(portion.heldBack).toBe(40 - portion.to);
  });

  it('returns a single oversized page whole rather than nothing', () => {
    // The smallest addressable thing has to be readable, or it is unreachable
    // for ever: a cap applied to the first part would make page 1 of a
    // one-page-per-chapter PDF permanently unopenable.
    const huge = pdf(['x'.repeat(MAX_PORTION_CHARS * 3)]);
    const portion = portionOf(huge, 1, 1);
    expect(portion.text.length).toBeGreaterThan(MAX_PORTION_CHARS);
    expect(portion.heldBack).toBe(0);
  });
});
