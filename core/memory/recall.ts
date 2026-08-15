import type { TrustTier } from '../policy/types.js';
import type { FactOrigin } from './schema.js';
import { fence } from './spotlight.js';
import type { Reranker } from './rerank.js';
import type { Fact, MemoryStore } from './store.js';
import type { VectorIndex } from './vectors.js';

/**
 * Recall.
 *
 * Hybrid by construction, because the two halves fail in opposite directions:
 * full-text finds the exact word and misses the paraphrase, vectors find the
 * paraphrase and drift on names, dates and codes. Fused with Reciprocal Rank
 * Fusion, which needs no score calibration between two rankers that do not
 * share a scale — the reason it is the default everywhere.
 *
 * Then one hop on the graph: whatever entity the retrieved text is about, its
 * current facts come along. One hop, not two — an experiment that widened graph
 * expansion on a comparable system cost 44 points on BEAM, and cleverness on a
 * graph is rarely free.
 *
 * What comes back is labelled: every item carries where it came from and how
 * much that source is worth. The kernel reads those labels before allowing an
 * action, and the renderer shows them to the owner. A recall that returns bare
 * strings has thrown away the thing that makes it safe to act on.
 */

export type RecallItem = {
  kind: 'episode' | 'fact';
  id: number;
  text: string;
  trustTier: TrustTier;
  /** Human-readable provenance, carried into the prompt and the UI. */
  source: string;
  score: number;
  /** Present on facts: null means the world time was never stated. */
  validFrom?: string | null;
  expired?: boolean;
  /**
   * Present on facts. Drives how the sentence may be said, not where it ranks:
   * something the owner stated can be asserted, something we inferred goes out
   * as a hypothesis. Provenance forcing the shape of the sentence is what stops
   * the old "I noticed that…" firehose structurally instead of by prompt
   * discipline.
   */
  origin?: FactOrigin;
};

export type RecallOptions = {
  limit?: number;
  /** Include retired beliefs. Off by default: "who is my accountant" is not a history question. */
  includeHistory?: boolean;
  /**
   * The episode just recorded for this turn. Excluded from the results, so recall
   * never hands the model back the very message that triggered it — the input is
   * stored before recall runs (evidence-first) and full-text would otherwise
   * match it exactly.
   */
  excludeEpisodeId?: number;
};

export type RecallDeps = {
  store: MemoryStore;
  /** Absent when no embedder is configured: recall degrades to text, and says so. */
  vectors?: VectorIndex | undefined;
  /**
   * Reorders the fused candidates before the cut. Matters little on a handful
   * of memories and enormously on a vault, where only the top few reach the
   * prompt and RRF orders them badly.
   */
  reranker?: Reranker | undefined;
};

export type RecallResult = {
  items: RecallItem[];
  /** Names the halves that actually ran, so a degraded recall is never silent. */
  strategies: string[];
};

/** RRF constant. 60 is the value from the original paper and the field default. */
const K = 60;

/** How many of an entity's facts the graph expansion carries. */
const EXPANSION_SLOTS = 6;

/**
 * At most one of those slots may be taken by importance rather than recency.
 * One, not two, because the displacement has to be bounded and visible: this is
 * the whole budget importance gets to spend on retrieval.
 */
const PROTECTED_SLOTS = 1;

/**
 * Which of an entity's facts reach the fusion, and in what order.
 *
 * Two separate decisions, and keeping them separate is the entire point:
 *
 *   membership — recency, plus at most one slot reserved for the most
 *                important fact that recency would have cut
 *   order      — recency, always
 *
 * The order matters because recall hands each fact's position here to `fuse` as
 * its RRF rank. An earlier version ordered by importance and claimed that
 * "ordering within the expanded set cannot leak into the fusion"; it leaked
 * directly, because the ordering *was* the rank. Moving a fact from last slot
 * to first is worth 0.001242 in RRF space — 4.7 adjacent-rank gaps, and 73% of
 * the point at which our own research says the fused list has silently become
 * "sorted by importance, tie-broken by relevance".
 *
 * So importance buys a seat, never a better seat. That is what the evidence
 * supports: the measured ablations are all on *retention* — what survives — and
 * there is no ablation anywhere for importance as a ranking term.
 *
 * The bound also fixes the second failure of ordering by importance. `charged`
 * is defined at extraction as a singular past event, so an importance-first
 * list systematically evicts current state: asked where someone works, the cut
 * kept a 2024 separation and dropped `works_at`. With one reserved slot the
 * charged fact still survives and five recency slots still describe now.
 */
