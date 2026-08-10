import DatabaseCtor from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SendLock, pidAlive } from './sendlock.js';

/**
 * The lock, on the branches the CLI cannot reach.
 *
 * Liveness is the whole decision here — a dead holder must be taken over and a
 * live one must not — and from a single process there is only one honest live
 * pid and no way at all to produce an EPERM. So those cases are driven through
 * the injected predicate, and the predicate itself is checked separately
 * against real processes.
 */

const NOW = new Date('2026-08-10T12:00:00Z');
const db = (): DatabaseCtor.Database => new DatabaseCtor(':memory:');

/** A pid that is really gone: a stale lock the test only *believes* is stale proves nothing. */
function deadPid(): number {
  const { pid } = spawnSync('/bin/sh', ['-c', 'exit 0']);
  expect(() => process.kill(pid as number, 0)).toThrow();
  return pid as number;
}

describe('pidAlive', () => {
  it('tells a running process from a finished one', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(deadPid())).toBe(false);
  });

  it('counts a process it may not signal as alive, not as gone', () => {
    // pid 1 is launchd/init: present, and not signalable by a normal user, so
    // `process.kill` raises EPERM rather than ESRCH. Reading that as "gone"
    // would make this run delete another user's live lock — the one liveness
    // mistake that costs a second message instead of a refusal.
    expect(pidAlive(1)).toBe(true);
  });
});

describe('SendLock', () => {
  it('lets one in and names the holder to the other', () => {
    const lock = new SendLock(db(), () => true);
    const first = lock.acquire(NOW, 4242);
    const second = lock.acquire(NOW, 4243);

    expect('release' in first).toBe(true);
    expect(second).toMatchObject({ held: expect.stringContaining('pid 4242') });
  });

  it('takes over a holder that is gone', () => {
    const lock = new SendLock(db(), (pid) => pid !== 4242);
    lock.acquire(NOW, 4242);

    const after = lock.acquire(NOW, 4243);

    expect('release' in after).toBe(true);
    expect(lock.holder()).toBe(4243);
  });

  it('a release frees it without deleting the row', () => {
    const database = db();
    const lock = new SendLock(database, () => true);
    const held = lock.acquire(NOW, 4242);
    if (!('release' in held)) throw new Error('expected to hold it');

    held.release();

    expect(lock.holder()).toBeNull();
    // Never delete rows (§I-8): "when was a send last attempted" has to survive
    // the release, so the row stays and only the holder is cleared.
    expect((database.prepare(`SELECT taken_at FROM send_lock WHERE id = 1`).get() as { taken_at: string }).taken_at)
      .toBe(NOW.toISOString());
    expect('release' in lock.acquire(NOW, 4243)).toBe(true);
  });

  it('a release never frees a lock this run does not hold', () => {
    // The takeover case: 4243 took it from a dead 4242, and 4242's own release
    // must not then unlock 4243. Without the pid guard the loser of a takeover
    // hands the lock back to nobody while the winner is still sending.
    const lock = new SendLock(db(), (pid) => pid !== 4242);
    const stale = lock.acquire(NOW, 4242);
    lock.acquire(NOW, 4243);
    if (!('release' in stale)) throw new Error('expected 4242 to have held it');

    stale.release();

    expect(lock.holder()).toBe(4243);
  });

  it('two real processes racing for a free lock: exactly one gets it', async () => {
    /**
     * The only assertion that can tell `BEGIN IMMEDIATE` from the default
     * deferred, and therefore the only one that proves the fix rather than
     * restating it. Inside one process it is untestable: better-sqlite3 is
     * synchronous, so a transaction never interleaves with another and both
     * modes look identical.
     *
     * With a deferred transaction both runs read `pid IS NULL` under a shared
     * lock, then both write — and both believe they hold it, which is the
     * original two-messages-one-row failure with a different mechanism under it.
     * `IMMEDIATE` takes the write lock before the read, so the second run's
     * SELECT cannot happen until the first has committed.
     *
     * The barrier is a wall-clock instant both children wait for: without it
     * they run one after the other and the second would refuse for the ordinary
     * reason, proving nothing.
     */
    const home = mkdtempSync(join(tmpdir(), 'muffin-sendlock-race-'));
    const dbPath = join(home, 'muffin.db');
    new DatabaseCtor(dbPath).close();
    const startAt = Date.now() + 900;
    const child = `
      import DatabaseCtor from 'better-sqlite3';
      import { SendLock } from '${join(process.cwd(), 'core/scheduler/sendlock.ts')}';
      const db = new DatabaseCtor(process.argv[1]);
      db.pragma('busy_timeout = 5000');
      new SendLock(db);
      while (Date.now() < Number(process.argv[2])) {}
      const got = 'release' in new SendLock(db).acquire(new Date());
      process.stdout.write(got ? 'got' : 'refused');
    `;
    // `spawn`, not `spawnSync`: a blocking spawn runs the children one after the
    // other, the first exits before the second starts, and the second finds a
    // dead holder and takes over — two "got" for a reason that has nothing to do
    // with the race. They have to be alive at the same time.
    const run = (): Promise<string> =>
      new Promise((resolve) => {
        const proc = spawn(
          'node',
          ['--experimental-transform-types', '--input-type=module', '-e', child, dbPath, String(startAt)],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        proc.stdout.on('data', (d) => (out += String(d)));
        proc.on('close', () => resolve(out.trim()));
      });

    const outcomes = await Promise.all([run(), run()]);

    expect(outcomes.filter((o) => o === 'got')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(1);
  }, 30_000);

  it('survives a home that has never taken it', () => {
    // The table is created by the constructor, so the first ever `--send` on a
    // real home must not die on "no such table" — the declared-but-never-created
    // failure this whole slice exists to have stopped repeating.
    const home = mkdtempSync(join(tmpdir(), 'muffin-sendlock-'));
    const database = new DatabaseCtor(join(home, 'muffin.db'));
    expect('release' in new SendLock(database).acquire(NOW)).toBe(true);
    database.close();
  });
});
