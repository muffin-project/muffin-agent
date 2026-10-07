# Memory proposal provenance and writer-lane review — 2026-10-07

## Question and observed state

Does the intentional-memory path preserve the trust of information available to
the model when it stages a proposal, and does the shared memory writer lane
protect a reconciliation snapshot until its asynchronous judge result commits?

Observed on PR #850 head `3b1ae3aaf47f681371d26852f5bebea715d94048`, tree
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
