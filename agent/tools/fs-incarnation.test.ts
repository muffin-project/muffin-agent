import DatabaseCtor from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableLock, type DurableLockSpec } from '../../core/lock/durable.js';
import { incarnationOf } from '../../core/lock/incarnation.js';
import { mandatoryGuards } from '../../core/rot/guards.js';
import { type FsScope, fsRead, fsSearch, fsWrite } from './fs.js';

/**
 * The fs tools run inside the process that holds claims, and a POSIX process
 * drops *all* its record locks on a file the moment it closes *any* descriptor
 * of that file. So one `fs_read` of the process's own incarnation file, or a
 * search that happens to open it, would silently free its lock: every other
 * process would then read a live holder as dead and take its claims (ADR-0092).
 * Reachable because the interactive `muffin` defaults its workspace to the
 * directory it was started from, `$HOME` included, which contains the home.
 *
 * Each case: this process holds a lock, a tool touches the incarnation file,
 * and a second process must still be refused.
 */

const SPEC: DurableLockSpec = {
  table: 'zz_fs_lock',
  schema: `CREATE TABLE IF NOT EXISTS zz_fs_lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, taken_at TEXT);`,
  staleAfterMs: 5 * 60_000,
  refusal: (holder) => ({ held: `held by ${holder}`, remedy: 'wait' }),
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Another process tries the same lock once and says what happened. */
const otherProcessTries = (dbPath: string): Promise<string> => {
  const code = `
    import DatabaseCtor from 'better-sqlite3';
    import { DurableLock } from '${join(process.cwd(), 'core/lock/durable.ts')}';
    const db = new DatabaseCtor(process.argv[1]);
    const spec = {
      table: 'zz_fs_lock',
      schema: ${JSON.stringify(SPEC.schema)},
      staleAfterMs: ${SPEC.staleAfterMs},
      refusal: (h) => ({ held: 'held by ' + h, remedy: 'wait' }),
    };
    process.stdout.write('release' in new DurableLock(db, spec).acquire(new Date()) ? 'got' : 'refused');
  `;
  const proc = spawn('node', ['--import', 'tsx', '--input-type=module', '-e', code, dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += String(d)));
  proc.stderr.on('data', (d) => (err += String(d)));
  return new Promise((resolve) => proc.on('close', () => resolve(out.trim() || `exited: ${err}`)));
};

/**
 * `$HOME` as the workspace, the Muffin home inside it, and this process holding
 * a lock on the home's database. Returns the incarnation file the lock rests on.
 */
const holdingFromHome = (): {
  scope: FsScope;
  dbPath: string;
  incarnationFile: string;
  root: string;
} => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-fs-incarnation-'));
  roots.push(root);
  const home = join(root, '.muffin');
  mkdirSync(home, { mode: 0o700 });
  const dbPath = join(home, 'muffin.db');
  const db = new DatabaseCtor(dbPath);
  db.pragma('journal_mode = WAL');
  const lock = new DurableLock(db, SPEC);
  if (!('release' in lock.acquire(new Date())))
    throw new Error('il processo di test non ha preso il lock');
  const id = incarnationOf(lock.recorded()?.holderId);
  if (id === null) throw new Error("il lock non porta un'incarnazione");
  const guards = mandatoryGuards(home, root, root);
  return {
    scope: { root, denyWrite: guards.denyWrite, denyRead: guards.denyRead },
    dbPath,
    incarnationFile: join(home, 'incarnations', `${id}.db`),
    root,
  };
};

describe("the fs tools cannot release the holder's own incarnation lock", () => {
  it('the holder is still held after fs_search walks the home', async () => {
    const { scope, dbPath } = holdingFromHome();
    // The table name is inside the incarnation file: a search that opened it
    // would have a reason to.
    fsSearch(scope, { query: 'incarnation' });
    expect(await otherProcessTries(dbPath)).toBe('refused');
  }, 30_000);

  it('fs_read of the incarnation file is denied, and the holder is still held', async () => {
    const { scope, dbPath, incarnationFile, root } = holdingFromHome();
    expect(() => fsRead(scope, relative(root, incarnationFile))).toThrow();
    expect(await otherProcessTries(dbPath)).toBe('refused');
  }, 30_000);

  it('a git include pointing at the incarnation file is never opened, and the holder is still held', async () => {
    // A checkout in the workspace whose config includes the incarnation file:
    // the write check reads every include to find hooks paths, and it runs in
    // this process. It must refuse to classify the file rather than open it.
    const { scope, dbPath, incarnationFile, root } = holdingFromHome();
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    writeFileSync(join(root, 'repo', '.git', 'config'), `[include]\n\tpath = ${incarnationFile}\n`);
    try {
      fsWrite(scope, 'repo/nota.txt', 'ciao');
    } catch {
      // Denied or not, what matters is below: the lock must survive the check.
    }
    expect(await otherProcessTries(dbPath)).toBe('refused');
  }, 30_000);
});
