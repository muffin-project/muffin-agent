import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { checkInvariants, formatViolations, PREDICATE_VOCABULARY_THRESHOLD } from './invariants.js';
import { MemoryStore } from './store.js';

/**
 * Every invariant is tested by breaking it on purpose.
 *
 * A check that has never been seen to fail is a check nobody knows is wired up:
 * the store's own API refuses most of these, so the violations are written with
 * raw SQL — which is also honest about the threat model, since the ways this
 * data actually gets corrupted are a bad migration and a batch job that skips
 * the typed layer.
 */

const HOST = 'host';
const NOW = '2026-08-04T10:00:00Z';

function fixture(): { db: DatabaseCtor.Database; store: MemoryStore; entity: number; episode: number } {
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const entity = store.upsertEntity(HOST, 'Marco', 'person', NOW);
  const episode = store.addEpisode({
    tenantId: HOST,
    connector: 'cli',
    threadKey: 't1',
    role: 'user',
    kind: 'message',
    content: 'Marco è il mio commercialista',
    trustTier: 0,
    createdAt: NOW,
  });
  return { db, store, entity, episode };
}

function addFact(
  f: ReturnType<typeof fixture>,
  overrides: Partial<{ predicate: string; value: string; tier: 0 | 1 | 2 | 3 }> = {},
): number {
  return f.store.addFact({
    tenantId: HOST,
    subjectId: f.entity,
    predicate: overrides.predicate ?? 'role',
    objectValue: overrides.value ?? 'commercialista',
    episodeId: f.episode,
    trustTier: overrides.tier ?? 0,
    confidence: 0.9,
    extractionV: 1,
    recordedAt: NOW,
  });
}

function ids(f: ReturnType<typeof fixture>): string[] {
  return checkInvariants(f.db).map((v) => v.id);
}

describe('graph invariants', () => {
  it('says nothing on a clean graph', () => {
    const f = fixture();
    addFact(f);
    expect(checkInvariants(f.db)).toEqual([]);
    expect(formatViolations([], 1)).toContain('rispettati');
    expect(formatViolations([], 0)).toContain('vuoto');
  });

  it('catches an active fact that already has a successor', () => {
    const f = fixture();
    const a = addFact(f);
    const b = addFact(f, { value: 'ex commercialista' });
    f.db.prepare(`UPDATE facts SET superseded_by = ? WHERE id = ?`).run(b, a);
    expect(ids(f)).toContain('active_fact_superseded');
  });

  it('catches a successor that does not exist', () => {
    // better-sqlite3 keeps `foreign_keys` ON, so this state cannot be reached
    // through normal writes — it is reached the way SQLite corruption actually
    // happens: a table rewrite or a restored dump, both of which run with the
    // pragma off. The check earns its place there, not in the happy path.
    const f = fixture();
    const a = addFact(f);
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
    f.db.pragma('foreign_keys = OFF');
    f.db.prepare(`UPDATE facts SET superseded_by = 9999, expired_at = ? WHERE id = ?`).run(NOW, a);
    f.db.pragma('foreign_keys = ON');
    expect(ids(f)).toContain('supersede_dangling');
  });

  it('catches trust rising between an episode and the fact drawn from it', () => {
    // The one that breaks memory poisoning in the data model: a group message is
    // tier 2, so nothing derived from it may claim to be owner-grade.
    const f = fixture();
    f.db.prepare(`UPDATE episodes SET trust_tier = 2 WHERE id = ?`).run(f.episode);
    addFact(f, { tier: 0 });
    expect(ids(f)).toContain('trust_tier_raised');
  });

  it('catches a fact whose provenance or subject lives in another tenant', () => {
    const f = fixture();
    const factId = addFact(f);
    f.db.prepare(`UPDATE facts SET tenant_id = 'group:telegram:42' WHERE id = ?`).run(factId);
    const found = ids(f);
    expect(found).toContain('tenant_crossed_provenance');
    expect(found).toContain('tenant_crossed_subject');
  });

  it('catches a fact retired before it was learned', () => {
    const f = fixture();
    const factId = addFact(f);
    f.db.prepare(`UPDATE facts SET expired_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(factId);
    expect(ids(f)).toContain('expired_before_recorded');
  });

  it('catches an identity confirmed without saying on what', () => {
    const f = fixture();
    f.db
      .prepare(
        `INSERT INTO identities (tenant_id, connector, external_id, link_status) VALUES (?, 'telegram', '123', 'confirmed')`,
      )
      .run(HOST);
    expect(ids(f)).toContain('confirmed_without_evidence');
  });

  it('catches two current values for a predicate declared functional', () => {
    const f = fixture();
    addFact(f, { predicate: 'date_of_birth', value: '1997-03-12' });
    addFact(f, { predicate: 'date_of_birth', value: '1998-04-01' });
    expect(ids(f)).toContain('functional_predicate_multivalued');
  });

  it('catches a chunk with no vector — the failure that reports success', () => {
    // Exactly the shape of the old system's silent damage: rows in `chunks`,
    // nothing in `chunks_vec`, and recall quietly falling back to keywords.
    const f = fixture();
    f.db.exec(`CREATE TABLE chunks (id INTEGER PRIMARY KEY, tenant_id TEXT, source_kind TEXT, source_id INTEGER, text TEXT, embedding_v TEXT, created_at TEXT)`);
    f.db.exec(`CREATE TABLE chunks_vec (rowid INTEGER PRIMARY KEY)`);
    f.db.prepare(`INSERT INTO chunks VALUES (1, ?, 'episode', ?, 'testo', 'ollama:x', ?)`).run(HOST, f.episode, NOW);
    expect(ids(f)).toContain('vector_desync');
  });

  it('escalates a swollen vocabulary as a warning, never as an error', () => {
    const f = fixture();
    for (let i = 0; i <= PREDICATE_VOCABULARY_THRESHOLD; i += 1) {
      addFact(f, { predicate: `predicato_${i}`, value: 'x' });
    }
    const violations = checkInvariants(f.db);
    const vocab = violations.find((v) => v.id === 'predicate_vocabulary');
    expect(vocab?.severity).toBe('warning');
    expect(violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('does not mistake a missing vector table for corruption', () => {
    // Before the first embedder run there is no `chunks_vec` at all. A health
    // check that screams on a fresh install is a health check people disable.
    const f = fixture();
    addFact(f);
    expect(checkInvariants(f.db)).toEqual([]);
  });
});
