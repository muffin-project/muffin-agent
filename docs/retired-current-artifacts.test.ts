import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A deleted current artifact must stay deleted from the *live* knowledge graph.
 *
 * The architecture map was intentionally retired, but two live documents kept
 * telling fresh agents to read/regenerate it. The filesystem was right and the
 * prose was wrong. Git preserves the old artifact; current docs must not turn
 * historical machinery back into an instruction.
 *
 * This is deliberately a tiny retired-artifact guard rather than a generic
 * parser for every path-shaped code span in Markdown. A generic parser cannot
 * distinguish examples/templates (`docs/<x>.md`, glob paths, generated output)
 * from promises without inventing a second documentation language. Here the
 * retired identities are exact and the failure is exact: if either spelling
 * returns to live material, the test names the file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SELF = relative(REPO, fileURLToPath(import.meta.url));

const SKIP_DIR = new Set(['node_modules', 'dist', '.git', '.releases', '.codex']);
const ARCHIVED = [
  /^docs\/history\//,
  /^docs\/decisions\//,
  /^docs\/evidence\//,
];
const READABLE = /\.(?:md|ts|tsx|mjs|js|json|ya?ml)$/;

// Build the strings so this guard does not report itself as the stale reference.
const RETIRED = [
  { label: 'retired architecture-map path', needle: ['docs', 'derived', 'architecture-map'].join('/') },
  { label: 'retired architecture-map command', needle: ['mappa', 'regen'].join(':') },
] as const;

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name) || entry.name.startsWith('.DS')) continue;
    const absolute = join(dir, entry.name);
    const rel = relative(REPO, absolute);
    if (rel === '.claude/worktrees' || rel.startsWith('.claude/worktrees/')) continue;
    if (entry.isDirectory()) {
      files(absolute, out);
      continue;
    }
    if (!READABLE.test(rel) || ARCHIVED.some((r) => r.test(rel)) || rel === SELF) continue;
    out.push(rel);
  }
  return out;
}

describe('retired current artifacts', () => {
  it('do not reappear as instructions in the live repository corpus', () => {
    expect(existsSync(REPO)).toBe(true);
    const corpus = files(REPO);
    expect(corpus.length).toBeGreaterThan(100);

    const stale: string[] = [];
    for (const file of corpus) {
      const text = readFileSync(join(REPO, file), 'utf8');
      for (const retired of RETIRED) {
        if (text.includes(retired.needle)) stale.push(`${file}: ${retired.label}`);
      }
    }

    expect(stale).toEqual([]);
  });
});
