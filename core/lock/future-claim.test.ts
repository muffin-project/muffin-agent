import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  formatAhead,
  futureLockCheckName,
  futureLockClaims,
  futureLockDetail,
  futureLockRemedy,
  msAhead,
} from './future-claim.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();

function db(): DatabaseCtor.Database {
  return new DatabaseCtor(':memory:');
}

describe('msAhead — a future stamp, with no tolerance', () => {
  it('is null for the past, for now, and for a stamp that is not a time', () => {
    expect(msAhead(ahead(-1), NOW)).toBeNull();
    expect(msAhead(new Date(NOW).toISOString(), NOW)).toBeNull();
    expect(msAhead(null, NOW)).toBeNull();
    expect(msAhead('non è una data', NOW)).toBeNull();
  });

  it('returns the exact gap, including a single millisecond', () => {
    expect(msAhead(ahead(1), NOW)).toBe(1);
    expect(msAhead(ahead(3_600_000), NOW)).toBe(3_600_000);
  });
});

describe('futureLockClaims', () => {
  it('names a gateway, a send, an ingest and a running turn whose stamp is ahead', () => {
    const database = db();
    database.exec(`
      CREATE TABLE gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER, taken_at TEXT, holder_id TEXT, since TEXT, status TEXT);
      CREATE TABLE send_lock (id INTEGER PRIMARY KEY, pid INTEGER, taken_at TEXT, holder_id TEXT);
      CREATE TABLE ingest_lock (id INTEGER PRIMARY KEY, pid INTEGER, taken_at TEXT, holder_id TEXT);
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, status TEXT, claimed_by INTEGER, updated_at TEXT, claim_token TEXT
      );
    `);
    database
      .prepare(
        `INSERT INTO gateway_lock (id, pid, taken_at, holder_id, since, status) VALUES (1, ?, ?, ?, ?, 'serving')`,
      )
      .run(11, ahead(7_200_000), 'inc-gw.token', ahead(-86_400_000));
    database
      .prepare(`INSERT INTO send_lock (id, pid, taken_at, holder_id) VALUES (1, ?, ?, ?)`)
      .run(22, ahead(60_000), 'inc-send.token');
    database
      .prepare(`INSERT INTO ingest_lock (id, pid, taken_at, holder_id) VALUES (1, ?, ?, ?)`)
      .run(33, ahead(1), 'inc-ingest.token');
    database
      .prepare(
        `INSERT INTO turns (id, status, claimed_by, updated_at, claim_token) VALUES (?, 'running', ?, ?, ?)`,
      )
      .run('turn-abc', 44, ahead(90_000), 'inc-turn.token');
    database
      .prepare(
        `INSERT INTO turns (id, status, claimed_by, updated_at, claim_token) VALUES (?, 'done', ?, ?, ?)`,
      )
      .run('turn-done', 44, ahead(90_000), 'inc-done.token');

    const claims = futureLockClaims(database, NOW, () => false);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(['gateway', 'ingest', 'send', 'turn']);

    const gateway = claims.find((claim) => claim.kind === 'gateway');
    if (gateway === undefined) throw new Error('gateway claim missing');
    expect(gateway).toMatchObject({
      pid: 11,
      holderId: 'inc-gw.token',
      aheadMs: 7_200_000,
      holderAlive: false,
    });
    expect(futureLockDetail(gateway)).toContain('pid 11');
    expect(futureLockDetail(gateway)).toContain('holder inc-gw.token');
    expect(futureLockDetail(gateway)).toContain(formatAhead(7_200_000));
    expect(futureLockDetail(gateway)).toContain("passo d'orologio");
    expect(futureLockRemedy(gateway)).toContain('unlock --confirm');
    expect(futureLockCheckName(gateway)).toBe('lock gateway');

    const turn = claims.find((claim) => claim.kind === 'turn');
    if (turn === undefined) throw new Error('turn claim missing');
    expect(turn.id).toBe('turn-abc');
    expect(futureLockDetail(turn)).toContain('updated_at (taken_at del claim)');
    expect(claims.some((claim) => claim.id === 'turn-done')).toBe(false);
    database.close();
  });

  it('a live holder is told to stop, not to unlock', () => {
    const database = db();
    database.exec(
      `CREATE TABLE gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER, taken_at TEXT, holder_id TEXT)`,
    );
    database
      .prepare(
        `INSERT INTO gateway_lock (id, pid, taken_at, holder_id) VALUES (1, 7, ?, 'live.token')`,
      )
      .run(ahead(5_000));
    const [claim] = futureLockClaims(database, NOW, () => true);
    if (claim === undefined) throw new Error('gateway claim missing');
    expect(claim.holderAlive).toBe(true);
    expect(futureLockDetail(claim)).toContain('il detentore risulta vivo');
    expect(futureLockRemedy(claim)).toContain('gateway stop');
    expect(futureLockRemedy(claim)).not.toContain('unlock --confirm');
    database.close();
  });

  it('a freed row, a past stamp, and a missing table are not claims', () => {
    const database = db();
    database.exec(`
      CREATE TABLE gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER, taken_at TEXT);
      CREATE TABLE send_lock (id INTEGER PRIMARY KEY, pid INTEGER, taken_at TEXT);
    `);
    database
      .prepare(`INSERT INTO gateway_lock (id, pid, taken_at) VALUES (1, NULL, ?)`)
      .run(ahead(60_000));
    database.prepare(`INSERT INTO send_lock (id, pid, taken_at) VALUES (1, 9, ?)`).run(ahead(-1));
    expect(futureLockClaims(database, NOW, () => true)).toEqual([]);
    database.close();

    const empty = db();
    expect(futureLockClaims(empty, NOW, () => true)).toEqual([]);
    empty.close();
  });
});
