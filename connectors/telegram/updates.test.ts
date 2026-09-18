import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { UpdateInbox } from './updates.js';

/**
 * The property under test is the one that loses data when it is wrong, and it
 * cannot be observed by a passing turn: Telegram never resends a confirmed
 * update, so the window between "offset advanced" and "message handled" is a
 * window where a crash is permanent loss.
 */

const NOW = '2026-08-06T10:00:00Z';
const inbox = () => new UpdateInbox(new DatabaseCtor(':memory:'));

describe('telegram inbox', () => {
  it('writes the batch and advances the offset together', () => {
    const box = inbox();
    expect(box.nextOffset()).toBe(0);

    const result = box.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    expect(result).toEqual({ stored: 2, duplicates: 0, accepted: [10, 11] });
    expect(box.nextOffset()).toBe(12);
    expect(box.pending().map((u) => u.updateId)).toEqual([10, 11]);
  });

  it('absorbs a redelivery instead of answering twice', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    const again = box.accept([{ update_id: 11 }, { update_id: 12 }], NOW);
    expect(again).toEqual({ stored: 1, duplicates: 1, accepted: [12] });
    expect(box.stats().total).toBe(3);
  });

  it('keeps a redelivered update out of pending once it was handled', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.markProcessed(10, NOW);
    box.accept([{ update_id: 10 }], NOW);
    expect(box.pending()).toHaveLength(0);
  });

  it('survives a crash between accepting and processing', () => {
    const db = new DatabaseCtor(':memory:');
    new UpdateInbox(db).accept([{ update_id: 10 }, { update_id: 11 }], NOW);

    const afterRestart = new UpdateInbox(db);
    expect(afterRestart.pending().map((u) => u.updateId)).toEqual([10, 11]);
    expect(afterRestart.nextOffset()).toBe(12);
  });

  it('keeps a failed update pending rather than dropping it', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.markFailed(10, 'provider 500');
    expect(box.pending().map((u) => u.updateId)).toEqual([10]);
    expect(box.stats()).toEqual({ total: 1, pending: 1, failed: 1 });
  });

  it('clears the failure when a retry succeeds', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.markFailed(10, 'provider 500');
    box.markProcessed(10, NOW);
    expect(box.stats()).toEqual({ total: 1, pending: 0, failed: 0 });
  });

  it('keeps the payload exactly as it arrived', () => {
    const box = inbox();
    box.accept([{ update_id: 10, message: { text: 'ciao 🧁', chat: { id: -100 } } } as never], NOW);
    const stored = JSON.parse(box.pending()[0]!.payload) as { message: { text: string } };
    expect(stored.message.text).toBe('ciao 🧁');
  });

  it('does nothing on an empty batch, including to the offset', () => {
    const box = inbox();
    box.accept([{ update_id: 7 }], NOW);
    expect(box.accept([], NOW)).toEqual({ stored: 0, duplicates: 0, accepted: [] });
    expect(box.nextOffset()).toBe(8);
  });
});

/**
 * ADR-0052: native event, composition and Work are different identities.
 * `StoredUpdate.turnId` remains the connector-facing Work view, but the store
 * derives it from composition membership rather than writing it on the event.
 */
