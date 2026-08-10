import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The handoff hook, exercised as Claude Code runs it.
 *
 * This file exists because of what its absence cost. The hook shipped with a
 * 10,000-character cap and no test, in the same change that added the practice
 * saying a cap arrives with the test that fails without it. The cap was applied
 * to the block instead of to the emitted string, so between 9,876 and 10,000
 * characters the output silently exceeded the limit — and past the limit Claude
 * Code replaces the whole thing with a preview and a file path, which is
 * precisely the "handoff became a pointer" failure the hook was written to stop.
 *
 * Running the real script through `execFileSync` rather than importing it: the
 * thing under test is a program Claude Code invokes, and an import would not
 * catch a broken shebang, a stray stdout write, or a non-zero exit.
 */

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'inject-state.mjs');
const MAX = 10_000;

/** A home where the hook can find a STATE.md with a block of exactly `n` chars. */
function homeWithBlock(n: number): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-hook-'));
  mkdirSync(join(home, 'docs', 'blueprint'), { recursive: true });
  mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
  cpSync(HOOK, join(home, '.claude', 'hooks', 'inject-state.mjs'));

  const head = '⭐ **START HERE**\n\n';
  const block = head + 'x'.repeat(Math.max(0, n - head.length));
  writeFileSync(join(home, 'docs', 'blueprint', 'STATE.md'), `# S\n\n${block}\n\n---\n\ncoda\n`);
  return home;
}

function run(home: string): { stdout: string; status: number } {
  const stdout = execFileSync('node', [join(home, '.claude', 'hooks', 'inject-state.mjs')], {
    input: '{}',
    encoding: 'utf8',
  });
  return { stdout, status: 0 };
}

const contextOf = (stdout: string): string =>
  JSON.parse(stdout).hookSpecificOutput.additionalContext as string;

describe('inject-state hook', () => {
  it('emits valid JSON with the right event name', () => {
    const { stdout } = run(homeWithBlock(200));
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(contextOf(stdout)).toContain('START HERE');
  });

  it.each([9_800, 9_875, 9_880, 9_950, 10_000, 10_400])(
    'never emits more than the cap, at a block of %i chars',
    (n) => {
      // The window that was broken was 9,876-10,000: wide enough to be reached
      // by a growing STATE.md, narrow enough that a single spot check missed it.
      const context = contextOf(run(homeWithBlock(n)).stdout);
      expect(context.length).toBeLessThanOrEqual(MAX);
    },
  );

  it('says so when it truncates, instead of looking complete', () => {
    const context = contextOf(run(homeWithBlock(10_400)).stdout);
    expect(context).toMatch(/blocco troncato/);
    expect(context.length).toBeLessThanOrEqual(MAX);
  });

  it('leaves a block that fits completely alone', () => {
    const context = contextOf(run(homeWithBlock(500)).stdout);
    expect(context).not.toMatch(/blocco troncato/);
  });

  it('stays silent rather than failing when there is nothing to inject', () => {
    // A session without its handoff is a bad day; a session that will not start
    // because a doc was mid-edit is worse. Every one of these exits 0, empty.
    const noState = mkdtempSync(join(tmpdir(), 'muffin-hook-bare-'));
    mkdirSync(join(noState, '.claude', 'hooks'), { recursive: true });
    cpSync(HOOK, join(noState, '.claude', 'hooks', 'inject-state.mjs'));
    expect(run(noState).stdout).toBe('');

    const noMarker = homeWithBlock(100);
    writeFileSync(join(noMarker, 'docs', 'blueprint', 'STATE.md'), '# S\n\nsenza stella\n\n---\n');
    expect(run(noMarker).stdout).toBe('');
  });
});