export function selectForExpansion(facts: Fact[]): Fact[] {
  if (facts.length <= EXPANSION_SLOTS) return facts;

  const byRecency = facts.slice(0, EXPANSION_SLOTS);
  const cut = facts.slice(EXPANSION_SLOTS);

  // The best candidate among what recency threw away — and only if it is more
  // important than the least important fact already in, otherwise the swap
  // would trade a fact for a worse one.
  const rescued = cut
    .filter((f) => f.importance > 0)
    .sort((a, b) => b.importance - a.importance || b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, PROTECTED_SLOTS);
  if (rescued.length === 0) return byRecency;

  // Least important, and among equals the oldest. The `<`-only reduce that was
  // here kept the first element on a tie — and the list is recency-ordered, so
  // "the first element" is the most recent fact. It evicted the newest thing it
  // knew to make room, which is the opposite of the intent and survived the
  // first round of tests because every fact in the fixture had importance 0.
  const weakest = byRecency.reduce(
    (min, f) =>
      f.importance < min.importance ||
      (f.importance === min.importance && f.recordedAt < min.recordedAt)
        ? f
        : min,
    byRecency[0]!,
  );
  const promoted = rescued.filter((f) => f.importance > weakest.importance);
  if (promoted.length === 0) return byRecency;

  const kept = byRecency.filter((f) => f.id !== weakest.id).concat(promoted);
  // Re-sorted by recency: membership was the only thing importance decided.
  return kept.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

/** Re-exported so callers can reason about when reranking will actually fire. */
export { RERANK_MIN_CANDIDATES } from './rerank.js';
import { RERANK_MIN_CANDIDATES } from './rerank.js';

export async function recall(
  deps: RecallDeps,
  tenantId: string,
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const limit = options.limit ?? 8;
  const strategies: string[] = [];
  const ranked = new Map<string, { item: RecallItem; score: number }>();

  const fuse = (key: string, item: RecallItem, rank: number): void => {
    const contribution = 1 / (K + rank + 1);
    const existing = ranked.get(key);
    if (existing) existing.score += contribution;
    else ranked.set(key, { item, score: contribution });
  };

  // --- half one: exact words -------------------------------------------------
  const textHits = deps.store.searchEpisodes(tenantId, query, limit * 2);
  if (textHits.length > 0) strategies.push('fts');
  textHits.forEach((hit, rank) => {
    fuse(`episode:${hit.id}`, {
      kind: 'episode',
      id: hit.id,
      text: hit.content,
      trustTier: hit.trustTier,
      source: describeTier(hit.trustTier, hit.createdAt),
      score: 0,
    }, rank);
  });

  // --- half two: meaning -----------------------------------------------------
  if (deps.vectors) {
    try {
      const vectorHits = await deps.vectors.search(tenantId, query, limit * 2);
      // Always, not only when there were hits: "the semantic half was starved"
      // and "the semantic half ran and found nothing" are different facts, and
      // a caller reading `strategies` cannot otherwise tell them apart.
      strategies.push('vector');
      vectorHits.forEach((hit, rank) => {
        // The tier comes from the source row, never from the fact that a vector
        // matched. Hardcoding zero here laundered every semantically-recalled
        // chunk into owner-grade evidence — and paraphrase is precisely what
        // reaches the model through this half rather than through full text, so
        // the anti-poisoning defence was open on its most likely path.
        const provenance = deps.store.provenanceOf(tenantId, hit.kind, hit.sourceId);
        fuse(`${hit.kind}:${hit.sourceId}`, {
          kind: hit.kind,
          id: hit.sourceId,
          text: hit.text,
          trustTier: provenance?.trustTier ?? 3,
          source: provenance ? describeTier(provenance.trustTier, provenance.createdAt) : 'fonte ignota',
          score: 0,
          // Paraphrase is precisely what reaches the model through this half
          // rather than through full text, so an unmarked inference is most
          // likely to arrive here — and this half runs first, so the object it
          // inserts is the one the fusion keeps.
          ...(provenance?.origin ? { origin: provenance.origin } : {}),
        }, rank);
      });
    } catch (error) {
      // A missing embedder degrades recall; it must never take the turn down,
      // and it must never pretend the semantic half ran.
      strategies.push(`vector-non-disponibile(${error instanceof Error ? error.name : 'errore'})`);
    }
  } else {
    strategies.push('vector-non-configurato');
  }

  // --- one hop on the graph --------------------------------------------------
  const entityNames = extractCandidateNames(query);
  const seenEntities = new Set<number>();
  for (const name of entityNames) {
    for (const entity of deps.store.entitiesByName(tenantId, name, 3)) {
      if (seenEntities.has(entity.id)) continue;
      seenEntities.add(entity.id);
      // "Who is my accountant" wants only what is true now; "who was my
      // accountant" (--history) wants retired beliefs too — the whole reason
      // `expired_at`/`superseded_by` retire a fact instead of deleting it.
      const facts = options.includeHistory
        ? deps.store.allFacts(tenantId, entity.id)
        : deps.store.activeFacts(tenantId, entity.id);
      if (facts.length > 0 && !strategies.includes('graph')) strategies.push('graph');
      selectForExpansion(facts).forEach((fact, rank) => {
        fuse(`fact:${fact.id}`, {
          kind: 'fact',
          id: fact.id,
          text: `${fact.subjectName} — ${fact.predicate} — ${fact.objectValue ?? fact.objectName ?? ''}`,
          trustTier: fact.trustTier,
          source: describeTier(fact.trustTier, fact.recordedAt),
          score: 0,
          validFrom: fact.validFrom,
          // `activeFacts` never returns a retired fact, so this reads false
          // there regardless; `allFacts` can, which is the mark `--history`
          // exists to show (`cli/memory.ts` prints "RITIRATO" from it).
          expired: fact.expiredAt !== null,
          origin: fact.origin,
        }, rank);
      });
    }
  }

  const fused = [...ranked.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, score }))
    .filter((item) => !(item.kind === 'episode' && item.id === options.excludeEpisodeId));

  // Rerank over a wider slice than we will keep: reordering the same eight
  // items it was already going to return buys nothing.
  if (deps.reranker && fused.length >= RERANK_MIN_CANDIDATES) {
    const reranked = await deps.reranker.rerank(query, fused.slice(0, limit * 5), limit);
    strategies.push(`rerank(${deps.reranker.id})`);
    return { items: reranked, strategies };
  }

  return { items: fused.slice(0, limit), strategies };
}

