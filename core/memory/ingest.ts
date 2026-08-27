import type { Provider } from '../../agent/providers/types.js';
import type { Principal } from '../policy/types.js';
import type { SpanHandle, Tracer } from '../tracing/types.js';
import type { VectorIndex } from './vectors.js';
import { ATTR } from '../tracing/types.js';
import { extractFacts } from './extract.js';
import { describeFailureReason, judgeContradiction, type JudgeOutcome } from './judge.js';
import { EXTRACTION_VERSION } from './schema.js';
import type { MemoryStore } from './store.js';

/**
 * The ingestion job: episodes in, facts out.
 *
 * Runs one tenant at a time, always. Not for tidiness — a batch that queries
 * across tenants for efficiency is how a stranger's claim ends up in the
 * owner's profile, and nothing downstream would notice.
 *
 * Never on the response path: this is a background job. Since ADR-0038 it has a
 * trigger — `core/memory/consolidator.ts`, a trailing-edge debounce armed by the
 * end of every turn — and the property that made this sentence worth writing is
 * now the thing that trigger is built to hold: a turn never waits for
 * extraction, so the hook that arms the lane may only start a timer.
 */

/**
 * The lane's own principal, and the first producer a slot in
 * `core/policy/types.ts` has ever had.
 *
 * It lives here, next to the work it names, rather than in `consolidator.ts`
 * which is its main consumer — that direction keeps the import one-way
 * (consolidator → ingest) instead of building a cycle around a constant.
 *
 * The claim it carries is deliberately narrow, and `consolidator.ts` states it
 * in full: the kernel never inspects `source`, so this is not a policy branch.
 * It is what distinguishes the memory lane from a scheduled job in the two
 * places the owner can look — this span in `muffin trace`, and the `capability`
 * column behind `/spend`.
 */
export const CONSOLIDATION_PRINCIPAL = {
  kind: 'system',
  source: 'consolidation',
} as const satisfies Principal;

/**
 * Identity predicates that pin themselves at the moment they are recorded,
 * with no judgment call left to the extractor. Small and hardcoded on
 * purpose, the same shape as `schema.ts`'s `DEFAULT_FUNCTIONAL_PREDICATES`:
 * grown by audit, never guessed at, because every predicate added here pins
 * itself into every future turn forever. These two are the exact predicates
 * the real dogfood database had recorded for the owner's identity before this
 * column existed (migration 3's own backfill targets the same pair).
 */
const BOOTSTRAP_IDENTITY_PREDICATES = new Set(['works_as', 'created']);

/**
 * Whether `subject` is the extraction pipeline's own name for the person on
 * the other end of the conversation — not a guess: `speakerName` below hands
 * the extractor literally `'owner'` for every user-role episode, and
 * `extract.ts`'s SYSTEM prompt (rule 5's own worked example) instructs it to
 * use that same literal word as `subject` for a first-person fact. A fact
 * whose `subject` is that word is therefore about the owner by construction
 * of this pipeline's contract, on any tenant, not by matching this
 * install's real name into the source.
 */
