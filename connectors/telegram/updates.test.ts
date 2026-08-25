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
    expect(box.nextOffset()).toBe(0); // fresh install asks for the backlog

    const result = box.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    expect(result).toEqual({ stored: 2, duplicates: 0 });
    // Highest seen plus one, which is what Telegram wants next.
    expect(box.nextOffset()).toBe(12);
    expect(box.pending().map((u) => u.updateId)).toEqual([10, 11]);
  });

  it('absorbs a redelivery instead of answering twice', () => {
    // Happens whenever the offset write is lost after the payload write, or a
    // restart lands mid-batch.
    const box = inbox();
    box.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    const again = box.accept([{ update_id: 11 }, { update_id: 12 }], NOW);
    expect(again).toEqual({ stored: 1, duplicates: 1 });
    expect(box.stats().total).toBe(3);
  });

  it('keeps a redelivered update out of pending once it was handled', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.markProcessed(10, NOW);
    box.accept([{ update_id: 10 }], NOW); // Telegram sends it again anyway
    expect(box.pending()).toHaveLength(0);
  });

  it('survives a crash between accepting and processing', () => {
    // The whole reason this table exists. A new inbox on the same database is
    // exactly what a restart looks like.
    const db = new DatabaseCtor(':memory:');
    new UpdateInbox(db).accept([{ update_id: 10 }, { update_id: 11 }], NOW);

    const afterRestart = new UpdateInbox(db);
    expect(afterRestart.pending().map((u) => u.updateId)).toEqual([10, 11]);
    // And it does not re-ask Telegram for them: they are already on disk.
    expect(afterRestart.nextOffset()).toBe(12);
  });

  it('keeps a failed update pending rather than dropping it', () => {
    // An update that failed once may well succeed after a restart. Marking it
    // done would be the same data loss arriving by a different road.
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
    // Parsed by the caller, never here: a transport that reshapes what it stores
    // has an opinion about the message, and this one is not entitled to one.
    const box = inbox();
    box.accept([{ update_id: 10, message: { text: 'ciao 🧁', chat: { id: -100 } } } as never], NOW);
    const stored = JSON.parse(box.pending()[0]!.payload) as { message: { text: string } };
    expect(stored.message.text).toBe('ciao 🧁');
  });

  it('does nothing on an empty batch, including to the offset', () => {
    // A long poll that times out with no updates is the common case, not an edge
    // one, and it must not move anything.
    const box = inbox();
    box.accept([{ update_id: 7 }], NOW);
    expect(box.accept([], NOW)).toEqual({ stored: 0, duplicates: 0 });
    expect(box.nextOffset()).toBe(8);
  });
});

/**
 * `bind`/`settle` — the `update_id → turn_id` identity bridge
 * (`slice/inbound-unit`, ADR-0035 emendamento №6). Same `claim`/`bind`/`settle`
 * shape as `core/scheduler/job-fires.ts`'s `JobFireStore`, with `accept` above
 * standing in for `claim`: the row already exists before any handling starts,
 * so there is nothing separate to claim.
 */
describe('UpdateInbox.bind — fault points 2/3: the identity survives a crash between the two writes', () => {
  it('a fresh update starts unbound and unsettled', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    expect(box.get(10)).toEqual({ updateId: 10, payload: JSON.stringify({ update_id: 10 }), receivedAt: NOW, turnId: null, settledAt: null });
    expect(box.pending()[0]).toMatchObject({ turnId: null, settledAt: null });
  });

  it('binds a fresh update to the given turn id', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    const winner = box.bind(10, 'turn-a');
    expect(winner).toBe('turn-a');
    expect(box.get(10)?.turnId).toBe('turn-a');
  });

  it('first writer wins: a second bind for the same update returns the first id, never overwrites it', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    const first = box.bind(10, 'turn-a');
    // A second pass racing on the same update, minting its own id.
    const second = box.bind(10, 'turn-b');
    expect(first).toBe('turn-a');
    // The loser gets told the winner's id back — never its own.
    expect(second).toBe('turn-a');
    expect(box.get(10)?.turnId).toBe('turn-a');
  });

  it('binding the SAME id twice (a retried call) is idempotent', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.bind(10, 'turn-a');
    expect(box.bind(10, 'turn-a')).toBe('turn-a');
  });

  it('a restart on the same database finds the same binding — a crash after bind, before the turn, loses nothing', () => {
    // A new UpdateInbox on the same connection is exactly what a restart looks
    // like (mirrors the "survives a crash between accepting and processing"
    // test above, one column over).
    const db = new DatabaseCtor(':memory:');
    new UpdateInbox(db).accept([{ update_id: 10 }], NOW);
    const first = new UpdateInbox(db);
    first.bind(10, 'turn-a');

    const afterRestart = new UpdateInbox(db);
    expect(afterRestart.get(10)?.turnId).toBe('turn-a');
    // And re-binding after the restart resolves to the SAME id, never a new one.
    expect(afterRestart.bind(10, 'turn-b')).toBe('turn-a');
  });
});

describe('UpdateInbox.settle — fault point 7: settlement, then (and only then) the update is processed', () => {
  it('marks settled_at, once', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.bind(10, 'turn-a');
    expect(box.get(10)?.settledAt).toBeNull();
    box.settle(10, NOW);
    expect(box.get(10)?.settledAt).toBe(NOW);
  });

  it('a second settle (a delivery retry, a duplicate drain) never moves settled_at', () => {
    const box = inbox();
    box.accept([{ update_id: 10 }], NOW);
    box.bind(10, 'turn-a');
    box.settle(10, NOW);
    const LATER = '2026-08-06T11:00:00Z';
    box.settle(10, LATER);
    expect(box.get(10)?.settledAt).toBe(NOW);
  });

  it('settle on an update that was never accepted touches nothing (no row to settle)', () => {
    const box = inbox();
    expect(() => box.settle(999, NOW)).not.toThrow();
    expect(box.get(999)).toBeNull();
  });
});

describe('UpdateInbox — additive on a database written before this slice', () => {
  it('CREATE TABLE IF NOT EXISTS plus ensureColumn on a table that already has real rows loses nothing and adds no missing column', () => {
    // A stand-in for the owner's already-installed muffin.db: telegram_updates
    // exists and has a real row in it, written by the pre-slice schema.
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
    expect(columns.sort()).toEqual(['failure', 'payload', 'processed_at', 'received_at', 'turn_id', 'settled_at', 'update_id'].sort());

    // The pre-existing row is untouched and reads its new columns as NULL.
    expect(box.get(5)).toEqual({ updateId: 5, payload: JSON.stringify({ update_id: 5 }), receivedAt: NOW, turnId: null, settledAt: null });
    // And the new methods work immediately on this same, previously-unbound row.
    expect(box.bind(5, 'turn-a')).toBe('turn-a');
  });
});
