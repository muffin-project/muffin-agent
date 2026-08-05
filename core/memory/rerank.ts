import type { Provider } from '../../agent/providers/types.js';
import type { RecallItem } from './recall.js';

/**
 * Reranking.
 *
 * RRF gives a candidate set that is roughly right and ordered badly. With a
 * handful of memories that hardly matters; with a vault of years of notes and
 * papers it is the whole game, because only the top few make it into the prompt
 * and everything below the cut may as well not exist. The previous system
 * shipped without this and carried it as a declared gap.
 *
 * A cross-encoder would be the textbook answer, but it means another model to
 * serve and another thing to install. An LLM on the light lane costs one short
 * call, works with whatever provider is already configured, and is what most
 * systems actually do. The interface is here so a cross-encoder can replace it
 * without touching recall.
 */

export interface Reranker {
  readonly id: string;
  rerank(query: string, candidates: RecallItem[], topK: number): Promise<RecallItem[]>;
}

/**
 * Below this many candidates, reordering is not worth a model call: the set is
 * already small enough that everything relevant is in the prompt anyway.
 */
export const RERANK_MIN_CANDIDATES = 12;

const SYSTEM = `Ordini frammenti di memoria per quanto rispondono a una domanda.

Ti arriva una domanda e una lista numerata di frammenti. Restituisci gli indici
dei più pertinenti, dal migliore al peggiore.

REGOLE:
- Pertinenza alla domanda, non qualità del testo. Un appunto sgrammaticato che
  risponde vale più di un paragrafo elegante che non c'entra.
- Un frammento che contraddice gli altri è pertinente, non da scartare: se la
  memoria si contraddice, chi legge deve vederlo.
- Non inventare indici che non esistono. Non ripetere lo stesso indice.
- Se meno frammenti del richiesto sono davvero pertinenti, restituiscine meno.

Rispondi SOLO con JSON: {"order":[3,1,7]}`;

export class LlmReranker implements Reranker {
  readonly id: string;
  constructor(
    private readonly provider: Provider,
    private readonly model: string,
  ) {
    this.id = `llm:${model}`;
  }

  async rerank(query: string, candidates: RecallItem[], topK: number): Promise<RecallItem[]> {
    if (candidates.length < RERANK_MIN_CANDIDATES) return candidates.slice(0, topK);

    const listing = candidates
      .map((c, i) => `[${i}] (${c.source}) ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');

    let text: string | null = null;
    try {
      const result = await this.provider.chat({
        model: this.model,
        system: [{ type: 'text', text: SYSTEM, cache: 'stable' }],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                // The candidates are data, and some of them came from strangers.
                // Delimited so a fragment cannot rewrite the ranking instruction.
                text: `Domanda: ${query}\n\nRestituisci i migliori ${topK}.\n\n<<<FRAMMENTI\n${listing}\nFRAMMENTI>>>`,
              },
            ],
          },
        ],
        maxOutputTokens: 200,
        temperature: 0,
        stream: false,
      });
      text = result.text;
    } catch {
      // A reranker that fails must not take recall down with it: the RRF order
      // is a worse answer, not no answer.
      return candidates.slice(0, topK);
    }

    const order = parseOrder(text, candidates.length);
    if (order.length === 0) return candidates.slice(0, topK);

    const ranked = order.map((i) => candidates[i]!).slice(0, topK);
    // Anything the model dropped still fills the tail: losing a candidate to a
    // parsing hiccup is worse than keeping it in a slightly wrong place.
    const chosen = new Set(order);
    const tail = candidates.filter((_, i) => !chosen.has(i));
    return [...ranked, ...tail].slice(0, topK);
  }
}

function parseOrder(text: string | null, candidateCount: number): number[] {
  if (!text) return [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { order?: unknown };
    if (!Array.isArray(parsed.order)) return [];
    const seen = new Set<number>();
    return parsed.order
      .filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
      .filter((n) => n >= 0 && n < candidateCount && !seen.has(n) && (seen.add(n), true));
  } catch {
    return [];
  }
}
