# Memory proposal provenance and writer-lane review — 2026-10-07

## Question and observed state

Does the intentional-memory path preserve the trust of information available to
the model when it stages a proposal, and does the shared memory writer lane
protect a reconciliation snapshot until its asynchronous judge result commits?

Initial observation on PR #850 head `3b1ae3aaf47f681371d26852f5bebea715d94048`, tree
`e93308733fcb00d8cee251e261731bdbcb73058f`, based on `dev` at
`b178dd3201d13a658a054e3cf28a005ea724afd5`:

1. `agent/runtime.ts` registers `memory_propose` with tenant and turn ID, but
   omits the runtime taint functions. `agent/tools/memory-propose.ts` defaults
   empty `evidence_ids` to the current ingress episode. `proposeMemoryRecord`
   derives proposal tier only from cited episodes. A current-turn tier-3 tool
   result can therefore influence an inference whose fallback evidence is the
   tier-0 owner ingress, leaving the durable proposal and accepted fact at tier
   0.
2. `reconcileProposal` holds the durable memory lane across a judge await.
   `ingestPending` releases that lane before `Consolidator.execute` calls
   `sweepDuplicates`; the sweep reads active facts and retires duplicates
   without reacquiring it. A second runtime sharing the database can sweep a
   candidate during the await. With equal `recorded_at` duplicate facts, the
   candidate lookup has no ID tie-break while the sweep keeps the larger ID.
   The reconciler can then commit a review referencing an expired fact, and the
   open-review join hides it.

## Decision table

| Claim | Current invariant | Smallest local fix | Alternative and counter-evidence | Choice and falsifier |
|---|---|---|---|---|
| Proposal trust cannot be lowered by omitted or selectively cited evidence. | ADR-0051 says a tier-3 inference cannot become tier 0 by paraphrase. `ToolContext.taint()` covers everything physically available in the current prompt, including reinjected history, while `intrinsicTaint()` excludes history/plan ceilings to avoid the reply/todo ratchet documented by ADR-0044. | Derive proposal tier as `max(cited episode tiers, current turn taint)`; pass the live taint function only from runtime, never from model arguments. Return the same derived tier from the tool. | Using `intrinsicTaint()` avoids stamping history-only ceilings but can lose a still-present injected instruction that causes a durable proposal. Requiring model-supplied episode IDs is weaker: the model can omit an influential result or select a lower-tier source. CaMeL's control/data-flow extraction is a finer-grained alternative but would require a new execution architecture. | Use current turn taint: memory proposals can persist a belief and must inherit every source physically present to the model. This accepts the conservative history ceiling already required for in-prompt actions; revisit if dogfood demonstrates lasting false-positive memory tiers after the tainted history leaves the prompt. Falsify through the production `memory_propose` handler: ingress and selected source tier 0, current turn taint 3, then assert proposal and resulting fact stay tier 3; removing the runtime taint floor must make the regression fail. |
| Reconciliation review rows remain answerable until owner resolution. | The shared lane is held across judge calls and owner decisions; the production duplicate sweep was the unguarded writer. | Reacquire the existing lane around the sweep's snapshot and retirements; report a busy sweep explicitly and let consolidation mark the run busy. | A transaction around the sweep alone cannot cover another process's asynchronous judge wait. Removing the sweep avoids the race but leaves exact duplicate active beliefs, a condition this maintenance path owns. The existing deterministic sweep-vs-sweep test does not cover a reconciliation writer. | Use the same durable lane, with no new lock or schema. Falsify on a file-backed DB with two equal-time duplicate facts, a blocked proposal judge and a second `MemoryStore` sweep: sweep must report busy, preserve the candidate, and the committed review must remain visible and resolvable. |
| A duplicate proposal's higher live taint must not be lost while reconciliation is deciding it. | `insertProposal` currently autocommits `INSERT OR IGNORE`, `SELECT id`, and pending-only `UPDATE trust_tier = MAX(...)` separately. Reconciliation re-reads the tier and writes the fact plus terminal outcome atomically after the judge await. If resolution lands between staging statements, the update affects zero rows and the fact can stay tier 0 while the duplicate request carried tier 3. | Wrap the existing insert, ID lookup and pending-only tier promotion in one SQLite `IMMEDIATE` transaction. | An atomic `ON CONFLICT ... DO UPDATE ... WHERE status='pending'` can express promotion in one statement, but keeping the current `changes`-based duplicate result and ID lookup makes it less direct. Removing promotion avoids the race by discarding the required monotonic taint floor. Extending the reconciliation lane to staging would hold a semantic lock around producer work and is broader than needed. | Use the short `IMMEDIATE` transaction: SQLite serializes writers, and this existing multi-statement storage operation then orders wholly before reconciliation's commit or after its terminal status. No schema or lane change is needed. Falsify with two processes/connections and a controlled pause after the duplicate insert: while staging owns the transaction, reconciliation must not commit; after staging resumes, the resulting fact must retain tier 3. Also verify a duplicate ordered after terminal commit leaves the outcome unchanged. |

