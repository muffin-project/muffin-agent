import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { UpdateInbox } from './updates.js';

const NOW = '2026-08-25T03:40:00Z';

describe('ADR-0052 · composition survives before Work materialisation', () => {
  it('recovers the same composition after a crash between include and bind', () => {
    const db = new DatabaseCtor(':memory:');
    const first = new UpdateInbox(db);
    first.accept([{ update_id: 10 }], NOW);

    expect(first.include(10, 'gesture:a')).toBe('gesture:a');
    expect(first.compositionOf(10)).toEqual({ compositionId: 'gesture:a', workId: null });

    // A new store on the same durable database is the storage boundary a
    // restarted process sees. No Work existed before the crash; membership did.
    const afterRestart = new UpdateInbox(db);
    expect(afterRestart.compositionOf(10)).toEqual({ compositionId: 'gesture:a', workId: null });

    expect(afterRestart.bind(10, 'turn-a')).toBe('turn-a');
    expect(afterRestart.compositionOf(10)).toEqual({ compositionId: 'gesture:a', workId: 'turn-a' });
    expect((db.prepare(`SELECT count(*) AS n FROM telegram_compositions`).get() as { n: number }).n).toBe(1);
  });

  it('keeps N already-composed events together across that same crash boundary', () => {
    const db = new DatabaseCtor(':memory:');
    const first = new UpdateInbox(db);
    first.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    first.include(10, 'album:77');
    first.include(11, 'album:77');

    const afterRestart = new UpdateInbox(db);
    expect(afterRestart.compositionOf(10)).toEqual({ compositionId: 'album:77', workId: null });
    expect(afterRestart.compositionOf(11)).toEqual({ compositionId: 'album:77', workId: null });

    expect(afterRestart.bind(11, 'turn-a')).toBe('turn-a');
    expect(afterRestart.get(10)?.turnId).toBe('turn-a');
    expect(afterRestart.get(11)?.turnId).toBe('turn-a');

    // A competing pass that mints another Work id loses at the composition,
    // not separately on each native event.
    expect(afterRestart.bind(10, 'turn-b')).toBe('turn-a');
    expect((db.prepare(`SELECT count(*) AS n FROM telegram_compositions`).get() as { n: number }).n).toBe(1);
  });

  it('does not consume sibling events merely because an unsealed composition exists', () => {
    const db = new DatabaseCtor(':memory:');
    const box = new UpdateInbox(db);
    box.accept([{ update_id: 10 }, { update_id: 11 }], NOW);
    box.include(10, 'album:77');
    box.include(11, 'album:77');

    // Before a Work exists, membership only says these events may compose. A
    // local disposition of one event cannot silently erase the other.
    box.settle(10, NOW);
    box.markProcessed(10, NOW);

    expect(box.get(10)?.settledAt).toBe(NOW);
    expect(box.get(11)?.settledAt).toBeNull();
    expect(box.pending().map((event) => event.updateId)).toEqual([11]);
    expect(box.compositionOf(11)).toEqual({ compositionId: 'album:77', workId: null });
  });
});
