import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Private-by-construction filesystem modes for Muffin Home state (#639).
 *
 * Node/fs creation modes are subject to the process umask. Relying on the
 * caller's umask or the parent home permissions is not a privacy boundary
 * for a personal agent intended to run on Linux/VPS hosts with other local
 * users. Every private directory is `0700`, every private regular file is
 * `0600` — explicitly, at creation, and again at startup for pre-existing
 * same-user installations.
 *
 * The `0700`/`0600` values are umask-independent by construction: they carry
 * no group/other bits, so `& ~umask` cannot add any. Passing them as `mode`
 * to `mkdirSync`/`writeFileSync` is what makes fresh files private even
 * under `022`. The `chmodSync` after each creation is what repairs a path
 * that already existed with wider bits (resumed `init`, pre-existing home).
 *
 * Hardened RoT / service-user-owned material is never touched: any path
 * whose uid differs from this process's uid is skipped. `chmod` only
 * requires ownership, so touching a foreign-owned file would at best fail
 * and at worst misrepresent the hardening boundary. Symlinks are never
 * followed and never chmodded; sockets and other non-regular files are left
 * alone.
 */

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export type StatLike = (path: string) => { uid: number; mode: number };
export type GetUidLike = () => number | undefined;

const defaultStat: StatLike = (p) => statSync(p);
const defaultGetuid: GetUidLike = () => process.getuid?.();

/** True when this process may tighten `path` without crossing an ownership boundary. */
export function isSelfOwned(
  path: string,
  stat: StatLike = defaultStat,
  getuid: GetUidLike = defaultGetuid,
): boolean {
  const me = getuid();
  if (me === undefined) return true;
  try {
    return stat(path).uid === me;
  } catch {
    return false;
  }
}

/**
 * `mkdir -p` that is private by construction, and tightens a pre-existing dir.
 *
 * Verifies the existing ancestor chain before creating anything: every
 * existing component from the requested directory up to (excluding) the first
 * foreign-owned ancestor — the trust boundary — must be a real directory.
 * Any symlink, or any non-directory, on that chain refuses fail-closed.
 * Only the missing suffix beneath the last verified real directory is then
 * created, so a symlinked ancestor (`home/vault -> outside-dir`) can never
 * divert creation or a later `chmod` outside the intended tree. The walk
 * stops at foreign-owned territory, which this process may neither plant in
 * nor tighten: system links above that boundary (e.g. `/var` on macOS) are
 * resolved identically for every party by the kernel and are not an
 * attacker-controlled escape.
 *
 * Returns `true` when the directory is established (created or verified, and
 * `0700` when it is ours — foreign-owned paths keep their prior best-effort
 * no-touch semantics). Returns `false` when refused: nothing was created and
 * nothing was chmodded. A `false` is observable precisely because a writer
 * that proceeds to write after a silent no-op would recreate the escape this
 * guards — callers that write after ensuring MUST check and fail truthfully
 * instead of writing through an unverified parent.
 */
export function ensurePrivateDir(
  dir: string,
  opts: { stat?: StatLike; getuid?: GetUidLike } = {},
): boolean {
  const stat = opts.stat ?? defaultStat;
  const getuid = opts.getuid ?? defaultGetuid;
  try {
    const abs = resolve(dir);

    // Split into longest existing prefix (verified below) and missing suffix
    // (which cannot hide a symlink: it does not exist yet).
    let cursor = abs;
    const missing: string[] = [];
    for (;;) {
      const st = lstatSync(cursor, { throwIfNoEntry: false });
      if (st !== undefined) break;
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      missing.unshift(basename(cursor));
      cursor = parent;
    }

    // Verify the existing chain bottom-up: each component must be a real
    // directory. Stop (exclusively) at the first foreign-owned ancestor —
    // the trust boundary — or at the filesystem root.
    let node = cursor;
    for (;;) {
      const st = lstatSync(node, { throwIfNoEntry: false });
      if (st === undefined) return false;
      if (st.isSymbolicLink()) return false;
      if (!st.isDirectory()) return false;
      if (!isSelfOwned(node, stat, getuid)) break;
      const parent = dirname(node);
      if (parent === node) break;
      node = parent;
    }

    // Create only the missing suffix beneath the verified real prefix.
    // (A concurrent plant between verification and creation is a best-effort
    // TOCTOU this layer does not claim to close; the leaf re-check below
    // still refuses a swapped-in link instead of chmodding through it.)
    if (missing.length > 0) {
      mkdirSync(abs, { recursive: true, mode: PRIVATE_DIR_MODE });
    }

    const leaf = lstatSync(abs, { throwIfNoEntry: false });
    if (leaf === undefined || !leaf.isDirectory()) return false;
    if (isSelfOwned(abs, stat, getuid)) {
      chmodSync(abs, PRIVATE_DIR_MODE);
    }
    return true;
  } catch {
    // Best-effort for historical callers, observable for writers: a hard
    // failure (vanished path, EACCES, foreign material) refuses instead of
    // leaving the caller believing the private parent exists.
    return false;
  }
}

/**
 * Ensure the parent of `file` exists and is private. Same fail-closed
 * contract as `ensurePrivateDir`: `false` means the parent was NOT
 * established and the caller must not write.
 */
export function ensurePrivateParent(file: string, opts: { stat?: StatLike; getuid?: GetUidLike } = {}): boolean {
  return ensurePrivateDir(dirname(file), opts);
}

/**
 * Tighten one regular file to `0600` when it is ours. No-op for missing
 * paths, symlinks, sockets, or foreign-owned files. Never throws.
 */
export function tightenPrivateFile(
  file: string,
  opts: { stat?: StatLike; getuid?: GetUidLike } = {},
): void {
  try {
    if (!existsSync(file)) return;
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) return;
    if (!isSelfOwned(file, opts.stat ?? defaultStat, opts.getuid ?? defaultGetuid)) return;
    chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    /* best-effort */
  }
}

