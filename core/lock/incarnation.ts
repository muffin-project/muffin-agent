import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ensurePrivateDir, tightenPrivateFile } from '../config/private-fs.js';

/**
 * Whether the holder of a durable claim is still running, answered by the
 * kernel rather than by a pid number (ADR-0094).
 *
 * ## The problem a pid cannot answer
 *
 * `heldBy` (core/lock/durable.ts) used to decide liveness with `kill(pid, 0)`.
 * A pid is a number the kernel hands out again, and in a container it hands it
 * out again at once: a restarted container starts a fresh pid namespace, so the
 * new gateway usually gets the pid the dead one had (7 behind `tini`). The dead
 * holder then reads as alive and the new gateway is refused, restart after
 * restart, until the hard horizon (thirty minutes); measured on 2026-09-27:
 * about seventeen minutes, ended only because one restart happened to get
 * another pid. Turns left `running` stay unreclaimed up to their own horizon
 * (six hours, configured, not measured). The other direction is worse: a second
 * container on the same home has its own namespace, where the recorded pid means
 * nothing, so a live holder can read as dead and be stolen from.
 *
 * ## The answer: a lock the kernel drops when the process dies
 *
 * Each process that becomes a holder first creates a small SQLite file,
 * `incarnations/<id>.db` next to the database whose rows it will claim, and
 * keeps it exclusively locked for the rest of its life (`locking_mode =
 * EXCLUSIVE` after one write). Every token it then mints (`holder_id` on the
 * lock tables, `claim_token` on `turns`) carries that id: `<incarnation>.<uuid>`.
 * A reader asks the kernel instead of the pid: if the file's lock can be taken,
 * no process holds it any more, whatever the pid on the row now points at; if it
 * cannot, the holder is alive, in whatever pid namespace it runs. POSIX record
 * locks are released by the kernel when their process dies, SIGKILL and OOM
 * included, and they are per-host, not per-namespace (measured: a probe from a
 * second container read the holder as alive, and as dead right after
 * `kill -9`).
 *
 * The id rides inside the existing fencing token rather than a new column, so
 * no table changes shape: tokens are only ever compared for equality, and a
 * build that predates this reads the same rows with the pid rule it always had.
 *
 * ## Rules this file depends on
 *
 * - **Only SQLite may open an incarnation file.** A POSIX process loses *all* its
 *   record locks on a file the moment it closes *any* descriptor of that file.
 *   SQLite knows this and keeps such descriptors open until its last connection
 *   to the file is gone; a plain `readFileSync` would silently release the
 *   holder's own lock, and the holder could not even notice, because SQLite's
 *   own bookkeeping would still believe it holds it. The sweep below only
 *   `stat`s and `unlink`s. The holder process also runs the model's fs tools,
 *   so the directory is on `mandatoryGuards().denyRead`
 *   (`core/rot/guards.ts`), which covers `fs_read`, `fs_search`, `fs_list` and
 *   the sandbox. The in-process reader that opens paths named by content, the
 *   git write check of the fs tools, reads every file (`.git` pointer,
 *   `commondir`, configs, includes) through one helper that resolves links,
 *   `/proc/self/fd/N` included, and refuses an incarnation file
 *   (`readGitControlFile` in `agent/tools/fs.ts`). Two independent reviews
 *   found this class twice; any new in-process reader of a path it did not
 *   choose must go through the same check.
 * - **A file is deleted only after its lock was taken**, and only when it is older
 *   than `SWEEP_MIN_AGE_MS`, so a file a process has just created and not yet
 *   locked is never swept from under it.
 * - **Anything the probe cannot decide falls back to the pid rule**, the rule
 *   every build before this one used, so an unreadable file can make the
 *   answer no better than before, never worse.
 * - **The same filesystem requirement as the database.** SQLite's own locking
 *   already has to work for `muffin.db`; these files ask for nothing more. On a
 *   network filesystem neither works.
 */

/**
 * Signal 0 sends nothing: it only asks whether that process still exists.
 * EPERM means it exists and belongs to another user: alive, and not ours to
 * take. Only ESRCH is proof the holder is gone.
 *
 * Still the rule for rows written before ADR-0094 (no incarnation in their
 * token), for in-memory databases, and whenever an incarnation cannot be
 * probed.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is the holder of a claim still running? `pid` is the row's pid, `holderId`
 * its fencing token (`holder_id` or `claim_token`). A function taking only the
 * pid still fits this type, which is how tests inject a fixed answer.
 */
