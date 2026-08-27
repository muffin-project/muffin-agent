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
  /** Present on facts: when it stopped being true out there, if anyone said. */
  validTo?: string | null;
  expired?: boolean;
  /**
   * What replaced this belief — and **only** when something really did.
   *
   * Gated on `valid_to`, never on `expired_at`, and the difference is a real
   * one the store makes on purpose. `supersede` is called from two places: the
   * judge, when a belief was actually replaced (it closes world time), and the
   * duplicate sweep, which passes `validTo: null` explicitly because *"a
   * duplicate was never a separate truth"* (`store.ts` supersede, and
   * `maintenance.test.ts` asserts the NULL). Both set `expired_at` and
   * `superseded_by`. So rendering every retired row as "was true until X,
   * replaced by Y" would report dedup bookkeeping as a change of mind — and
   * that sentence, said to the owner about their own life, is a fabrication.
   */
  replacedBy?: { id: number; text: string };
  /** Present on episodes: which connector it was learned on. */
  surface?: string;
  /**
   * Set on an item that is here as *context* for another one, never as a
   * result of its own. Neighbours are attached after the cut and never enter
   * the fusion: they did not match the query and must not displace something
   * that did.
   */
  neighbourOf?: number;
  /**
   * Present on facts. Drives how the sentence may be said, not where it ranks:
   * something the owner stated can be asserted, something we inferred goes out
   * as a hypothesis. Provenance forcing the shape of the sentence is what stops
   * the old "I noticed that…" firehose structurally instead of by prompt
   * discipline.
   */
  origin?: FactOrigin;
};

/**
 * The instant recall is evaluated at.
 *
 * An ISO timestamp, or `'all'` for every instant at once — the whole chain of
 * what was ever believed, each row labelled with when it held.
 */
type RecallWhen = string | 'all';

/** `'all'` is a sentinel, not a date, and this is the one place that knows it. */
export const EVERY_INSTANT = 'all';

/**
 * A date as a human or a model writes it, turned into an instant the store can
 * compare — or `undefined`, which the caller must refuse rather than paper over.
 *
 * Rejecting is the point. Every temporal predicate in `factsAsOf` is a string
 * comparison, so a date SQLite cannot order does not raise: it makes every
 * clause false and the search comes back empty. Empty is indistinguishable from
 * *"I never knew that"* — a typo would read to the owner as amnesia, which is
 * the worst way for this to fail and the reason parsing lives at the boundary
 * (PRACTICES §4) instead of inside the query.
 *
 * `edge` resolves what a named period means as a single instant, and the two
 * answers are genuinely different:
 *
 *   'end'    the last instant *inside* the period. What `--as-of` wants: asked
 *            about May, the useful instant is the one that has seen all of May,
 *            not the one before any of it happened.
 *   'start'  the first instant of the period. What a range's lower bound wants.
 *
 * A bare year is refused rather than guessed: `2025` as an instant is a whole
 * year of difference depending on which edge you pick, and a wrong guess there
 * is silent.
 */
export function normaliseDate(raw: string | undefined, edge: 'start' | 'end'): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();

  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const [, y, m] = month;
    const year = Number(y);
    const monthIndex = Number(m) - 1;
    if (monthIndex < 0 || monthIndex > 11) return undefined;
    return edge === 'start'
      ? new Date(Date.UTC(year, monthIndex, 1)).toISOString()
      : // The instant before the next month begins, so the whole month is inside.
        new Date(Date.UTC(year, monthIndex + 1, 1) - 1).toISOString();
  }

  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return undefined;
    // Round-tripped rather than trusted: `2026-02-31` parses to March 3rd, and
    // a date that silently became a different date is the failure this whole
    // function exists to prevent.
    if (parsed.toISOString().slice(0, 10) !== text) return undefined;
    return edge === 'start' ? parsed.toISOString() : new Date(parsed.getTime() + 86_400_000 - 1).toISOString();
  }

  const full = new Date(text);
  if (!Number.isNaN(full.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(text)) return full.toISOString();
  return undefined;
}

