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
    const reranked = (await new LlmReranker(provider, 'light').rerank('q', items(5), 3)).items;
    expect(provider.calls).toBe(0); // nothing to reorder that was not already in
    expect(reranked).toHaveLength(3);
  });

  it('reorders a vault-sized set by relevance', async () => {
    const provider = new Scripted('{"order":[14,3,7]}');
    const reranked = (await new LlmReranker(provider, 'light').rerank('q', items(20), 3)).items;
    expect(provider.calls).toBe(1);
    expect(reranked.map((i) => i.id)).toEqual([14, 3, 7]);
    // Honesty about what this pin defends: the marker is correct by
    // construction, and TODAY it is a no-op — this prefix is ~190 tokens and
    // the light lane's model (Haiku) ignores cache_control below a 4096-token
    // minimum. No write happens, no price changes either way. The pin exists so
    // the marker survives refactors and starts working the day the prefix
    // grows past the floor — not because it saves money now. Whoever sees a
    // "cache miss" here later: it is a length problem, not a bug.
    expect(provider.seen[0]?.system[0]).toMatchObject({ cache: 'stable' });
  });

  it('keeps the RRF order when the reranker breaks', async () => {
    // A worse order is a worse answer; no answer is a broken turn.
    const provider = new Scripted(new Error('502'));
    const reranked = (await new LlmReranker(provider, 'light').rerank('q', items(20), 3)).items;
    expect(reranked.map((i) => i.id)).toEqual([0, 1, 2]);
  });

  it('ignores indices the model invented, and fills the rest', async () => {
    const provider = new Scripted('{"order":[5,999,-2,5,1]}');
    const reranked = (await new LlmReranker(provider, 'light').rerank('q', items(20), 4)).items;
    // 999 and -2 do not exist, 5 is repeated: what is left is 5 and 1, then the
    // tail fills the remaining slots rather than returning short.
    expect(reranked.slice(0, 2).map((i) => i.id)).toEqual([5, 1]);
    expect(reranked).toHaveLength(4);
    expect(new Set(reranked.map((i) => i.id)).size).toBe(4);
  });

  it('survives prose wrapped around the JSON', async () => {
    const provider = new Scripted('Ecco l\'ordine che propongo:\n```json\n{"order":[9,2]}\n```\nSpero sia utile.');
    const reranked = (await new LlmReranker(provider, 'light').rerank('q', items(20), 2)).items;
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
it('chiede un tetto che lascia spazio al reasoning — 200 token non bastano nemmeno a iniziare', async () => {
    // Il più piccolo dei tre tetti della corsia leggera, e quindi il primo a
    // morire contro un modello che ragiona: misurato il 27/08, l'estrazione con
    // 1500 tornava `stop=max_tokens` a 1502 token in uscita. Con 200 non c'è
    // nemmeno una domanda da porsi.
    const provider = new Scripted('{"order":[14,3,7]}');
    await new LlmReranker(provider, 'light').rerank('q', items(20), 3);
    expect(provider.seen[0]?.maxOutputTokens).toBeGreaterThan(200);
  });
});

/**
 * Un rerank fallito è una risposta peggiore, non nessuna risposta — e va detto.
 *
 * `RecallResult.strategies` promette di «nominare le metà che hanno davvero
 * girato, così un recall degradato non è mai silenzioso». Per questa metà
 * diceva il falso: `rerank(id)` finiva nell'elenco anche quando l'ordine veniva
 * da RRF, perché il fallimento restituiva gli stessi candidati e nient'altro.
 */
describe('il rerank dice se ha davvero riordinato', () => {
  it('riordinato dal modello: lo dichiara, senza motivo da dare', async () => {
    const out = await new LlmReranker(new Scripted('{"order":[14,3,7]}'), 'light').rerank('q', items(20), 3);
    expect(out.reordered).toBe(true);
    expect(out.why).toBeUndefined();
  });

  it('il modello lancia: torna RRF e dice perché', async () => {
    const out = await new LlmReranker(new Scripted(new Error('rete giù')), 'light').rerank('q', items(20), 3);
    expect(out.reordered).toBe(false);
    expect(out.why).toContain('rete giù');
    // E l'ordine di prima resta, che è il punto: peggiore, non assente.
    expect(out.items.map((i) => i.id)).toEqual([0, 1, 2]);
  });

  it('risposta illeggibile: stessa cosa, motivo diverso', async () => {
    const out = await new LlmReranker(new Scripted('non è affatto JSON'), 'light').rerank('q', items(20), 3);
    expect(out.reordered).toBe(false);
    expect(out.why).toContain('non leggibile');
  });

  it('troppo pochi candidati: non è un fallimento, ed è comunque un non-riordino', async () => {
    const out = await new LlmReranker(new Scripted('{"order":[2,1,0]}'), 'light').rerank('q', items(5), 3);
    expect(out.reordered).toBe(false);
    expect(out.why).toContain('troppo pochi');
  });
});

/**
 * Una chiamata che è stata pagata si vede.
 *
 * Era l'ultima chiamata al modello che non compariva da nessuna parte: un turno
 * mostrava un recall lento e nessuno poteva vedere che dentro c'era un giro di
 * modello. Esce col risultato invece che da uno span perché `recall()` non ha
 * un tracer, e darglielo sarebbe plumbing attraverso quattro file per un numero.
 */
describe('il rerank dice quanto è costato', () => {
  class Costoso extends Scripted {
    override async chat(request: ChatCall): Promise<ChatResult> {
      const base = await super.chat(request);
      return { ...base, usage: { inputTokens: 812, outputTokens: 19, cacheReadTokens: 5, cacheWriteTokens: 0 } };
    }
  }

  it('porta i token quando ha riordinato', async () => {
    const out = await new LlmReranker(new Costoso('{"order":[14,3,7]}'), 'light').rerank('q', items(20), 3);
    expect(out.usage).toEqual({ inputTokens: 812, outputTokens: 19, cacheReadTokens: 5 });
  });

  it("li porta anche quando la risposta era illeggibile — è il caso in cui non vederli inganna", async () => {
    const out = await new LlmReranker(new Costoso('non è JSON'), 'light').rerank('q', items(20), 3);
    expect(out.reordered).toBe(false);
    expect(out.usage?.inputTokens).toBe(812);
  });

  it('nessun uso quando la chiamata non è mai avvenuta', async () => {
    // Troppo pochi candidati: non è stato speso niente, e dire zero sarebbe
    // diverso da dire niente.
    const out = await new LlmReranker(new Costoso('{"order":[2,1,0]}'), 'light').rerank('q', items(5), 3);
    expect(out.usage).toBeUndefined();
  });

  it('se il modello lancia non si inventa un costo', async () => {
    const out = await new LlmReranker(new Scripted(new Error('rete giù')), 'light').rerank('q', items(20), 3);
    expect(out.usage).toBeUndefined();
  });
});