function isOwnerSubject(subject: string): boolean {
  return subject.trim().toLowerCase() === 'owner';
}

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
  /**
   * Rows `pendingEpisodes` handed back this run — the page size actually read,
   * not the page size asked for.
   *
   * With `marked` below, this is what makes draining a backlog decidable
   * without a second query. `fetched < limit` means the queue is shorter than
   * one page, i.e. there is nothing left behind this batch. Counting instead of
   * re-asking matters because the obvious re-ask — "is `stats.pending` still
   * above zero" — is the alternative ADR-0038 rejected by name: an episode that
   * fails extraction permanently keeps that count above zero forever.
   */
  fetched: number;
  /**
   * Episodes whose `extraction_v` this run advanced — mined, or skipped for a
   * declared reason and marked done.
   *
   * The progress signal, and the whole anti-livelock argument for the drain:
   * `marked === 0` on a **full** page means the head of the queue cannot be
   * consumed, so continuing would re-read the same rows and pay the same model
   * calls forever. Derived from the marker rather than from `episodes`, which
   * counts episodes the extractor *attempted* — a failed extraction is
   * deliberately left unmarked (retry next run), so it raises `episodes` while
   * making no progress at all.
   */
  marked: number;
  episodes: number;
  factsAdded: number;
  /**
   * Candidates `extractFacts` parsed but discarded before they ever reached
   * `reconcile` — confidence below the floor, or shaped like an obeyed
   * instruction rather than a description of one (P25, `looksInjected` in
   * `extract.ts`). Summed across the round's `ExtractionResult`s rather than
   * split by reason, the same one-count shape `ExtractionResult.rejected`
   * itself uses.
   */
  rejected: number;
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
  /**
   * The lane lock refused: another extraction already held it.
   *
   * Structural rather than left for a caller to recognise in `errors[0]`. The
   * automatic lane has to tell this apart from a failure because they mean
   * opposite things — this one is the guarantee working — and matching on the
   * Italian text of a refusal message would make the run log depend on wording.
   */
  busy: boolean;
  needsReview: { subject: string; predicate: string; existing: string; incoming: string; why: string }[];
  /**
   * Everything that went wrong this round **except** a judge whose answer
   * could not be read — that one entry per candidate lives in
   * `judgeUnavailable` below instead, kept apart rather than folded in here.
   * A caller that wants "how many problems this round" adds both lengths,
   * the same way `fetched`/`marked` already coexist as two related-but-
   * distinct counts in this file: one flat list a caller can sum, one that
   * carries the structure (subject, predicate) a reader needs to fold by.
   */
  errors: string[];
  /**
   * One entry per judge call whose answer could not be turned into a
   * verdict — never folded here. Folding by (subject, predicate) is a
   * read-side concern: `formatConsolidationLines` below, for the boot line
   * printed once per round, and `errorGroups` in `maintenance.ts`, for
   * `muffin memory review` folding across every round on the durable
   * register. Both derive counts from these raw occurrences (or from the
   * `memory_review` rows they produced) rather than from a count kept here,
   * which could drift from what actually happened.
   */
  judgeUnavailable: JudgeUnavailable[];
};

/** One judge call this round that could not be turned into a verdict. */
type JudgeUnavailable = {
  subject: string;
  predicate: string;
  /** `describeFailureReason` output: "vuota" · "non-json" · "schema: <campo> — <messaggio>". */
  reason: string;
};

/**
 * What a human reads at the end of a consolidation round — grouped, not one
 * line per candidate.
 *
 * `judgeUnavailable` carries one entry per candidate because the write is
 * the honest count of what happened, the same argument `errorGroups`
 * (`maintenance.ts`) makes for the durable register it feeds. Printing it
 * verbatim is what put "giudice non disponibile su owner/interest" on the
 * owner's screen three times in a row for three candidates in the same
 * round (2026-08-16) — the same failure, not three of them. This folds it
 * by (subject, predicate) before anything reaches a terminal, once per
 * round, and points at `muffin memory review` for the raw response instead
 * of repeating it inline — which is exactly what the durable row is for.
 *
 * Every other error passes through unchanged: an extraction failure, a lock
 * refusal, a dead vector index. None of those is observed to repeat within a
 * single round the way a judge failure can (`reconcile` calls the judge once
 * per candidate fact, and one episode can carry several) — folding them here
 * too would hide a count instead of showing one. `errorGroups` already folds
 * the ones that *do* repeat, across rounds, on the durable register.
 */
export function formatConsolidationLines(report: IngestReport): string[] {
  const groups = new Map<string, { subject: string; predicate: string; count: number }>();
  for (const j of report.judgeUnavailable) {
    const key = JSON.stringify([j.subject, j.predicate]);
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { subject: j.subject, predicate: j.predicate, count: 1 });
  }
  const judgeLines = [...groups.values()].map(
    (g) =>
      `giudice non disponibile su ${g.subject}/${g.predicate}` +
      `${g.count > 1 ? ` ×${g.count}` : ''} — vedi muffin memory review`,
  );
  return [...judgeLines, ...report.errors];
}

