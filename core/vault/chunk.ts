/**
 * Structural chunking with carried context (ADR-0024).
 *
 * Split on headings first, paragraphs when a section is too long, words when a
 * paragraph is. Three levels, most meaningful to most brutal, never the reverse.
 *
 * The decision this file encodes is that **semantic chunking is not the answer
 * here**, which is worth writing down because it is the intuitive choice and it
 * is wrong for this corpus. Splitting on embedding-similarity between adjacent
 * sentences wins on documents assembled from unrelated pieces and loses on
 * documents written as one thing — which is what a note is. On natural corpora
 * the canonical semantic chunker measures *below* plain fixed-size, and in the
 * widest comparison available the winners are structural, never
 * embedding-breakpoint. Sources are in ADR-0024; the short version is that the
 * boundary a person already put in their document beats one inferred from
 * cosine distance.
 *
 * The other half matters as much: **every chunk carries where it came from**.
 * A chunk that says "he agreed to the March deadline" is nearly useless on its
 * own and fine as `note/clienti.md › Acme › Riunione 12 marzo`. This is the
 * deterministic, zero-LLM half of contextual retrieval, and it improves two
 * things at once — the vector, and the text the reranker reads.
 */

/** Target size. Comfortably under the ~2.5k-token cliff, above the point where a chunk stops being usable alone. */
const CHUNK_TARGET = 1200;
const CHUNK_MAX = 2000;

export type Chunk = {
  /** What gets embedded and indexed: the context line, then the text. */
  text: string;
  /** The text alone, without the prefix — for display, and for hashing content. */
  body: string;
  /** Heading breadcrumb at this point in the document, outermost first. */
  headings: string[];
};

type Section = { headings: string[]; body: string };

/**
 * `# Title` … `###### deep`, ATX style only.
 *
 * Setext headings (underlined with === or ---) are deliberately not handled:
 * they are rare in the tools that write these files, and the failure mode of
 * getting them wrong (a `---` frontmatter fence read as a heading) is worse
 * than the failure mode of ignoring them (one section instead of two).
 */
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Fenced code: headings inside it are code, not structure. */
const FENCE = /^\s*(```|~~~)/;

export function splitIntoSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let stack: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = (headings: string[]): void => {
    const body = buffer.join('\n').trim();
    if (body !== '') sections.push({ headings: [...headings], body });
    buffer = [];
  };

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (!match) {
      buffer.push(line);
      continue;
    }
    flush(stack);
    const depth = match[1]!.length;
    const title = match[2]!.trim();
    // Truncate the stack to this level, then push: `## B` after `# A` gives
    // [A, B]; a second `## C` gives [A, C], not [A, B, C].
    stack = [...stack.slice(0, depth - 1), title];
    // Fill any skipped level so the breadcrumb never has holes.
    while (stack.length < depth - 1) stack.splice(stack.length - 1, 0, '');
  }
  flush(stack);

  return sections;
}

/**
 * Frontmatter is metadata about the file, not content of it. Pulled out before
 * chunking so a YAML block does not become a chunk, and kept so the caller can
 * use a declared title in the context line.
 */
export function stripFrontmatter(text: string): { frontmatter: string | null; body: string } {
  if (!text.startsWith('---')) return { frontmatter: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: null, body: text };
  const after = text.indexOf('\n', end + 1);
  return {
    frontmatter: text.slice(4, end).trim(),
    // The blank line that conventionally follows the closing fence is part of
    // the separator, not of the document.
    body: after === -1 ? '' : text.slice(after + 1).replace(/^\s*\n/, ''),
  };
}

/** `title: Foo` out of a YAML block, without a YAML parser for one field. */
export function titleFromFrontmatter(frontmatter: string | null): string | null {
  if (!frontmatter) return null;
  const match = /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter);
  return match?.[1]?.trim() || null;
}

export type ChunkOptions = {
  /** Path shown in the context line. Usually the vault-relative path. */
  source: string;
  /** Overrides the filename in the context line when the document declares one. */
  title?: string | undefined;
  /**
   * A breadcrumb the caller already knows and the text cannot state — a PDF
   * page number, say. Prepended to whatever headings the text declares, so a
   * chunk from page 4 reads `[Contratto (inbox/x.pdf) › p. 4]` and a recalled
   * fragment can be checked against the page it came from. Without it a PDF's
   * chunks are all labelled with the same filename and nothing else, which is
   * a citation that cannot be followed.
   */
  headings?: readonly string[] | undefined;
  target?: number;
  max?: number;
};

export function chunkDocument(text: string, options: ChunkOptions): Chunk[] {
  const target = options.target ?? CHUNK_TARGET;
  const max = options.max ?? CHUNK_MAX;
  const { frontmatter, body } = stripFrontmatter(text);
  const title = options.title ?? titleFromFrontmatter(frontmatter) ?? undefined;
  const outer = options.headings ?? [];

  const chunks: Chunk[] = [];
  for (const section of splitIntoSections(body)) {
    const headings = [...outer, ...section.headings];
    for (const piece of splitToSize(section.body, target, max)) {
      chunks.push({
        body: piece,
        headings,
        text: `${contextLine(options.source, title, headings)}\n\n${piece}`,
      });
    }
  }
  return chunks;
}

/**
 * The line every chunk carries. Kept to one line on purpose: it is prepended to
 * every chunk, so its cost is paid once per chunk in every embedding, every
 * index entry and every prompt that recalls it.
 */
export function contextLine(source: string, title: string | undefined, headings: string[]): string {
  const parts = [title ? `${title} (${source})` : source, ...headings.filter((h) => h !== '')];
  return `[${parts.join(' › ')}]`;
}

/**
 * Packs paragraphs up to `target`, splits anything still over `max`.
 *
 * No overlap, by decision: the controlled evidence is split between "no
 * measurable benefit, and it costs indexing" and "modest improvement", and
 * neither finds harm in leaving it out. With structural boundaries the cut
 * lands where the document already put one, which is the case where overlap
 * earns the least.
 */
export function splitToSize(text: string, target = CHUNK_TARGET, max = CHUNK_MAX): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '');
  const out: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim() !== '') out.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      flush();
      out.push(...hardSplit(paragraph, max));
      continue;
    }
    if (current !== '' && current.length + paragraph.length + 2 > target) flush();
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
  }
  flush();
  return out;
}

/** Last resort: break on the latest word boundary before the limit. */
function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    const at = space > max / 2 ? space : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== '') out.push(rest);
  return out;
}
