import { describe, expect, it } from 'vitest';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import type { RecallItem } from './recall.js';
import { LlmReranker, RERANK_MIN_CANDIDATES } from './rerank.js';

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  readonly seen: ChatCall[] = [];
  constructor(private readonly reply: string | Error) {}
  async chat(request?: ChatCall): Promise<ChatResult> {
    if (request) this.seen.push(request);
    this.calls += 1;
    if (this.reply instanceof Error) throw this.reply;
    return {
      text: this.reply,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

const items = (n: number): RecallItem[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'episode' as const,
    id: i,
    text: `frammento ${i}`,
    trustTier: 0 as const,
    source: 'tu, 2026-08-04',
    score: 1 / (i + 1),
  }));

describe('reranking', () => {
  it('does not pay for a model call on a small candidate set', async () => {
    const provider = new Scripted('{"order":[2,1,0]}');
    const reranked = await new LlmReranker(provider, 'light').rerank('q', items(5), 3);
    expect(provider.calls).toBe(0); // nothing to reorder that was not already in
    expect(reranked).toHaveLength(3);
  });

  it('reorders a vault-sized set by relevance', async () => {
    const provider = new Scripted('{"order":[14,3,7]}');
    const reranked = await new LlmReranker(provider, 'light').rerank('q', items(20), 3);
    expect(provider.calls).toBe(1);
    expect(reranked.map((i) => i.id)).toEqual([14, 3, 7]);
    // The rerank instructions are the stable half of a per-recall call: on the
    // endpoints that only cache on request, an unmarked prefix pays full price
    // on every recall. Deleting the marker at the call site was suite-green —
    // the same untested join as the loop's, one caller over.
    expect(provider.seen[0]?.system[0]).toMatchObject({ cache: 'stable' });
  });

  it('keeps the RRF order when the reranker breaks', async () => {
    // A worse order is a worse answer; no answer is a broken turn.
    const provider = new Scripted(new Error('502'));
    const reranked = await new LlmReranker(provider, 'light').rerank('q', items(20), 3);
    expect(reranked.map((i) => i.id)).toEqual([0, 1, 2]);
  });

  it('ignores indices the model invented, and fills the rest', async () => {
    const provider = new Scripted('{"order":[5,999,-2,5,1]}');
    const reranked = await new LlmReranker(provider, 'light').rerank('q', items(20), 4);
    // 999 and -2 do not exist, 5 is repeated: what is left is 5 and 1, then the
    // tail fills the remaining slots rather than returning short.
    expect(reranked.slice(0, 2).map((i) => i.id)).toEqual([5, 1]);
    expect(reranked).toHaveLength(4);
    expect(new Set(reranked.map((i) => i.id)).size).toBe(4);
  });

  it('survives prose wrapped around the JSON', async () => {
    const provider = new Scripted('Ecco l\'ordine che propongo:\n```json\n{"order":[9,2]}\n```\nSpero sia utile.');
    const reranked = await new LlmReranker(provider, 'light').rerank('q', items(20), 2);
    expect(reranked.map((i) => i.id)).toEqual([9, 2]);
  });

  it('fires exactly at the declared threshold', async () => {
    const below = new Scripted('{"order":[1]}');
    await new LlmReranker(below, 'light').rerank('q', items(RERANK_MIN_CANDIDATES - 1), 3);
    expect(below.calls).toBe(0);

    const at = new Scripted('{"order":[1]}');
    await new LlmReranker(at, 'light').rerank('q', items(RERANK_MIN_CANDIDATES), 3);
    expect(at.calls).toBe(1);
  });
});
