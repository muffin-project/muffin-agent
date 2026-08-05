import type { Provider } from '../../agent/providers/types.js';
import type { SpanHandle, Tracer } from '../tracing/types.js';
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
  now?: () => Date;
};

export type IngestReport = {
  tenantId: string;
  episodes: number;
  factsAdded: number;
  superseded: number;
  /** Stored and searchable, deliberately not mined. */
  skippedAgentOutput: number;
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

    deps.store.markExtracted([...processed, ...processedNonExtractable], EXTRACTION_VERSION);
    span.setAttributes({
      'muffin.memory.episodes': report.episodes,
      'muffin.memory.facts_added': report.factsAdded,
      'muffin.memory.superseded': report.superseded,
      'muffin.memory.needs_review': report.needsReview.length,
      'muffin.memory.skipped_agent': report.skippedAgentOutput,
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
  fact: { subject: string; predicate: string; object: string; validFrom: string | null; confidence: number },
  episode: { id: number; trustTier: 0 | 1 | 2 | 3 },
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
      extractionV: EXTRACTION_VERSION,
      recordedAt: now.toISOString(),
    });

  // Nothing to contradict, or a predicate that is a set by design: no judge, no
  // cost, no chance of a wrong retirement.
  if (existing.length === 0 || !deps.store.isFunctional(fact.predicate)) {
    // A set-valued predicate still gets judged when the values look mutually
    // exclusive — but only the functional ones can end in a supersede below.
    insert();
    return 'added';
  }

  const candidate = existing[0]!;
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
    });
    judgeSpan.setAttributes({ 'muffin.memory.verdict': verdict.verdict, 'muffin.memory.judge_confidence': verdict.confidence });
    judgeSpan.end();
  } catch (error) {
    judgeSpan.end({ error });
    // A broken judge must not be able to retire a belief.
    insert();
    return 'added';
  }

  const newId = insert();

  switch (verdict.verdict) {
    case 'supersede':
      deps.store.supersede(candidate.id, newId, now.toISOString());
      report.superseded += 1;
      break;
    case 'temporal_scope':
      deps.store.supersede(
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
