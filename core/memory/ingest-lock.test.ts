import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARD_STALE_MULTIPLIER } from '../lock/durable.js';
import { IngestLock, STALE_AFTER_MS } from './ingest-lock.js';

/**
 * The lock's own wiring, on the branches `ingest.test.ts` does not reach.
 *
 * Mirrors `core/scheduler/sendlock.test.ts`'s shape deliberately: same claim,
 * same `DurableLock`, same reasoning about liveness — only the table and the
 * wording differ, and that is exactly what these tests are checking rather
 * than re-proving `BEGIN IMMEDIATE` correctness (sendlock.test.ts already
 * does that against real, racing processes).
 */

const NOW = new Date('2026-08-13T10:00:00Z');
const db = (): DatabaseCtor.Database => new DatabaseCtor(':memory:');

describe('IngestLock', () => {
  it('lets one in and names the holder to the other', () => {
    const lock = new IngestLock(db(), () => true);
    const first = lock.acquire(NOW, 111);
    const second = lock.acquire(NOW, 222);

    expect('release' in first).toBe(true);
    expect(second).toMatchObject({ held: expect.stringContaining('pid 111') });
  });

  it('takes over a holder that is gone', () => {
    const lock = new IngestLock(db(), (pid) => pid !== 111);
    lock.acquire(NOW, 111);

    const after = lock.acquire(NOW, 222);

    expect('release' in after).toBe(true);
  });

  it('a release frees it without deleting the row', () => {
    const database = db();
    const lock = new IngestLock(database, () => true);
    const held = lock.acquire(NOW, 111);
    if (!('release' in held)) throw new Error('expected to hold it');

    held.release();

    // Never delete rows (§I-8): the row survives, only the holder clears.
    const row = database.prepare(`SELECT pid, taken_at FROM ingest_lock WHERE id = 1`).get() as {
      pid: number | null;
      taken_at: string;
    };
    expect(row.pid).toBeNull();
    expect(row.taken_at).toBe(NOW.toISOString());
    expect('release' in lock.acquire(NOW, 222)).toBe(true);
  });

  it('a release never frees a lock this run does not hold', () => {
    // The takeover case: 222 took it from a dead 111, and 111's own release
    // (arriving late) must not then unlock 222.
    const lock = new IngestLock(db(), (pid) => pid !== 111);
    const stale = lock.acquire(NOW, 111);
    lock.acquire(NOW, 222);
    if (!('release' in stale)) throw new Error('expected 111 to have held it');

    stale.release();

    expect(lock.acquire(NOW, 333)).toMatchObject({ held: expect.stringContaining('pid 222') });
  });

  it('a genuinely alive holder is not stolen just for missing the ordinary horizon (P20)', () => {
    // `alive` says true throughout — a batch that is genuinely still running,
    // not a corpse. Before the fix, the wall clock alone decided this at
    // `STALE_AFTER_MS`, never consulting `alive` at all.
    const lock = new IngestLock(db(), () => true);
    lock.acquire(NOW, 111);

    const soon = new Date(NOW.getTime() + STALE_AFTER_MS - 1000);
    expect(lock.acquire(soon, 222)).toMatchObject({ held: expect.stringContaining('111') });

    const pastOrdinary = new Date(NOW.getTime() + STALE_AFTER_MS + 1000);
    expect(lock.acquire(pastOrdinary, 222)).toMatchObject({ held: expect.stringContaining('111') });
  });

  it('an old claim is stale past the hard horizon, whatever its pid says — the pid-reuse backstop', () => {
    const lock = new IngestLock(db(), () => true);
    lock.acquire(NOW, 111);

    const pastHard = new Date(NOW.getTime() + STALE_AFTER_MS * HARD_STALE_MULTIPLIER + 1000);
    expect('release' in lock.acquire(pastHard, 222)).toBe(true);
  });

  it('survives a home that has never taken it', () => {
    // The table is created by the constructor, so the first `ingestPending`
    // call on a real home must not die on "no such table".
    const home = mkdtempSync(join(tmpdir(), 'muffin-ingestlock-'));
    const database = new DatabaseCtor(join(home, 'muffin.db'));
    expect('release' in new IngestLock(database).acquire(NOW)).toBe(true);
    database.close();
  });
});