## Peer evidence and limits

- CaMeL extracts control and data flow from a trusted query and keeps untrusted
  data from influencing program flow. This is evidence that a scalar whole-turn
  tier is a coarse approximation, not a reason to build CaMeL into this local
  repair. Debenedetti et al., *Defeating Prompt Injections by Design* (2025):
  <https://arxiv.org/abs/2503.18813>.
- Louck's 2026 preprint argues that content scoring and derivation edges can be
  laundered by summarization and tool echoes, and proposes write-time,
  origin-bound non-malleable authority. This challenges trusting only
  model-selected `evidence_ids`; its threat model and benchmark are not an
  independent evaluation of Muffin, and its broader authority machinery is not
  adopted here. *Securing LLM-Agent Long-Term Memory Against Poisoning*:
  <https://arxiv.org/abs/2606.24322>.
- Mem0's current documentation describes LLM extraction, metadata scoping and
  retrieval, but makes no security claim about ambient taint or source-bound
  promotion. It is product documentation, not a security evaluation:
  <https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/how-it-works.mdx>.

These sources support retaining deterministic write-time provenance and
challenge how much a scalar or caller-supplied lineage can establish. They do
not settle Muffin's product policy. The selected changes enforce the current
ADR/security promise without a schema migration or a new provenance system.

For the staging/reconciliation race, SQLite's primary documentation says that
separate connections see only committed transactions, SQLite serializes writes
to one writer at a time, and `BEGIN IMMEDIATE` acquires that writer position
before subsequent reads/writes. Its `UPDATE` documentation also makes explicit
that a `WHERE` clause matching no rows is a successful zero-row update — the
exact silent outcome in the reproduced interleaving. These sources support
grouping the existing statements in one short transaction; they do not make
separate autocommit statements atomic by themselves:

