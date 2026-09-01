# Memory lineage implementation contract — 2026-08-29

Status: **implementation contract, not runtime truth**.

This note closes the naming/ownership question discovered after the memory-composition research and before a CRITICAL schema change.

## Claim

Automatic recall in a live conversation must not re-inject an episode that is already represented by the bounded current-session history. The exclusion must use durable identity/provenance, never text similarity, timestamp proximity or role-wide suppression.

This is both a context-quality property and a provenance/security property: duplicate self-recall wastes context, amplifies old agent prose and can re-introduce taint/influence as if it were new evidence.

## Step 0: existing reality changes the proposed shape

The first candidate from the 2026-08-29 memory-composition audit was a new nullable `episodes.origin_trace_id`.

Do **not** add that column.

An older still-open CRITICAL slice, PR #186 (`slice/undo-riallinea-il-turno`), already independently introduced the narrower and better join as `episodes.turn_id`, propagated it into recall, and used it to reconcile memory after undo. That work is not on `dev` and must not be copied wholesale, but it is prior design evidence that the same durable relation has two real consumers.

Current `dev` already makes the turn id and trace id the same identity (`TurnResult.turnId` / `traceId`), and session messages already carry `traceId`. Therefore a second `origin_trace_id` would encode the same relation twice and violate the repository rule "one guarantee, one owner".

Decision:

> **`episodes.turn_id` is the canonical exact lineage from a runtime-produced episode to the durable turn that produced/observed it.**

`traceId` remains the session/tracing vocabulary. At the memory boundary, the value is stored as `turn_id` because the durable object being referenced is the turn, not an arbitrary tracing span.

Historical/imported evidence for which no native turn exists keeps `turn_id = NULL`. Never manufacture retroactive precision.

## Required data flow

```text
TurnRecord.id (= turn trace id)
        |
        +--> SessionMessage.traceId
        |
        +--> Episode.turn_id
                 |
                 +--> EpisodeHit / provenance projection
                 |
                 +--> RecallItem.turnId
```

For a fresh turn:

1. persist the durable TurnRecord before any episode;
2. write the owner's episode with `turnId = record.id`;
3. read the bounded reinjected session history;
4. collect the exact non-null `traceId`s represented by that kept history;
5. recall normally, excluding:
   - the just-written current episode by id; and
   - episode items whose non-null `turnId` is in the kept-history id set;
6. facts remain independently eligible: a fact derived from an old episode is semantic memory, not a duplicate transcript line;
7. write the final agent episode with the same `turnId = record.id`.

On resume, no second owner episode is created because context is already built; existing turn semantics remain unchanged.

## Exclusion semantics

The filter is deliberately narrow:

```text
exclude episode if
  episode.turn_id != NULL
  AND episode.turn_id is already represented in kept current history
```

Do not:

- fuzzy-deduplicate by text;
- deduplicate by timestamps;
- suppress all `role = 'agent'` episodes;
- suppress all episodes from the current thread;
- suppress facts merely because their source episode is in current history;
- infer a turn id for historical rows without exact evidence.

Why role-wide suppression is wrong: an agent-authored summary may be the only durable evidence of a previous turn and may carry important provenance/taint. Agent authorship changes attribution; it does not erase relevance or authority lineage.

Why thread-wide suppression is wrong: the current history is bounded. Older episodes from the same long-running relationship are precisely what recall is for.

## Where the filter belongs

The caller (`agent/loop.ts`) owns **which turns are already in the current prompt**, because only it owns the exact history cut (`reinjectedHistory`).

Recall owns **how an episode carrying one of those identities is excluded across every retrieval door** (FTS, vector and neighbourhood).

Do not implement the exclusion only after ranking. That would let duplicates consume candidate/reranker budget and can attach neighbourhood around an item that should never have been an anchor. Prefer a shared predicate applied wherever episode candidates enter recall, with a final defensive filter as backstop.

Pinned facts are unaffected because they are facts, not episode transcript duplicates.

## Schema/migration direction

Add nullable `turn_id TEXT` to `episodes` in both:

- `MEMORY_SCHEMA` for new databases;
- `MemoryStore` constructor via `ensureColumn` for existing databases.

No `NOT NULL`, no fake default. Existing rows remain NULL.

Add an index only if query shape demonstrates it is useful. The first implementation can filter a bounded recall candidate set in memory; do not create an index by reflex.

Foreign-keying `turn_id` to `turns(id)` is **not** part of this slice: memory and turn stores have historically had independent lifecycle/opening paths, and imported/archive evidence legitimately has no turn. A logical typed relation is sufficient for the exclusion invariant; a physical FK would be a separate durability decision.

## Compatibility with PR #186

PR #186 is not merged and is based on older `dev`. It contains broader undo reconciliation and should be judged/rebased as its own CRITICAL change.

When memory lineage lands first:

- #186 must reuse the shipped `episodes.turn_id` column and types rather than re-add them;
- its undo consumer may build on the same lineage;
- any backfill logic in #186 remains an undo-migration concern, not part of this recall slice;
- conflicts are resolved by preserving one canonical field, not by renaming one side.

Do not close #186 merely because this slice lands: memory-lineage exclusion and undo reconciliation are different guarantees sharing one primitive.

## Acceptance tests required before merge

This is CRITICAL because it changes durable schema and provenance used in action context.

At minimum:

1. **current user message** — just-written episode is never recalled;
2. **current-history agent episode** — an agent episode whose `turn_id` matches a kept session `traceId` is not recalled;
3. **older same-thread episode** — an episode from the same thread whose turn fell outside the bounded history remains recallable;
4. **historical NULL lineage** — an old row with `turn_id = NULL` remains recallable; no guessed exclusion;
5. **fact survives** — a fact sourced from an episode represented in current history can still be recalled as a fact;
6. **vector door** — semantic episode hit with excluded `turn_id` is removed;
7. **FTS door** — lexical episode hit with excluded `turn_id` is removed;
8. **neighbourhood door** — excluded episode cannot return as a neighbour or become a neighbourhood anchor;
9. **cross-thread collision impossible by identity** — same text/timestamp in another turn is not excluded;
10. **existing DB migration** — old `episodes` table gains nullable `turn_id` without data loss;
11. **fresh runtime wiring** — both user and final agent episodes receive exactly `record.id`;
12. **resume regression** — resumed turn does not duplicate the owner episode or change lineage semantics.

The runtime-level acceptance should inspect the actual `ChatCall` context, not only the store query, and prove that one current exchange appears once while an older relevant exchange can still enter through memory.

## Observability

Record enough to measure the product effect, not just test it:

- number of episode candidates excluded because already in current history;
- duplicate/self-recall rate before/after in dogfood;
- recall strategy remains visible when vector degrades;
- do not log raw excluded episode text solely for this metric.

This metric belongs with the memory-health surface proposed in `memory-composition-contract-2026-08-29.md`.

## Gate

Do not merge the runtime/schema implementation while GitHub Actions cannot execute real checks. Local evidence may be developed, but the CRITICAL slice still requires the repository's fresh independent judge and real gate before integration.

This note itself changes no runtime semantics.