export async function ingestPending(
  deps: IngestDeps,
  tenantId: string,
  limit = 20,
): Promise<IngestReport> {
  const now = deps.now ?? (() => new Date());
  const report: IngestReport = {
    tenantId,
    fetched: 0,
    marked: 0,
    episodes: 0,
    factsAdded: 0,
    rejected: 0,
    superseded: 0,
    skippedAgentOutput: 0,
    skippedDocuments: 0,
    skippedEmpty: 0,
    indexed: 0,
    busy: false,
    needsReview: [],
    errors: [],
    judgeUnavailable: [],
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
    report.busy = true;
    report.errors.push(`${claim.held} — ${claim.remedy}`);
    return report;
  }

  const span = deps.tracer.start('muffin.turn', {
    [ATTR.operationName]: 'memory.ingest',
    [ATTR.tenant]: tenantId,
    // The lane's own principal, so a trace can tell the memory lane's model
    // calls from a scheduled job's. Before the automatic trigger existed this
    // value had no producer anywhere in the repo.
    [ATTR.principalKind]: `${CONSOLIDATION_PRINCIPAL.kind}:${CONSOLIDATION_PRINCIPAL.source}`,
  });

  try {
    const pending = deps.store.pendingEpisodes(tenantId, EXTRACTION_VERSION, limit);
    report.fetched = pending.length;

    // Every marker goes through here, so `marked` cannot drift from the column
    // it claims to count. The drain decides whether to take another page from
    // this number, and a counter incremented at three of the four call sites
    // would read as "stuck" on exactly the page that was working.
    const mark = (id: number): void => {
      deps.store.markExtracted(tenantId, [id], EXTRACTION_VERSION);
      report.marked += 1;
    };

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
        mark(episode.id);
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
        mark(episode.id);
        continue;
      }

      // Documents are indexed for recall and never mined. A downloaded paper is
      // full of confident claims, and none of them is a belief about the owner's
      // life; the cheapest way to guarantee that is for a document to never
      // reach extraction at all. Something in a note that should become a belief
      // arrives the normal way — the owner says it, with a speaker attached.
      if (episode.kind === 'document') {
        report.skippedDocuments += 1;
        mark(episode.id);
        continue;
      }

      report.episodes += 1;

      // The step that costs the most and was the only one nobody could see.
      //
      // Measured on the owner's install on 27/08: one idle round spent 129
      // seconds against the model across fourteen episodes and produced zero
      // facts — and the trace file for that day held `memory.recall` and
      // `memory.ingest` spans and not one for the calls that burned the time.
      // The judge got this same span in #141 for the same reason; extraction is
      // the larger half and was still missing.
      const extractSpan = deps.tracer.start(
        'muffin.chat_call',
        { [ATTR.operationName]: 'memory.extract', [ATTR.requestModel]: deps.model },
        span,
      );
      let extraction: Awaited<ReturnType<typeof extractFacts>>;
      try {
        extraction = await extractFacts(deps.provider, deps.model, {
          content: episode.content,
          speakerName: episode.role === 'user' ? 'owner' : episode.role,
          trustTier: episode.trustTier,
        });
      } catch (error) {
        extractSpan.end({ error });
        throw error;
      }
      extractSpan.setAttributes({
        [ATTR.usageInputTokens]: extraction.usage.inputTokens,
        [ATTR.usageOutputTokens]: extraction.usage.outputTokens,
        [ATTR.cacheReadTokens]: extraction.usage.cacheReadTokens,
        'muffin.memory.facts': extraction.facts.length,
      });
      // A model that answers something unusable is not an exception — the
      // function returns normally with `error` set — so without this the span
      // would close green on the exact rounds that produced nothing.
      extractSpan.end(extraction.error === undefined ? undefined : { error: new Error(extraction.error) });

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

      report.rejected += extraction.rejected;

      // Una perdita parziale che nessuno vede è una perdita silenziosa. Da
      // quando i candidati si validano uno per uno, un episodio può essere
      // marcato come fatto **avendo scartato** qualche fatto per strada: senza
      // questa riga il rapporto direbbe «3 fatti» e non «3 fatti su 5».
      if (extraction.malformed !== undefined && extraction.malformed > 0) {
        const detail =
          `episodio ${episode.id}: ${extraction.malformed} candidati fuori schema, tenuti gli altri` +
          (extraction.malformedWhy === undefined ? '' : ` — ${extraction.malformedWhy.join(' · ')}`);
        report.errors.push(detail);
        deps.store.recordReview({
          tenantId,
          kind: 'error',
          detail,
          createdAt: now().toISOString(),
        });
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
      mark(episode.id);
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
    pinned: boolean;
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
      // The extractor's own strict-vocabulary request, OR the small bootstrap
      // rule: a fact about the owner (by this pipeline's own subject-naming
      // convention, see `isOwnerSubject`) on one of the two identity
      // predicates the real install had already recorded before this column
      // existed. Either way this is only a *request* — `addFact`'s own gate
      // is what actually decides, from `episode.trustTier`/`origin` here, not
      // from anything this module claims.
      pinned: fact.pinned || (isOwnerSubject(fact.subject) && BOOTSTRAP_IDENTITY_PREDICATES.has(fact.predicate)),
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
    judgeSpan.setAttributes({
      'muffin.memory.verdict': verdict.verdict,
      'muffin.memory.judge_confidence': verdict.confidence,
      // The same three attribute names the loop's own `muffin.chat_call` sets,
      // because this span carries that same name and a reader cannot be
      // expected to know which of the two produced it. Without them a judged
      // step showed a duration and a model and no tokens, which on a per-step
      // view reads as *free* rather than as *unrecorded* — the spend was
      // always billed (`agent/providers/light-lane.ts`), only invisible.
      [ATTR.usageInputTokens]: verdict.usage.inputTokens,
      [ATTR.usageOutputTokens]: verdict.usage.outputTokens,
      [ATTR.cacheReadTokens]: verdict.usage.cacheReadTokens,
    });
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

  // A judge whose answer could not be turned into a verdict at all reads as
  // `coexist` with zero confidence. The outcome is the safe one, but it is
  // not a decision, and letting it look like one — a durable row that says
  // only "tengo entrambi i valori" — is how "the memory just accumulates"
  // becomes something nobody can explain months later. This is what an
  // owner running a real install saw three times in a row on 2026-08-16,
  // for a light model that had answered but not in a shape the schema could
  // read, with the row itself unable to say which of three problems it was.
  //
  // Keyed on `verdict.failure`, not on `confidence === 0`: a legitimately
  // parsed `supersede` can itself carry confidence 0 (the model is allowed
  // to say so), and that case is the threshold downgrade inside
  // `judgeContradiction` — a considered `review`, not a failure to read the
  // answer. The old condition could not tell the two apart and would run
  // both this block and the `case 'review'` branch below for the same
  // candidate, writing two review rows for one judge call.
  if (verdict.failure) {
    const reason = describeFailureReason(verdict.failure.reason);
    report.judgeUnavailable.push({ subject: fact.subject, predicate: fact.predicate, reason });
    deps.store.recordReview({
      tenantId,
      kind: 'error',
      subject: fact.subject,
      predicate: fact.predicate,
      existingFactId: candidate.id,
      incomingFactId: newId,
      // First line is the summary `errorGroups` (`maintenance.ts`) folds on
      // and `muffin memory review` always shows; everything after it is the
      // model's own words, shown only with `--verbose` — free text, not a
      // second column (`store.ts` `ReviewItemInput.detail`).
      detail:
        `giudice non disponibile su ${fact.subject}/${fact.predicate}: tengo entrambi i valori [${reason}]\n` +
        `risposta grezza: ${verdict.failure.rawResponse || '(vuota)'}`,
      createdAt: now.toISOString(),
    });
  }

  // Pin follows the *current* belief, not a specific row — a pinned fact
  // superseded here would otherwise vanish from every future turn's
  // unconditional core the moment the owner corrects it (a new name, a new
  // stated preference), which is the opposite of what pinning that belief
  // meant. Gated on this episode's own trust tier, same as `addFact`'s gate:
  // a low-trust message that talks the judge into a supersede must not be
  // able to ride the old fact's pin onto the new one — `candidate.pinned`
  // says the *old* value was owner-said, it says nothing about this one.
  const carryPin = (): void => {
    if (candidate.pinned === 1 && episode.trustTier === 0) deps.store.setPinned(tenantId, newId, true);
  };

  switch (verdict.verdict) {
    case 'supersede':
      deps.store.supersede(tenantId, candidate.id, newId, now.toISOString());
      report.superseded += 1;
      carryPin();
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
      carryPin();
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
