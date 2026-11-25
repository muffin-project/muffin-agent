import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const files = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();

function workflow(path: string): string {
  return readFileSync(join(WORKFLOWS, path), 'utf8');
}

function pullRequestBlock(text: string): string | null {
  const match = text.match(/^ {2}pull_request:\s*\n([\s\S]*?)(?=^ {2}[a-zA-Z_]+:\s*$)/m);
  return match?.[1] ?? null;
}

describe('source-public workflow invariants', () => {
  it.each(files)(
    '%s does not hide a required PR check behind trigger-level path filters',
    (file) => {
      const block = pullRequestBlock(workflow(file));
      if (block === null) return;
      expect(block).not.toMatch(/^ {4}paths(?:-ignore)?:/m);
    },
  );

  it.each(files)('%s pins first-party checkout/setup actions to immutable commit SHAs', (file) => {
    const refs = [
      ...workflow(file).matchAll(/uses:\s+(actions\/(?:checkout|setup-node)@([^\s#]+))/g),
    ];
    for (const [, full, ref] of refs) {
      expect(full).toBeDefined();
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('runs DCO before the expensive verification job', () => {
    const ci = workflow('ci.yml');
    expect(ci).toContain('\n  dco:\n');
    expect(ci).toMatch(/\n {2}verifica:\n {4}needs: dco\n/);
    expect(ci).toContain('scripts/check-dco.ts');
  });
});

describe('merge queue readiness', () => {
  const required = ['ci.yml', 'collegamenti.yml', 'install.yml', 'strumenti.yml'];

  it.each(required)('%s reports its required check on merge queue groups', (file) => {
    const text = workflow(file);
    const match = text.match(/^ {2}merge_group:\s*\n([\s\S]*?)(?=^ {2}[a-zA-Z_]+:\s*$)/m);
    expect(match).not.toBeNull();
    expect(match?.[1]).toContain('types: [checks_requested]');
    expect(match?.[1]).not.toMatch(/^ {4}(?:paths|branches)(?:-ignore)?:/m);
  });

  it.each(required)(
    '%s never reads a pull_request SHA without the merge_group fallback',
    (file) => {
      for (const line of workflow(file).split('\n')) {
        if (/github\.event\.pull_request\.(?:base|head)\.sha/.test(line))
          expect(line).toMatch(/github\.event\.merge_group\.(?:base|head)_sha/);
      }
    },
  );

  it('checks DCO on queue groups with read access to check runs', () => {
    const ci = workflow('ci.yml');
    expect(ci).toContain("if: github.event_name == 'merge_group'");
    expect(ci).toContain('scripts/check-dco.ts --merge-group "$BASE_SHA" "$HEAD_SHA"');
    expect(ci).toMatch(
      /\n {2}dco:\n(?: {4}.*\n)*? {4}permissions:\n {6}contents: read\n {6}checks: read\n/,
    );
  });
});
