import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { newActivityAllowance } from '../turns/activity-allowance.js';
import { TURN_STORE_SCHEMA } from '../turns/schema.js';
import { migrate, SchemaAheadError, schemaVersionOf } from './migrate.js';

const priorWriter = [{ version: 9, description: 'previous release schema ceiling', up: () => {} }];

describe('activity allowance semantic schema compatibility', () => {
  it('preserves populated v9 counters and refuses the previous writer before execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-activity-schema-'));
    const db = new DatabaseCtor(join(root, 'muffin.db'));
    try {
      migrate(db, { backupDir: join(root, 'backups'), migrations: priorWriter });
      db.exec(TURN_STORE_SCHEMA);
      const counters = JSON.stringify({
        iterations: 7,
        activityAllowance: {
          ...newActivityAllowance({
            maxModelCalls: 128,
            maxToolCalls: 256,
            maxAutomaticContinuations: 3,
          }),
          modelCallsUsed: 7,
          toolCallsUsed: 4,
        },
      });
      db.prepare(
        `INSERT INTO turns (id,principal,tenant,surface,session_id,model,messages,taint,counters,status,created_at,updated_at) VALUES ('activity','{"kind":"owner","connector":"cli","externalId":"local"}','host','cli','session','test','[]',0,?,'interrupted','2026-10-13','2026-10-13')`,
      ).run(counters);
      const before = db.prepare('SELECT * FROM turns').get();
      const result = migrate(db, { backupDir: join(root, 'backups') });
      expect(result.applied).toEqual([10]);
      expect(schemaVersionOf(db)).toBe(10);
      expect(db.prepare('SELECT * FROM turns').get()).toEqual(before);
      expect(result.backup).not.toBeNull();
      const backup = new DatabaseCtor(result.backup!, { readonly: true });
      expect(schemaVersionOf(backup)).toBe(9);
      expect(backup.prepare('SELECT * FROM turns').get()).toEqual(before);
      backup.close();
      expect(() =>
        migrate(db, { backupDir: join(root, 'old-backups'), migrations: priorWriter }),
      ).toThrow(SchemaAheadError);
      expect(db.prepare('SELECT * FROM turns').get()).toEqual(before);
      expect(migrate(db, { backupDir: join(root, 'backups') }).applied).toEqual([]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