- [SQLite isolation](https://www.sqlite.org/isolation.html)
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite UPDATE](https://www.sqlite.org/lang_update.html)

No agent-framework peer comparison changes this storage decision: the failure
is determined by SQLite transaction boundaries, and the existing single-writer
memory semantics remain intact.

## Follow-up falsifiers found during review

Follow-up review ran against PR #850 head `132ff02d5e70b998589cc9a923541e78d104c9fc`, tree
`89e3240b13fa13748a9e320e2b37ab2863d62219`, on base `dev` at
`b178dd3201d13a658a054e3cf28a005ea724afd5`.

Review and production-path falsifiers exposed gaps in the initial implementation:

1. `proposalIdentityKey` joined free-text fields with `|`, so distinct tuples
   such as (`owner|x`, `p`) and (`owner`, `x|p`) produced the same key. It also
   omitted `validFrom`, although the row and eventual fact carry that temporal
   boundary. The key now serializes a versioned tuple and includes trimmed
   `validFrom`; the stored value uses the same trim. Tests falsify this by
   staging both delimiter cases and two temporal values against the same
   source, while confirming whitespace-only differences remain idempotent.
2. A duplicate pending proposal monotonically keeps the highest durable tier,
   but `memory_propose` originally returned only the current call's evidence
   and taint tier. A clean-context retry could therefore report tier 0 while
   committing a tier-3 fact. Responses now include the persisted proposal tier;
   the production tool test stages under a busy lane at tier 3, retries at tier
   0, and asserts both the returned tier and committed fact remain tier 3.
3. Automatic consolidation rearmed after a complete proposal page, but the
   manual `muffin memory extract` loop only considered episode and vector
   progress. When episodes were already extracted, it could close the runtime
   and cancel the scheduled follow-up with proposals left pending. The CLI loop
   now continues on a full proposal page within its existing round limit, with
   tests for the stop condition and command loop.
4. Idempotent terminal replay could phrase an old acceptance or supersession
   in the present tense after its fact was retired. The tool now labels those
   outcomes as history and asks the model to check `memory_search` for current
   state; new outcomes still use the immediate reconciliation result.
5. With equal `recorded_at`, reconciliation selected a candidate without the
   ID tie-break used by the duplicate sweep. The sweep could therefore retire
   the fact referenced by a just-created open review. Extraction and proposal
   reconciliation now use the same descending ID tie-break, and a production
   `Consolidator` test verifies the post-ingest sweep leaves the review open
   and resolvable.
6. Fresh CRITICAL review of PR #850 head
   `779514a595ad7c1d49cb26868bc28c27b17916b6` found that duplicate tier
   promotion was three separate autocommit statements. A second process can
   commit a terminal proposal between the initial `INSERT OR IGNORE` and the
   pending-only tier update, so the final commit's fresh read can still be tier
   0. The chosen repair groups those statements in an `IMMEDIATE` transaction;
   the regression pauses one process after the insert while another attempts
   reconciliation, then verifies the writer is serialized and the committed
   fact retains tier 3. A second connection also verifies that a duplicate
   arriving after terminal commit leaves both outcome and fact unchanged.
7. The same review found that a `review` response claimed the outcome was not a
   judge verdict, although a parsed `verdict: "review"` is exactly such a
   verdict. The response now reports only that the proposal went to review and
   points to the current review surface; parsed review and resolved replay
   regressions prevent the inaccurate claim from returning.

## Consequences and reversal signals

The proposal tier can only stay the same or rise; its origin remains derived
from the producer and source references remain unchanged. A high tier anywhere
in the current prompt will persist with the proposal and accepted fact. Unlike
ordinary assistant replies and `todo`, a durable belief proposal deliberately
uses the full current ceiling: the cost of overtainting until an injected
history item leaves the prompt is preferable to lowering trust for a persistent
belief. The accepted limitation is conservative tier inflation when inherited
history is unrelated to the proposal; revisit only with production evidence
that this materially blocks legitimate memory use.

The sweep now yields when reconciliation or owner review owns the shared lane.
Consolidation can report this as busy and retry on its next data-driven fire; it
does not retire a snapshotted candidate during judge work. Revisit if the lane
does not cover every production writer or if the retry cadence leaves duplicates
persistently unresolved.

The duplicate staging transaction is intentionally short and covers only the
insert, identity lookup and pending-tier promotion. It has no external work or
await. If it wins the SQLite writer order, reconciliation later reads the
raised tier; if terminal resolution wins, the pending-only update is a no-op.
The cross-process regression reproduced both orderings without a schema or lane
change.

## Verification

- Related local suite: 204 tests passed across 7 files, including the new
  process-interleaving and terminal-replay cases.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- The focused E5 acceptance result recorded for the preceding candidate was 1
  passed with 4 sibling scenarios skipped; exact-head hosted checks remain the
  integration gate for the replacement commit.
