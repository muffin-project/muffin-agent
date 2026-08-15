import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPdf, pagesWithoutText } from './fixtures/pdf.js';
import { extractDocument, paragraphsFromWordXml, sniffFormat } from './extract.js';
import { NotAZip, readZipEntry } from './zip.js';

/**
 * The defect this file exists to prevent is not "PDFs are not supported". It is
 * the two ways a document can *look* acquired and not be:
 *
 *  - **cut on the way in** — page one indexed, seventy-nine dropped, and
 *    nothing anywhere saying so. `M5-BIS.md` C7 was `BLOCKER — nessun parser`;
 *    the failure that replaces a missing parser with a bad one is worse,
 *    because the row would read `READY`.
 *  - **empty and called success** — a scanned PDF parses, reports its pages,
 *    and yields the empty string. Measured on unpdf 1.8.1 (2026-08-15):
 *    `{ totalPages: 2, text: ["", ""] }`. An extractor that returns that as
 *    text records the document as read.
 *
 * Every PDF here is built byte by byte and parsed by the real pdf.js
 * (`fixtures/pdf.ts`); the DOCX is a real file written by a third-party
 * serialiser. A test that stubs the parser proves that the stub works.
 */

const CONTRACT = buildPdf({
  title: 'Contratto di locazione',
  pages: [
    ['Contratto di locazione', 'Le parti convengono quanto segue.'],
    ['Canone mensile 850 euro', 'Da versare entro il cinque del mese.'],
    ['Recesso con preavviso di tre mesi'],
  ],
});

describe('extracting a document', () => {
  it('returns every page of a PDF, not the first one', async () => {
    const result = await extractDocument(CONTRACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.document.format).toBe('pdf');
    expect(result.document.pages).toHaveLength(3);
    // The last page in particular: a truncating extractor passes every check
    // that only looks at the beginning.
    expect(result.document.pages[2]).toContain('preavviso di tre mesi');
    expect(result.document.text).toContain('Canone mensile 850 euro');
    expect(result.document.chars).toBe(result.document.text.length);
  });

  it('keeps the title the document declares', async () => {
    const result = await extractDocument(CONTRACT);
    expect(result.ok && result.document.title).toBe('Contratto di locazione');
  });

  it('refuses a PDF with no text layer instead of returning the empty string', async () => {
    // A scan. It parses, it has pages, and it has no characters — the exact
    // shape that would be filed as "document acquired, nothing in it".
    const result = await extractDocument(pagesWithoutText(4));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('no_text_layer');
    // The owner has to be able to act on it: which document, why, and that the
    // remedy this system does not have is OCR.
    expect(result.why).toContain('4 pagine');
    expect(result.why).toContain('OCR');
  });

  it('names a corrupt PDF as unreadable rather than as empty', async () => {
    const truncated = CONTRACT.subarray(0, 120);
    const result = await extractDocument(truncated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('unreadable');
    expect(result.why).toContain('PDF');
  });

  it('reads a real DOCX written by another program', async () => {
    // Produced by macOS `textutil -convert docx` — someone else's OOXML writer,
    // so the reader is checked against a serialiser we did not write to match.
    const bytes = readFileSync(join(import.meta.dirname, 'fixtures', 'relazione.docx'));
    const result = await extractDocument(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.document.format).toBe('docx');
    expect(result.document.text).toContain('Relazione trimestrale');
    expect(result.document.text).toContain('Ricavi 2026: 1.240.000 euro');
    expect(result.document.text).toContain('margine');
  });

  it('reads plain text and markdown unchanged', async () => {
    const result = await extractDocument(Buffer.from('# Nota\n\nil ritrovo è al porto\n'));
    expect(result.ok && result.document.format).toBe('text');
    expect(result.ok && result.document.text).toContain('il ritrovo è al porto');
  });

  it('says so when there is nothing to read', async () => {
    const empty = await extractDocument(Buffer.from('   \n\n'));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.failure).toBe('empty');

    const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(64)]);
    const image = await extractDocument(png);
    expect(image.ok).toBe(false);
    if (!image.ok) expect(image.failure).toBe('unsupported');
  });
});

describe('deciding what a file is', () => {
  it('reads the bytes, not the name', () => {
    // The name arrives from whoever sent the message. `media.ts` rebuilds it
    // from a safe alphabet for exactly that reason, so an extension is a hint
    // about intent and never a fact about content.
    expect(sniffFormat(CONTRACT)).toBe('pdf');
    expect(sniffFormat(Buffer.from('ciao'))).toBe('text');
    expect(sniffFormat(Buffer.from([0x00, 0x01, 0x02, 0x00]))).toBeNull();
  });

  it('calls a ZIP a DOCX only when it holds a Word document', () => {
    // A `.xlsx` renamed to `.docx` is a ZIP with the same magic bytes. Deciding
    // by extension would half-read it; deciding by content refuses it.
    const notWord = zipOf('xl/workbook.xml', '<workbook/>');
    expect(sniffFormat(notWord)).toBeNull();
    expect(sniffFormat(zipOf('word/document.xml', '<w:document/>'))).toBe('docx');
  });
});

describe('the ZIP reader', () => {
  it('finds one entry and leaves the rest alone', () => {
    const bytes = readFileSync(join(import.meta.dirname, 'fixtures', 'relazione.docx'));
    expect(readZipEntry(bytes, 'word/document.xml')?.toString('utf8')).toContain('<w:body');
    expect(readZipEntry(bytes, 'word/inesistente.xml')).toBeNull();
  });

  it('refuses bytes that are not a ZIP, rather than slicing them', () => {
    expect(() => readZipEntry(Buffer.from('non è un archivio'), 'word/document.xml')).toThrow(NotAZip);
  });
});

describe('WordprocessingML to text', () => {
  it('keeps paragraphs apart and puts breaks and tabs where they were', () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Voce</w:t></w:r><w:tab/><w:r><w:t>Importo</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>prima riga</w:t></w:r><w:br/><w:r><w:t>seconda riga</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">a &amp; b &lt;c&gt;</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    expect(paragraphsFromWordXml(xml)).toBe('Voce\tImporto\nprima riga\nseconda riga\na & b <c>');
  });

  it('joins the runs Word splits a word into', () => {
    // Word breaks a single word across runs whenever formatting or a spell-check
    // marker changes mid-word. Joining with anything between them would produce
    // "loca zione" in the indexed text.
    const xml =
      '<w:document><w:body><w:p>' +
      '<w:r><w:t xml:space="preserve">loca</w:t></w:r><w:r><w:t>zione</w:t></w:r>' +
      '</w:p></w:body></w:document>';
    expect(paragraphsFromWordXml(xml)).toBe('locazione');
  });
});

/** A one-entry ZIP, stored uncompressed — enough to be sniffed. */
function zipOf(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const data = Buffer.from(content, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0, 10); // stored
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const centralAt = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralAt, 16);

  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}