describe('UpdateInbox composition -> Work binding', () => {
  it('a fresh event has neither a composition nor a Work', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);

    expect(box.compositionOf(10)).toBeNull();
    expect(box.get(10)).toEqual({
      updateId: 10,
      payload: JSON.stringify({ update_id: 10 }),
      receivedAt: NOW,
      turnId: null,
      settledAt: null,
    });
  });

  it('the singleton fallback creates a composition distinct from the Work id', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);

    expect(box.bind(10, 'turn-a')).toBe('turn-a');
    const relation = box.compositionOf(10)!;
    expect(relation.workId).toBe('turn-a');
    expect(relation.compositionId).not.toBe('turn-a');
    expect(relation.compositionId).toContain('update:10');
    expect(box.get(10)?.turnId).toBe('turn-a');
  });

  it('composition membership is first-writer-wins: a retry cannot move an event', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);

    expect(box.include(10, 'album:77')).toBe('album:77');
    expect(box.include(10, 'album:other')).toBe('album:77');
    expect(box.compositionOf(10)).toEqual({ compositionId: 'album:77', workId: null });
  });

  it('N native events may share one composition and therefore one Work', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    box.include(10, 'album:77');
    box.include(11, 'album:77');

    expect(box.bind(10, 'turn-a')).toBe('turn-a');
    expect(box.get(10)?.turnId).toBe('turn-a');
    expect(box.get(11)?.turnId).toBe('turn-a');
    expect(box.compositionOf(11)).toEqual({ compositionId: 'album:77', workId: 'turn-a' });
  });

  it('the Work binding is first-writer-wins across different members of the same composition', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    box.include(10, 'album:77');
    box.include(11, 'album:77');

    expect(box.bind(10, 'turn-a')).toBe('turn-a');
    expect(box.bind(11, 'turn-b')).toBe('turn-a');
    expect(box.get(10)?.turnId).toBe('turn-a');
    expect(box.get(11)?.turnId).toBe('turn-a');
  });

  it('a restart finds the same composition and Work binding', () => {
    const db = new DatabaseCtor(':memory:');
    const first = new UpdateInbox(db);
    first.accept([{ update_id: 10 }], NOW);
    first.include(10, 'gesture:a');
    first.bind(10, 'turn-a');

    const afterRestart = new UpdateInbox(db);
    expect(afterRestart.compositionOf(10)).toEqual({ compositionId: 'gesture:a', workId: 'turn-a' });
    expect(afterRestart.bind(10, 'turn-b')).toBe('turn-a');
  });
});

describe('UpdateInbox.settle — settlement is composition-wide once Work exists', () => {
  it('marks settled_at once', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.bind(10, 'turn-a');
    expect(box.get(10)?.settledAt).toBeNull();
    box.settle(10, NOW);
    expect(box.get(10)?.settledAt).toBe(NOW);
  });

  it('a second settle never moves settled_at', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.bind(10, 'turn-a');
    box.settle(10, NOW);
    const LATER = '2026-08-06T11:00:00Z';
    box.settle(10, LATER);
    expect(box.get(10)?.settledAt).toBe(NOW);
  });

  it('settling one member settles every native event consumed by the same composition', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    box.include(10, 'album:77');
    box.include(11, 'album:77');
    box.bind(10, 'turn-a');

    box.settle(10, NOW);
    expect(box.get(10)?.settledAt).toBe(NOW);
    expect(box.get(11)?.settledAt).toBe(NOW);

    box.markProcessed(10, NOW);
    expect(box.pending()).toHaveLength(0);
  });

  it('settle on an update that was never accepted touches nothing', () => {
    const box = inbox();
    expect(() => box.settle(999, NOW)).not.toThrow();
    expect(box.get(999)).toBeNull();
  });
});

describe('UpdateInbox — additive schema evolution', () => {
  it('adds composition_id/settled_at to a pre-slice database without losing rows', () => {
    const db = new DatabaseCtor(':memory:');
    db.exec(`
      CREATE TABLE telegram_updates (
        update_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, received_at TEXT NOT NULL,
        processed_at TEXT, failure TEXT
      );
    `);
    db.prepare(`INSERT INTO telegram_updates (update_id, payload, received_at) VALUES (?, ?, ?)`).run(
      5,
      JSON.stringify({ update_id: 5 }),
      NOW,
    );

    const box = new UpdateInbox(db);
    const columns = (db.prepare(`PRAGMA table_info(telegram_updates)`).all() as { name: string }[]).map((c) => c.name);
    expect(columns.sort()).toEqual(
      ['failure', 'payload', 'processed_at', 'received_at', 'composition_id', 'settled_at', 'update_id'].sort(),
    );

    expect(box.get(5)).toEqual({
      updateId: 5,
      payload: JSON.stringify({ update_id: 5 }),
      receivedAt: NOW,
      turnId: null,
      settledAt: null,
    });
    expect(box.bind(5, 'turn-a')).toBe('turn-a');
  });

  it('migrates a dogfood database written by the old #78 direct turn_id bridge', () => {
    const db = new DatabaseCtor(':memory:');
    db.exec(`
      CREATE TABLE telegram_updates (
        update_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, received_at TEXT NOT NULL,
        processed_at TEXT, failure TEXT, turn_id TEXT, settled_at TEXT
      );
      INSERT INTO telegram_updates (update_id, payload, received_at, turn_id)
      VALUES (5, '{"update_id":5}', '${NOW}', 'turn-old');
    `);

    const box = new UpdateInbox(db);
    expect(box.get(5)?.turnId).toBe('turn-old');
    const relation = box.compositionOf(5)!;
    expect(relation.workId).toBe('turn-old');
    expect(relation.compositionId).not.toBe('turn-old');
    expect(box.bind(5, 'turn-new')).toBe('turn-old');
  });
});

