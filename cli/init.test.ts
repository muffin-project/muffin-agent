import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isSameOrNestedPath, resolveLocalHome } from './init.js';

/**
 * The `--local` guard (M5-BIS A9), in isolation from the CLI around it: a
 * throwaway rehearsal home must never be able to land on, or under, the real
 * one — checked through symlinks and through directories that do not exist
 * yet, since the whole point of `--local` is a directory `muffin init` is
 * about to create.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('resolveLocalHome', () => {
  it('defaults to ~/.muffin-local when no directory is given', () => {
    expect(resolveLocalHome(undefined)).toBe(join(homedir(), '.muffin-local'));
  });

  it('resolves an explicit directory relative to the cwd', () => {
    expect(resolveLocalHome('some/relative/dir')).toBe(resolve('some/relative/dir'));
  });

  it('leaves an explicit absolute directory as-is', () => {
    expect(resolveLocalHome('/tmp/whatever-local-home')).toBe(resolve('/tmp/whatever-local-home'));
  });
});

describe('isSameOrNestedPath', () => {
  it('is true for the identical directory', () => {
    const base = scratchDir('muffin-init-guard-same-');
    expect(isSameOrNestedPath(base, base)).toBe(true);
  });

  it('is true for a directory nested several levels deep that does not exist yet', () => {
    const base = scratchDir('muffin-init-guard-base-');
    const candidate = join(base, 'a', 'b', 'c'); // none of a/b/c exist
    expect(isSameOrNestedPath(candidate, base)).toBe(true);
  });

  it('is false for an unrelated sibling directory', () => {
    const base = scratchDir('muffin-init-guard-base2-');
    const sibling = scratchDir('muffin-init-guard-sibling-');
    expect(isSameOrNestedPath(sibling, base)).toBe(false);
    expect(isSameOrNestedPath(join(sibling, 'nested', 'deeper'), base)).toBe(false);
  });

  it('follows a symlink to the real target before comparing — a link cannot disguise nesting', () => {
    const base = scratchDir('muffin-init-guard-real-');
    const outside = scratchDir('muffin-init-guard-outside-');
    const link = join(outside, 'looks-unrelated');
    symlinkSync(base, link, 'dir');
    // The string `link` shares no prefix with `base` at all — only realpath
    // resolution reveals that it names the same directory, or a directory
    // that will sit inside it once created.
    expect(isSameOrNestedPath(link, base)).toBe(true);
    expect(isSameOrNestedPath(join(link, 'not-yet-created'), base)).toBe(true);
  });

  it('a symlink elsewhere that merely resembles the base by name is not nested', () => {
    const base = scratchDir('muffin-init-guard-real2-');
    const decoyTarget = scratchDir('muffin-init-guard-decoy-target-');
    const outside = scratchDir('muffin-init-guard-outside2-');
    const link = join(outside, 'also-looks-unrelated');
    symlinkSync(decoyTarget, link, 'dir');
    expect(isSameOrNestedPath(link, base)).toBe(false);
  });
});