/**
 * Why a resolved temporal window cannot be searched, checked once every raw
 * string has already parsed cleanly through `normaliseDate`. Shared by every
 * boundary — CLI flags, tool arguments — so the two failure modes read the
 * same from a terminal and from the model, and so a third caller inherits the
 * check instead of having to remember to repeat it.
 *
 * Two modes, and both are "wrong request", never "no memory of this":
 *
 *   empty-window   `since` sits after `until`. No episode's `created_at` can
 *                   ever be inside both bounds, so the query is not merely
 *                   unlucky, it is unsatisfiable by construction — and running
 *                   it anyway would return zero rows indistinguishable from
 *                   genuine amnesia, which is exactly the failure
 *                   `normaliseDate`'s own doc comment refuses to risk for a
 *                   single malformed date.
 *   future-asof     the graph is asked what it believed at an instant that
 *                    has not happened. `factsAsOf` would answer anyway —
 *                    nothing can have expired past "now" yet, so it would
 *                    silently return today's facts — which is a prediction
 *                    wearing a memory's clothes. `EVERY_INSTANT` is exempt
 *                    on purpose: "all of history" is not a single instant
 *                    that can be in the future.
 */
export type TemporalWindowError = 'empty-window' | 'future-asof';

export function checkTemporalWindow(
  resolved: { asOf?: string | undefined; since?: string | undefined; until?: string | undefined },
  now: string = new Date().toISOString(),
): TemporalWindowError | null {
  if (resolved.since !== undefined && resolved.until !== undefined && resolved.since > resolved.until) {
    return 'empty-window';
  }
  if (resolved.asOf !== undefined && resolved.asOf !== EVERY_INSTANT && resolved.asOf > now) {
    return 'future-asof';
  }
  return null;
}

/**
 * What a recall could not answer, said out loud instead of left silent.
 *
 * The failure this exists to stop is specific: asked *"who was my contact in
 * May"* about an entity whose graph starts in June, recall used to return June's
 * belief with no mark on it, and the turn answered a question about May with a
 * fact about today. A wrong answer that looks like an answer is the worst
 * available outcome — worse than "I don't know", which is at least true and
 * which the owner can act on.
 */
type RecallGap = {
  kind: 'temporal';
  /** The entity the graph was interrogated about. */
  entity: string;
  /** The instant asked for, at which nothing was in force. */
  asOf: string;
  /** The nearest thing on record, so the answer can be "the earliest I have is…". */
  nearest?: { text: string; recordedAt: string };
};

export type RecallOptions = {
  limit?: number;
  /**
   * **The instant the graph is evaluated at.** Absent means now.
   *
   * This is the parameter, and it is a primitive rather than a flag because it
   * does not add a query — it removes a constant. Recall has always had an
   * instant baked into it: `activeFacts`' `expired_at IS NULL` and
   * `searchEpisodes`' `superseded_at IS NULL` both mean "as of this moment",
   * hardcoded, unreachable. `asOf` names that moment and lets a caller move it.
   *
   * `'all'` is the same parameter's other end: every instant, which is what
   * `--history` asks for. It is deliberately a *value of this option* and not a
   * second boolean beside it — `knowledge/05-person-model.md` records the
   * half-life/TTL/`validity_horizon` mess as three knobs for one idea and the
   * rule that came out of it, *"nel nuovo va una primitiva sola, non tre"*.
   *
   * What this must never become: a classifier. Nothing here reads the query
   * text looking for "a maggio" and flips the mode — `02-ontologia.md` §9 rules
   * that out by name (*"niente classificatore «è una domanda storica»"*), with
   * the intent-classifiers this project demoted to monitor-only twice as the
   * evidence. The caller says which instant it means; recall labels what it
   * finds; the model decides.
   */
  asOf?: RecallWhen;
  /**
   * The episode just recorded for this turn. Excluded from the results, so recall
   * never hands the model back the very message that triggered it — the input is
   * stored before recall runs (evidence-first) and full-text would otherwise
   * match it exactly.
   */
  excludeEpisodeId?: number;
  /**
   * Navigation over the evidence — the `(surface, date_range)` filter of
   * `02-ontologia.md` §9. Distinct from `asOf`, and the distinction is not
   * pedantry: `asOf` says *which graph*, these say *which evidence may be
   * looked at*. A message from August is a perfectly good source for a question
   * about May, so `asOf` must not filter episodes by date — only an explicit
   * range may.
   */
  surface?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  /**
   * How many episodes before and after each recalled episode to carry, in its
   * own thread. The `vicinato` primitive, and the reason it is not a
   * convenience is in `02-ontologia.md` §9: without its surroundings a recalled
   * episode is a cut sentence, and the easiest thing for a model to do with a
   * cut sentence is invent the rest.
   */
  neighbours?: number;
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
  /**
   * Questions this recall could not answer. Empty on the ordinary path.
   *
   * Sibling of `strategies` and there for the same reason: a recall that came
   * back worse than it looks must say so. `strategies` covers "a half did not
   * run"; this covers "the half ran and the memory does not reach that far".
   */
  gaps: RecallGap[];
  /**
   * Pinned facts `PINNED_BUDGET` could not fit this turn — recency decided
   * which stayed, same rule `selectForExpansion` already uses for the graph
   * hop. 0 on the ordinary path (most tenants pin a handful of things, not
   * dozens), and reported in the rendered block itself, not only here: a
   * silent cut is the failure `MAX_CONTEXT_ITEMS`'s own `tetto(...)` strategy
   * exists to avoid, and this is the same guarantee for the pinned core.
   */
  pinnedOverflow: number;
};

