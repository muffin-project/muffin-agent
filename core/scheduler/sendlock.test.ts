import DatabaseCtor from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SendLock, STALE_AFTER_MS, pidAlive } from './sendlock.js';

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

  it('an old claim is stale whatever its pid says', () => {
    // A pid is weaker evidence than it looks: ordinary reuse after a hard kill
    // is enough for a dead holder to read as alive, and that happens in hours,
    // not after 2³² processes. Without this the command wedges permanently while
    // telling the owner to wait for a send that ended days ago.
    const lock = new SendLock(db(), () => true);
    lock.acquire(NOW, 4242);

    const soon = new Date(NOW.getTime() + STALE_AFTER_MS - 1000);
    expect(lock.acquire(soon, 4243)).toMatchObject({ held: expect.stringContaining('4242') });

    const later = new Date(NOW.getTime() + STALE_AFTER_MS + 1000);
    expect('release' in lock.acquire(later, 4243)).toBe(true);
    expect(lock.holder()).toBe(4243);
  });

  it('inherits a busy timeout, which is what makes a lost race a wait and not a crash', () => {
    // The guarantee is real and it is **not ours**: better-sqlite3 sets
    // `busy_timeout = 5000` on every connection. Without it the run that loses
    // the race throws SQLITE_BUSY out of `acquire` instead of waiting its turn
    // and refusing cleanly. Setting the pragma ourselves was tried and removed —
    // it changed nothing, and the test asserting it was asserting the driver.
    //
    // This one guards the inherited default: it fails if a driver upgrade drops
    // it, or if a caller opens the database with `timeout: 0` — the two ways it
    // could stop being true, both measured here.
    expect(db().pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(new DatabaseCtor(':memory:', { timeout: 0 }).pragma('busy_timeout', { simple: true })).toBe(0);
  });

  it('two real processes racing for a free lock: exactly one gets it', async () => {
    /**
     * The only assertion that can tell `BEGIN IMMEDIATE` from the default
     * deferred, and therefore the only one that proves the fix rather than
     * restating it. Inside one process it is untestable: better-sqlite3 is
     * synchronous, so a transaction never interleaves with another and both
     * modes look identical.
     *
     * What deferred actually produces here, measured rather than reasoned:
     * **one `got` and zero `refused`** — the loser dies on SQLITE_BUSY when it
     * tries to upgrade its read to a write. Not two deliveries; a crash. That is
     * still the wrong outcome (`IMMEDIATE` gives a clean refusal and an exit
     * code the owner can read), and it is what makes the two modes
     * distinguishable at all. Said this way because the earlier version of this
     * comment claimed the double delivery, and this repo's rule is not to assert
     * what has not been run.
     *
     * Both children have to be inside `acquire` at the same time; otherwise the
     * second one refuses for the ordinary reason and proves nothing.
     */
    const home = mkdtempSync(join(tmpdir(), 'muffin-sendlock-race-'));
    const dbPath = join(home, 'muffin.db');
    // WAL, because production is WAL (`agent/runtime.ts`, `cli/init.ts`) and a
    // lock proved in a journal mode nobody runs is proved somewhere else.
    const seed = new DatabaseCtor(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.close();
    const child = `
      import DatabaseCtor from 'better-sqlite3';
      import { SendLock } from '${join(process.cwd(), 'core/scheduler/sendlock.ts')}';
      const db = new DatabaseCtor(process.argv[1]);
      new SendLock(db);
      process.stdout.write('ready\\n');
      const at = await new Promise((r) => process.stdin.once('data', (d) => r(Number(String(d).trim()))));
      while (Date.now() < at) {}
      const got = 'release' in new SendLock(db).acquire(new Date());
      process.stdout.write(got ? 'got' : 'refused');
      // Report, then stay. The parent kills us once both have reported. See the
      // note on the barrier below for why exiting here made the test lie.
      // The self-destruct is for the case where the parent dies first: an
      // orphan holding a lock in a temp dir is litter, not a hang, but it is
      // still litter.
      setTimeout(() => process.exit(0), 10_000);
    `;
    // `spawn`, not `spawnSync`: a blocking spawn runs the children one after the
    // other, the first exits before the second starts, and the second finds a
    // dead holder and takes over — two "got" for a reason that has nothing to do
    // with the race. They have to be alive at the same time.
    //
    // The barrier is a handshake *and* a spin, and it needs both halves.
    //
    // A bare wall-clock deadline flaked: under the full suite node's startup ate
    // the window, the children stopped overlapping, and the test failed for a
    // reason that had nothing to do with the lock. A bare handshake fixed that
    // and quietly broke the test instead — released by an I/O event the two
    // children arrive milliseconds apart, which is enough for them to serialise,
    // and the deferred mutation started surviving. So: the handshake decides
    // *when* the window opens, once both children exist, and a hot spin to a
    // shared instant makes them collide inside it.
    //
    // And a third half, found by running the suite ten times: colliding inside
    // `acquire` is not enough, because the winner used to **exit immediately
    // after winning**. Under load the loser could reach `heldBy` after the
    // winner's pid was already gone, read it as dead — correctly, that is what
    // `pidAlive` is for — and take the lock over. Two `got`, from a lock
    // behaving exactly as designed. Measured once in ten full-suite runs, and it
    // is the worst possible flake: this is the only assertion that distinguishes
    // `IMMEDIATE` from deferred, so a maintainer seeing it go red at a bad
    // moment would hunt a concurrency bug that is not there. The children now
    // report and wait; the parent kills them once both have spoken, so neither
    // can ever observe the other as a corpse.
    const start = (): { proc: ReturnType<typeof spawn>; ready: Promise<void>; done: Promise<string> } => {
      // `--import tsx` and not `--experimental-transform-types`: Node's own type
      // stripping does not rewrite a `./x.js` specifier to `./x.ts`, so the
      // child dies with ERR_MODULE_NOT_FOUND the moment the module it imports
      // has a runtime import of its own (measured, when the claim moved to
      // `core/lock/durable.ts`). This harness worked only because sendlock.ts
      // happened to have none — an undeclared constraint on a file nobody was
      // told to keep import-free. tsx resolves them, and the handshake below
      // already absorbs the extra startup.
      const proc = spawn('node', ['--import', 'tsx', '--input-type=module', '-e', child, dbPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let markReady: () => void;
      let markDone: (outcome: string) => void;
      const ready = new Promise<void>((r) => (markReady = r));
      const done = new Promise<string>((r) => (markDone = r));
      const outcome = (): string => out.replace('ready', '').trim();
      proc.stdout.on('data', (d) => {
        out += String(d);
        if (out.includes('ready')) markReady();
        // Done is "it has spoken", not "it has exited" — the child outlives its
        // own answer on purpose now.
        if (outcome() === 'got' || outcome() === 'refused') markDone(outcome());
      });
      // A child that dies without speaking still resolves, so a broken harness
      // fails on the assertion with what it did say instead of on a timeout.
      proc.on('close', () => markDone(outcome()));
      return { proc, ready, done };
    };

    const children = [start(), start()];
    await Promise.all(children.map((c) => c.ready));
    // `end`, not `write`: a stdin left open keeps the child's event loop alive,
    // so it acquires the lock and then never exits, and the parent waits for a
    // `close` that cannot come.
    const at = Date.now() + 250;
    for (const c of children) c.proc.stdin!.end(`${at}\n`);
    const outcomes = await Promise.all(children.map((c) => c.done));
    for (const c of children) c.proc.kill();

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
