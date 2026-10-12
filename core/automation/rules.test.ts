import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutomationRuleStore } from './rules.js';

const origin = {
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' } as const,
  surface: 'cli',
  turnId: 'turn-create',
  tier: 0 as const,
};

describe('AutomationRuleStore', () => {
  it('persists a non-time rule across a database reopen', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-automation-rules-'));
    const file = join(home, 'rules.db');

    const firstDb = new DatabaseCtor(file);
    const first = new AutomationRuleStore(firstDb, () => new Date('2026-10-07T12:00:00.000Z'));
    const created = first.create({
      id: 'morning',
      tenant: 'host',
      eventKind: 'message.received',
      matcher: { type: 'evidence_equals', key: 'text', value: 'buongiorno' },
      action: { mode: 'deterministic', ref: 'test.checked' },
      origin,
    });
    expect(created.version).toBe(1);
    firstDb.close();

    const secondDb = new DatabaseCtor(file);
    const second = new AutomationRuleStore(secondDb);
    expect(second.listEnabled('host', 'message.received')).toEqual([
      expect.objectContaining({
        id: 'morning',
        tenant: 'host',
        eventKind: 'message.received',
        matcher: { type: 'evidence_equals', key: 'text', value: 'buongiorno' },
        action: { mode: 'deterministic', ref: 'test.checked' },
        origin,
        enabled: true,
        version: 1,
      }),
    ]);
    secondDb.close();
  });

  it('rejects time-based rules because JobStore owns schedule.fire', () => {
    const db = new DatabaseCtor(':memory:');
    const store = new AutomationRuleStore(db);
    expect(() =>
      store.create({
        tenant: 'host',
        eventKind: 'schedule.fire',
        matcher: { type: 'evidence_equals', key: 'jobId', value: 'j1' },
        action: { mode: 'agent', ref: 'job.goal' },
        origin,
      }),
    ).toThrow(/JobStore/);
  });

  it('uses optimistic versioning for enable and update without execution state', () => {
    const db = new DatabaseCtor(':memory:');
    let now = new Date('2026-10-07T12:00:00.000Z');
    const store = new AutomationRuleStore(db, () => now);
    const created = store.create({
      id: 'r1',
      tenant: 'host',
      eventKind: 'message.received',
      matcher: { type: 'evidence_equals', key: 'text', value: 'ciao' },
      action: { mode: 'agent', ref: 'conversation.normal' },
      origin,
    });

    now = new Date('2026-10-07T12:01:00.000Z');
    const disabled = store.setEnabled(created.id, 1, false);
    expect(disabled).toMatchObject({ enabled: false, version: 2 });
    expect(store.listEnabled('host', 'message.received')).toEqual([]);
    expect(store.setEnabled(created.id, 1, true)).toBeNull();

    now = new Date('2026-10-07T12:02:00.000Z');
    const updated = store.update(created.id, 2, {
      matcher: { type: 'evidence_equals', key: 'text', value: 'buongiorno' },
      action: {
        mode: 'deterministic_then_agent_on_signal',
        ref: 'test.changed',
        input: { scope: 'inbox' },
      },
      origin: { ...origin, turnId: 'turn-update' },
    });
    expect(updated).toMatchObject({
      enabled: false,
      version: 3,
      matcher: { type: 'evidence_equals', key: 'text', value: 'buongiorno' },
      action: {
        mode: 'deterministic_then_agent_on_signal',
        ref: 'test.changed',
        input: { scope: 'inbox' },
      },
      origin: { ...origin, turnId: 'turn-update' },
    });
  });
});