describe('UpdateInbox.sealIgnored — a gate refusal ends terminal, body retired', () => {
  it('one statement takes an ignored update terminal: settled, processed, body stubbed', () => {
    const box = inbox();
    box.accept([{ update_id: 10, message: { text: 'ragazzi che si fa stasera' } } as never], NOW);
    box.sealIgnored(10, NOW);
    const row = box.get(10)!;
    expect(JSON.parse(row.payload)).toEqual({ scrubbed: true, update_id: 10 });
    expect(row.payload).not.toContain('stasera');
    expect(row.updateId).toBe(10);
    expect(row.receivedAt).toBe(NOW);
    expect(row.settledAt).toBe(NOW);
    expect(row.turnId).toBeNull();
    expect(box.pending()).toHaveLength(0);
    expect(box.stats()).toEqual({ total: 1, pending: 0, failed: 0 });
  });

  it('a crash before the seal leaves the row pending with its body recoverable', () => {
    const box = inbox();
    box.accept([{ update_id: 10, message: { text: 'ragazzi che si fa stasera' } } as never], NOW);
    // Nothing terminal ran: still pending, body intact for the re-drive.
    expect(box.pending().map((u) => u.updateId)).toEqual([10]);
    expect(JSON.parse(box.get(10)!.payload)).toMatchObject({ update_id: 10 });
  });

  it('a restart never re-runs a sealed refusal, and a redelivery is absorbed', () => {
    const db = new DatabaseCtor(':memory:');
    const first = new UpdateInbox(db);
    first.accept([{ update_id: 10 }], NOW);
    first.sealIgnored(10, NOW);

    const afterRestart = new UpdateInbox(db);
    expect(afterRestart.pending()).toHaveLength(0);
    expect(afterRestart.nextOffset()).toBe(11);
    expect(afterRestart.get(10)?.settledAt).toBe(NOW);
    const again = afterRestart.accept([{ update_id: 10 }], NOW);
    expect(again).toEqual({ stored: 0, duplicates: 1, accepted: [] });
    expect(afterRestart.pending()).toHaveLength(0);
  });

  it('a prior failure is cleared: terminal means no retry', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.markFailed(10, 'provider 500');
    box.sealIgnored(10, NOW);
    expect(box.stats()).toEqual({ total: 1, pending: 0, failed: 0 });
  });

  it('fail-closed: a composed row is left alone', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.bind(10, 'turn-a');
    box.sealIgnored(10, NOW);
    const row = box.get(10)!;
    expect(row.payload).toBe(JSON.stringify({ update_id: 10 }));
    expect(row.settledAt).toBeNull();
    expect(row.turnId).toBe('turn-a');
    expect(box.pending().map((u) => u.updateId)).toEqual([10]);
  });

  it('re-sealing keeps the first settlement timestamp', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.sealIgnored(10, NOW);
    box.sealIgnored(10, '2026-08-06T11:00:00Z');
    expect(box.get(10)?.settledAt).toBe(NOW);
  });
});

