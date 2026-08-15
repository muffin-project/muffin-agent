import type { Provider } from '../../agent/providers/types.js';
import type { SpanHandle, Tracer } from '../tracing/types.js';
import type { VectorIndex } from './vectors.js';
import { ATTR } from '../tracing/types.js';
import { extractFacts } from './extract.js';
import { judgeContradiction, type JudgeOutcome } from './judge.js';
import { EXTRACTION_VERSION } from './schema.js';
import type { MemoryStore } from './store.js';

/**
 * The ingestion job: episodes in, facts out.
 *
 * Runs one tenant at a time, always. Not for tidiness — a batch that queries
 * across tenants for efficiency is how a stranger's claim ends up in the
 * owner's profile, and nothing downstream would notice.
 *
 * Never on the response path: this is a background job (M5 will schedule it,
 * ADR-0022 says where it runs). A turn should never wait for extraction.
 */

export type IngestDeps = {
  store: MemoryStore;
  provider: Provider;
  /** The light lane: extraction is the archetypal small-model job. */
  model: string;
  tracer: Tracer;
  /**
   * Absent when no embedder is configured. Present, it means this job is also
   * what keeps the semantic half of recall alive — nothing else feeds it, and
   * an index nobody fills degrades recall to keyword search without ever
   * raising an error.
   */
  vectors?: VectorIndex | undefined;
  now?: () => Date;
};

export type IngestReport = {
  tenantId: string;
  episodes: number;
  factsAdded: number;
  superseded: number;
  /** Stored and searchable, deliberately not mined. */
  skippedAgentOutput: number;
  /** Same, for vault documents: recall yes, beliefs no. */
  skippedDocuments: number;
  /** Chunks embedded this run. Zero with an embedder present is worth noticing. */
  indexed: number;
  needsReview: { subject: string; predicate: string; existing: string; incoming: string; why: string }[];
  errors: string[];
};

export async function ingestPending(
  deps: IngestDeps,
  tenantId: string,
  limit = 20,
): Promise<IngestReport> {
  const now = deps.now ?? (() => new Date());
  const span = deps.tracer.start('muffin.turn', {
    [ATTR.operationName]: 'memory.ingest',
    [ATTR.tenant]: tenantId,
  });

  const report: IngestReport = {
    tenantId,
    episodes: 0,
    factsAdded: 0,
    superseded: 0,
    skippedAgentOutput: 0,
    skippedDocuments: 0,
    indexed: 0,
    needsReview: [],
    errors: [],
  };

  try {
    const pending = deps.store.pendingEpisodes(tenantId, EXTRACTION_VERSION, limit);
    const processed: number[] = [];
    // Marked as done without extraction: they must not come back as pending on
    // every run, but nothing was mined from them.
    const processedNonExtractable: number[] = [];

    for (const episode of pending) {
      if (!episode.content) continue;

      // The agent's own words are evidence of what was said, never a source of
      // facts about the world. Mining them means the system manufactures its own
      // proof: Muffin infers "sembri sotto pressione", the inference becomes a
      // fact about the owner, and next week it recalls it as something it knows.
      // In the corpus being migrated, agent output is 68% of the text — this is
      // not a corner case, it is most of it.
      if (episode.role === 'agent') {
        processedNonExtractable.push(episode.id);
        report.skippedAgentOutput += 1;
        continue;
      }

      // Documents are indexed for recall and never mined. A downloaded paper is
      // full of confident claims, and none of them is a belief about the owner's
      // life; the cheapest way to guarantee that is for a document to never
      // reach extraction at all. Something in a note that should become a belief
      // arrives the normal way — the owner says it, with a speaker attached.
      if (episode.kind === 'document') {
        processedNonExtractable.push(episode.id);
        report.skippedDocuments += 1;
        continue;
      }

      report.episodes += 1;

      const extraction = await extractFacts(deps.provider, deps.model, {
        content: episode.content,
        speakerName: episode.role === 'user' ? 'owner' : episode.role,
        trustTier: episode.trustTier,
      });

      if (extraction.error) {
        report.errors.push(`episodio ${episode.id}: ${extraction.error}`);
        // Not marked as processed: a failed extraction is retried next run
        // rather than silently losing the evidence.
        continue;
      }

      for (const fact of extraction.facts) {
        const subjectId = deps.store.upsertEntity(
          tenantId,
          fact.subject,
          fact.subjectKind,
          now().toISOString(),
        );

        const outcome = await reconcile(deps, tenantId, subjectId, fact, episode, now(), span, report);
        if (outcome !== 'skipped') report.factsAdded += 1;
      }

      processed.push(episode.id);
    }

    deps.store.markExtracted(tenantId, [...processed, ...processedNonExtractable], EXTRACTION_VERSION);

    // After marking, and separately: the backlog is idempotent, so an embedder
    // that is down costs a retry next run instead of losing the extraction that
    // already succeeded.
    if (deps.vectors) {
      try {
        const backlog = deps.vectors.indexBacklog(tenantId);
        if (backlog.length > 0) {
          report.indexed = await deps.vectors.index(tenantId, backlog, now().toISOString());
        }
      } catch (error) {
        report.errors.push(
          `indice vettoriale: ${error instanceof Error ? error.message : String(error)} — il recall resta testuale`,
        );
      }
    }

    span.setAttributes({
      'muffin.memory.episodes': report.episodes,
      'muffin.memory.facts_added': report.factsAdded,
      'muffin.memory.superseded': report.superseded,
      'muffin.memory.needs_review': report.needsReview.length,
      'muffin.memory.skipped_agent': report.skippedAgentOutput,
      'muffin.memory.indexed': report.indexed,
    });
    span.end();
    return report;
  } catch (error) {
    span.end({ error });
    throw error;
  }
}

