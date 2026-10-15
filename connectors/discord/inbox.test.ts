import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DiscordInbox } from './inbox.js';

/**
 * #860: il bind durevole evento → Work. Senza, un crash fra il turno e
 * `markProcessed` fa ripartire il messaggio con un Work nuovo e gli effetti
 * possono eseguirsi due volte. Questi test pinnano il bind first-writer-wins
 * e il settle; il riuso dell'id nel recovery è in `connector.test.ts`.
 */
describe('DiscordInbox.bindWork — first-writer-wins', () => {
  it('il primo vince, il secondo ritrova lo stesso id come taken', () => {
    const inbox = new DiscordInbox(new DatabaseCtor(':memory:'));
    inbox.accept('m1', { id: 'm1' }, '2026-10-15T10:00:00Z');
    const first = inbox.bindWork('m1', 'work-A');
    expect(first).toEqual({ workId: 'work-A', mine: true });
    const second = inbox.bindWork('m1', 'work-B');
    expect(second).toEqual({ workId: 'work-A', mine: false });
    expect(inbox.boundWork('m1')).toBe('work-A');
  });

  it('riga sconosciuta: errore rumoroso, mai un bind fantasma', () => {
    const inbox = new DiscordInbox(new DatabaseCtor(':memory:'));
    expect(() => inbox.bindWork('mai-visto', 'w')).toThrow();
    expect(inbox.boundWork('mai-visto')).toBeNull();
  });

  it('settle e settledAt sopravvivono al giro', () => {
    const inbox = new DiscordInbox(new DatabaseCtor(':memory:'));
    inbox.accept('m1', { id: 'm1' }, '2026-10-15T10:00:00Z');
    expect(inbox.settledAt('m1')).toBeNull();
    inbox.settle('m1', '2026-10-15T10:01:00Z');
    expect(inbox.settledAt('m1')).toBe('2026-10-15T10:01:00Z');
  });

  it('la migrazione è additiva: righe vecchie senza colonne leggono NULL', () => {
    const db = new DatabaseCtor(':memory:');
    db.exec(
      `CREATE TABLE discord_messages (message_id TEXT PRIMARY KEY, payload TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT, failure TEXT)`,
    );
    db.prepare(`INSERT INTO discord_messages (message_id, payload, received_at) VALUES ('m9', '{}', '2026-10-15T10:00:00Z')`).run();
    const inbox = new DiscordInbox(db);
    expect(inbox.boundWork('m9')).toBeNull();
    expect(inbox.settledAt('m9')).toBeNull();
    expect(inbox.bindWork('m9', 'w9')).toEqual({ workId: 'w9', mine: true });
  });
});