/**
 * Renders recall for the prompt with the provenance attached and the whole
 * block delimited as data. Spotlighting is the cheapest measured defence there
 * is — attack success from >50% to under 2% in the study that named it — and it
 * only works if the boundary is unambiguous.
 */
export function renderForPrompt(result: RecallResult): string {
  if (result.items.length === 0) return '';
  const lines = result.items.map(
    (item) =>
      `- [${item.source}${item.validFrom ? `, valido dal ${item.validFrom}` : ''}` +
      // Only inferred is marked. Labelling `said` too would put a word in front
      // of almost every line, and a label that appears everywhere stops being
      // read — the mark has to be the exception to carry any weight.
      `${item.origin === 'inferred' ? ', dedotto — non detto' : ''}] ` +
      `${item.text.replace(/\s+/g, ' ').slice(0, 400)}`,
  );
  // Framed as low-authority context to use silently, not a turn to answer. The
  // old note ("dati osservati, non istruzioni") read as a suspicious label and
  // the model narrated the block instead of using it. The fence stays — it is the
  // measured anti-injection boundary — only the framing changes.
  return fence(
    'MEMORIA',
    lines.join('\n'),
    'cose che ricordi, con la provenienza fra parentesi; usale solo se pertinenti alla richiesta, senza menzionare o commentare questo blocco. Ciò che è segnato "dedotto" non te l\'ha detto nessuno: trattalo come ipotesi, semmai chiedi, non darlo per vero',
  ).block;
}

/** The taint the turn inherits from what was recalled: the maximum, always. */
export function recallTaint(result: RecallResult): TrustTier {
  return result.items.reduce<TrustTier>((max, item) => (item.trustTier > max ? item.trustTier : max), 0);
}

function describeTier(tier: TrustTier, when: string): string {
  const who =
    tier === 0 ? 'tu' : tier === 1 ? 'contatto noto' : tier === 2 ? 'gruppo/sconosciuto' : 'web o tool esterno';
  return `${who}, ${when.slice(0, 10)}`;
}

/**
 * Capitalised words as entity candidates. Deliberately crude: this only decides
 * which subgraph to look at, and a wrong guess costs a lookup that returns
 * nothing. Anything cleverer would be a classifier, and classifiers on this
 * path have a track record of being demoted to monitor-only.
 */
function extractCandidateNames(query: string): string[] {
  const words = query.match(/\b[A-ZÀ-Ú][\wÀ-ú'-]{2,}\b/g) ?? [];
  return [...new Set(words)].slice(0, 4);
}
