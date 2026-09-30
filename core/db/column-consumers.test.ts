import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { TelegramDeliveryStore } from '../../connectors/telegram/delivery.js';
import { ConsolidationLog } from '../memory/consolidator.js';
import { DecisionLog } from '../scheduler/decisions.js';

/** Insert a second real SQLite connection exactly after a stale schema read. */
function raceColumn(
  db: DatabaseCtor.Database,
  rival: DatabaseCtor.Database,
  table: string,
  ddl: string,
): { connection: DatabaseCtor.Database; raced: () => boolean } {
  let raced = false;
  const connection = {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      if (sql !== `PRAGMA table_info(${table})` || raced) return statement;
      return {
        all: () => {
          const before = statement.all();
          raced = true;
          rival.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
          return before;
        },
      };
    },
  } as unknown as DatabaseCtor.Database;
  return { connection, raced: () => raced };
}

describe('additive store migrations with a concurrent opener', () => {
  for (const { table, column, ddl, create } of [
    {
      table: 'consolidation_runs', column: 'merged', ddl: 'merged INTEGER NOT NULL DEFAULT 0',
      create: (db: DatabaseCtor.Database) => new ConsolidationLog(db),
    },
    {
      table: 'proactive_decisions', column: 'tenant_id', ddl: "tenant_id TEXT NOT NULL DEFAULT 'host'",
      create: (db: DatabaseCtor.Database) => new DecisionLog(db),
    },
    {
      table: 'telegram_delivery_parts', column: 'thread_id', ddl: 'thread_id INTEGER',
      create: (db: DatabaseCtor.Database) => new TelegramDeliveryStore(db),
    },
  ]) {
    it(`${table} opens after another process adds ${column}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'muffin-column-race-'));
      const file = join(directory, 'muffin.db');
      const db = new DatabaseCtor(file);
      const rival = new DatabaseCtor(file);
      try {
        create(db);
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        const { connection, raced } = raceColumn(db, rival, table, ddl);
        expect(() => create(connection)).not.toThrow();
        expect(raced()).toBe(true);
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        expect(columns.filter((entry) => entry.name === column)).toHaveLength(1);
      } finally {
        rival.close();
        db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
