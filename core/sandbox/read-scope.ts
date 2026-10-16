import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The allow-scoped read surface for sandboxed shell commands (#645, slice
 * `read-scoped-workspace`).
 *
 * Until this slice, the read-only lane bound `--ro-bind / /` (Linux) or
 * `(allow file-read*)` (macOS Seatbelt) minus a finite `denyRead`: the whole
 * host was readable, and an `it.fails` canary in
 * `core/sandbox/confine-sola-lettura.test.ts` documented the exposure in
 * executable form. The compensation was ADR-0091 (`sys.shell` asks every
 * time) — which gates, but does not confine.
 *
 * What srt 0.0.71 (pinned) can actually express — measured in its dist, not
 * assumed from prose (`dist/sandbox/sandbox-config.js` `allowRead`,
 * `dist/sandbox/macos-sandbox-utils.js` `generateReadRules`,
 * `dist/sandbox/linux-sandbox-utils.js` `pushReadDenyDirMounts`): a broad
 * `denyRead` plus `allowRead` paths re-allowed *within* the denied region.
 * On macOS that is SBPL last-match-wins (`deny (subpath "/")`, re-allow the
 * literal root for traversal, re-allow each listed subpath, re-emit nested
 * denies last so they keep winning). On Linux a root deny expands to a
 * `--tmpfs` over each top-level child (except `/proc` `/dev` `/sys`, which
 * are remounted) with the allowed subtrees bound back over it. So the
 * enforceable shape is exactly this module: `denyRead: ['/']` plus an
 * explicit allow list of per-call roots and justified system paths. The
 * previous claim that "pinned srt has no read allowlist"
 * (`docs/architecture/SECURITY.md` §9.2) was stale the day it was written —
 * the schema field exists in the pinned dist — and this slice corrects it.
 */
export const READ_DENY_ROOT = '/';

/**
 * System paths a contained command may READ, per platform, in resolved
 * spelling. Justified entry by entry because each one re-opens host surface:
 *
 * - `/bin`, `/sbin` — the shell itself and the single-user coreutils
 *   (`sh`, `cat`, `ls`, `env`, …).
 * - `/usr` — the toolchain (`git`, `curl`, `env`, `xcrun` shims),
 *   `/usr/lib` and shared data (git-core fallback, locales, certificates).
 * - `/opt` — the package-manager toolchain prefix (Homebrew `bash`, `node`,
 *   `python3`, Cellar dylibs on macOS; hostedtoolcache on Linux CI).
 * - `/Library`, `/System` (macOS only) — the CLT/Apple frameworks data and
 *   the dyld shared cache: without them no spawned binary starts.
 * - `/Applications/Xcode.app` (macOS only) — the git exec-path on hosts
 *   with full Xcode (`git --exec-path` measured on the owner seat; CLT-only
 *   hosts do not need it and the entry matches nothing there). Application
 *   bundles, not owner data.
 * - `/lib`, `/lib64` (Linux only) — the loader and libc.
 * - `/private/etc` (macOS) / `/etc` (Linux) — `passwd`/`group`/`nsswitch`
 *   (whatever resolves `getpwuid` at startup), `hosts`, TLS bundles. On macOS
 *   the entry that works is the resolved spelling — never `/etc` (see
 *   `resolveReadRoot`) — and the lexical `/etc` link arrives via
 *   `rootSymlinkAliases`, link inode only.
 * - `/dev` — device nodes (`null`, `zero`, `urandom`, `tty`); the seatbelt
 *   base profile already pins the char-device reads, this re-allows them
 *   after the root deny.
 *
 * Deliberately absent: `$HOME` and `/home` (owner data — the point of the
 * slice), `/root`, `/private/tmp` and `/tmp` (shared temp outside the
 * session scratch; the legacy `/tmp/claude` dir in particular),
 * `/private/var` and `/var` (except the per-call scratch, which arrives via
 * `roots`), `/run` (service sockets), `/boot` `/srv` `/mnt` `/media`.
 * `/proc` and `/sys` (Linux) are not listed because srt never denies them —
 * they are remounted, and `/proc` is a fresh mount under PID-namespace
 * isolation, so only sandbox pids are visible.
 */
export const SYSTEM_READ_PATHS_DARWIN = [
  '/bin',
  '/sbin',
  '/usr',
  '/opt',
  '/Library',
  '/System',
  '/Applications/Xcode.app',
  '/private/etc',
  '/dev',
] as const;

export const SYSTEM_READ_PATHS_LINUX = [
  '/bin',
  '/sbin',
  '/usr',
  '/lib',
  '/lib64',
  '/opt',
  '/etc',
  '/dev',
] as const;

export function systemReadPaths(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'linux' ? SYSTEM_READ_PATHS_LINUX : SYSTEM_READ_PATHS_DARWIN;
}

export type ReadScope = {
  /** Always `[READ_DENY_ROOT]` today: reads are allow-scoped, not deny-listed. */
  denyRead: string[];
  /** Per-call roots (resolved) first, then the platform system paths. */
  allowRead: string[];
};

/**
 * One read-scope entry, resolved symlink-safe BEFORE delegation.
 *
 * srt normalises paths itself (`normalizePathForSandbox`), but with a
 * boundary check that keeps spellings like `/etc` unresolved while the
 * kernel matches the resolved vnode (`/private/etc`) — measured against the
 * pinned dist. Passing the resolved spelling ourselves keeps the allow rule
 * on the inode the sandbox will actually match. A relative path is dropped
 * (srt would resolve it against ITS OWN process cwd — the daemon's
 * directory, never the turn's workspace — so keeping it would allow the
 * wrong tree). A path that cannot be resolved is kept raw: srt skips
 * non-existent allows on Linux and matches nothing on macOS, which fails
 * the command loudly instead of widening anything.
 */
