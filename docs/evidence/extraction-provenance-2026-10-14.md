# Automatic extraction attribution

Observed base: `dev@fbdf05371b87de5adf2601c18dd265c8ac034edb`.
Claim: model-extracted tuples are inferred projections of source evidence,
not owner assertions, and cannot acquire an automatic pin. CRITICAL (provenance).

## Measured failure and existing invariant

Production: `buildRuntime` → `onTurnEnd` → `Consolidator.notify` →
`ingestPending` → `extractFacts` → `reconcile` → canonical `MemoryStore.addFact`.
`reconcile` assigns every extracted tuple `origin=said` because the prompt
forbids inference. An owner-subject `works_as` tuple also requests a bootstrap
pin. `addFact` accepts that pin with tier 0 and origin said. A second path can
carry a prior pin onto a superseding tuple based only on episode tier.

A bounded fault probe on the compiled base supplied owner evidence containing
no profession and an extractor reply claiming “Synthetic accountant”. Actual
SQLite state: `said`, tier 0, pinned 1, original episode reference. This is an
injected model fault, not a measured live-provider hallucination rate.
The original source and the model's interpretation must remain distinct.
Schema already treats origin and source trust as orthogonal: owner-derived
inference may be tier 0 and inferred. No new taint floor is justified here.

## Decision before implementation

| Option | Evidence and counter-evidence | Consequence | Decision |
| --- | --- | --- | --- |
| Use existing inferred origin for extraction; remove bootstrap pin and gate pin inheritance on incoming origin/trust | Same interpretation boundary already repaired for intentional proposals (#886); existing store/recall supports inferred. Correct facts also carry interpretation status and no automatic profile pin. | No added calls, schema, writer or language restriction; source episodes and explicit owner pin remain. | Choose bounded attribution repair. |
| Add evidence spans or an independent semantic verifier | TrustMem supports measuring verified transitions. Exact substring presence alone does not establish the tuple's entailment; model judgment remains fallible. | Additional contract/calls require comparative quality/cost evidence. | Reserve for the paired memory experiment. |
| Remove automatic extraction; retain source-history search | Original evidence avoids generated-fact errors; existing October12 research makes this a credible control. | May lose useful compact recall and correction. | Allow this arm to win the pending experiment; do not settle quality by this fault probe. |
| Expand lexical owner-fact parser | Previous preserved candidate loses prepositions and rejects ordinary speech. | Language restrictions and maintenance without general semantic proof. | Reject. |

No relabeling of old beliefs or owner-state mutation. New inferred successors
cannot inherit a pin from an older belief merely because a model claimed a
correction. Genuine owner-authored candidates and explicit `memory pin` retain
their existing route. Reconciliation, source trust, episode references, tenant
scope, confidence, importance and history remain the existing primitives.

## Supporting and adversarial prior art

[HaluMem v3](https://arxiv.org/html/2511.03506v3) separately evaluates extraction,
updates and answers, and observes errors propagating from memory writes. It uses
synthetic evolving users and GPT-4o scoring; it does not establish Muffin's error
rate or prove this attribution fix improves answer quality.
[TrustMem v1](https://arxiv.org/html/2606.25161v1) learns memory-editing behavior
with intermediate transition verification and reports improved benchmark
reliability. This challenges abandoning useful generated memory, but trained
benchmark gains are not proof that an extra generic verifier is warranted here.

Pinned [Hermes memory tool at53bc70c5](https://github.com/NousResearch/hermes-agent/blob/53bc70c5ee8544040cd9f0708d25c0f55276a44b/tools/memory_tool.py)
allows agent-authored notes; [OpenClaw at94b92ccb](https://github.com/openclaw/openclaw/blob/94b92ccb37c8f7b83ef859b0a1dd24cad6d29497/docs/concepts/memory.md)
separates memory content from operational authority. Current
[Letta memory documentation](https://docs.letta.com/configuration/memory), read
October14, describes editable Git-backed memory. These are counterexamples to
requiring human confirmation for every useful memory write. None proves that
Muffin should describe an interpreted tuple as literally owner-stated.
The October12 paired history/proposal/consolidation evaluation remains NOT_RUN;
this slice fixes attribution, not memory quality or background scheduling.

## Falsifiers and evidence budget

Fail if an extracted tuple becomes said, requests/receives a bootstrap pin,
inherits an older pin after supersede/temporal_scope, loses its original evidence,
or appears in recall without inferred attribution. Include accurate paraphrase,
unsupported inference, hostile flags, tier-3 evidence, foreign tenant, persisted
reopen, explicit owner pin and a legitimate owner-authored successor. Register
red-first production-ingest tests; mutate attribution and pin-transfer seams;
use compiled CLI extraction with real provider responses and independent SQLite
oracles. Relevant focused coverage, canonical exact-head CI and fresh CRITICAL
review are required before integration. Personal deployment is separately gated.
