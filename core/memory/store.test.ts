import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EXTRACTION_VERSION } from './schema.js';
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
  it('migrates a database that predates origin and importance, without losing its rows', () => {
    // The real migration path, not a simulation of it: an existing `facts`
    // table means CREATE TABLE IF NOT EXISTS does nothing, so the two columns
    // can only arrive through ensureColumn. A row written before they existed
    // has to come back as `said`/routine — the honest backfill, because
    // extraction has never been permitted to infer.
    const db = new DatabaseCtor(':memory:');
    db.exec(`
      CREATE TABLE facts (
        id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, subject_id INTEGER NOT NULL,
        predicate TEXT NOT NULL, object_id INTEGER, object_value TEXT,
        valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL, expired_at TEXT,
        episode_id INTEGER NOT NULL, speaker_id INTEGER,
        trust_tier INTEGER NOT NULL, confidence REAL NOT NULL,
        extraction_v INTEGER NOT NULL, superseded_by INTEGER)`);
    db.prepare(
      `INSERT INTO facts (id, tenant_id, subject_id, predicate, object_value, recorded_at,
                          episode_id, trust_tier, confidence, extraction_v)
       VALUES (1, 'host', 1, 'accountant', 'Marco', '2026-05-01T10:00:00Z', 1, 0, 0.9, 1)`,
    ).run();

    const s = new MemoryStore(db);
    db.prepare(`INSERT INTO entities (id, tenant_id, kind, name, recorded_at)
                VALUES (1, 'host', 'person', 'Giusto', '2026-05-01T10:00:00Z')`).run();

    const migrated = s.factById(HOST, 1)!;
    expect(migrated.objectValue).toBe('Marco');
    expect(migrated.origin).toBe('said');
    expect(migrated.importance).toBe(0);
  });

  it('refuses an origin or an importance the schema does not allow', () => {
    // The enum is enforced by SQLite, not only by zod at the boundary: a writer
    // that skips the parse still cannot invent a third kind of provenance.
    const s = store();
    const me = s.upsertEntity(HOST, 'Giusto', 'person', '2026-08-04T10:00:00Z');
    const ep = episode(s, HOST, 'nota');
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'x', objectValue: 'y',
      episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    };
    expect(() => s.addFact({ ...base, origin: 'gossip' as never })).toThrow(/CHECK/);
    expect(() => s.addFact({ ...base, importance: 9 })).toThrow(/CHECK/);
  });

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
    s.supersede(HOST, marco, lucia, '2026-07-01T10:00:00Z');

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
    s.markExtracted(HOST, [a], 1);
    expect(s.pendingEpisodes(HOST, 1).map((e) => e.id)).toEqual([b]);
    // Bumping the pipeline version makes everything pending again: that is how
    // a re-extraction is a job rather than a migration.
    expect(s.pendingEpisodes(HOST, 2).map((e) => e.id)).toEqual([a, b]);
  });

  it('does not fork an entity when the same name is upserted under a different kind', () => {
    // `kind` is a per-mention guess from the extractor, not a stable identity
    // property. Forking on it used to mean "Giusto" seen once as `person` and
    // once as `thing` became two rows — and since fact dedup and the judge are
    // both scoped to one subjectId, every fact recorded against the second
    // fork duplicated the first with no judge call at all.
    const s = store();
    const now = '2026-08-04T10:00:00Z';
    const first = s.upsertEntity(HOST, 'Giusto', 'person', now);
    const second = s.upsertEntity(HOST, 'Giusto', 'thing', now);
    expect(second).toBe(first);
    expect(s.entitiesByName(HOST, 'Giusto')).toHaveLength(1);
    // The kind recorded is the first one seen — a later, different guess does
    // not silently overwrite it.
    expect(s.entitiesByName(HOST, 'Giusto')[0]?.kind).toBe('person');
  });

  it('still tells two different names apart, kind fix notwithstanding', () => {
    // The fix drops `kind` from the lookup entirely; this guards against an
    // overcorrection that would fold every entity in a tenant into one row.
    const s = store();
    const now = '2026-08-04T10:00:00Z';
    const giusto = s.upsertEntity(HOST, 'Giusto', 'person', now);
    const cagliari = s.upsertEntity(HOST, 'Cagliari', 'place', now);
    expect(giusto).not.toBe(cagliari);
  });

  it('records a review item and reads it back, most recent first', () => {
    // The durable home for what used to go only to stderr: the judge's
    // `review` verdict and pipeline errors.
    const s = store();
    const me = s.upsertEntity(HOST, 'Giusto', 'person', '2026-08-04T10:00:00Z');
    const ep = episode(s, HOST, 'nota');
    const marco = s.addFact({
      tenantId: HOST, subjectId: me, predicate: 'accountant', objectValue: 'Marco',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: '2026-08-04T10:00:00Z',
    });
    const lucia = s.addFact({
      tenantId: HOST, subjectId: me, predicate: 'accountant', objectValue: 'Lucia',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: '2026-08-05T10:00:00Z',
    });

    s.recordReview({
      tenantId: HOST, kind: 'contradiction', subject: 'Giusto', predicate: 'accountant',
      existingFactId: marco, incomingFactId: lucia, detail: 'non chiaro se è un cambio',
      createdAt: '2026-08-05T10:00:00Z',
    });
    s.recordReview({
      tenantId: HOST, kind: 'error', detail: 'giudice non disponibile',
      createdAt: '2026-08-05T10:01:00Z',
    });

    const items = s.pendingReview(HOST);
    expect(items).toHaveLength(2);
    // Most recent first.
    expect(items[0]?.kind).toBe('error');
    expect(items[1]?.kind).toBe('contradiction');
    expect(items[1]?.existingFactId).toBe(marco);
    expect(items[1]?.incomingFactId).toBe(lucia);
    // Never crosses a tenant.
    expect(s.pendingReview(GROUP)).toHaveLength(0);
    // And it is not write-only: `muffin memory stats` reads this count, so a
    // review item that never surfaces anywhere but `pendingReview` would be
    // the same "declared and connected to nothing" shape this was meant to
    // fix in the first place.
    expect(s.stats(HOST).needsReview).toBe(2);
  });

  it('claims the ingest lane and refuses a second claim while the first holds it', () => {
    // The store is what `ingestPending` asks for the claim, so the wiring has
    // to be provable at this level too, not just through the whole pipeline.
    const s = store();
    const now = new Date('2026-08-13T10:00:00Z');
    const first = s.acquireIngestLock(now);
    expect('release' in first).toBe(true);
    const second = s.acquireIngestLock(now);
    expect(second).toMatchObject({ held: expect.stringContaining(String(process.pid)) });
    s.releaseIngestLock();
    expect('release' in s.acquireIngestLock(now)).toBe(true);
  });

  it('counts as pending exactly what the fetch will return, role and version included', () => {
    // The two queries answer the same question and used to disagree three ways.
    // Asserting the count against a literal would have stayed green through all
    // three: the number was self-consistent, it just described a different set
    // from the one the lane drains. So the assertion is the *identity* — stats
    // and fetch, on the same store — which is the property that has to hold and
    // the only one a wrong filter can break.
    const s = store();
    episode(s, HOST, 'detto da me');
    s.addEpisode({
      tenantId: HOST,
      connector: 'cli',
      threadKey: 't1',
      role: 'agent',
      kind: 'message',
      content: 'e questo l’ho detto io',
      trustTier: 0,
      createdAt: '2026-08-04T10:00:01Z',
    });
    // Never fetchable, so it must never be counted: `pendingEpisodes` filters
    // `content IS NOT NULL`, and a row the fetch cannot return is a row the
    // count can never work off.
    s.addEpisode({
      tenantId: HOST,
      connector: 'cli',
      threadKey: 't1',
      role: 'user',
      kind: 'media',
      content: null,
      trustTier: 0,
      createdAt: '2026-08-04T10:00:02Z',
    });
    episode(s, GROUP, 'un altro tenant');

    const fetched = s.pendingEpisodes(HOST, EXTRACTION_VERSION, 999);
    expect(s.stats(HOST).pending).toBe(fetched.length);
    expect(fetched.map((e) => e.role).sort()).toEqual(['agent', 'user']);

    // And it reaches zero when the lane has done its work, which the old query
    // could not promise: the null-content row would have sat in it forever.
    s.markExtracted(
      HOST,
      fetched.map((e) => e.id),
      EXTRACTION_VERSION,
    );
    expect(s.stats(HOST).pending).toBe(0);
  });
});
