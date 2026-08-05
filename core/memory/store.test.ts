import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';

const HOST = 'host';
const GROUP = 'group:telegram:42';

function store(): MemoryStore {
  return new MemoryStore(new DatabaseCtor(':memory:'));
}

function episode(s: MemoryStore, tenant: string, content: string, tier: 0 | 1 | 2 | 3 = 0): number {
  return s.addEpisode({
    tenantId: tenant,
    connector: 'cli',
    threadKey: 't1',
    role: 'user',
    kind: 'message',
    content,
    trustTier: tier,
    createdAt: '2026-08-04T10:00:00Z',
  });
}

describe('memory store', () => {
  it('keeps tenants apart even when the names are identical', () => {
    // Two people called Marco, one the owner's accountant, one a stranger in a
    // group. Merging them is the failure that never announces itself.
    const s = store();
    const hostMarco = s.upsertEntity(HOST, 'Marco', 'person', '2026-08-04T10:00:00Z');
    const groupMarco = s.upsertEntity(GROUP, 'Marco', 'person', '2026-08-04T10:00:00Z');
    expect(hostMarco).not.toBe(groupMarco);
    expect(s.findEntity(HOST, 'Marco')).toBe(hostMarco);
    expect(s.findEntity(GROUP, 'Marco')).toBe(groupMarco);
  });

  it('never returns another tenant evidence from a search', () => {
    const s = store();
    episode(s, HOST, 'il commercialista si chiama Marco Serra');
    episode(s, GROUP, 'il commercialista si chiama Marco Falso');
    const hits = s.searchEpisodes(HOST, 'commercialista');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain('Serra');
  });

  it('accumulates set-valued predicates instead of expiring the previous one', () => {
    // The exact regression the old system had: a second interest silently
    // retired the first. Accumulating wrongly is visible; deleting wrongly is not.
    const s = store();
    const now = '2026-08-04T10:00:00Z';
    const me = s.upsertEntity(HOST, 'Giusto', 'person', now);
    const ep = episode(s, HOST, 'mi piace la fotografia e anche la vela');
    const base = { tenantId: HOST, subjectId: me, episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: now };
    s.addFact({ ...base, predicate: 'interest', objectValue: 'fotografia' });
    s.addFact({ ...base, predicate: 'interest', objectValue: 'vela' });

    const active = s.activeFacts(HOST, me, 'interest');
    expect(active.map((f) => f.objectValue).sort()).toEqual(['fotografia', 'vela']);
    expect(s.isFunctional('interest')).toBe(false);
    expect(s.isFunctional('date_of_birth')).toBe(true);
  });

  it('retires a superseded belief without losing it', () => {
    const s = store();
    const now = '2026-05-01T10:00:00Z';
    const me = s.upsertEntity(HOST, 'Giusto', 'person', now);
    const ep1 = episode(s, HOST, 'il mio commercialista è Marco');
    const ep2 = episode(s, HOST, 'ho cambiato commercialista, ora è Lucia');
    const base = { tenantId: HOST, subjectId: me, trustTier: 0 as const, confidence: 0.9, extractionV: 1 };

    const marco = s.addFact({ ...base, predicate: 'accountant', objectValue: 'Marco', episodeId: ep1, recordedAt: now });
    const lucia = s.addFact({ ...base, predicate: 'accountant', objectValue: 'Lucia', episodeId: ep2, recordedAt: '2026-07-01T10:00:00Z' });
    s.supersede(marco, lucia, '2026-07-01T10:00:00Z');

    expect(s.activeFacts(HOST, me, 'accountant').map((f) => f.objectValue)).toEqual(['Lucia']);
    // "chi era il mio commercialista a maggio" is still answerable.
    const history = s.factHistory(HOST, me, 'accountant');
    expect(history).toHaveLength(2);
    expect(history[0]?.objectValue).toBe('Marco');
    expect(history[0]?.expiredAt).toBe('2026-07-01T10:00:00Z');
    expect(history[0]?.validTo).toBe('2026-07-01T10:00:00Z');
  });

  it('does not invent a validity date that nobody stated', () => {
    const s = store();
    const now = '2026-08-04T10:00:00Z';
    const me = s.upsertEntity(HOST, 'Giusto', 'person', now);
    const ep = episode(s, HOST, 'abito a Cagliari');
    s.addFact({
      tenantId: HOST, subjectId: me, predicate: 'lives_in', objectValue: 'Cagliari',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: now,
    });
    const fact = s.activeFacts(HOST, me, 'lives_in')[0];
    expect(fact?.validFrom).toBeNull(); // world time unknown
    expect(fact?.recordedAt).toBe(now); // system time known
  });

  it('carries provenance and trust on every fact', () => {
    const s = store();
    const now = '2026-08-04T10:00:00Z';
    const someone = s.upsertEntity(GROUP, 'Tizio', 'person', now);
    const ep = episode(s, GROUP, 'Tizio dice che il bonifico va fatto a questo IBAN', 2);
    s.addFact({
      tenantId: GROUP, subjectId: someone, predicate: 'claims', objectValue: 'IBAN XX',
      episodeId: ep, trustTier: 2, confidence: 0.5, extractionV: 1, recordedAt: now,
    });
    const fact = s.activeFacts(GROUP, someone)[0];
    // Tier travels with the fact: a recall can label it, and the kernel can refuse to act on it.
    expect(fact?.trustTier).toBe(2);
    expect(fact?.episodeId).toBe(ep);
  });

  it('tracks which episodes still need extracting', () => {
    const s = store();
    const a = episode(s, HOST, 'primo');
    const b = episode(s, HOST, 'secondo');
    expect(s.pendingEpisodes(HOST, 1).map((e) => e.id)).toEqual([a, b]);
    s.markExtracted([a], 1);
    expect(s.pendingEpisodes(HOST, 1).map((e) => e.id)).toEqual([b]);
    // Bumping the pipeline version makes everything pending again: that is how
    // a re-extraction is a job rather than a migration.
    expect(s.pendingEpisodes(HOST, 2).map((e) => e.id)).toEqual([a, b]);
  });
});