/** RRF constant. 60 is the value from the original paper and the field default. */
const K = 60;

/** The durable episode role. Trust and speaker are deliberately separate axes. */
type EpisodeRole = NonNullable<ReturnType<MemoryStore['episodeById']>>['role'];

/** How many of an entity's facts the graph expansion carries. */
const EXPANSION_SLOTS = 6;

/**
 * Ceiling on `RecallOptions.neighbours`, enforced here rather than trusted to
 * every caller. `episodeNeighbourhood`'s own `LIMIT k` has no other bound, so
 * an unclamped value from a tool argument the model controls would let one
 * call pull an unbounded slice of a thread into context — the same shape as
 * `limit`, except `limit` is owner-typed at a terminal and this is
 * model-typed. Fixed at the primitive instead of at each boundary so a third
 * caller inherits the cap instead of having to remember it.
 */
const MAX_NEIGHBOURS = 5;

/**
 * How many of `kept`'s episodes get a neighbourhood attached — never all of
 * them. The primitive exists to un-cut *the ambiguous line* (`02-ontologia.md`
 * §9), the one anchor whose meaning depends on what came before or after, not
 * to re-inline every thread a search happened to touch. Bounding this at the
 * source also means the fourth anchor onward never pays for an
 * `episodeNeighbourhood` query whose rows `MAX_CONTEXT_ITEMS` would only have
 * discarded.
 */
const MAX_NEIGHBOUR_ANCHORS = 3;

/**
 * Ceiling on the whole result, after the neighbourhood is attached — the
 * backstop `MAX_NEIGHBOURS` and `MAX_NEIGHBOUR_ANCHORS` do not provide by
 * themselves. Each bounds one axis (one anchor's own window; how many anchors
 * get one); neither bounds their product, and neither bounds `limit`, which a
 * caller — `muffin memory search -n` has no cap of its own — can set as large
 * as it likes. Before this existed, `limit:20, around:5` on twenty threads
 * could append up to 220 rows, about 24k tokens, to a tool result
 * `runtime.ts` marks `keepResult: true` — so it was never compacted, for the
 * rest of the conversation. Exported so the test that proves this asserts
 * against the real threshold rather than a copy of the number.
 */
export const MAX_CONTEXT_ITEMS = 40;

/**
 * At most one of those slots may be taken by importance rather than recency.
 * One, not two, because the displacement has to be bounded and visible: this is
 * the whole budget importance gets to spend on retrieval.
 */
const PROTECTED_SLOTS = 1;

/**
 * The pinned core's own budget — fixed, small, and a plain constant on
 * purpose: the accepted fix for "the owner cannot get their own name back"
 * is a boolean column and an unconditional injection, not a new tier system
 * with its own knobs (owner directive, 2026-08-26). Twelve is a handful of
 * stable-identity facts (a name, a couple of standing preferences), not a
 * budget meant to hold a profile — `EXPANSION_SLOTS` (6) is the comparable
 * number for one entity's whole active fact set, and the pinned core spans
 * however many entities the owner has pinned something on.
 */
