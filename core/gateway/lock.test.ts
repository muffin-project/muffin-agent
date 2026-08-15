import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { GatewayLock, readGateway, STALE_AFTER_MS } from './lock.js';

/**
 * "Two schedulers must never run", as a claim that survives a hard kill.
 *
 * The send lock already settled *how* to claim (see its docstring: the file
 * locks that failed 6/6, and why `BEGIN IMMEDIATE` ends the family). What is
 * new here is the horizon. A send is one model call, so an hour of silence
 * means the holder is gone; a gateway holds its lock for weeks, so silence
 * means nothing and a **heartbeat** has to say it is alive. Both directions are
 * tested: a beating gateway is never declared stale, and a killed one does not
 * wedge the REPL forever.
 */

const T0 = new Date('2026-08-11T09:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const db = (): DatabaseCtor.Database => new DatabaseCtor(':memory:');

describe('GatewayLock', () => {
  it('lets one gateway in and tells the second whose pid holds it', () => {
    const database = db();
    const first = new GatewayLock(database, () => true).claim(T0, 'in attesa', 4242);
    const second = new GatewayLock(database, () => true).claim(T0, 'in attesa', 4243);

    expect('release' in first).toBe(true);
    // The pid, because the remedy is `kill` or `muffin gateway stop` and both
    // need it. "Un gateway è già attivo" alone leaves the owner nothing to do.
    expect(second).toMatchObject({ held: expect.stringContaining('4242') });
  });

  it('takes over a holder that is gone, so a hard kill does not wedge it', () => {
    const database = db();
    new GatewayLock(database, () => true).claim(T0, 'in attesa', 4242);

    const after = new GatewayLock(database, (pid) => pid !== 4242).claim(at(1000), 'in attesa', 4243);

    expect('release' in after).toBe(true);
    expect(readGateway(database, at(1000), () => true)?.pid).toBe(4243);
  });

  it('a claim nobody refreshed goes stale whatever its pid says', () => {
    // The pid-reuse backstop, inherited from the send lock: after a hard kill
    // the pid can be handed to an unrelated process within hours, and a bare
    // pid check would then report a gateway that died days ago — refusing every
    // `muffin gateway run` forever.
    const database = db();
    const lock = new GatewayLock(database, () => true);
    lock.claim(T0, 'in attesa', 4242);

    expect(lock.claim(at(STALE_AFTER_MS - 1000), 'in attesa', 4243)).toMatchObject({
      held: expect.stringContaining('4242'),
    });
    expect('release' in lock.claim(at(STALE_AFTER_MS + 1000), 'in attesa', 4243)).toBe(true);
  });

  it('a heartbeat pushes the horizon out, so a live gateway is never stale', () => {
    // The property that made a fixed horizon wrong. Without the beat, a gateway
    // running normally would read as dead after five minutes and a REPL would
    // start a second scheduler beside it.
    const database = db();
    const lock = new GatewayLock(database, () => true);
    lock.claim(T0, 'in attesa', 4242);

    for (let t = 60_000; t <= STALE_AFTER_MS * 3; t += 60_000) {
      expect(lock.beat(at(t), 'in attesa', 4242)).toBe(true);
    }

    const long = at(STALE_AFTER_MS * 3 + 1000);
    expect(lock.claim(long, 'in attesa', 4243)).toMatchObject({ held: expect.stringContaining('4242') });
    expect(readGateway(database, long, () => true)?.pid).toBe(4242);
  });

  it('a heartbeat from a pid that no longer holds it changes nothing', () => {
    // After a takeover the old process may still have one timer in flight. If
    // its beat landed, a dead gateway would keep a live one's claim looking
    // like its own — and the status line would describe the wrong process.
    const database = db();
    const lock = new GatewayLock(database, (pid) => pid !== 4242);
    lock.claim(T0, 'vecchio', 4242);
    lock.claim(at(1000), 'nuovo', 4243);

    expect(lock.beat(at(2000), 'vecchio', 4242)).toBe(false);

    const info = readGateway(database, at(2000), () => true);
    expect(info?.pid).toBe(4243);
    expect(info?.status).toBe('nuovo');
  });

  it('reports since, status and the last beat — and since does not move', () => {
    // `doctor` and `gateway status` ask three different questions of this row:
    // is it up, since when, and what is it doing. "Since when" is uptime and
    // must survive every heartbeat, or it reads as a process that restarted 30
    // seconds ago, every 30 seconds.
    const database = db();
    const lock = new GatewayLock(database, () => true);
    lock.claim(T0, 'avvio', 4242);
    lock.beat(at(90_000), 'job in corso', 4242);

    const info = readGateway(database, at(90_000), () => true);
    expect(info).toMatchObject({ pid: 4242, status: 'job in corso' });
    expect(info?.since.toISOString()).toBe(T0.toISOString());
    expect(info?.lastBeat.toISOString()).toBe(at(90_000).toISOString());
  });

  it('a release frees it without deleting the row', () => {
    const database = db();
    const lock = new GatewayLock(database, () => true);
    const held = lock.claim(T0, 'in attesa', 4242);
    if (!('release' in held)) throw new Error('expected to hold it');

    held.release();

    expect(readGateway(database, at(1000), () => true)).toBeNull();
    // Never delete rows (§I-8): "when did a gateway last run here" outlives it.
    expect(
      (database.prepare(`SELECT since FROM gateway_lock WHERE id = 1`).get() as { since: string }).since,
    ).toBe(T0.toISOString());
  });
});

describe('readGateway — the reader every inspection path shares', () => {
  it('answers null on a database that has never had a gateway', () => {
    // `doctor` opens the database **readonly**, so the reader must not create
    // the table — and a home that has only ever run the REPL has no such table.
    // Throwing here would turn `muffin doctor` into a stack trace on a healthy
    // install.
    const database = db();
    expect(readGateway(database, T0, () => true)).toBeNull();
    expect(
      database.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'gateway_lock'`).get(),
    ).toMatchObject({ n: 0 });
  });

  it('judges a dead holder exactly as the claim does', () => {
    // Two liveness rules would disagree precisely around a crash, which is when
    // it matters: `doctor` saying "attivo" while `gateway run` takes the lock.
    const database = db();
    new GatewayLock(database, () => true).claim(T0, 'in attesa', 4242);
    expect(readGateway(database, at(1000), () => false)).toBeNull();
  });

  it('reports a released row as no gateway', () => {
    const database = db();
    new GatewayLock(database, () => true).claim(T0, 'in attesa', 4242);
    new GatewayLock(database, () => true).release(4242);
    expect(readGateway(database, at(1000), () => true)).toBeNull();
  });
});
