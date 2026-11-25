import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';

// ADR-0112: pinning an existing belief on a model-originated request goes
// through `pinIfEligible`, which applies `addFact`'s pin rule to the stored row.

const HOST = 'host';
const GROUP = 'group:telegram:42';

function store(): MemoryStore {
  return new MemoryStore(new DatabaseCtor(':memory:'));
}

function episode(s: MemoryStore, tenant: string, tier: 0 | 1 | 2 | 3): number {
  return s.addEpisode({
    tenantId: tenant,
    connector: 'cli',
    threadKey: 't1',
    role: 'user',
    kind: 'message',
    content: 'nota',
    trustTier: tier,
    createdAt: '2026-08-04T10:00:00Z',
  });
}

describe('MemoryStore.pinIfEligible', () => {
  function fact(s: MemoryStore, tier: 0 | 1 | 2 | 3, origin: 'said' | 'inferred'): number {
    const me = s.upsertEntity(HOST, 'Owner', 'person', '2026-08-04T10:00:00Z');
    return s.addFact({
      tenantId: HOST,
      subjectId: me,
      predicate: 'preferisce',
      objectValue: 'risposte brevi',
      episodeId: episode(s, HOST, tier),
      trustTier: tier,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
      origin,
    });
  }

  it('pins an owner-said row on an owner-tier request, under the addFact rule', () => {
    const s = store();
    const id = fact(s, 0, 'said');
    expect(s.pinIfEligible(HOST, id, 0)).toBe(true);
    expect(s.pinnedFacts(HOST).map((f) => f.id)).toEqual([id]);
  });

  it('refuses an inferred row, a non-owner row, a tainted request, and another tenant', () => {
    const s = store();
    const inferred = fact(s, 0, 'inferred');
    const relayed = fact(s, 1, 'said');
    const said = fact(s, 0, 'said');
    expect(s.pinIfEligible(HOST, inferred, 0)).toBe(false);
    expect(s.pinIfEligible(HOST, relayed, 0)).toBe(false);
    expect(s.pinIfEligible(HOST, said, 1)).toBe(false);
    expect(s.pinIfEligible(GROUP, said, 0)).toBe(false);
    expect(s.pinnedFacts(HOST)).toHaveLength(0);
  });
});
