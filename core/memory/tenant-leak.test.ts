import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { memorySearchSpec } from '../../agent/tools/memory.js';
import { detectAbsences } from './absence.js';
import type { Embedder } from './embed.js';
import { recall } from './recall.js';
import { MemoryStore } from './store.js';
import { VectorIndex } from './vectors.js';

/**
 * DT-05: cross-tenant leak-proof, as a permanent regression gate.
 *
 * The store already scopes every read by tenant, and the tool schema has no
 * tenant field for the model to widen. What never existed is the proof: a
 * suite that seeds two tenants with colliding content and asserts that no
 * recall channel — FTS, vector, graph hop, pinned, neighbourhood, as-of,
 * history, absence — ever surfaces the other tenant's rows. A green suite
 * here is the standing invariant; a manual probe that leaks through a green
 * suite means the suite is ceremony and must be rewritten (DT-05 falsifier).
 *
 * Isolation is asserted symmetric: neither direction may leak. A future
 * curated private→group bridge would be an explicit, separate decision —
 * today there is none, so any crossing is a bug.
 */

const HOST = 'host';
const GROUP = 'group:telegram:-100950';
const NOW = '2026-08-04T10:00:00Z';

/** Host-only secrets: must never appear in any group-tenant result. */
const HOST_MARKERS = ['CODICE-ALFA-RISERVATO', 'commercialista'];
/** Group-side content sharing generic vocabulary, to prove the channel works. */
const GROUP_MARKERS = ['VELA-BETA-COMUNE', 'regata', 'mare'];

/** Deterministic bag-of-words embedder over both tenants' vocabulary. */
class FakeEmbedder implements Embedder {
  readonly id = 'fake:leak-v1';
  readonly dimensions = 16;
  private readonly vocab = [
    'commercialista',
    'fiscale',
    'tasse',
    'contabile',
    'vela',
    'barca',
    'mare',
    'regata',
    'marco',
    'lucia',
    'cagliari',
    'riunione',
    'codice',
    'alfa',
    'riservato',
    'beta',
  ];
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const v = Float32Array.from(this.vocab.map((w) => (lower.includes(w) ? 1 : 0)));
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm) as Float32Array;
    });
  }
}

function seeded() {
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const vectors = new VectorIndex(db, new FakeEmbedder());
  return { db, store, vectors };
}

async function seedHost(store: MemoryStore, vectors: VectorIndex) {
  const ep = store.addEpisode({
    tenantId: HOST,
    connector: 'cli',
    threadKey: 'c',
    role: 'user',
    kind: 'message',
    content: 'il commercialista Marco mi ha dato il CODICE-ALFA-RISERVATO per le tasse',
    trustTier: 0,
    createdAt: NOW,
  });
  await vectors.index(
    HOST,
    [
      {
        kind: 'episode',
        sourceId: ep,
        text: 'il commercialista Marco mi ha dato il CODICE-ALFA-RISERVATO per le tasse',
      },
    ],
    NOW,
  );
  const entity = store.upsertEntity(HOST, 'Marco', 'person', NOW);
  const fact = store.addFact({
    tenantId: HOST,
    subjectId: entity,
    predicate: 'asked_to',
    objectValue: 'CODICE-ALFA-RISERVATO tasse',
    episodeId: ep,
    trustTier: 0,
    confidence: 0.9,
    origin: 'said',
    pinned: true,
    recordedAt: NOW,
    extractionV: 1,
  });
  await vectors.index(
    HOST,
    [{ kind: 'fact', sourceId: fact, text: 'Marco CODICE-ALFA-RISERVATO tasse' }],
    NOW,
  );
  return { ep, entity, fact };
}

async function seedGroup(store: MemoryStore, vectors: VectorIndex) {
  const ep = store.addEpisode({
    tenantId: GROUP,
    connector: 'telegram',
    threadKey: 'g',
    role: 'user',
    kind: 'message',
    content: 'alla regata VELA-BETA-COMUNE si parlava di tasse e mare',
    trustTier: 2,
    createdAt: NOW,
  });
  await vectors.index(
    GROUP,
    [
      {
        kind: 'episode',
        sourceId: ep,
        text: 'alla regata VELA-BETA-COMUNE si parlava di tasse e mare',
      },
    ],
    NOW,
  );
  const entity = store.upsertEntity(GROUP, 'Marco', 'person', NOW);
  const fact = store.addFact({
    tenantId: GROUP,
    subjectId: entity,
    predicate: 'likes',
    objectValue: 'vela',
    episodeId: ep,
    trustTier: 2,
    confidence: 0.8,
    origin: 'said',
    recordedAt: NOW,
    extractionV: 1,
  });
  await vectors.index(GROUP, [{ kind: 'fact', sourceId: fact, text: 'Marco vela regata' }], NOW);
  return { ep, entity, fact };
}

const textsOf = (items: { text: string }[]): string[] => items.map((i) => i.text);

