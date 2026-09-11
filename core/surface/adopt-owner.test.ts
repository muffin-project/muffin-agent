import DatabaseCtor from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_SCHEMA } from '../memory/schema.js';
import { adoptOwnerState } from './adopt-owner.js';

const homes: string[] = [];

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'muffin-owner-adopt-'));
  mkdirSync(join(h, 'sessions'), { recursive: true });
  homes.push(h);
  return h;
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('adoptOwnerState', () => {
  it('moves durable knowledge, rebuilds derived memory, preserves trust, and never promotes old work', () => {
    const h = home();
    const db = new DatabaseCtor(':memory:');
    db.exec(MEMORY_SCHEMA);
    db.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding_v TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE turns (id TEXT PRIMARY KEY, tenant TEXT NOT NULL);
      CREATE TABLE todos (tenant TEXT NOT NULL, session_id TEXT NOT NULL, key TEXT NOT NULL);
    `);

    const legacy = 'group:telegram:4242';
    db.prepare(
      `INSERT INTO episodes(id, tenant_id, connector, thread_key, role, kind, content, trust_tier, created_at, extraction_v)
       VALUES (1, ?, 'telegram', 'telegram:4242', 'user', 'message', 'mi chiamo Egon', 2, '2026-09-11T10:00:00.000Z', 1)`,
    ).run(legacy);
    db.prepare(`INSERT INTO entities(id, tenant_id, kind, name, recorded_at) VALUES (1, ?, 'person', 'owner', '2026-09-11T10:00:00.000Z')`).run(legacy);
    db.prepare(`INSERT INTO identities(id, tenant_id, connector, external_id, link_status) VALUES (1, ?, 'telegram', '4242', 'unlinked')`).run(legacy);
    db.prepare(
      `INSERT INTO facts(id, tenant_id, subject_id, predicate, object_value, recorded_at, episode_id, trust_tier, confidence, extraction_v)
       VALUES (1, ?, 1, 'legal_name', 'Egon', '2026-09-11T10:00:01.000Z', 1, 2, 0.9, 1)`,
    ).run(legacy);
    db.prepare(`INSERT INTO profiles(entity_id, tenant_id, text, generated_at, extraction_v) VALUES (1, ?, 'profilo vecchio', '2026-09-11T10:01:00.000Z', 1)`).run(legacy);
    db.prepare(`INSERT INTO digests(id, tenant_id, scope, text, covers_from, covers_to, generated_at) VALUES (1, ?, 'day', 'digest vecchio', 'a', 'b', '2026-09-11T10:01:00.000Z')`).run(legacy);
    db.prepare(`INSERT INTO chunks(id, tenant_id, source_kind, source_id, text, embedding_v, created_at) VALUES (1, ?, 'episode', 1, 'mi chiamo Egon', 'fake', '2026-09-11T10:01:00.000Z')`).run(legacy);
    db.prepare(`INSERT INTO turns(id, tenant) VALUES ('old-turn', ?)`).run(legacy);
    db.prepare(`INSERT INTO todos(tenant, session_id, key) VALUES (?, 'telegram:4242', 'old-todo')`).run(legacy);

    writeFileSync(
      join(h, 'sessions', 'owner.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'dal terminale', surface: 'cli', createdAt: '2026-09-11T09:00:00.000Z' })}\n`,
    );
    writeFileSync(
      join(h, 'sessions', 'telegram:4242.jsonl'),
      [
        { role: 'user', content: 'ciao', surface: 'telegram', createdAt: '2026-09-11T10:00:00.000Z', tier: 2 },
        { role: 'assistant', content: 'ciao', surface: 'telegram', createdAt: '2026-09-11T10:00:01.000Z', tier: 2 },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n',
    );

    const first = adoptOwnerState(db, h, 'telegram', '4242');
    expect(first.movedRows).toBeGreaterThan(0);
    expect(first.transcriptRows).toBe(3);

    expect((db.prepare(`SELECT tenant_id AS t, trust_tier AS tier FROM episodes WHERE id = 1`).get() as { t: string; tier: number })).toEqual({ t: 'host', tier: 2 });
    expect((db.prepare(`SELECT tenant_id AS t, trust_tier AS tier FROM facts WHERE id = 1`).get() as { t: string; tier: number })).toEqual({ t: 'host', tier: 2 });
    expect((db.prepare(`SELECT tenant_id AS t FROM entities WHERE id = 1`).get() as { t: string }).t).toBe('host');
    expect((db.prepare(`SELECT tenant_id AS t FROM identities WHERE id = 1`).get() as { t: string }).t).toBe('host');
    expect((db.prepare(`SELECT count(*) AS n FROM profiles`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT count(*) AS n FROM digests`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number }).n).toBe(0);

    // Historical work retains the authority boundary under which it was made.
    expect((db.prepare(`SELECT tenant FROM turns WHERE id = 'old-turn'`).get() as { tenant: string }).tenant).toBe(legacy);
    expect((db.prepare(`SELECT tenant FROM todos WHERE key = 'old-todo'`).get() as { tenant: string }).tenant).toBe(legacy);

    const ownerRows = readFileSync(join(h, 'sessions', 'owner.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { content: string; tier?: number });
    expect(ownerRows.map((row) => row.content)).toEqual(['dal terminale', 'ciao', 'ciao']);
    expect(ownerRows.slice(1).map((row) => row.tier)).toEqual([2, 2]);
    expect(existsSync(join(h, 'sessions', 'telegram:4242.jsonl'))).toBe(false);
    expect(readdirSync(join(h, 'sessions')).some((name) => name.startsWith('telegram:4242.adopted-'))).toBe(true);

    // A retry after pairing/restart neither duplicates transcript nor rewrites work.
    const second = adoptOwnerState(db, h, 'telegram', '4242');
    expect(second.movedRows).toBe(0);
    expect(second.transcriptRows).toBe(0);
    expect(readFileSync(join(h, 'sessions', 'owner.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);

    db.close();
  });

  it('also adopts the corrected direct tenant used before pairing', () => {
    const h = home();
    const db = new DatabaseCtor(':memory:');
    db.exec(MEMORY_SCHEMA);
    db.prepare(
      `INSERT INTO episodes(id, tenant_id, connector, thread_key, role, kind, content, trust_tier, created_at, extraction_v)
       VALUES (1, 'direct:telegram:99', 'telegram', 'telegram:99', 'user', 'message', 'prima del pairing', 2, '2026-09-11T10:00:00.000Z', 1)`,
    ).run();

    adoptOwnerState(db, h, 'telegram', '99');
    expect((db.prepare(`SELECT tenant_id AS t, trust_tier AS tier FROM episodes WHERE id = 1`).get() as { t: string; tier: number })).toEqual({ t: 'host', tier: 2 });
    db.close();
  });
});
