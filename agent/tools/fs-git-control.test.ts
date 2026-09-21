import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mandatoryGuards } from '../../core/rot/guards.js';
import { fsEdit, fsRead, fsWrite, type FsScope } from './fs.js';

let roots: string[] = [];
afterEach(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
  roots = [];
});

function repo(): { base: string; dir: string; scope: FsScope } {
  const base = mkdtempSync(join(tmpdir(), 'muffin-gitctl-'));
  roots.push(base);
  const dir = join(base, 'repo');
  execSync(`git init -q "${dir}"`);
  execSync(`git -C "${dir}" config user.email t@t.t`);
  execSync(`git -C "${dir}" config user.name t`);
  writeFileSync(join(dir, 'file.txt'), 'hi\n');
  execSync(`git -C "${dir}" add file.txt`);
  execSync(`git -C "${dir}" commit -qm init`);
  const guards = mandatoryGuards(join(base, 'home'), dir, join(base, 'user'));
  return { base, dir, scope: { root: dir, denyWrite: guards.denyWrite, denyRead: guards.denyRead } };
}

function deniedMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected PathDenied, write went through');
}

describe('git execution-control metadata is deny-write (#646)', () => {
  it('denies .git/config via write and edit, and .git/hooks', () => {
    const { scope } = repo();
    expect(() => fsWrite(scope, '.git/config', 'evil')).toThrow(/denied by the root of trust/);
    expect(() => fsEdit(scope, '.git/config', '[core]', '[core]\n\thooksPath = x')).toThrow(
      /denied by the root of trust/,
    );
    expect(() => fsWrite(scope, '.git/hooks/pre-commit', 'evil')).toThrow(/denied by the root/);
  });

  it('reads of .git/config still work (writes only)', () => {
    const { scope } = repo();
    expect(() => fsRead(scope, '.git/config')).not.toThrow();
  });

  it('denies nested-repo, submodule and worktree control files structurally', () => {
    const { dir, scope } = repo();
    mkdirSync(join(dir, 'vendored', 'dep', '.git'), { recursive: true });
    writeFileSync(join(dir, 'vendored', 'dep', '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    expect(deniedMessage(() => fsEdit(scope, 'vendored/dep/.git/config', '[core]', '[core]\n\thooksPath = x'))).toMatch(
      /denied by the root/,
    );
    expect(() => fsWrite(scope, 'vendored/dep/.git/hooks/pre-commit', 'evil')).toThrow(/denied by the root/);

    // Submodule config lives under the superproject's .git/modules tree.
    mkdirSync(join(dir, '.git', 'modules', 'sub'), { recursive: true });
    writeFileSync(join(dir, '.git', 'modules', 'sub', 'config'), '[core]\n');
    expect(() => fsWrite(scope, '.git/modules/sub/config', 'evil')).toThrow(/denied by the root/);

    // Worktree pointer file and its gitdir.
    mkdirSync(join(dir, 'wt'), { recursive: true });
    writeFileSync(join(dir, 'wt', '.git'), 'gitdir: ../.git/worktrees/wt\n');
    expect(() => fsWrite(scope, 'wt/.git', 'evil')).toThrow(/denied by the root/);
    mkdirSync(join(dir, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(dir, '.git', 'worktrees', 'wt', 'config'), '[core]\n');
    expect(() => fsWrite(scope, '.git/worktrees/wt/config', 'evil')).toThrow(/denied by the root/);
  });

  it('denies configured include and hooksPath targets, but nothing else', () => {
    const { scope, dir } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(
      cfg,
      `${readFileSync(cfg, 'utf8')}\n[core]\n\thooksPath = .muffin-hook\n[include]\n\tpath = .muffin-include\n[includeIf "gitdir:/nowhere"]\n\tpath = .muffin-conditional\n`,
    );
    mkdirSync(join(dir, '.muffin-hook'), { recursive: true });
    writeFileSync(join(dir, '.muffin-include'), '# include original\n');
    writeFileSync(join(dir, '.muffin-conditional'), '# conditional\n');
    expect(() => fsWrite(scope, '.muffin-hook/pre-commit', 'evil')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, '.muffin-include', 'evil')).toThrow(/denied by the root/);
    expect(() => fsEdit(scope, '.muffin-include', '# include original', '# evil')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, '.muffin-conditional', 'evil')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'other.md', 'hi')).not.toThrow();
  });

  it('ordinary project editing keeps working', () => {
    const { scope } = repo();
    expect(() => fsWrite(scope, 'notes.md', 'ciao')).not.toThrow();
    expect(() => fsWrite(scope, 'src/app.ts', 'export {};\n')).not.toThrow();
    expect(() => fsWrite(scope, '.gitignore', '*.log\n')).not.toThrow();
    expect(() => fsWrite(scope, '.gitattributes', '*.txt text\n')).not.toThrow();
    expect(() => fsWrite(scope, '.gitmodules', '[submodule "x"]\n\tpath = x\n')).not.toThrow();
    // Lookalike segments are not git control metadata.
    expect(() => fsWrite(scope, '.git-worktree/file.txt', 'x')).not.toThrow();
    expect(() => fsWrite(scope, '.gitxhooks/file.txt', 'x')).not.toThrow();
  });

  it('a later host git operation does not execute after the fix (top-level and nested)', () => {
    for (const nested of [false, true]) {
      const { base, dir, scope } = repo();
      const targetRepo = nested ? join(dir, 'vendored', 'dep') : dir;
      const rel = nested ? 'vendored/dep/.git/config' : '.git/config';
      if (nested) {
        execSync(`git init -q "${targetRepo}"`);
        execSync(`git -C "${targetRepo}" config user.email t@t.t`);
        execSync(`git -C "${targetRepo}" config user.name t`);
      }
      const canary = join(base, `canary-${nested ? 'nested' : 'top'}`);
      const hookDir = join(nested ? targetRepo : dir, '.muffin-hook');
      mkdirSync(hookDir, { recursive: true });
      const hook = join(hookDir, 'pre-commit');
      // Payload alone is an ordinary workspace write and stays allowed — it
      // is inert without the config mutation, which is what must be refused.
      fsWrite(scope, nested ? 'vendored/dep/.muffin-hook/pre-commit' : '.muffin-hook/pre-commit', `#!/bin/sh\necho PWNED > ${canary}\n`);
      chmodSync(hook, 0o755);
      const before = readFileSync(join(targetRepo, '.git', 'config'), 'utf8');
      expect(() => fsEdit(scope, rel, '[core]', '[core]\n\thooksPath = .muffin-hook')).toThrow(
        /denied by the root/,
      );
      expect(readFileSync(join(targetRepo, '.git', 'config'), 'utf8')).toBe(before);
      writeFileSync(join(targetRepo, `probe-${nested ? 'n' : 't'}.txt`), 'x\n');
      execSync(`git -C "${targetRepo}" add .`);
      execSync(`git -C "${targetRepo}" commit -m probe 2>&1`);
      expect(existsSync(canary)).toBe(false);
    }
  });
});
