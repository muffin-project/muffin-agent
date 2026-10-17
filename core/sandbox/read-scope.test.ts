import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReadScope,
  READ_DENY_ROOT,
  resolveReadRoot,
  rootSymlinkAliases,
  SYSTEM_READ_PATHS_DARWIN,
  SYSTEM_READ_PATHS_LINUX,
  symlinkAncestors,
} from './read-scope.js';

/**
 * Pure unit tests — no sandbox, no gate, runs on every platform. The live
 * proof that the scope confines is `confine-sola-lettura.test.ts`; this file
 * pins the construction so a typo'd key or a dropped field fails fast here
 * instead of as a silent widening (the `denyWriteTypo` class
 * `core/sandbox/executor.ts` documents for srt's silent unknown-key rule).
 */
describe('buildReadScope', () => {
  it('denies the root and allows the call roots plus the platform system paths', () => {
    const scope = buildReadScope(['/tmp/workspace-x'], 'darwin');
    expect(scope.denyRead).toEqual([READ_DENY_ROOT]);
    expect(scope.allowRead).toContain('/tmp/workspace-x');
    for (const system of SYSTEM_READ_PATHS_DARWIN) {
      expect(scope.allowRead, `missing system path ${system}`).toContain(system);
    }
  });

  it('uses the Linux system list on Linux', () => {
    const scope = buildReadScope(['/work'], 'linux');
    for (const system of SYSTEM_READ_PATHS_LINUX) {
      expect(scope.allowRead, `missing system path ${system}`).toContain(system);
    }
    expect(scope.allowRead).not.toContain('/System');
  });

  it('never allows the home, however the roots read', () => {
    const scope = buildReadScope(['/work', '/tmp/scratch-x'], 'darwin');
    expect(scope.allowRead).not.toContain('/Users');
    expect(scope.allowRead).not.toContain('/home');
    expect(scope.allowRead).not.toContain('/root');
  });

  it('drops relative paths instead of letting srt resolve them against its own cwd', () => {
    const scope = buildReadScope(['relative/path', '/abs'], 'darwin');
    expect(scope.allowRead).toContain('/abs');
    expect(scope.allowRead.some((p) => p.includes('relative'))).toBe(false);
  });

  it('dedupes roots that resolve to the same inode', () => {
    const scope = buildReadScope(['/', '/'], 'linux');
    expect(scope.allowRead.filter((p) => p === '/')).toHaveLength(1);
  });

  it('resolves a symlinked root to its target before delegation', () => {
    const base = mkdtempSync(join(tmpdir(), 'muffin-read-scope-'));
    const target = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link);
    // Resolved spelling: on macOS tmpdir() itself sits under the
    // /var -> /private/var symlink, so compare against the real path.
    const resolved = realpathSync(target);
    expect(resolveReadRoot(link)).toBe(resolved);
    const scope = buildReadScope([link], 'darwin');
    expect(scope.allowRead).toContain(resolved);
    // The lexical spelling stays as a traversable alias (link inode only),
    // so commands spelling paths through the link resolve instead of dying.
    expect(scope.allowRead).toContain(link);
  });

  it('lists the lexical symlinked ancestors of a root, deepest first', () => {
    const base = mkdtempSync(join(tmpdir(), 'muffin-read-scope-'));
    const mid = join(base, 'mid');
    const leaf = join(base, 'mid', 'leaf');
    mkdirSync(leaf, { recursive: true });
    symlinkSync(mid, join(base, 'mid-link'));
    // The link itself is an ancestor only through its own spelling; the raw
    // chain under it has no symlinked ancestors here beyond tmpdir()'s own.
    expect(symlinkAncestors(leaf)).not.toContain(leaf);
    const viaLink = symlinkAncestors(join(base, 'mid-link', 'leaf'));
    expect(viaLink).toContain(join(base, 'mid-link'));
  });

  it('derives root aliases only for links whose target holds allowed content', () => {
    // /etc -> /private/etc is traversable when /private/etc is allowed…
    const withEtc = rootSymlinkAliases(['/private/etc', '/bin']);
    if (realpathSync('/etc') === '/private/etc') {
      expect(withEtc).toContain('/etc');
    }
    // …while a link whose target holds nothing allowed contributes nothing.
    expect(rootSymlinkAliases(['/nonexistent-allowed-xyz'])).toEqual([]);
  });
});
