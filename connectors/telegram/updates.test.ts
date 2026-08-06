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
