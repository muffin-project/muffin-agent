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

  it('transitive include chain cannot arm hooks (BLOCKER1, canary=false)', () => {
    const { base, dir, scope } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ../inc1\n`);
    writeFileSync(join(dir, 'inc1'), '[include]\n\tpath = inc2\n');
    // The second-order target is outside `.git`, so only the recursive
    // include walk can know it is config. A single-level parse allows it.
    expect(() => fsWrite(scope, 'inc2', '[core]\n\thooksPath = r1hooks\n')).toThrow(/denied by the root/);
    expect(() => fsEdit(scope, 'inc1', 'path = inc2', 'path = inc2 # x')).toThrow(/denied by the root/);
    const canary = join(base, 'canary-r1');
    writeFileSync(join(dir, 'probe-r1.txt'), 'x\n');
    execSync(`git -C "${dir}" add .`);
    execSync(`git -C "${dir}" commit -m probe 2>&1`);
    expect(existsSync(canary)).toBe(false);
  });

  it('hooksPath inside an included config denies the hook dir (BLOCKER2, canary=false)', () => {
    const { base, dir, scope } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ../inch\n`);
    writeFileSync(join(dir, 'inch'), '[core]\n\thooksPath = r2hooks\n');
    expect(() => fsWrite(scope, 'r2hooks/pre-commit', '#!/bin/sh\necho PWNED\n')).toThrow(/denied by the root/);
    const canary = join(base, 'canary-r2');
    writeFileSync(join(dir, 'probe-r2.txt'), 'x\n');
    execSync(`git -C "${dir}" add .`);
    execSync(`git -C "${dir}" commit -m probe 2>&1`);
    expect(existsSync(canary)).toBe(false);
  });

  it('unquoted # / ; comments match Git, quoted values keep them (BLOCKER3, canary=false)', () => {
    const { base, dir, scope } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(
      cfg,
      `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ../inc3 # trailing comment\n` +
        `\tpath = ../incsemi;other\n[core]\n\thooksPath = r3hooks ; trailing\n`,
    );
    // Git strips the comment and honors the short path: the guard must deny
    // exactly that path, not the comment-carrying string.
    expect(() => fsWrite(scope, 'inc3', 'x')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'incsemi', 'x')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'r3hooks/pre-commit', 'x')).toThrow(/denied by the root/);
    // The un-stripped lookalikes are ordinary files and stay writable.
    expect(() => fsWrite(scope, 'unrelated.md', 'hi')).not.toThrow();
    const canary = join(base, 'canary-r3');
    writeFileSync(join(dir, 'probe-r3.txt'), 'x\n');
    execSync(`git -C "${dir}" add .`);
    execSync(`git -C "${dir}" commit -m probe 2>&1`);
    expect(existsSync(canary)).toBe(false);
  });

  it('quoted # / ; are data, and resolve like Git (BLOCKER3 quoting)', () => {
    const { scope, dir } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(
      cfg,
      `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = "../q#1"\n[core]\n\thooksPath = "../h;1" # c\n`,
    );
    // What Git honors (verified against `git config --includes`): the full
    // quoted value, comment excluded.
    expect(() => fsWrite(scope, 'q#1', 'x')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'h;1/pre-commit', 'x')).toThrow(/denied by the root/);
    // Prefixes without the quoted character are not the honored path.
    expect(() => fsWrite(scope, 'q', 'x')).not.toThrow();
    expect(() => fsWrite(scope, 'h', 'x')).not.toThrow();
    expect(readFileSync(join(dir, 'q'), 'utf8')).toBe('x');
  });

  it('nested include paths resolve against the naming file, like Git', () => {
    const { scope, dir } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ../a/inc1\n`);
    mkdirSync(join(dir, 'a', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'a', 'inc1'), '[include]\n\tpath = deep/n2\n');
    writeFileSync(join(dir, 'a', 'deep', 'n2'), '[marker]\n\tnk = nv\n');
    // `deep/n2` is relative to `a/`, not to the gitdir or the repo root: a
    // gitdir/root-only resolution misses it while Git reads it.
    expect(execSync(`git -C "${dir}" config --includes --get marker.nk 2>/dev/null`).toString().trim()).toBe('nv');
    expect(() => fsWrite(scope, 'a/deep/n2', 'evil')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'a/inc1', 'evil')).toThrow(/denied by the root/);
    // `deep/n2` at the repo root is denied too — deliberately: relative
    // include values resolve against the naming file *plus* the gitdir and
    // repo root as a fail-closed union, so the root-relative spelling is
    // covered even though Git honors the `a/`-relative one.
    expect(() => fsWrite(scope, 'deep/n2', 'x')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'a/deep/other', 'x')).not.toThrow();
  });

  it('guard agrees with git on what each include file contributes (oracle)', () => {
    const { scope, dir } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(
      cfg,
      `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ../o1 # comment\n\tpath = "../o2#x"\n`,
    );
    writeFileSync(join(dir, 'o1'), '[marker]\n\tk1 = v1\n');
    writeFileSync(join(dir, 'o2#x'), '[marker]\n\tk2 = v2\n');
    // Git's own view: both markers visible through the includes.
    expect(execSync(`git -C "${dir}" config --includes --get marker.k1 2>/dev/null`).toString().trim()).toBe('v1');
    expect(execSync(`git -C "${dir}" config --includes --get marker.k2 2>/dev/null`).toString().trim()).toBe('v2');
    // Guard's view: both files deny-write.
    expect(() => fsWrite(scope, 'o1', 'evil')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'o2#x', 'evil')).toThrow(/denied by the root/);
  });

  it('include cycles terminate with full coverage and stay precise', () => {
    const { scope, dir } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ../cy1\n`);
    writeFileSync(join(dir, 'cy1'), '[include]\n\tpath = cy2\n');
    writeFileSync(join(dir, 'cy2'), '[include]\n\tpath = cy1\n');
    // Completes (no hang): every reachable file is classified, so both
    // targets deny while an ordinary file stays writable.
    expect(() => fsWrite(scope, 'cy1', 'evil')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'cy2', 'evil')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'notes.md', 'ciao')).not.toThrow();
  });

  it('chains deeper than Git follows fail closed', () => {
    const { scope, dir } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ../d1\n`);
    for (let i = 1; i <= 12; i++) {
      writeFileSync(join(dir, `d${i}`), `[include]\n\tpath = d${i + 1}\n`);
    }
    // Git itself refuses this checkout (`maximum include depth (10)`), so no
    // reliable classification exists: even ordinary writes deny here.
    expect(() => fsWrite(scope, 'd12', 'evil')).toThrow(/denied by the root/);
    expect(() => fsWrite(scope, 'notes-deep.md', 'ciao')).toThrow(/denied by the root/);
  });

  it('unresolvable ~user indirection fails closed', () => {
    const { scope, dir } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ~nosuchuser_xyz_649/f\n`);
    // Git expands `~user` against another home this process cannot resolve:
    // deny rather than guess.
    expect(() => fsWrite(scope, 'notes-tilde.md', 'ciao')).toThrow(/denied by the root/);
  });

  it('unreadable present include target fails closed', () => {
    const { scope, dir } = repo();
    const cfg = join(dir, '.git', 'config');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ../noacc\n`);
    writeFileSync(join(dir, 'noacc'), '# locked\n');
    chmodSync(join(dir, 'noacc'), 0o000);
    let readable = true;
    try {
      readFileSync(join(dir, 'noacc'), 'utf8');
    } catch {
      readable = false;
    }
    try {
      if (!readable) {
        expect(() => fsWrite(scope, 'notes-acc.md', 'ciao')).toThrow(/denied by the root/);
        expect(() => fsWrite(scope, 'noacc', 'evil')).toThrow(/denied by the root/);
      }
    } finally {
      chmodSync(join(dir, 'noacc'), 0o644);
    }
  });

  it('worktree config.worktree and commondir scope deny from the worktree', () => {
    const { base, dir } = repo();
    const wt = join(base, 'wt');
    execSync(`git -C "${dir}" worktree add -q "${wt}" 2>&1`);
    try {
      const guards = mandatoryGuards(join(base, 'home'), wt, join(base, 'user'));
      const wtScope: FsScope = { root: wt, denyWrite: guards.denyWrite, denyRead: guards.denyRead };
      // Common config (via commondir) names an absolute include inside the
      // worktree; worktree-local config.worktree names an absolute hooks dir.
      const cfg = join(dir, '.git', 'config');
      writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[include]\n\tpath = ${wt}/wtinc-abs\n`);
      writeFileSync(join(wt, 'wtinc-abs'), '# common include\n');
      const wtGitdir = execSync(`git -C "${wt}" rev-parse --git-dir 2>/dev/null`).toString().trim();
      writeFileSync(join(wtGitdir, 'config.worktree'), `[core]\n\thooksPath = ${wt}/wthooks-abs\n`);
      mkdirSync(join(wt, 'wthooks-abs'), { recursive: true });
      expect(() => fsWrite(wtScope, 'wtinc-abs', 'evil')).toThrow(/denied by the root/);
      expect(() => fsWrite(wtScope, 'wthooks-abs/pre-commit', 'evil')).toThrow(/denied by the root/);
      expect(() => fsWrite(wtScope, 'notes-wt.md', 'ciao')).not.toThrow();
    } finally {
      execSync(`git -C "${dir}" worktree remove --force "${wt}" 2>&1`);
    }
  });
});
