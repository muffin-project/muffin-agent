import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_SCHEMA } from '../../core/memory/schema.js';
import {
  MEMORY_PREDICATE,
  MEMORY_REQUEST,
  MEMORY_VALUE,
  memoryWitness,
} from './telegram-memory.js';

let db: Database.Database;

function fresh(): Database.Database {
  db = new Database(':memory:');
  db.exec(MEMORY_SCHEMA);
  return db;
}

function addWitness(
  options: {
    proposalStatus?: string;
    episodeTenant?: string;
    episodeRole?: string;
    resultingFactId?: number;
  } = {},
): void {
  const episodeTenant = options.episodeTenant ?? 'host';
  const episode = db
    .prepare(
      `INSERT INTO episodes
         (tenant_id, connector, thread_key, role, kind, content, trust_tier, created_at, turn_id)
       VALUES (?, 'telegram', 'private:owner', ?, 'message', ?, 3, '2026-10-11T00:00:00.000Z', 'turn-1')`,
    )
    .run(episodeTenant, options.episodeRole ?? 'user', MEMORY_REQUEST).lastInsertRowid;
  const entity = db
    .prepare(
      "INSERT INTO entities (tenant_id, kind, name, recorded_at) VALUES ('host', 'person', 'owner', '2026-10-11T00:00:00.000Z')",
    )
    .run().lastInsertRowid;
  const fact = db
    .prepare(
      `INSERT INTO facts
         (tenant_id, subject_id, predicate, object_value, recorded_at, episode_id,
          trust_tier, confidence, origin, extraction_v)
       VALUES ('host', ?, ?, ?, '2026-10-11T00:00:00.000Z', ?, 3, 0.8, 'said', 1)`,
    )
    .run(entity, MEMORY_PREDICATE, MEMORY_VALUE, episode).lastInsertRowid;
  db.prepare(
    `INSERT INTO memory_proposals
       (tenant_id, identity_key, subject, predicate, object_value, producer,
        source_episodes, content, trust_tier, confidence, status, resulting_fact_ids, proposed_at)
     VALUES ('host', 'test-key', 'owner', ?, ?, 'owner-stated', ?, ?, 3, 0.8, ?, ?, '2026-10-11T00:00:00.000Z')`,
  ).run(
    MEMORY_PREDICATE,
    MEMORY_VALUE,
    JSON.stringify([episode]),
    MEMORY_REQUEST,
    options.proposalStatus ?? 'accepted',
    JSON.stringify([options.resultingFactId ?? fact]),
  );
}

afterEach(() => db?.close());

describe('Telegram memory witness SQL oracle', () => {
  it('accepts one canonical owner-stated fact linked to its exact Telegram turn', () => {
    fresh();
    addWitness();
    expect(memoryWitness(db)).toEqual({ ok: true, links: 1, activeFacts: 1 });
  });

  it('rejects a proposal that is still pending', () => {
    fresh();
    addWitness({ proposalStatus: 'pending' });
    expect(memoryWitness(db)).toEqual({ ok: false, links: 0, activeFacts: 1 });
  });

  it.each([
    ['foreign tenant episode', { episodeTenant: 'direct:telegram:someone-else' }],
    ['non-user episode', { episodeRole: 'agent' }],
  ])('rejects a %s as proposal evidence', (_label, options) => {
    fresh();
    addWitness(options);
    expect(memoryWitness(db)).toEqual({ ok: false, links: 0, activeFacts: 1 });
  });

  it('rejects a proposal whose resulting fact ID does not link to the canonical fact', () => {
    fresh();
    addWitness({ resultingFactId: 999 });
    expect(memoryWitness(db)).toEqual({ ok: false, links: 0, activeFacts: 1 });
  });

  it('rejects duplicate active canonical facts even when one proposal links correctly', () => {
    fresh();
    addWitness();
    const entity = db
      .prepare("SELECT id FROM entities WHERE tenant_id = 'host' AND name = 'owner'")
      .get() as { id: number };
    const episode = db.prepare("SELECT id FROM episodes WHERE tenant_id = 'host'").get() as {
      id: number;
    };
    db.prepare(
      `INSERT INTO facts
         (tenant_id, subject_id, predicate, object_value, recorded_at, episode_id,
          trust_tier, confidence, origin, extraction_v)
       VALUES ('host', ?, ?, ?, '2026-10-11T00:00:01.000Z', ?, 3, 0.8, 'said', 1)`,
    ).run(entity.id, MEMORY_PREDICATE, MEMORY_VALUE, episode.id);
    expect(memoryWitness(db)).toEqual({ ok: false, links: 1, activeFacts: 2 });
  });
});