async function reconcile(
  deps: IngestDeps,
  tenantId: string,
  subjectId: number,
  fact: {
    subject: string;
    predicate: string;
    object: string;
    validFrom: string | null;
    confidence: number;
    importance: number;
  },
  episode: { id: number; trustTier: 0 | 1 | 2 | 3; content: string | null },
  now: Date,
  parent: SpanHandle,
  report: IngestReport,
): Promise<'added' | 'skipped'> {
  const existing = deps.store.activeFacts(tenantId, subjectId, fact.predicate);

  // Same thing said twice is not news.
  const duplicate = existing.find(
    (f) => (f.objectValue ?? f.objectName ?? '').toLowerCase() === fact.object.toLowerCase(),
  );
  if (duplicate) return 'skipped';

  const insert = () =>
    deps.store.addFact({
      tenantId,
      subjectId,
      predicate: fact.predicate,
      objectValue: fact.object,
      validFrom: fact.validFrom,
      episodeId: episode.id,
      // Provenance travels: a fact can never be more trusted than where it came from.
      trustTier: episode.trustTier,
      confidence: fact.confidence,
      // Everything this pipeline produces is `said` by construction: rule 2 of
      // the extraction prompt forbids inference, so a fact reaching here is
      // always something someone actually stated. The `inferred` producer is
      // the observing spine (MVP #5) — declared deferred, not forgotten, and
      // the hedging path it will feed is already tested from the store side.
      origin: 'said',
      // Never derived from confidence, and never allowed to raise it: intensity
      // changes how accurate a memory feels, not how accurate it is.
      importance: fact.importance,
      extractionV: EXTRACTION_VERSION,
      recordedAt: now.toISOString(),
    });

  // Nothing to contradict: no judge, no cost.
  if (existing.length === 0) {
    insert();
    return 'added';
  }

  // Everything else is judged, functional or not. Restricting the judge to the
  // four functional predicates was the same mistake as a closed vocabulary by
  // another name: "il mio commercialista ora è Lucia" would have accumulated
  // beside Marco forever, because `accountant` is not on a list somebody wrote
  // in advance. The list of predicates a person changes their mind about is the
  // list of predicates, and no enum is going to contain it.
  //
  // What protects beliefs is not the gate, it is the judge's own bias: its
  // default is `coexist`, and SUPERSEDE_THRESHOLD turns an unsure supersede into
  // a review. `isFunctional` now means what it says — predicates where two
  // current values are an error by definition, enforced by the invariant, not
  // the only predicates allowed to change.

  // The most recently recorded belief, chosen here rather than inherited from
  // the store's sort order. `activeFacts` now orders by importance first (so
  // that recall's six-fact cut keeps the charged ones), and the judge wants a
  // different thing entirely: the belief this one might be replacing, which is
  // the latest. Leaving it as `existing[0]` would have silently made "the most
  // important fact" the supersede candidate the day that ORDER BY changed.
  const candidate = [...existing].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]!;
  let verdict: JudgeOutcome;
  const judgeSpan = deps.tracer.start(
    'muffin.chat_call',
    { [ATTR.operationName]: 'memory.judge', [ATTR.requestModel]: deps.model },
    parent,
  );
  try {
    verdict = await judgeContradiction(deps.provider, deps.model, {
      subject: fact.subject,
      predicate: fact.predicate,
      existing: candidate,
      incoming: { object: fact.object, validFrom: fact.validFrom },
      evidence: {
        existing: deps.store.episodeById(tenantId, candidate.episodeId)?.content ?? undefined,
        incoming: episode.content ?? undefined,
      },
    });
    judgeSpan.setAttributes({ 'muffin.memory.verdict': verdict.verdict, 'muffin.memory.judge_confidence': verdict.confidence });
    judgeSpan.end();
  } catch (error) {
    judgeSpan.end({ error });
    // A broken judge must not be able to retire a belief — same rule as the
    // low-confidence branch eight lines below, and reported the same way.
    // Silently returning 'added' here made an unreachable judge (network,
    // auth, a 5xx on the light provider) indistinguishable from an ordinary,
    // considered 'coexist': not a decision, and looking like one is how "the
    // memory just accumulates" becomes something nobody can explain.
    report.errors.push(
      `giudice non raggiungibile su ${fact.subject}/${fact.predicate}: ` +
        `${error instanceof Error ? error.message : String(error)} — tengo entrambi i valori`,
    );
    insert();
    return 'added';
  }

  const newId = insert();

  // A judge that could not answer at all reads as `coexist` with zero
  // confidence. The outcome is the safe one, but it is not a decision, and
  // letting it look like one is how "the memory just accumulates" becomes
  // something nobody can explain months later.
  if (verdict.confidence === 0 && verdict.downgraded) {
    report.errors.push(
      `giudice non disponibile su ${fact.subject}/${fact.predicate}: tengo entrambi i valori`,
    );
  }

  switch (verdict.verdict) {
    case 'supersede':
      deps.store.supersede(tenantId, candidate.id, newId, now.toISOString());
      report.superseded += 1;
      break;
    case 'temporal_scope':
      deps.store.supersede(
        tenantId,
        candidate.id,
        newId,
        now.toISOString(),
        verdict.oldValidTo ?? fact.validFrom ?? now.toISOString(),
      );
      report.superseded += 1;
      break;
    case 'review':
      // Both stay. The owner is told, rather than the system choosing quietly.
      report.needsReview.push({
        subject: fact.subject,
        predicate: fact.predicate,
        existing: candidate.objectValue ?? candidate.objectName ?? '',
        incoming: fact.object,
        why: verdict.reasoning,
      });
      break;
    case 'coexist':
      break;
  }
  return 'added';
}