/** Tighten a SQLite database and its sidecars (`-wal`, `-shm`, `-journal`). */
export function tightenPrivateDb(
  dbPath: string,
  opts: { stat?: StatLike; getuid?: GetUidLike } = {},
): void {
  tightenPrivateFile(dbPath, opts);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    tightenPrivateFile(`${dbPath}${suffix}`, opts);
  }
}

export type TightenReport = { tightened: string[]; skippedForeign: string[] };

/**
 * Startup migration: tighten a pre-existing same-user home, not only new files.
 *
 * Walks `home` without following symlinks. Every directory that is ours
 * becomes `0700`; every regular file that is ours becomes `0600`. Foreign-
 * owned entries (hardened RoT, service-user material) are recorded in
 * `skippedForeign` and left alone. Never throws: a tightening failure on one
 * entry does not stop the walk and does not break boot.
 */
export function tightenHome(
  home: string,
  opts: { stat?: StatLike; getuid?: GetUidLike } = {},
): TightenReport {
  const stat = opts.stat ?? defaultStat;
  const getuid = opts.getuid ?? defaultGetuid;
  const report: TightenReport = { tightened: [], skippedForeign: [] };
  if (!existsSync(home)) return report;

  const visit = (path: string): void => {
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      return;
    }
    if (st === undefined) return;
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      try {
        if (!isSelfOwned(path, stat, getuid)) {
          report.skippedForeign.push(path);
          return;
        }
        chmodSync(path, PRIVATE_DIR_MODE);
        report.tightened.push(path);
      } catch {
        return;
      }
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }
      for (const entry of entries) visit(join(path, entry));
      return;
    }
    if (st.isFile()) {
      try {
        if (!isSelfOwned(path, stat, getuid)) {
          report.skippedForeign.push(path);
          return;
        }
        chmodSync(path, PRIVATE_FILE_MODE);
        report.tightened.push(path);
      } catch {
        /* best-effort per file */
      }
    }
    /* sockets, fifos, devices: left alone */
  };

  visit(home);
  return report;
}
