import { describe, expect, it } from 'vitest';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { extractFacts } from './extract.js';
import { judgeContradiction } from './judge.js';
import { LlmReranker, RERANK_MIN_CANDIDATES } from './rerank.js';
import type { Fact } from './store.js';
import type { RecallItem } from './recall.js';

/**
 * Le tre corsie che parlano al modello e non leggono prosa.
 *
 * `agent/profiles/consumer-local.json` dichiara `"thinking": "off"` per
 * `*qwen3*` da sempre, e da 27/08 l'adapter openai-compat sa davvero spegnerlo
 * su OpenRouter. Ma il profilo lo legge **solo** il turno (`agent/loop.ts`):
 * estrazione, giudizio e rerank costruiscono la loro `ChatCall` da sole, e
 * senza questo file l'adapter saprebbe spegnere un reasoning che nessuno gli
 * chiede di spegnere.
 *
 * È la stessa forma tre volte (#151, #157, #159): la funzione giusta scollegata
 * è lo stesso guasto della funzione sbagliata. Qui il collegamento sono cinque
 * caratteri per corsia, e sono esattamente ciò che una riscrittura toglierebbe
 * senza accorgersene.
 *
 * La misura, sull'installazione viva del 27/08 con `qwen/qwen3.8-27b`: 204
 * token in uscita senza il campo, **85** con.
 */
class Registra implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  constructor(private readonly reply: string) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push(request);
    return {
      text: this.reply,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

const UN_FATTO: Fact = {
  id: 1, subjectId: 1, subjectName: 'Giusto', predicate: 'commercialista',
  objectValue: 'Marco', objectId: null, objectName: null,
  validFrom: null, validTo: null, recordedAt: '2026-08-01T10:00:00Z', expiredAt: null,
  episodeId: 1, trustTier: 0, confidence: 0.9, origin: 'said', importance: 0,
  supersededBy: null, pinned: 0,
};

describe('nessuna delle tre corsie paga un reasoning che non legge', () => {
  it("l'estrazione chiede di non ragionare", async () => {
    const p = new Registra('{"facts":[]}');
    await extractFacts(p, 'm', { content: 'ciao', speakerName: 'Giusto', trustTier: 0 });
    expect(p.seen[0]?.thinking).toBe('off');
  });

  it('il giudizio chiede di non ragionare', async () => {
    const p = new Registra('{"verdict":"coexist","reasoning":"","confidence":0.5}');
    await judgeContradiction(p, 'm', {
      subject: 'Giusto', predicate: 'commercialista',
      existing: UN_FATTO, incoming: { object: 'Lucia', validFrom: null },
    });
    expect(p.seen[0]?.thinking).toBe('off');
  });

  it('il rerank chiede di non ragionare', async () => {
    const p = new Registra('{"order":[1,0]}');
    const items: RecallItem[] = Array.from({ length: RERANK_MIN_CANDIDATES + 1 }, (_, i) => ({
      kind: 'episode' as const, id: i, text: `frammento ${i}`,
      trustTier: 0 as const, source: 'tu', score: 1 / (i + 1),
    }));
    await new LlmReranker(p, 'light').rerank('q', items, 3);
    expect(p.seen[0]?.thinking).toBe('off');
  });
});
