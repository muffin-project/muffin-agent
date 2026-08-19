import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Embedder } from './embed.js';
import { recall, recallTaint, renderForPrompt } from './recall.js';
import { MemoryStore } from './store.js';
import { VectorIndex } from './vectors.js';

const HOST = 'host';
const NOW = '2026-08-19T10:00:00Z';

type Role = 'user' | 'agent' | 'tool' | 'system';
type Tier = 0 | 1 | 2 | 3;

function memory() {
  const db = new DatabaseCtor(':memory:');
  return { db, store: new MemoryStore(db) };
}

function addEpisode(
  store: MemoryStore,
  {
    content,
    role,
    tier = 0,
    at = NOW,
    thread = 't',
  }: { content: string; role: Role; tier?: Tier; at?: string; thread?: string },
): number {
  return store.addEpisode({
    tenantId: HOST,
    connector: 'cli',
    threadKey: thread,
    role,
    kind: 'message',
    content,
    trustTier: tier,
    createdAt: at,
  });
}

/**
 * Deliberately maps every string to the same point. The vector-only test has a
 * single indexed row, so similarity is deterministic while the query shares no
 * lexical token with the episode and therefore cannot arrive through FTS.
 */
class SamePointEmbedder implements Embedder {
  readonly id = 'same-point:v1';
  readonly dimensions = 2;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0]));
  }
}

describe('recall preserves episode speaker independently from trust', () => {
  it('FTS renders owner tier 0 as owner and Muffin tier 0 as Muffin', async () => {
    const { store } = memory();
    const ownerId = addEpisode(store, { content: 'codiceowner irripetibile', role: 'user' });
    const agentId = addEpisode(store, { content: 'codiceagente irripetibile', role: 'agent' });

    const ownerRecall = await recall({ store }, HOST, 'codiceowner');
    const agentRecall = await recall({ store }, HOST, 'codiceagente');

    const owner = ownerRecall.items.find((item) => item.id === ownerId);
    const agent = agentRecall.items.find((item) => item.id === agentId);

    expect(owner?.source).toContain('tu via cli');
    expect(agent?.source).toContain('Muffin via cli');
    expect(agent?.source).not.toContain('tu via cli');

    // The prompt is the load-bearing consumer: a correct in-memory item that is
    // rendered wrongly would still launder the speaker on the next model call.
    expect(renderForPrompt(agentRecall)).toContain('[Muffin via cli');
    expect(renderForPrompt(agentRecall)).not.toContain('[tu via cli');
  });

  it('the semantic-only episode path also keeps Muffin as the speaker', async () => {
    const { db, store } = memory();
    const vectors = new VectorIndex(db, new SamePointEmbedder());
    const agentId = addEpisode(store, {
      content: 'risposta precedente completamente diversa',
      role: 'agent',
    });
    await vectors.index(
      HOST,
      [{ kind: 'episode', sourceId: agentId, text: 'risposta precedente completamente diversa' }],
      NOW,
    );

    // No shared word: this assertion makes the test red if the vector path is
    // accidentally replaced by FTS while still producing the expected item.
    expect(store.searchEpisodes(HOST, 'commercialista')).toHaveLength(0);

    const result = await recall({ store, vectors }, HOST, 'commercialista');
    const agent = result.items.find((item) => item.id === agentId);
    expect(result.strategies).toContain('vector');
    expect(agent?.source).toContain('Muffin via cli');
    expect(agent?.source).not.toContain('tu via cli');
  });

  it('a tier-2 Muffin neighbour keeps both speaker and trust context, and still raises turn taint', async () => {
    const { store } = memory();
    const agentId = addEpisode(store, {
      content: 'questa era una risposta precedente di Muffin',
      role: 'agent',
      tier: 2,
      at: '2026-08-19T09:59:59Z',
      thread: 'same-thread',
    });
    const anchorId = addEpisode(store, {
      content: 'ancoraprecisa richiesta owner',
      role: 'user',
      tier: 0,
      at: NOW,
      thread: 'same-thread',
    });

    const result = await recall({ store }, HOST, 'ancoraprecisa', { neighbours: 1 });
    const anchor = result.items.find((item) => item.id === anchorId);
    const neighbour = result.items.find((item) => item.id === agentId);

    expect(anchor?.source).toContain('tu via cli');
    expect(neighbour?.neighbourOf).toBe(anchorId);
    expect(neighbour?.source).toContain('Muffin');
    expect(neighbour?.source).toContain('contesto: gruppo/sconosciuto');
    expect(neighbour?.source).not.toContain('tu via cli');
    expect(neighbour?.trustTier).toBe(2);
    expect(recallTaint(result)).toBe(2);
  });
});
