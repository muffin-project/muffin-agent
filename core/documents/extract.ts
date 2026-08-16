import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import { posix } from 'node:path';
import {
  MAX_ZIP_ENTRY_BYTES,
  NotAZip,
  hasZipEntry,
  listZipEntries,
  readZipEntry,
} from './zip.js';

/**
 * Text out of a document, whole.
 *
 * The rule this module exists to hold: **a document enters entire**. Nothing
 * here truncates, samples, or summarises — an eighty-page PDF produces eighty
 * pages of text and the caller stores all of it. Compacting for a model's
 * context happens afterwards and elsewhere (`outline.ts`), never instead:
 * *"parsiamo tutto quello che serve ed evitiamo di troncare dati importanti"*
 * is the directive, and the defect it names is a document that arrived and was
 * cut on the way in, where nothing downstream can tell it happened.
 *
 * The second rule is about the failure that looks like success. A PDF made of
 * scanned pages parses perfectly, reports its page count, and yields the empty
 * string — measured on 2026-08-15, unpdf 1.8.1: a two-page PDF with no text
 * operators returns `{ totalPages: 2, text: ["", ""] }`. Returning that as
 * extracted text would index a document as if it had been read. So the result
 * is a **union the caller cannot ignore**: either a document or a named
 * failure, never a string that might be empty for a reason nobody recorded.
 * That is `docs/ORCHESTRATION.md` §14 — prefer the shape that fails on its own
 * to the one that depends on somebody remembering.
 *
 * OCR is out of scope and stays out: it is a model or a binary, and both are
 * decisions of their own. What is in scope is that the owner is told *"this PDF
 * has no selectable text"* instead of being told nothing.
 */

/** What every page is joined with, and therefore what a page slice is cut on. */
export const PAGE_SEPARATOR = '\n\n';

export type DocumentFormat = 'pdf' | 'docx' | 'text';

export type ExtractedDocument = {
  format: DocumentFormat;
  /** The whole document. `pages.join(PAGE_SEPARATOR)`, and never anything less. */
  text: string;
  /**
   * One entry per page for a PDF; a single entry for everything else, because
   * a Markdown note does not have pages and pretending otherwise would put a
   * page number in a citation that cannot be checked.
   */
  pages: string[];
  /** Named OOXML parts when the source has semantic sections without pages. */
  sections?: { label: string; text: string }[];
  /** From the document's own metadata, when it declares one. */
  title: string | null;
  chars: number;
};

export type ExtractionFailure =
  /** Bytes we have no extractor for — an image, an archive, a binary. */
  | 'unsupported'
  /** A PDF that parsed and holds no text: a scan, and there is no OCR here. */
  | 'no_text_layer'
  /** The bytes claim a format and do not hold it. */
  | 'unreadable'
  /** Read fine, and there is nothing in it. */
  | 'empty';

export type Extraction =
  | { ok: true; document: ExtractedDocument }
  | { ok: false; failure: ExtractionFailure; why: string };

const failed = (failure: ExtractionFailure, why: string): Extraction => ({ ok: false, failure, why });

/**
 * The format, from the bytes.
 *
 * Never from the filename alone. On the path that matters the name is chosen by
 * whoever sent the message — `connectors/telegram/media.ts` rebuilds it from a
 * safe alphabet precisely because it is attacker-controlled — so an extension
 * is a hint about intent, not a fact about content. `.docx` is decided by the
 * archive actually containing `word/document.xml`, which also means a `.xlsx`
 * renamed to `.docx` is refused instead of half-read.
 */
export function sniffFormat(bytes: Buffer): DocumentFormat | null {
  // The header is at byte 0 in a well-formed file and a few bytes in when a
  // transfer prepended something; pdf.js itself scans a window, so this does.
  if (bytes.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    try {
      // Presence comes from the central directory. Sniffing must never inflate
      // the document once only to inflate it again during extraction.
      return hasZipEntry(bytes, 'word/document.xml') ? 'docx' : null;
    } catch {
      return null;
    }
  }
  return readableText(bytes) === null ? null : 'text';
}