const PINNED_BUDGET = 12;

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
function selectForExpansion(facts: Fact[]): Fact[] {
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

import { RERANK_MIN_CANDIDATES } from './rerank.js';

export async function recall(
  deps: RecallDeps,
  tenantId: string,
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const limit = options.limit ?? 8;
  const strategies: string[] = [];
  const gaps: RecallGap[] = [];
  const ranked = new Map<string, { item: RecallItem; score: number }>();
  // A moved instant is a different recall, and a reader of `strategies` has to
  // be able to tell that it happened — the same argument that puts
  // `vector-non-configurato` there rather than leaving it inferable.
  const when = options.asOf;
  if (when !== undefined) strategies.push(when === EVERY_INSTANT ? 'storia' : `as-of(${when.slice(0, 10)})`);
  // Retired evidence is in scope for exactly the two modes that asked for the
  // past. Under the default instant — now — it stays out, which is what
  // `superseded_at` is for.
  const includeSuperseded = when !== undefined;

  // `role` lives on the durable episode row. Do not duplicate it into every
  // retrieval projection just to render provenance: FTS, vector and
  // neighbourhood all converge here, so one cached lookup per unique episode
  // is the single seam that decides who actually said the text. Missing role
  // fails closed as unattributed; tier 0 alone can never manufacture "tu".
  const episodeRoles = new Map<number, EpisodeRole | null>();
  const episodeSource = (id: number, tier: TrustTier, at: string, surface?: string): string => {
    if (!episodeRoles.has(id)) {
      episodeRoles.set(id, deps.store.episodeById(tenantId, id)?.role ?? null);
    }
    return describeEpisodeSource(episodeRoles.get(id) ?? null, tier, at, surface);
  };

  const fuse = (key: string, item: RecallItem, rank: number): void => {
    const contribution = 1 / (K + rank + 1);
    const existing = ranked.get(key);
    if (existing) existing.score += contribution;
    else ranked.set(key, { item, score: contribution });
  };

  // --- half one: exact words -------------------------------------------------
  const textHits = deps.store.searchEpisodes(tenantId, query, limit * 2, {
    includeSuperseded,
    surface: options.surface,
    since: options.since,
    until: options.until,
  });
  if (textHits.length > 0) strategies.push('fts');
  if (options.surface !== undefined || options.since !== undefined || options.until !== undefined) {
    strategies.push(
      `filtro(${[
        options.surface ? `superficie=${options.surface}` : '',
        options.since ? `dal ${options.since.slice(0, 10)}` : '',
        options.until ? `al ${options.until.slice(0, 10)}` : '',
      ]
        .filter((s) => s !== '')
        .join(' ')})`,
    );
  }
  textHits.forEach((hit, rank) => {
    fuse(`episode:${hit.id}`, {
      kind: 'episode',
      id: hit.id,
      text: hit.content,
      trustTier: hit.trustTier,
      source: episodeSource(hit.id, hit.trustTier, hit.createdAt, hit.connector),
      score: 0,
      surface: hit.connector,
      // Retired evidence comes back only when the past was asked for, and it
      // arrives marked. An episode that was withdrawn or a vault note that has
      // since been edited is still true of *then*, and false of now; handing it
      // over unmarked is the failure that `superseded_at` was added to avoid.
      ...(hit.supersededAt === null ? {} : { expired: true }),
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
        if (hit.kind === 'fact') {
          // A superseded belief stays embedded forever — nothing re-embeds on
          // supersede — so paraphrase can match its old text years later. The
          // text half and the graph hop both learned to gate this on
          // `includeSuperseded`; the semantic half never did, which made it the
          // one door a retired belief could still walk back through, unmarked,
          // in the *default* search — not only under `--history`. Reading the
          // full row rather than extending `provenanceOf` a second time also
          // buys the exact same successor rule the graph hop uses, instead of a
          // second, divergent copy of it.
          const fact = deps.store.factById(tenantId, hit.sourceId);
          if (!fact) return;
          if (fact.expiredAt !== null && !includeSuperseded) return;
          // The gate above only ever excluded a fact that is *itself* retired
          // — it never asked whether an *active* fact had even been recorded
          // yet as of `when`. `asOf('2026-05')` with Marco (June) superseded by
          // Lucia (August) walked Lucia through here unmarked: her row has
          // `expiredAt: null`, so the check above never fires, and the graph
          // hop's own temporal gate (`factsAsOf`, below) was never consulted on
          // this path. Reusing it here — one query per vector hit, bounded by
          // `limit * 2` — is the same primitive the graph hop already trusts,
          // not a second, divergent temporal rule. `EVERY_INSTANT` keeps its
          // own history semantics (every instant, nothing to check here); the
          // default instant (`when === undefined`) leaves the gate above
          // unchanged, so an ordinary "now" turn pays for none of this.
          if (when !== undefined && when !== EVERY_INSTANT) {
            const inForceThen = deps.store.factsAsOf(tenantId, fact.subjectId, when).some((f) => f.id === fact.id);
            if (!inForceThen) return;
          }
          const successor = successorOf(deps.store, tenantId, fact);
          fuse(`fact:${fact.id}`, {
            kind: 'fact',
            id: fact.id,
            text: hit.text,
            trustTier: fact.trustTier,
            source: describeTier(fact.trustTier, fact.recordedAt),
            score: 0,
            validFrom: fact.validFrom,
            validTo: fact.validTo,
            expired: fact.expiredAt !== null,
            ...(fact.origin === 'inferred' ? { origin: fact.origin } : {}),
            ...(successor ? { replacedBy: { id: successor.id, text: factText(successor) } } : {}),
          }, rank);
          return;
        }
        // Episode. Provenance carries `connector`/`supersededAt` for the same
        // reason it carries `trust_tier`: the vector index stores text and a
        // source id, nothing else, so this is the only place the semantic half
        // can learn either. Both the retirement gate and the (surface,
        // date_range) navigation filter of `02-ontologia.md` §9 apply here too
        // — a filter that only the text half honoured would be a guarantee that
        // reads as absolute and holds for one of two paths into the same list.
        const provenance = deps.store.provenanceOf(tenantId, hit.kind, hit.sourceId);
        // `connector` is a defensive narrowing, not a real branch: every
        // episode row carries one (`NOT NULL` in the schema), and the only way
        // it is absent here is `provenanceOf` having read the fact-shaped row —
        // which cannot happen on this path, since `hit.kind === 'fact'` already
        // returned above.
        if (!provenance || provenance.connector === undefined) return;
        const connector = provenance.connector;
        if (provenance.supersededAt != null && !includeSuperseded) return;
        if (options.surface !== undefined && connector !== options.surface) return;
        if (options.since !== undefined && provenance.createdAt < options.since) return;
        if (options.until !== undefined && provenance.createdAt > options.until) return;
        fuse(`episode:${hit.sourceId}`, {
          kind: 'episode',
          id: hit.sourceId,
          text: hit.text,
          trustTier: provenance.trustTier,
          source: episodeSource(hit.sourceId, provenance.trustTier, provenance.createdAt, connector),
          score: 0,
          surface: connector,
          ...(provenance.supersededAt == null ? {} : { expired: true }),
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
      // The instant decides which of three selectors runs, and nothing else
      // changes: the expansion bound, the ordering and the fusion are the same
      // on all three paths. `asOf` acts here — inside the graph hop, on
      // membership — and never on the score. That placement is the one
      // `importance` already uses (`knowledge/01-understanding.md`: it "acts
      // inside the graph expansion, deciding which facts survive the cut, and
      // does not enter RRF"), and the ban it obeys is the same: at k=60 a term
      // big enough to move anything is big enough to erase the agreement
      // between the two rankers, and it fails invisibly, because the list still
      // looks sorted by relevance.
      const facts =
        when === undefined
          ? deps.store.activeFacts(tenantId, entity.id)
          : when === EVERY_INSTANT
            ? deps.store.allFacts(tenantId, entity.id)
            : deps.store.factsAsOf(tenantId, entity.id, when);
      if (facts.length > 0 && !strategies.includes('graph')) strategies.push('graph');

      // The graph knows this entity and has nothing that reaches the instant
      // asked about. Silence here is what produced the defect: the entity still
      // matched the text half, so the turn got today's belief and answered a
      // question about May with it. Saying so costs one line and is the only
      // honest output.
      if (facts.length === 0 && when !== undefined && when !== EVERY_INSTANT) {
        const nearest = deps.store.nearestFactTo(tenantId, entity.id, when);
        gaps.push({
          kind: 'temporal',
          entity: entity.name,
          asOf: when,
          ...(nearest
            ? {
                nearest: {
                  text: factText(nearest),
                  recordedAt: nearest.recordedAt,
                },
              }
            : {}),
        });
      }

      selectForExpansion(facts).forEach((fact, rank) => {
        const successor = successorOf(deps.store, tenantId, fact);
        fuse(`fact:${fact.id}`, {
          kind: 'fact',
          id: fact.id,
          text: factText(fact),
          trustTier: fact.trustTier,
          source: describeTier(fact.trustTier, fact.recordedAt),
          score: 0,
          validFrom: fact.validFrom,
          validTo: fact.validTo,
          // `activeFacts` never returns a retired fact, so this reads false
          // there regardless; the other two selectors can, which is the mark
          // the history mode exists to show.
          expired: fact.expiredAt !== null,
          ...(successor ? { replacedBy: { id: successor.id, text: factText(successor) } } : {}),
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
  let kept: RecallItem[];
  if (deps.reranker && fused.length >= RERANK_MIN_CANDIDATES) {
    const outcome = await deps.reranker.rerank(query, fused.slice(0, limit * 5), limit);
    kept = outcome.items;
    // `strategies` promette di nominare «le metà che hanno davvero girato», e
    // qui diceva il falso: la riga finiva nell'elenco anche quando il rerank
    // era caduto sull'ordine RRF. Un rerank fallito **ha girato** — ha anche
    // speso una chiamata al modello — quindi resta nell'elenco, ma col motivo.
    strategies.push(
      outcome.reordered
        ? `rerank(${deps.reranker.id})`
        : `rerank(${deps.reranker.id}) non riuscito: ${outcome.why ?? 'motivo non dichiarato'}`,
    );
  } else {
    kept = fused.slice(0, limit);
  }

  // --- the neighbourhood, after the cut and never inside it ------------------
  // Attached last on purpose. A neighbour did not match the query and must not
  // be able to take a slot from something that did, nor to change anyone's
  // rank — so it is appended to the survivors rather than fused with the
  // candidates. What it does carry is its own `trust_tier`, and that is the
  // whole of the taint rule for this primitive: `recallTaint` takes the maximum
  // over the items, so a window that reaches into a group raises this turn to
  // the group's tier. At most `MAX_NEIGHBOURS` messages before and after, inside
  // a group, are that many more chances for an injection to arrive at the tier
  // of whoever searched — collapsing the window into the anchor's tier is
  // exactly that hole, and it stays closed here by construction rather than by
  // a check.
  //
  // Three clamps, not one, because each bounds a different axis and none of
  // them implies another: `MAX_NEIGHBOURS` bounds one anchor's own window;
  // `MAX_NEIGHBOUR_ANCHORS` (below) bounds how many of `kept` get a window at
  // all; `MAX_CONTEXT_ITEMS` bounds the sum of everything this call returns,
  // `limit` included. An earlier version of this comment claimed the first
  // alone made "the count" safe — true of one anchor, false of the call:
  // `limit:20, around:5` on twenty threads reached 220 rows through exactly
  // the product these three clamps now cut.
  const k = Math.min(Math.max(options.neighbours ?? 0, 0), MAX_NEIGHBOURS);
  if (k > 0) {
    strategies.push(`vicinato(${k})`);
    const already = new Set(kept.map((i) => `${i.kind}:${i.id}`));
    const context: RecallItem[] = [];
    // Only the highest-ranked few, not every episode in `kept` — see
    // `MAX_NEIGHBOUR_ANCHORS`.
    const anchors = kept.filter((item) => item.kind === 'episode').slice(0, MAX_NEIGHBOUR_ANCHORS);
    for (const anchor of anchors) {
      for (const near of deps.store.episodeNeighbourhood(tenantId, anchor.id, k, includeSuperseded)) {
        const key = `episode:${near.id}`;
        if (already.has(key) || near.id === options.excludeEpisodeId) continue;
        already.add(key);
        context.push({
          kind: 'episode',
          id: near.id,
          text: near.content,
          trustTier: near.trustTier,
          source: episodeSource(near.id, near.trustTier, near.createdAt, near.connector),
          // Zero, and it never competes: it was appended, not ranked.
          score: 0,
          surface: near.connector,
          neighbourOf: anchor.id,
          ...(near.supersededAt === null ? {} : { expired: true }),
        });
      }
    }
    kept = [...kept, ...context];
  }

  // --- the pinned core: unconditional, and first ----------------------------
  //
  // Everything above this line is retrieval: a query goes in, and what comes
  // back depends on how well the query happened to match. That is exactly
  // the shape that failed on 2026-08-26 — the owner typed "Yo!", the episode
  // that carried their name shares no word and no meaning with it, and the
  // fact never got a chance to be ranked, let alone kept. A handful of facts
  // cannot be allowed to depend on phrasing: they enter here, unconditionally,
  // ahead of anything similarity found, which is the one deliberately
  // un-ranked step in this whole function.
  //
  // This is a different layer from `rot/identity.md`, not a replacement for
  // it: identity.md is the constitution the owner writes by hand and that
  // never learns on its own — who Muffin is, what it will not do. The pinned
  // core is the layer that *does* learn, one fact at a time, through the
  // ordinary ingestion pipeline (`ingest.ts`) or a deliberate `muffin memory
  // pin`. Bootstrap auto-pin (migration 3) exists at all because identity.md
  // ships empty — today nothing in the constitution says the owner's own
  // name, and this is the layer built to hold that instead.
  //
  // Deduped against what retrieval already found — a pinned fact recall
  // ranked well on its own must not print twice — and filtered to what is
  // still active: `pinnedFacts` already drops anything expired, but a fact
  // superseded in the *same* call (vanishingly rare, cheap to guard anyway)
  // would otherwise slip past a store-level check taken before this line ran.
  const alreadyFound = new Set(kept.filter((i) => i.kind === 'fact').map((i) => i.id));
  const pinnedCandidates = deps.store
    .pinnedFacts(tenantId)
    .filter((f) => f.expiredAt === null && !alreadyFound.has(f.id));
  const pinnedOverflow = Math.max(0, pinnedCandidates.length - PINNED_BUDGET);
  const pinnedItems: RecallItem[] = pinnedCandidates.slice(0, PINNED_BUDGET).map((f) => ({
    kind: 'fact',
    id: f.id,
    text: factText(f),
    trustTier: f.trustTier,
    source: describeTier(f.trustTier, f.recordedAt),
    score: 0,
    validFrom: f.validFrom,
    validTo: f.validTo,
    origin: f.origin,
  }));
  kept = [...pinnedItems, ...kept];

  // The hard backstop: ranked results occupy the front of `kept` and
  // neighbours were appended after them, so a cut here drops context before it
  // ever drops something that actually matched the query. A cut that fires is
  // exactly the case `strategies` exists to report: a recall that came back
  // worse than it looks has to say so, the same rule `vector-non-configurato`
  // already follows. The pinned core is now at the front of `kept` too, but it
  // never has to compete for this cut in practice — `PINNED_BUDGET` (12) is
  // far under `MAX_CONTEXT_ITEMS` (40).
  if (kept.length > MAX_CONTEXT_ITEMS) strategies.push(`tetto(${MAX_CONTEXT_ITEMS})`);
  return { items: kept.slice(0, MAX_CONTEXT_ITEMS), strategies, gaps, pinnedOverflow };
}

/** One fact as a line: subject, predicate, object. Written once, read by four callers. */
function factText(fact: Fact): string {
  return `${fact.subjectName} — ${fact.predicate} — ${fact.objectValue ?? fact.objectName ?? ''}`;
}

/**
 * What replaced `fact`, if anything really did — the one rule, read by both
 * the places a superseded fact can reach recall (the graph hop and the vector
 * half), so the discriminant cannot drift between the two.
 *
 * Gated on `validTo`, never on `expiredAt`: `supersede` is called from the
 * judge, when a belief was actually replaced (it closes world time), and from
 * the duplicate sweep, which passes `validTo: null` explicitly because a
 * duplicate was never a separate truth (`store.ts` supersede). Both set
 * `expiredAt` and `supersededBy`. Keying on `expiredAt` alone would report
 * dedup bookkeeping as a change of mind.
 */
function successorOf(store: MemoryStore, tenantId: string, fact: Fact): Fact | null {
  return fact.supersededBy !== null && fact.validTo !== null ? store.factById(tenantId, fact.supersededBy) : null;
}

/**
 * Renders recall for the prompt with the provenance attached and the whole
 * block delimited as data. Spotlighting is the cheapest measured defence there
 * is — attack success from >50% to under 2% in the study that named it — and it
 * only works if the boundary is unambiguous.
 */
export function renderForPrompt(result: RecallResult): string {
  if (result.items.length === 0 && result.gaps.length === 0 && result.pinnedOverflow === 0) return '';
  const lines = result.items.map(
    (item) =>
      `- [${item.source}${temporalLabel(item)}` +
      // Only inferred is marked. Labelling `said` too would put a word in front
      // of almost every line, and a label that appears everywhere stops being
      // read — the mark has to be the exception to carry any weight.
      `${item.origin === 'inferred' ? ', dedotto — non detto' : ''}` +
      `${item.neighbourOf === undefined ? '' : ', intorno'}] ` +
      `${item.text.replace(/\s+/g, ' ').slice(0, 400)}` +
      // The successor on the same line as the belief it replaced, because the
      // two are one piece of information: "it was X, now it is Y". Split across
      // two lines the model has to re-associate them, and the failure when it
      // does not is to report the retired one as current.
      `${item.replacedBy ? `\n    ↳ sostituito da: ${item.replacedBy.text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`,
  );

  // What the memory could not answer goes in the same block as what it could,
  // and above nothing: a model that reads eight remembered lines and no note
  // will answer from the eight. This is the line that stops "who was my contact
  // in May" from being answered with today's contact.
  for (const gap of result.gaps) {
    lines.push(
      `- [lacuna] su ${gap.entity} non ho niente che valga per il ${gap.asOf.slice(0, 10)}` +
        (gap.nearest
          ? `; la cosa più vicina che ho è del ${gap.nearest.recordedAt.slice(0, 10)}: ${gap.nearest.text}`
          : '') +
        `. Dillo, non rispondere con quello che vale oggi.`,
    );
  }

  // The one line that says the pinned core itself got cut — never silent,
  // same argument as the gaps loop just above and `tetto(...)` in `recall.ts`.
  if (result.pinnedOverflow > 0) {
    lines.push(
      `- [appuntati] altri ${result.pinnedOverflow} fatti appuntati non entrano nel budget di questo turno.`,
    );
  }
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

function tierSpeaker(tier: TrustTier): string {
  return tier === 0 ? 'tu' : tier === 1 ? 'contatto noto' : tier === 2 ? 'gruppo/sconosciuto' : 'web o tool esterno';
}

function describeSource(who: string, when: string, surface?: string): string {
  return `${who}${surface ? ` via ${surface}` : ''}, ${when.slice(0, 10)}`;
}

/**
 * Episode role answers "who produced these bytes"; tier answers "how much
 * authority do these bytes carry". Conflating the two is how an agent message
 * at tier 0 used to become `[tu ...]` on recall. For non-user episodes the
 * speaker remains explicit while a non-zero tier is also shown as context, so
 * fixing attribution never launders the trust provenance that reply taint was
 * built to preserve. Unknown role fails closed: absence of attribution can
 * never be promoted to owner speech.
 */
function describeEpisodeSource(role: EpisodeRole | null, tier: TrustTier, when: string, surface?: string): string {
  const who =
    role === 'agent'
      ? 'Muffin'
      : role === 'tool'
        ? 'tool'
        : role === 'system'
          ? 'sistema'
          : role === 'user'
            ? tierSpeaker(tier)
            : 'origine non attribuita';
  const trustContext = role === 'user' || tier === 0 ? '' : ` · contesto: ${tierSpeaker(tier)}`;
  return describeSource(`${who}${trustContext}`, when, surface);
}

function describeTier(tier: TrustTier, when: string, surface?: string): string {
  return describeSource(tierSpeaker(tier), when, surface);
}

/**
 * The temporal mark on a rendered line — and, most of the time, nothing.
 *
 * This file's own rule about `origin` applies here with more force, because
 * every fact has a time and only some have a story: *"a label that appears
 * everywhere stops being read — the mark has to be the exception to carry any
 * weight"*. So a live belief whose world time nobody stated renders bare, as it
 * always did. What earns a mark is a fact that is **not simply true now**: a
 * stated world window, or a retirement.
 */
function temporalLabel(item: RecallItem): string {
  const parts: string[] = [];
  if (item.validFrom || item.validTo) {
    parts.push(`valido ${item.validFrom?.slice(0, 10) ?? '?'} → ${item.validTo?.slice(0, 10) ?? 'oggi'}`);
  }
  if (item.expired) {
    // Two different reasons a fact can be retired, and only one of them is a
    // change of mind. `supersede` is called from the judge, closing world time
    // (`validTo` set), and from the duplicate sweep, which passes `validTo:
    // null` on purpose because a duplicate was never a separate truth
    // (`store.ts` supersede's own doc comment; `successorOf` above reads the
    // same discriminant). Saying "was true before" about a row that was never
    // a distinct belief — only ever a second copy of the one that survived —
    // is a fabrication under `as-of`, exactly where a dedup-retired row is
    // often the only line left standing. Episodes have no `validTo` at all
    // (the field is fact-only): their `expired` always means the vault file
    // changed under them, which the old text was still true of when it was
    // recorded, so only a fact makes this distinction.
    parts.push(
      item.kind === 'fact' && !item.validTo ? 'riga ritirata (duplicato)' : 'non più attuale — era vero prima',
    );
  }
  return parts.length === 0 ? '' : `, ${parts.join(', ')}`;
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
