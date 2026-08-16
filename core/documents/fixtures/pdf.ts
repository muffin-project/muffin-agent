/**
 * Real PDFs, built byte by byte, for the tests.
 *
 * Not a stub and not a mock: what comes out of here is a file with a header,
 * indirect objects, content streams, a cross-reference table with correct byte
 * offsets and a trailer — the thing pdf.js actually parses. The alternative
 * everybody reaches for is a fake extractor that returns a fixed string, and it
 * proves nothing: the whole question is whether a **PDF** turns into text, so a
 * test that never produces one is testing its own imagination.
 *
 * `pagesWithoutText` is the other half, and it is the reason this file exists at
 * all rather than a single committed sample. A scanned document is a PDF whose
 * pages carry no text-showing operators; that is a byte-level property, it
 * cannot be simulated by emptying a string, and it is the failure this slice
 * has to make explicit.
 *
 * Lives under `fixtures/` so it is excluded from the shipped build
 * (`tsconfig.build.json`), next to `core/mcp/fixtures/`.
 */

export type PdfSpec = {
  /** One entry per page; each entry is the lines printed on that page. */
  pages: string[][];
  /** Written into the document information dictionary when given. */
  title?: string;
};

/** A PDF with a text layer: every line becomes a `Tj` in the page's content stream. */
export function buildPdf(spec: PdfSpec): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body); // push returns the new length = 1-based number

  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contents = spec.pages.map((lines) => {
    const ops =
      lines.length === 0
        ? ''
        : `BT /F1 12 Tf 72 720 Td 14 TL\n${lines.map((l) => `(${escapeText(l)}) Tj T*`).join('\n')}\nET`;
    return add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
  });

  // The page tree object is written after the pages, so its number has to be
  // known before they can point at it as their parent.
  const pagesNumber = objects.length + spec.pages.length + 1;
  const pages = contents.map((content) =>
    add(
      `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    ),
  );
  const tree = add(
    `<< /Type /Pages /Kids [${pages.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  const catalog = add(`<< /Type /Catalog /Pages ${tree} 0 R >>`);
  const info = spec.title === undefined ? null : add(`<< /Title (${escapeText(spec.title)}) >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }

  const startxref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R` +
    `${info === null ? '' : ` /Info ${info} 0 R`} >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;

  // latin1 throughout: PDF offsets are byte offsets, and a multi-byte character
  // counted as one would put every entry in the xref table one short.
  return Buffer.from(out, 'latin1');
}

/**
 * A PDF that parses, reports its pages, and holds no text — the shape of a
 * scan, and the one an extractor reports as success while returning nothing.
 */
export function pagesWithoutText(count: number): Buffer {
  return buildPdf({ pages: Array.from({ length: count }, () => []) });
}

/** `(`, `)` and `\` end or escape a PDF string literal. */
function escapeText(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}