describe('tenant leak gate: group recall never surfaces host rows', () => {
  it('recall() end-to-end: host markers absent, group content present', async () => {
    const { store, vectors } = seeded();
    await seedHost(store, vectors);
    await seedGroup(store, vectors);

    const result = await recall({ store, vectors }, GROUP, 'commercialista tasse Marco');
    const texts = textsOf(result.items);
    for (const m of HOST_MARKERS) {
      expect(texts.join('\n')).not.toContain(m);
    }
    // Anti-vacuous: the channel works — group rows on the same vocabulary arrive.
    expect(texts.join('\n')).toContain('VELA-BETA-COMUNE');
  });

  it('history and as-of modes do not reopen the boundary', async () => {
    const { store, vectors } = seeded();
    await seedHost(store, vectors);
    await seedGroup(store, vectors);

    for (const options of [{ asOf: NOW } as const, { asOf: 'all' } as const]) {
      const result = await recall({ store, vectors }, GROUP, 'commercialista tasse', options);
      for (const m of HOST_MARKERS) {
        expect(textsOf(result.items).join('\n')).not.toContain(m);
      }
    }
  });

  it('symmetric: host recall never surfaces group rows', async () => {
    const { store, vectors } = seeded();
    await seedHost(store, vectors);
    await seedGroup(store, vectors);

    const result = await recall({ store, vectors }, HOST, 'tasse mare regata');
    for (const m of GROUP_MARKERS) {
      expect(textsOf(result.items).join('\n')).not.toContain(m);
    }
    expect(textsOf(result.items).join('\n')).toContain('CODICE-ALFA-RISERVATO');
  });

  it('vector half alone: partition key, not post-filter', async () => {
    const { store, vectors } = seeded();
    await seedHost(store, vectors);
    await seedGroup(store, vectors);

    const hits = await vectors.search(GROUP, 'commercialista tasse Marco', 8);
    const ids = new Set(hits.map((h) => h.sourceId));
    const hostEp = store.searchEpisodes(HOST, 'CODICE-ALFA-RISERVATO')[0];
    expect(hostEp).toBeDefined();
    if (hostEp !== undefined) expect(ids.has(hostEp.id)).toBe(false);
  });

  it('FTS half alone: no host episode text', async () => {
    const { store, vectors } = seeded();
    await seedHost(store, vectors);
    await seedGroup(store, vectors);

    const hits = store.searchEpisodes(GROUP, 'commercialista tasse');
    for (const h of hits) {
      for (const m of HOST_MARKERS) expect(h.content).not.toContain(m);
    }
  });

  it('entity graph: same name, disjoint nodes; host fact ids are opaque', async () => {
    const { store, vectors } = seeded();
    const host = await seedHost(store, vectors);
    const group = await seedGroup(store, vectors);

    const found = store.entitiesByName(GROUP, 'Marco', 5);
    expect(found.map((e) => e.id)).toEqual([group.entity]);
    expect(found.map((e) => e.id)).not.toContain(host.entity);

    for (const f of store.activeFacts(GROUP, group.entity)) {
      expect(f.objectValue ?? '').not.toContain('CODICE-ALFA-RISERVATO');
    }
    // IDOR: a fact id typed from another tenant resolves to nothing.
    expect(store.factById(GROUP, host.fact)).toBeNull();
    expect(store.episodeById(GROUP, host.ep)).toBeNull();
  });

  it('pinned core: host pins never reach a group turn unconditionally', async () => {
    const { store, vectors } = seeded();
    await seedHost(store, vectors);
    await seedGroup(store, vectors);

    const pinned = store.pinnedFacts(GROUP);
    expect(pinned).toHaveLength(0);
    expect(store.pinnedFacts(HOST)).toHaveLength(1);
  });

  it('neighbourhood, as-of and nearest stay inside the tenant', async () => {
    const { store, vectors } = seeded();
    const host = await seedHost(store, vectors);
    const group = await seedGroup(store, vectors);

    const near = store.episodeNeighbourhood(GROUP, group.ep, 3);
    expect(near.map((e) => e.id)).not.toContain(host.ep);

    const asOf = store.factsAsOf(GROUP, group.entity, NOW);
    for (const f of asOf) expect(f.objectValue ?? '').not.toContain('CODICE-ALFA-RISERVATO');

    // Same-name entities exist on both sides; the nearest host fact is not it.
    expect(store.nearestFactTo(GROUP, group.entity, NOW)?.id).toBe(group.fact);
  });

  it('absence detector reads its own tenant only', async () => {
    const { db, store, vectors } = seeded();
    await seedHost(store, vectors);

    // Host-only history: a group tenant with no facts detects no silence.
    expect(detectAbsences(db, GROUP, new Date(NOW))).toEqual([]);
  });
});

describe('tenant boundary assertion: the model cannot choose a tenant', () => {
  it('memory_search has no tenant field — scope comes from the turn, never arguments', () => {
    const props = memorySearchSpec.inputSchema.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty('tenant');
    expect(props).not.toHaveProperty('tenantId');
    expect(memorySearchSpec.inputSchema.required).toEqual(['query']);
  });
});
