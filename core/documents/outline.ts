import { PAGE_SEPARATOR, type ExtractedDocument } from './extract.js';

/**
 * The compact half of the bargain.
 *
 * `extract.ts` guarantees the document went in whole; this guarantees the model
 * does not have to swallow it whole to answer a question about it. The owner's
 * words: *"forse conviene compattare in caso? con possibilità di poi analizzare
 * meglio parti specifiche"* — so a document arrives as **an index plus a way
 * back in**, never as a summary that replaces it.
 *
 * The direction matters and is easy to get backwards. Compacting *instead of*
 * acquiring is the defect (a summary is lossy and the loss is invisible six
 * months later); compacting *after* acquiring is free, because every part named
 * in the index is still on disk and `document_read` returns it verbatim. That
 * is why the outline is allowed to leave pages unlisted and a portion is
 * allowed to stop at a size cap: both say so, in the same breath, with the call
 * that gets the rest.
 */

/**
 * A page for a PDF; a block of about this many characters for anything without
 * pages. Deliberately the same order as `CHUNK_MAX` in `core/vault/chunk.ts`,
 * so the units the model asks for are roughly the units recall hands it back —
 * a "parte 3" that spanned four recalled chunks would be a second vocabulary
 * for the same document.
 */
const PART_TARGET_CHARS = 2_000;

/** Rows before the index stops listing and starts saying what it left out. */
export const MAX_OUTLINE_PARTS = 16;

/** How much of a part's first line is worth showing to tell parts apart. */
const PREVIEW_CHARS = 90;

/**
 * The ceiling on one `document_read`, in characters.
 *
 * Not a truncation: the call reports the last part it returned and how many are
 * left, so the next call continues. A cap is needed at all because the model
 * chooses the range, and *"leggi le pagine 1-80"* would put the whole document
 * back in the context this module exists to protect. 12,000 characters is
 * roughly 3,000 tokens — several pages, comfortably below the 32K useful
 * context the floor is measured against (`09-contratti-m0-m1.md` §3).
 */
export const MAX_PORTION_CHARS = 12_000;

export type DocumentPart = {
  /** 1-based, and what `document_read` takes. */
  n: number;
  /** `p. 4` for a PDF page, `parte 4` for a block of a document without pages. */
  label: string;
  text: string;
};

/**
 * The addressable units of a document.
 *
 * A PDF has pages and they are the honest unit: a citation that says "page 4"
 * can be checked by opening the file. Nothing else does, so blocks are cut on
 * paragraph boundaries and called `parte` rather than borrowing a word that
 * would promise a page number the document does not have.
 */
export function partsOf(doc: ExtractedDocument): DocumentPart[] {
  if (doc.format === 'pdf') {
    return doc.pages.map((text, i) => ({ n: i + 1, label: `p. ${i + 1}`, text }));
  }
  if (doc.sections && doc.sections.length > 0) {
    let n = 0;
    return doc.sections.flatMap((section) => {
      const blocks = blocksOf(section.text);
      return blocks.map((text, i) => ({
        n: ++n,
        label: blocks.length === 1 ? section.label : `${section.label} ${i + 1}`,
        text,
      }));
    });
  }
  return blocksOf(doc.text).map((text, i) => ({ n: i + 1, label: `parte ${i + 1}`, text }));
}

function blocksOf(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const blocks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current !== '' && current.length + paragraph.length + 2 > PART_TARGET_CHARS) {
      blocks.push(current);
      current = '';
    }
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
  }
  if (current.trim() !== '') blocks.push(current);
  return blocks.length > 0 ? blocks : [text];
}

/**
 * What the model is shown when a document lands: what it is, that all of it is
 * in memory, an index of its parts, and the call that reads one.
 *
 * The last line is not decoration. A model that is handed an index and not told
 * how to open it answers from the index — which is the summary-instead-of-the-
 * document failure arriving by the other road.
 */
export function outlineOf(doc: ExtractedDocument, vaultPath: string): string {
  const parts = partsOf(doc);
  const head =
    `${vaultPath} — ${formatName(doc.format)}` +
    `${doc.title === null ? '' : ` «${doc.title}»`}, ` +
    `${parts.length} ${doc.format === 'pdf' ? 'pagine' : 'parti'}, ` +
    `${doc.chars.toLocaleString('it-IT')} caratteri, acquisito per intero`;

  const listed = parts.slice(0, MAX_OUTLINE_PARTS);
  const rows = listed.map((part) => `  ${part.label.padEnd(8)} ${preview(part.text)}`);
  if (parts.length > listed.length) {
    rows.push(
      `  … ${listed.length + 1}-${parts.length}: non elencate qui, ci si arriva con document_read`,
    );
  }

  return [
    head,
    ...rows,
    `  → per rileggere una porzione esatta: document_read(path: "${vaultPath}", da: N, a: M)`,
  ].join('\n');
}

function formatName(format: ExtractedDocument['format']): string {
  return format === 'pdf' ? 'PDF' : format === 'docx' ? 'DOCX' : 'testo';
}

/** The first line with something on it, which is what tells two pages apart. */
function preview(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '(vuota)';
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line;
}

export type Portion = {
  text: string;
  /** The range actually returned, which is not always the range asked for. */
  from: number;
  to: number;
  /** Parts after `to` that the caller asked for and the cap held back. */
  heldBack: number;
  total: number;
};

/**
 * A range of parts, verbatim from the document, with the cap stated rather than
 * applied in silence.
 *
 * Reads from the text the extractor produced — the whole text, the same one the
 * index was built from — so a portion can never be a slice of a slice. `from`
 * and `to` are clamped instead of refused: a model asking for page 90 of an
 * 80-page document should get page 80 and be told, not an error it will retry.
 */
export function portionOf(doc: ExtractedDocument, from?: number, to?: number): Portion {
  const parts = partsOf(doc);
  const total = parts.length;
  const first = clamp(from ?? 1, 1, total);
  const last = clamp(to ?? first, first, total);

  const taken: DocumentPart[] = [];
  let size = 0;
  for (const part of parts.slice(first - 1, last)) {
    // The first part always goes in whole, however long it is: returning a
    // fraction of the smallest thing that can be asked for would leave no way
    // to ever read it.
    if (taken.length > 0 && size + part.text.length > MAX_PORTION_CHARS) break;
    taken.push(part);
    size += part.text.length;
  }

  const stoppedAt = taken[taken.length - 1]?.n ?? first;
  return {
    text: taken.map((p) => `[${p.label}]\n${p.text}`).join(PAGE_SEPARATOR),
    from: first,
    to: stoppedAt,
    heldBack: last - stoppedAt,
    total,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(Math.trunc(value), low), high);
}
