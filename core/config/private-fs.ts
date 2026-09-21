import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** `mkdir -p` that is private by construction, and tightens a pre-existing dir. */
export function ensurePrivateDir(
  dir: string,
  opts: { stat?: StatLike; getuid?: GetUidLike } = {},
): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    if (isSelfOwned(dir, opts.stat ?? defaultStat, opts.getuid ?? defaultGetuid)) {
      chmodSync(dir, PRIVATE_DIR_MODE);
    }
  } catch {
    /* best-effort: a tightening failure must not break boot/init */
  }
}

/** Ensure the parent of `file` exists and is private. */
export function ensurePrivateParent(file: string, opts: { stat?: StatLike; getuid?: GetUidLike } = {}): void {
  ensurePrivateDir(dirname(file), opts);
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