export type Liveness = (pid: number, holderId: string | null) => boolean;

/** The directory, beside the database, that holds the incarnation files. */
export const INCARNATIONS_DIRNAME = 'incarnations';

/** A file younger than this is never swept: its creator may not have locked it yet. */
export const SWEEP_MIN_AGE_MS = 60_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * `<incarnation>.<uuid>`, both halves UUIDs. Strict on purpose: the first half
 * becomes a file name, so nothing but a UUID may ever reach `join` below.
 */
const TOKEN_WITH_INCARNATION = new RegExp(`^(${UUID})\\.${UUID}$`);
const INCARNATION_FILE = new RegExp(`^(${UUID})\\.db$`);
/** For `isIncarnationFile`: on a case-insensitive filesystem any spelling opens the file. */
const INCARNATION_FILE_ANY_CASE = new RegExp(`^(${UUID})\\.db$`, 'i');

/** The incarnation id a token carries, or null for a token minted without one. */
export function incarnationOf(holderId: string | null | undefined): string | null {
  if (typeof holderId !== 'string') return null;
  return TOKEN_WITH_INCARNATION.exec(holderId)?.[1] ?? null;
}

/**
 * Where the incarnations of the processes sharing `db` live: beside the database
 * file, because liveness only has to be agreed on by the processes that share
 * that file. Null for a database that is not a file (`:memory:`, anonymous
 * temporary databases): nothing outside this process can hold its rows.
 */
export function incarnationDir(db: Database.Database): string | null {
  if (db.memory || db.name === '' || db.name === ':memory:') return null;
  return join(dirname(resolve(db.name)), INCARNATIONS_DIRNAME);
}

/**
 * Whether `path`, after following links, is an incarnation file: a UUID-named
 * `.db` inside a directory called `incarnations`, in any letter case. For
 * readers that open paths they did not choose (the git write check in
 * `agent/tools/fs.ts`) and must never open one of these; see "Only SQLite may
 * open an incarnation file" above. A path that cannot be resolved is judged by
 * its spelling.
 */
export function isIncarnationFile(path: string): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path);
  }
  return (
    INCARNATION_FILE_ANY_CASE.test(basename(real)) &&
    basename(dirname(real)).toLowerCase() === INCARNATIONS_DIRNAME
  );
}

type Owned = { id: string; db: Database.Database; file: string };

/** This process's incarnation, per directory: created on the first claim, held until exit. */
const owned = new Map<string, Owned>();
/** Directories this process could not establish an incarnation in, warned about once. */
const failed = new Set<string>();

let exitHookInstalled = false;

/**
 * On a clean exit the process removes its own file. A SIGKILL leaves it behind;
 * the next process that creates an incarnation in the same directory sweeps it.
 * Either way the lock itself is gone the moment the process is.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const o of owned.values()) {
      try {
        o.db.close();
        unlinkSync(o.file);
      } catch (error) {
        process.stderr.write(
          `incarnazione ${o.id}: non rimossa all'uscita (${String(error)}), la rimuoverà il prossimo avvio\n`,
        );
      }
    }
  });
}

/**
 * Deletes the files of incarnations that are provably over: older than
 * `SWEEP_MIN_AGE_MS` and not locked by anybody. A file whose rows still exist
 * then probes as missing, which reads as dead: the same answer its unlocked
 * file gave.
 */
function sweep(dir: string, nowMs: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    process.stderr.write(`incarnazioni: non posso leggere ${dir} (${String(error)})\n`);
    return;
  }
  for (const name of names) {
    const id = INCARNATION_FILE.exec(name)?.[1];
    if (id === undefined) continue;
    const file = join(dir, name);
    try {
      if (nowMs - statSync(file).mtimeMs < SWEEP_MIN_AGE_MS) continue;
      if (probeIncarnation(dir, id) !== 'dead') continue;
      unlinkSync(file);
    } catch (error) {
      // Another process may have swept it first: that is the wanted outcome.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`incarnazioni: non posso rimuovere ${file} (${String(error)})\n`);
      }
    }
  }
}

/**
 * This process's incarnation id in `dir`, creating and locking its file on the
 * first call. Null when it cannot be established: the caller then mints a token
 * without an incarnation, and readers judge that claim by its pid, exactly as
 * every build before ADR-0094 did. Said once on stderr, because a claim that
 * falls back silently is the kind of degradation nobody finds.
 */
