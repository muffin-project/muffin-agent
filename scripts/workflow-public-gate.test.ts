import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();

function workflow(path: string): string {
  return readFileSync(join(WORKFLOWS, path), 'utf8');
}

function pullRequestBlock(text: string): string | null {
  const match = text.match(/^  pull_request:\s*\n([\s\S]*?)(?=^  [a-zA-Z_]+:\s*$)/m);
  return match?.[1] ?? null;
}

describe('source-public workflow invariants', () => {
  it.each(files)('%s does not hide a required PR check behind trigger-level path filters', (file) => {
    const block = pullRequestBlock(workflow(file));
    if (block === null) return;
    expect(block).not.toMatch(/^    paths(?:-ignore)?:/m);
  });

  it.each(files)('%s pins first-party checkout/setup actions to immutable commit SHAs', (file) => {
    const refs = [...workflow(file).matchAll(/uses:\s+(actions\/(?:checkout|setup-node)@([^\s#]+))/g)];
    for (const [, full, ref] of refs) {
      expect(full).toBeDefined();
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('runs DCO before the expensive verification job', () => {
    const ci = workflow('ci.yml');
    expect(ci).toContain('\n  dco:\n');
    expect(ci).toMatch(/\n  verifica:\n    needs: dco\n/);
    expect(ci).toContain('scripts/check-dco.ts');
  });
});
