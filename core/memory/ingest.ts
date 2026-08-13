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
  /**
   * Episodes with no content at all — marked done, nothing to mine. Tracked
   * separately from the other two skip counts so a caller can tell "nothing
   * pending" from "a batch of empty rows just got marked": both make
   * `episodes` read 0, and only this field says whether more work might still
   * be waiting past the current `limit`.
   */
  skippedEmpty: number;
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
  const report: IngestReport = {
    tenantId,
    episodes: 0,
    factsAdded: 0,
    superseded: 0,
    skippedAgentOutput: 0,
    skippedDocuments: 0,
    skippedEmpty: 0,
    indexed: 0,
    needsReview: [],
    errors: [],
  };

  // One extractor at a time. A hand-typed `muffin memory extract` overlapping
  // a scheduled tick used to read the same pending set and both extract it —
  // every episode processed twice, every judge call paid for twice. Refused,
  // not queued: `ingestPending` always returns a report rather than blocking
  // on a batch it did not start, and a scheduler's next tick is the retry.
  // See ingest-lock.ts for why a single lane lock — not a per-episode claim
  // like the old system's `memory_work_queue` — is the whole mechanism.
  const claim = deps.store.acquireIngestLock(now());
  if ('held' in claim) {
    report.errors.push(`${claim.held} — ${claim.remedy}`);
    return report;
  }

  const span = deps.tracer.start('muffin.turn', {
    [ATTR.operationName]: 'memory.ingest',
    [ATTR.tenant]: tenantId,
  });

  try {
    const pending = deps.store.pendingEpisodes(tenantId, EXTRACTION_VERSION, limit);

    for (const episode of pending) {
      if (!episode.content) {
        // Marked immediately, unlike the bare `continue` this replaced. An
        // empty-content episode still satisfies `content IS NOT NULL` in
        // `pendingEpisodes`, so leaving it unmarked meant it came back on
        // every future run: if `limit` such rows sat at the head of
        // `ORDER BY created_at`, the batch made zero progress forever while
        // still reporting success. Under a scheduler that is an infinite
        // no-op that looks healthy.
        report.skippedEmpty += 1;
        deps.store.markExtracted(tenantId, [episode.id], EXTRACTION_VERSION);
        continue;
      }

      // The agent's own words are evidence of what was said, never a source of
      // facts about the world. Mining them means the system manufactures its own
      // proof: Muffin infers "sembri sotto pressione", the inference becomes a
      // fact about the owner, and next week it recalls it as something it knows.
      // In the corpus being migrated, agent output is 68% of the text — this is
      // not a corner case, it is most of it.
      if (episode.role === 'agent') {
        report.skippedAgentOutput += 1;
        deps.store.markExtracted(tenantId, [episode.id], EXTRACTION_VERSION);
        continue;
      }

      // Documents are indexed for recall and never mined. A downloaded paper is
      // full of confident claims, and none of them is a belief about the owner's
      // life; the cheapest way to guarantee that is for a document to never
      // reach extraction at all. Something in a note that should become a belief
      // arrives the normal way — the owner says it, with a speaker attached.
      if (episode.kind === 'document') {
        report.skippedDocuments += 1;
        deps.store.markExtracted(tenantId, [episode.id], EXTRACTION_VERSION);
        continue;
      }

      report.episodes += 1;

      const extraction = await extractFacts(deps.provider, deps.model, {
        content: episode.content,
        speakerName: episode.role === 'user' ? 'owner' : episode.role,
        trustTier: episode.trustTier,
      });

      if (extraction.error) {
        const detail = `episodio ${episode.id}: ${extraction.error}`;
        report.errors.push(detail);
        deps.store.recordReview({
          tenantId,
          kind: 'error',
          detail: `estrazione fallita su ${detail}`,
          createdAt: now().toISOString(),
        });
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

      // Marked immediately after this episode's facts — and any judge calls
      // they triggered — are fully written. That is the smallest window the
      // constraint below allows, and far smaller than "the rest of the batch":
      // better-sqlite3 12.11.1 rejects an async transaction function
      // ("Transaction function cannot return a promise"), and this loop awaits
      // `extractFacts` and `judgeContradiction`, so no `db.transaction()` can
      // span an episode's extraction and its marker. Marking here, right after
      // the awaits return, is as close to atomic as that constraint allows.
      //
      // What remains: a crash between the last write inside this episode's
      // `reconcile()` calls and this line replays this ONE episode next run —
      // never the ones before it, which is what the old end-of-batch marker
      // risked (up to `limit` episodes, replayed together). Replaying means
      // re-running extraction and reconcile on it: an exact-repeat fact is
      // absorbed for free by reconcile's own duplicate check, and a fact whose
      // wording drifted is a second row plus, if its predicate already has an
      // active fact, a second judge call — a real cost, never a lost belief.
      // That asymmetry is decision #2 of the 2026-08-13 research doc:
      // at-least-once, because losing an extraction is silently invisible and
      // a spurious duplicate row is not.
      deps.store.markExtracted(tenantId, [episode.id], EXTRACTION_VERSION);
    }

    // After the loop, and separately: the backlog is idempotent, so an embedder
    // that is down costs a retry next run instead of losing the extraction that
    // already succeeded.
    if (deps.vectors) {
      try {
        const backlog = deps.vectors.indexBacklog(tenantId);
        if (backlog.length > 0) {
          report.indexed = await deps.vectors.index(tenantId, backlog, now().toISOString());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = `indice vettoriale: ${message} — il recall resta testuale`;
        report.errors.push(detail);
        deps.store.recordReview({ tenantId, kind: 'error', detail, createdAt: now().toISOString() });
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
  } finally {
    claim.release();
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

  // Same thing said twice is not news — but "the same thing" means the
  // CURRENT belief, i.e. `candidate`, and only that. This used to check every
  // member of `existing`: with two active facts for one (subject, predicate)
  // — a legitimately set-valued predicate, or an earlier judge `coexist` call
  // that should not have let both stand — a new value matching the OLDER,
  // non-current one returned 'skipped' right here, before the judge ever ran.
  // That is the failure the research doc names: a correction whose new value
  // happens to duplicate an existing-but-not-current fact never retired the
  // fact that actually was current, because the code never reached the
  // comparison that would have noticed. Matching only `candidate` keeps the
  // free case free — repeating what is already believed still costs
  // nothing — while letting a reversion-shaped correction reach the judge
  // like any other change. Proven in ingest.test.ts: "lets a correction that
  // repeats an older active value still reach the judge".
  if ((candidate.objectValue ?? candidate.objectName ?? '').toLowerCase() === fact.object.toLowerCase()) {
    return 'skipped';
  }

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
    // A broken judge must not be able to retire a belief.
    insert();
    return 'added';
  }

  const newId = insert();

  // A judge that could not answer at all reads as `coexist` with zero
  // confidence. The outcome is the safe one, but it is not a decision, and
  // letting it look like one is how "the memory just accumulates" becomes
  // something nobody can explain months later.
  if (verdict.confidence === 0 && verdict.downgraded) {
    const detail = `giudice non disponibile su ${fact.subject}/${fact.predicate}: tengo entrambi i valori`;
    report.errors.push(detail);
    deps.store.recordReview({
      tenantId,
      kind: 'error',
      subject: fact.subject,
      predicate: fact.predicate,
      existingFactId: candidate.id,
      incomingFactId: newId,
      detail,
      createdAt: now.toISOString(),
    });
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
      // Both stay. The owner is told, rather than the system choosing quietly
      // — and told durably: `recordReview` is what keeps this outcome from
      // disappearing into a stderr nobody reads once a scheduler, not a human
      // at a terminal, is what calls `ingestPending`.
      report.needsReview.push({
        subject: fact.subject,
        predicate: fact.predicate,
        existing: candidate.objectValue ?? candidate.objectName ?? '',
        incoming: fact.object,
        why: verdict.reasoning,
      });
      deps.store.recordReview({
        tenantId,
        kind: 'contradiction',
        subject: fact.subject,
        predicate: fact.predicate,
        existingFactId: candidate.id,
        incomingFactId: newId,
        detail: verdict.reasoning,
        createdAt: now.toISOString(),
      });
      break;
    case 'coexist':
      break;
  }
  return 'added';
}