function ownIncarnation(dir: string): string | null {
  const existing = owned.get(dir);
  if (existing !== undefined) return existing.id;
  if (failed.has(dir)) return null;

  const fail = (why: string): null => {
    failed.add(dir);
    process.stderr.write(`incarnazioni: ${why}; i lock di questo processo si giudicano dal pid\n`);
    return null;
  };

  if (!ensurePrivateDir(dir)) return fail(`la directory ${dir} non è stata stabilita`);
  sweep(dir, Date.now());

  const id = randomUUID();
  const file = join(dir, `${id}.db`);
  let db: Database.Database | null = null;
  try {
    db = new DatabaseCtor(file);
    // No sidecar files: the content is a label, not data worth a journal.
    db.pragma('journal_mode = MEMORY');
    // Held from the first write until this connection closes, i.e. until the
    // process ends. This is the whole mechanism.
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec(`CREATE TABLE incarnation (pid INTEGER NOT NULL, started_at TEXT NOT NULL)`);
    db.prepare(`INSERT INTO incarnation (pid, started_at) VALUES (?, ?)`).run(
      process.pid,
      new Date().toISOString(),
    );
    tightenPrivateFile(file);
  } catch (error) {
    try {
      db?.close();
    } catch (closeError) {
      process.stderr.write(`incarnazioni: chiusura di ${file} fallita (${String(closeError)})\n`);
    }
    return fail(`non posso creare ${file} (${String(error)})`);
  }
  owned.set(dir, { id, db, file });
  installExitHook();
  return id;
}

/**
 * A fresh fencing token for a claim on `db` made in the name of `pid`:
 * `<incarnation>.<uuid>` when the claimant is this process and it has an
 * incarnation beside that database, a bare UUID otherwise.
 *
 * Establishing the incarnation happens here, before the token can reach a row:
 * a token must never name an incarnation whose file is not yet locked.
 *
 * A claim in another pid's name gets no incarnation, because this process's
 * incarnation would say nothing about that pid: the row would read as alive for
 * as long as *this* process lives, whoever `pid` is. Production always claims
 * for `process.pid`; the stores accept a pid only so tests and fixtures can
 * stage a row for a process that is not the caller, and such a row is judged
 * by its pid, as every row was before ADR-0094.
 */
export function mintHolderId(db: Database.Database, pid: number = process.pid): string {
  const dir = pid === process.pid ? incarnationDir(db) : null;
  const own = dir === null ? null : ownIncarnation(dir);
  const token = randomUUID();
  return own === null ? token : `${own}.${token}`;
}

/**
 * Asks the kernel whether incarnation `id` is still held.
 *
 * `dead`: the file is gone (a clean exit, or a sweep after death) or its lock
 * could be taken. `alive`: the lock is held by a connection, in this process or
 * another. `unknown`: anything else (permissions, a damaged file); the caller
 * falls back to the pid.
 */
export function probeIncarnation(dir: string, id: string): 'alive' | 'dead' | 'unknown' {
  const file = join(dir, `${id}.db`);
  let probe: Database.Database;
  try {
    probe = new DatabaseCtor(file, { fileMustExist: true, timeout: 0 });
  } catch {
    // Only a file that is certainly gone is a dead incarnation. A file this
    // reader cannot even stat (a directory it may not traverse) says nothing
    // about the holder: that is the pid rule's case.
    try {
      return statSync(file, { throwIfNoEntry: false }) === undefined ? 'dead' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  try {
    // A read needs a shared lock, which a holder's exclusive lock refuses at once.
    probe.prepare(`SELECT count(*) FROM sqlite_master`).get();
    return 'dead';
  } catch (error) {
    return (error as { code?: string }).code === 'SQLITE_BUSY' ? 'alive' : 'unknown';
  } finally {
    probe.close();
  }
}

/**
 * The liveness rule for claims on `db`: the holder's incarnation when its token
 * carries one and it can be probed, its pid otherwise.
 */
export function holderLiveness(db: Database.Database): Liveness {
  const dir = incarnationDir(db);
  return (pid, holderId) => {
    const id = incarnationOf(holderId);
    if (dir !== null && id !== null) {
      const verdict = probeIncarnation(dir, id);
      if (verdict !== 'unknown') return verdict === 'alive';
    }
    return pidAlive(pid);
  };
}
