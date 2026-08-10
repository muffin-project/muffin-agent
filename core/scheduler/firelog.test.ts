import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FireLog } from './firelog.js';

const AT = new Date('2026-05-14T10:00:00Z');

function fileDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'muffin-firelog-')), 'muffin.db');
}

describe('FireLog', () => {
  it('survives a restart — a dedup that forgets re-fires the same nudge every boot', () => {
    const path = fileDb();
    const first = new DatabaseCtor(path);
    new FireLog(first).record({ anchor: 'absence:7:2026-05-01', kind: 'gone_quiet', decidedAt: AT, effect: 'allow', reason: 'p 0.004' });
    first.close();

    const second = new DatabaseCtor(path);
    try {
      expect(new FireLog(second).has('absence:7:2026-05-01')).toBe(true);
    } finally {
      second.close();
    }
  });

  it('an unknown anchor is not fired, and a different lastSeen is a different anchor', () => {
    const log = new FireLog(new DatabaseCtor(':memory:'));
    log.record({ anchor: 'absence:7:2026-05-01', kind: 'gone_quiet', decidedAt: AT, effect: 'allow', reason: 'p 0.004' });
    expect(log.has('absence:7:2026-05-01')).toBe(true);
    expect(log.has('absence:7:2026-08-01')).toBe(false);
    expect(log.has('absence:9:2026-05-01')).toBe(false);
  });

  it('a second record on the same anchor keeps the first row (§I-8)', () => {
    const log = new FireLog(new DatabaseCtor(':memory:'));
    log.record({ anchor: 'a', kind: 'gone_quiet', decidedAt: AT, effect: 'allow', reason: 'il primo' });
    log.record({ anchor: 'a', kind: 'gone_quiet', decidedAt: new Date('2026-07-01T10:00:00Z'), effect: 'allow', reason: 'il secondo' });
    const row = log.get('a');
    expect(row?.reason).toBe('il primo');
    expect(row?.decidedAt.toISOString()).toBe(AT.toISOString());
  });
});