export function resolveReadRoot(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const stripped = path.replace(/\/+$/, '') || '/';
  try {
    return realpathSync(stripped);
  } catch {
    return stripped;
  }
}

/**
 * The lexical symlinked ancestors of a path — `/var` in
 * `/var/folders/…/scratch`, `/etc` in `/etc/hosts` — which must be readable
 * as link inodes for ANY spelling of the path to resolve.
 *
 * Measured on macOS 2026-10-16 with `sandbox-exec` by hand: with
 * `(deny file-read* (subpath "/"))`, allowing the resolved
 * `/private/var/folders/…/scratch` is NOT enough to `cat` it via its
 * `/var/…` spelling — resolving the `/var` symlink reads the link inode,
 * and that read is denied. Adding the lexical `(subpath "/var")` fixes it.
 * The widening is one inode, not a tree: past resolution nothing is
 * lexically under `/var` any more (everything reads `/private/var/…`),
 * so the alias allows the link — whose content is the public system layout
 * — and no content. The same walk covers user-level symlinked ancestors
 * (a workspace reached through a link): the link becomes traversable, the
 * target's content is allowed only through the resolved root entry.
 */
export function symlinkAncestors(rawPath: string): string[] {
  const found: string[] = [];
  const parts = rawPath.split('/').filter(Boolean);
  // Walk the lexical chain from the path itself up to (excluding) '/': the
  // path itself counts, so a root that IS a symlink
  // (`/x/link` -> `/y/real`) contributes its lexical spelling — the link
  // inode only, never content (see above).
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const ancestor = `/${parts.slice(0, depth).join('/')}`;
    try {
      if (lstatSync(ancestor).isSymbolicLink()) found.push(ancestor);
    } catch {
      // Missing or unreadable component: cannot be a traversable link.
    }
  }
  return found;
}

/**
 * Root-level symlinks that must stay traversable because their target holds
 * allowed content — `/var` when the scratch is `/private/var/folders/…`,
 * `/etc` when commands read `/etc/hosts` while the allow entry is the
 * resolved `/private/etc`.
 *
 * Derived, not hardcoded: every symlink directly under `/` whose target is
 * an ancestor of (or equal to) an allowed path contributes its lexical
 * spelling. The widening is the link inode only — past resolution nothing is
 * lexically under the alias (see `symlinkAncestors`), so a `/tmp` whose
 * target holds no allowed content contributes nothing and both spellings of
 * its content stay denied. On Linux this is a no-op in practice (no
 * root-level symlinks into the allowed set; bwrap resolves through mounts
 * rather than matching path spellings), kept platform-independent so the
 * two backends cannot drift.
 */
export function rootSymlinkAliases(allowed: readonly string[]): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/');
  } catch {
    return found;
  }
  for (const entry of entries) {
    const candidate = `/${entry}`;
    let target: string;
    try {
      if (!lstatSync(candidate).isSymbolicLink()) continue;
      target = realpathSync(candidate);
    } catch {
      continue;
    }
    if (allowed.some((a) => a === target || a.startsWith(`${target}/`))) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * The read scope for one sandboxed call. `roots` are the call's own
 * directories — `cwd`, `writeScope`, the session scratch — and nothing else
 * caller-chosen ever enters the allow list; the model never supplies these.
 * Each root contributes its resolved spelling plus its lexical symlinked
 * ancestors (see `symlinkAncestors`); `guards.denyRead` is layered
 * separately by the executor and keeps winning over every entry here
 * (nested-deny re-emit on macOS, exact file-mask and tmpfs ordering on
 * Linux), so a secret inside an allowed root stays denied.
 */
export function buildReadScope(
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ReadScope {
  const allow = new Set<string>();
  for (const root of roots) {
    const resolved = resolveReadRoot(root);
    if (resolved !== null) allow.add(resolved);
    for (const ancestor of symlinkAncestors(root)) allow.add(ancestor);
  }
  for (const system of systemReadPaths(platform)) allow.add(system);
  // Lexical aliases of the allowed tree (see `rootSymlinkAliases`): without
  // them every absolute path spelled through a root symlink fails closed.
  for (const alias of rootSymlinkAliases([...allow])) allow.add(alias);
  // The xcrun toolchain cache (macOS only): without it every `git` through
  // the `/usr/bin` shim pays a ~1.2s cache-miss re-lookup plus failed
  // rewrite attempts — measured 2026-10-16, `xcrun --find git` 1193ms vs
  // 77ms for the real binary direct. Before the scope the cache
  // (`$TMPDIR/xcrun_db`, fixed name — the `xcrun_db-XXXXXX` files are atomic-
  // rewrite temps) was a read hit; the scope denies the shared temp dir, so
  // this one fixed file is re-allowed for READ. Its content is toolchain
  // paths, never owner data; the rewrite (a write into shared temp) stays
  // denied. A stale cache after a toolchain switch degrades to slow git,
  // never to failure — and a host-side `git` refreshes it.
  if (platform === 'darwin') {
    const cacheRaw = join(tmpdir(), 'xcrun_db');
    const cache = resolveReadRoot(cacheRaw);
    if (cache !== null) allow.add(cache);
    for (const ancestor of symlinkAncestors(cacheRaw)) allow.add(ancestor);
  }
  return { denyRead: [READ_DENY_ROOT], allowRead: [...allow] };
}