export async function extractDocument(bytes: Buffer): Promise<Extraction> {
  const format = sniffFormat(bytes);
  if (format === null) {
    return failed('unsupported', 'non è testo né PDF né DOCX — serve un estrattore che non c\'è');
  }
  if (format === 'pdf') return extractPdf(bytes);
  if (format === 'docx') return extractDocx(bytes);

  const text = readableText(bytes);
  if (text === null) return failed('unsupported', 'non è testo leggibile');
  if (text.trim() === '') return failed('empty', 'vuoto');
  return { ok: true, document: { format: 'text', text, pages: [text], title: null, chars: text.length } };
}

async function extractPdf(bytes: Buffer): Promise<Extraction> {
  let pages: string[];
  let title: string | null = null;
  try {
    // Probed 2026-08-15: pdf.js refuses a Node `Buffer` outright — *"Please
    // provide binary data as `Uint8Array`, rather than `Buffer`"* — even though
    // `Buffer` extends `Uint8Array`. A fresh array, not a view: pdf.js may
    // detach the backing buffer, and the caller still owns these bytes.
    //
    // `verbosity: 0` keeps a malformed file from writing to the process's
    // stderr, which on a long-running gateway is a log nobody asked for.
    //
    // The option that is deliberately *not* here is `isEvalSupported: false`,
    // and its absence is checked rather than assumed: a PDF from Telegram is
    // tier-2 or tier-3 input (`03-threat-model.md` §4e), so eval-compiled font
    // programs would matter — and `grep` over the bundled pdf.js 6.1.200 finds
    // zero occurrences of either `isEvalSupported` or `new Function`. Upstream
    // removed that path, so there is nothing to switch off. If a future bump
    // brings it back, this is the line that has to change.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    const extracted = await extractText(pdf, { mergePages: false });
    pages = extracted.text;
    const meta = await getMeta(pdf);
    const declared = meta.info?.['Title'];
    title = typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : null;
  } catch (error) {
    return failed('unreadable', `PDF illeggibile: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = pages.join(PAGE_SEPARATOR);
  if (text.trim() === '') {
    // The measured shape, named for the owner rather than for us: pages exist,
    // characters do not. Everything this system could do about it — OCR — is a
    // decision nobody has taken, so the honest answer is the one that says
    // which document and why, not an empty string filed as evidence.
    return failed(
      'no_text_layer',
      `PDF senza testo selezionabile: ${pages.length} pagine di sola immagine, ` +
        'probabilmente una scansione — qui non c\'è OCR',
    );
  }
  return { ok: true, document: { format: 'pdf', text, pages, title, chars: text.length } };
}

function extractDocx(bytes: Buffer): Extraction {
  let sections: { label: string; text: string }[];
  try {
    sections = docxSections(bytes);
  } catch (error) {
    const why = error instanceof NotAZip ? error.message : String(error);
    return failed('unreadable', `DOCX illeggibile: ${why}`);
  }
  if (sections.length === 0) return failed('unreadable', 'DOCX senza word/document.xml');

  const text = sections.map((section) => section.text).join(PAGE_SEPARATOR);
  if (text.trim() === '') return failed('empty', 'DOCX senza testo');
  return {
    ok: true,
    document: { format: 'docx', text, pages: [text], sections, title: null, chars: text.length },
  };
}

const RELATION_LABELS = new Map([
  ['header', 'intestazione'],
  ['footer', 'piè di pagina'],
  ['footnotes', 'note a piè di pagina'],
  ['endnotes', 'note finali'],
  ['comments', 'commenti'],
]);

/**
 * Every text-bearing part linked by the main Word document, with a shared
 * decompression budget. The relation is provenance: a header is not silently
 * flattened into the body and a footnote remains named as a footnote.
 */
function docxSections(bytes: Buffer): { label: string; text: string }[] {
  const entries = listZipEntries(bytes);
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('word/document.xml')) return [];

  const parts: { name: string; label: string }[] = [
    { name: 'word/document.xml', label: 'corpo principale' },
  ];
  const rels = readZipEntry(bytes, 'word/_rels/document.xml.rels', 1024 * 1024, entries);
  if (rels !== null) {
    for (const tag of rels.toString('utf8').match(/<Relationship\b[^>]*>/g) ?? []) {
      const attrs = new Map(
        [...tag.matchAll(/\b([A-Za-z][\w:]*)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
      );
      if (attrs.get('TargetMode') === 'External') continue;
      const kind = attrs.get('Type')?.split('/').pop();
      const label = kind ? RELATION_LABELS.get(kind) : undefined;
      const target = attrs.get('Target');
      if (!label || !target) continue;

      const name = target.startsWith('/')
        ? posix.normalize(target).replace(/^\/+/, '')
        : posix.normalize(posix.join('word', target));
      if (!name.startsWith('word/') || !names.has(name) || parts.some((part) => part.name === name)) continue;
      parts.push({ name, label });
    }
  }

  let remaining = MAX_ZIP_ENTRY_BYTES;
  const sections: { label: string; text: string }[] = [];
  const labelCounts = new Map<string, number>();
  for (const part of parts) {
    const xml = readZipEntry(bytes, part.name, remaining, entries);
    if (xml === null) continue;
    remaining -= xml.length;
    const text = paragraphsFromWordXml(xml.toString('utf8'));
    if (text.trim() === '') continue;
    const count = (labelCounts.get(part.label) ?? 0) + 1;
    labelCounts.set(part.label, count);
    const duplicates = parts.filter((candidate) => candidate.label === part.label).length;
    sections.push({ label: duplicates > 1 ? `${part.label} ${count}` : part.label, text });
  }
  return sections;
}

/**
 * WordprocessingML down to plain text, without an XML parser.
 *
 * The shape is fixed by the format and is the whole of what carries text:
 * `<w:p>` is a paragraph, `<w:t>` inside it is a run of characters. Everything
 * else in the part — fonts, styles, revision ids — is presentation. A real
 * `.docx` written by a third-party writer is in
 * `core/documents/fixtures/relazione.docx`, so this is checked against someone
 * else's serialiser rather than against one we wrote to match.
 *
 * Not a full XML parse, deliberately: relations select each relevant part and
 * this reader walks its text runs in order. Tables lose presentation like PDF
 * tables do, while headers, footers and notes keep a named part in the result.
 */
export function paragraphsFromWordXml(xml: string): string {
  const bodyAt = xml.indexOf('<w:body');
  const body = bodyAt === -1 ? xml : xml.slice(bodyAt);
  // One pass in document order, because the three things that produce
  // characters are siblings: a `<w:br/>` is a line the author asked for and a
  // `<w:tab/>` separates table cells often enough that dropping it would join
  // two numbers into one. Collecting `<w:t>` alone and putting the breaks back
  // afterwards would put them in the wrong places.
  const RUN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(br|tab)\b[^>]*\/>/g;
  return body
    .split(/<\/w:p>/)
    .map((paragraph) =>
      [...paragraph.matchAll(RUN)]
        .map((match) =>
          match[1] !== undefined ? decodeXmlEntities(match[1]) : match[2] === 'tab' ? '\t' : '\n',
        )
        .join('')
        .replace(/\s+$/, ''),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // Last, or an escaped `&amp;lt;` would decode twice.
    .replace(/&amp;/g, '&');
}

/**
 * utf-8 or nothing — the test the vault has always applied, moved here so the
 * three formats are decided in one place instead of two.
 *
 * A NUL byte in the first block is the practical test for binary; a field of
 * replacement characters means the decode was lossy, and a handful in a long
 * file is normal.
 */
export function readableText(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  const text = bytes.toString('utf8');
  const replacements = (text.match(/�/g) ?? []).length;
  if (replacements > Math.max(4, text.length / 1000)) return null;
  return text;
}
