import { describe, expect, it } from 'vitest';
import {
  chunkDocument,
  contextLine,
  splitIntoSections,
  splitToSize,
  stripFrontmatter,
  titleFromFrontmatter,
} from './chunk.js';

const NOTE = `---
title: Clienti
tags: [lavoro]
---

# Clienti

Note generali sul lavoro con i clienti.

## Acme

Contratto firmato a marzo.

### Riunione 12 marzo

Ha accettato la scadenza di marzo.

## Beta

Ancora in trattativa.
`;

describe('structural chunking', () => {
  it('splits on headings and keeps the breadcrumb', () => {
    const chunks = chunkDocument(NOTE, { source: 'note/clienti.md' });
    const breadcrumbs = chunks.map((c) => c.headings.join(' › '));
    expect(breadcrumbs).toEqual([
      'Clienti',
      'Clienti › Acme',
      'Clienti › Acme › Riunione 12 marzo',
      'Clienti › Beta',
    ]);
  });

  it('carries the context into the indexed text, not just into metadata', () => {
    // The whole point: the embedder, FTS and the reranker all read `text`. A
    // context that only exists in a column helps none of them.
    const chunks = chunkDocument(NOTE, { source: 'note/clienti.md' });
    const meeting = chunks.find((c) => c.body.includes('scadenza di marzo'))!;
    expect(meeting.text).toContain('Clienti (note/clienti.md) › Clienti › Acme › Riunione 12 marzo');
    expect(meeting.text).toContain('Ha accettato la scadenza di marzo.');
    // "Ha accettato la scadenza" alone says nothing about who or what.
    expect(meeting.body).not.toContain('Acme');
  });

  it('takes the title from frontmatter and keeps the frontmatter out of the content', () => {
    expect(titleFromFrontmatter(stripFrontmatter(NOTE).frontmatter)).toBe('Clienti');
    const chunks = chunkDocument(NOTE, { source: 'note/clienti.md' });
    expect(chunks.some((c) => c.body.includes('tags:'))).toBe(false);
  });

  it('replaces a sibling in the breadcrumb instead of nesting under it', () => {
    const sections = splitIntoSections('# A\n\n## B\n\ntesto b\n\n## C\n\ntesto c');
    expect(sections.map((s) => s.headings)).toEqual([['A', 'B'], ['A', 'C']]);
  });

  it('does not read a heading inside a code fence', () => {
    // A shell comment is not a section, and treating it as one splits a code
    // block down the middle.
    const sections = splitIntoSections('# Setup\n\n```sh\n# install\nnpm ci\n```\n\ncoda');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).toContain('npm ci');
  });

  it('does not read the frontmatter fence as a heading', () => {
    expect(stripFrontmatter(NOTE).body.startsWith('# Clienti')).toBe(true);
    expect(stripFrontmatter('nessun frontmatter').frontmatter).toBeNull();
  });

  it('splits a long section on paragraphs and a long paragraph on words', () => {
    const paragraph = 'parola '.repeat(400).trim(); // ~2800 chars, no blank lines
    const pieces = splitToSize(`${'testo breve.\n\n'.repeat(3)}${paragraph}`, 1200, 2000);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(2000);
    // Words survive: nothing is cut mid-token.
    expect(pieces.join(' ')).not.toMatch(/paro\s|\spla/);
  });

  it('leaves a document with no headings as plain paragraph packing', () => {
    const chunks = chunkDocument('primo paragrafo.\n\nsecondo paragrafo.', { source: 'a.txt' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headings).toEqual([]);
    expect(chunks[0]?.text.startsWith('[a.txt]')).toBe(true);
  });

  it('produces nothing from an empty document', () => {
    expect(chunkDocument('', { source: 'vuoto.md' })).toEqual([]);
    expect(chunkDocument('---\ntitle: x\n---\n', { source: 'solo-meta.md' })).toEqual([]);
  });

  it('builds a context line that reads as a location', () => {
    expect(contextLine('note/a.md', 'Titolo', ['Uno', 'Due'])).toBe('[Titolo (note/a.md) › Uno › Due]');
    expect(contextLine('note/a.md', undefined, [])).toBe('[note/a.md]');
  });
});
