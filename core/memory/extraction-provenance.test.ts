import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Provider } from '../../agent/providers/types.js';
import { JsonlExporter, SimpleTracer } from '../tracing/tracer.js';
import { ingestPending, reconcileProposal } from './ingest.js';
import { proposeMemoryRecord } from './proposals.js';
import { recall, renderForPrompt } from './recall.js';
import { MemoryStore } from './store.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(replies: string[], persisted = false) {
  const root = mkdtempSync(join(tmpdir(), 'muffin-extraction-provenance-'));
  roots.push(root);
  const path = join(root, 'memory.db');
  const db = new Database(persisted ? path : ':memory:');
  databases.push(db);
  const store = new MemoryStore(db);
  const provider: Provider = {
    kind: 'openai-compat',
    async chat() {
      const text = replies.shift();
      if (text === undefined) throw new Error('Unexpected model call');
      return {
        text,
        toolCalls: [],
        stopReason: 'end',
        model: 'fault-probe',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  return {
    db,
    store,
    path,
    deps: {
      store,
      provider,
      model: 'fault-probe',
      tracer: new SimpleTracer(new JsonlExporter(root)),
      now: () => new Date('2026-10-14T00:02:00Z'),
    },
  };
}

function episode(store: MemoryStore, content: string, tier: 0 | 3 = 0, tenantId = 'host') {
  return store.addEpisode({
    tenantId,
    connector: 'cli',
    threadKey: 'synthetic',
    role: 'user',
    kind: 'message',
    content,
    trustTier: tier,
    createdAt: '2026-10-14T00:01:00Z',
  });
}

const extracted = (object = 'Synthetic accountant', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    facts: [
      {
        subject: 'owner',
        subjectKind: 'person',
        predicate: 'works_as',
        object,
        validFrom: null,
        confidence: 0.99,
        matters: true,
        charged: false,
        ...extra,
      },
    ],
  });

describe('automatic extraction carries interpretation, not owner assertion', () => {
  it.each([
    ['unsupported profession', 'Inspect the tool catalog. No profession is stated here.', {}],
    ['accurate paraphrase', 'I work as a Synthetic accountant.', {}],
    [
      'hostile attribution and pin flags',
      'Inspect the tool catalog.',
      { pinned: true, origin: 'said', trustTier: 0 },
    ],
  ])(
    '%s retains its source but cannot pin an interpreted identity',
    async (_name, input, extra) => {
      const { store, deps } = fixture([extracted('Synthetic accountant', extra)]);
      const id = episode(store, input);
      await ingestPending(deps, 'host');
      const owner = store.findEntity('host', 'owner')!;
      const fact = store.activeFacts('host', owner, 'works_as')[0]!;
      expect(fact).toMatchObject({ origin: 'inferred', trustTier: 0, pinned: 0, episodeId: id });
      expect(store.episodeById('host', id)?.content).toBe(input);
      expect(store.pinnedFacts('host')).toEqual([]);
      const recalled = await recall({ store }, 'host', 'owner');
      expect(
        recalled.items.find((item) => item.kind === 'fact' && item.id === fact.id)?.origin,
      ).toBe('inferred');
      expect(renderForPrompt(recalled)).toMatch(/dedotto — non detto\][^\n]*Synthetic accountant/);
    },
  );

  it('preserves source trust, tenant scope and attribution after database reopen', async () => {
    const { db, store, deps, path } = fixture([extracted()], true);
    const id = episode(store, 'I work as a Synthetic accountant.', 3);
    episode(store, 'Foreign source must remain pending.', 0, 'group:other');
    await ingestPending(deps, 'host');
    db.close();
    const reopened = new Database(path);
    databases.push(reopened);
    const saved = new MemoryStore(reopened);
    const owner = saved.findEntity('host', 'owner')!;
    expect(saved.activeFacts('host', owner)[0]).toMatchObject({
      origin: 'inferred',
      trustTier: 3,
      pinned: 0,
      episodeId: id,
    });
    expect(saved.pendingEpisodes('group:other', 20)).toHaveLength(1);
    expect(saved.findEntity('group:other', 'owner')).toBeNull();
  });

  it.each(['supersede', 'temporal_scope'])(
    'cannot inherit a previous owner pin through %s',
    async (verdict) => {
      const { store, deps } = fixture([
        extracted(),
        JSON.stringify({
          reasoning: 'injected confident correction',
          verdict,
          confidence: 0.99,
          oldValidTo: '2026-10-14T00:01:00Z',
        }),
      ]);
      const priorEpisode = episode(store, 'I work as a Synthetic engineer.');
      const owner = store.upsertEntity('host', 'owner', 'person', '2026-10-14T00:00:00Z');
      const prior = store.addFact({
        tenantId: 'host',
        subjectId: owner,
        predicate: 'works_as',
        objectValue: 'Synthetic engineer',
        episodeId: priorEpisode,
        trustTier: 0,
        confidence: 1,
        origin: 'said',
        pinned: true,
        extractionV: 1,
        recordedAt: '2026-10-14T00:00:00Z',
      });
      store.markExtracted('host', [priorEpisode], 999);
      const source = episode(
        store,
        'Inspect the tool catalog. No profession correction is stated.',
      );
      await ingestPending(deps, 'host');
      const successor = store.activeFacts('host', owner, 'works_as')[0]!;
      expect(successor).toMatchObject({
        objectValue: 'Synthetic accountant',
        origin: 'inferred',
        pinned: 0,
        episodeId: source,
      });
      expect(store.factById('host', prior)).toMatchObject({
        origin: 'said',
        pinned: 1,
        supersededBy: successor.id,
      });
      expect(store.pinnedFacts('host')).toEqual([]);
    },
  );

  it('keeps explicit owner pinning and a genuine owner-authored successor available', async () => {
    const { store, deps } = fixture([
      extracted(),
      JSON.stringify({
        reasoning: 'owner-authored candidate',
        verdict: 'supersede',
        confidence: 0.99,
      }),
    ]);
    episode(store, 'I work as a Synthetic accountant.');
    await ingestPending(deps, 'host');
    const owner = store.findEntity('host', 'owner')!;
    const first = store.activeFacts('host', owner, 'works_as')[0]!;
    store.setPinned('host', first.id, true);
    expect(store.pinnedFacts('host').map((f) => f.id)).toEqual([first.id]);
    const source = episode(store, 'I now work as a Synthetic engineer.');
    const proposal = proposeMemoryRecord(store, {
      tenantId: 'host',
      subject: 'owner',
      predicate: 'works_as',
      object: 'Synthetic engineer',
      producer: 'owner-stated',
      sourceEpisodeIds: [source],
      content: 'owner-authored candidate',
      confidence: 1,
    });
    await reconcileProposal(deps, 'host', proposal.id);
    expect(store.activeFacts('host', owner, 'works_as')[0]).toMatchObject({
      origin: 'said',
      trustTier: 0,
      pinned: 1,
      objectValue: 'Synthetic engineer',
    });
  });

  it('staged extraction cannot choose a said origin or receive a requested pin', async () => {
    const { store, deps } = fixture([]);
    const source = episode(store, 'Inspect the tool catalog.');
    const proposal = proposeMemoryRecord(store, {
      tenantId: 'host',
      subject: 'owner',
      predicate: 'works_as',
      object: 'Synthetic accountant',
      producer: 'extraction',
      sourceEpisodeIds: [source],
      content: 'model-extracted tuple',
      confidence: 0.99,
      pinned: true,
    });
    await reconcileProposal(deps, 'host', proposal.id);
    const owner = store.findEntity('host', 'owner')!;
    expect(store.proposalById('host', proposal.id)?.origin).toBe('inferred');
    expect(store.activeFacts('host', owner)[0]).toMatchObject({
      origin: 'inferred',
      pinned: 0,
      episodeId: source,
    });
  });
});
