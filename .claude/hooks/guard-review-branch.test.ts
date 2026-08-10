import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The guard that stops a commit landing in a PR under review.
 *
 * It shipped without this file, in the slice that codifies "a guard arrives
 * with the test that fails without its wiring" — and the review that caught the
 * omission also found three ways past the guard in one pass, which is precisely
 * what these cases would have caught. The most embarrassing of the three:
 * `git commit -m "document the --amend flag"` disarmed it, because the
 * exemption was tested against the whole command including the message, in a
 * repository whose commit messages are prose about git practice.
 *
 * The hook reads its branch from `git rev-parse` in its own cwd, so each case
 * runs against a throwaway repository parked on a chosen branch. That is the
 * only way to exercise the decision it actually makes.
 */

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'guard-review-branch.mjs');

let repo: string | undefined;
function repoOn(branch: string): string {
  if (!repo) {
    repo = execFileSync('mktemp', ['-d']).toString().trim();
    const git = (...a: string[]) => execFileSync('git', ['-C', repo!, ...a], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'root');
  }
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-B', branch], { stdio: 'pipe' });
  return repo;
}

/** 2 = refused, 0 = allowed through. */
function guard(command: string, branch: string): number {
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      cwd: repoOn(branch),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MUFFIN_PR_OK: '' },
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

describe('guard-review-branch', () => {
  describe('on a review branch, it refuses', () => {
    it.each([
      'git commit -m x',
      // The message is payload. This one passed before, and this repo writes
      // commit messages about git.
      'git commit -m "document the --amend flag"',
      "git commit -m 'nota su --amend'",
      // git's own flags carry values; consuming the flag but not its argument
      // let the two most script-like forms through untouched.
      'git -C /elsewhere commit -m x',
      'git -c user.name=x commit -m y',
      'git -c a=b -c c=d commit -m z',
      'git commit',
    ])('%s', (cmd) => {
      expect(guard(cmd, 'pr4-sicurezza')).toBe(2);
    });
  });

  describe('on a review branch, it lets through', () => {
    it.each([
      // Both name a commit deliberately: that is the way forward the refusal
      // message itself points at.
      'git commit --amend --no-edit',
      'git cherry-pick -x abc123',
      'git rebase pr3-persona',
      'git push origin pr4-sicurezza',
      'git status',
      'npm test',
      'MUFFIN_PR_OK=1 git commit -m x',
    ])('%s', (cmd) => {
      expect(guard(cmd, 'pr4-sicurezza')).toBe(0);
    });
  });

  it('says nothing on a working branch', () => {
    expect(guard('git commit -m x', 'claude/whatever')).toBe(0);
    expect(guard('git commit -m x', 'main')).toBe(0);
  });

  it('carries the way out in its refusal, not just the refusal', () => {
    let stderr = '';
    try {
      execFileSync('node', [HOOK], {
        input: JSON.stringify({ tool_input: { command: 'git commit -m x' } }),
        cwd: repoOn('pr1-workflow'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr ?? '');
    }
    // A guard that only says no makes the next person guess.
    expect(stderr).toMatch(/checkout/);
    expect(stderr).toMatch(/cherry-pick/);
    expect(stderr).toMatch(/MUFFIN_PR_OK=1/);
  });
});
