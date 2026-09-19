---
name: jev-shadow
description: Use TypeSafe/Jev as a shadow semantic-judgment layer for bounded development decisions — milestone relevance, triage dispositions, scope drift, evidence sufficiency. Use when a decision needs semantic judgment that deterministic evidence alone does not settle.
---

# Jev shadow

Jev (TypeSafe System One) supplies **bounded semantic judgments**. Code, Git,
tests, schemas and shells own deterministic facts. Jev never approves or
merges, never overrides deterministic evidence, never certifies
security/privacy, never grants authority, and never becomes product truth.
Full framework work, if any, is tracked in issue #607 — this skill is only the
minimum shadow procedure.

## Decision routing

```text
DETERMINISTIC FACT      → code / Git / tests / schema / shell
BOUNDED SEMANTIC JUDGMENT → Jev first when useful and available
DEEP / COMPOSITIONAL REASONING → the primary model
KNOWN OWNER BOUNDARY    → deterministic escalation to the owner
```

Jev may flag additional possible owner/escalation cases. It may never waive a
deterministic owner gate.

## Availability

Jev judgments require `TYPESAFE_API_KEY` and the `@typesafe-ai/sdk` (or
equivalent access). When either is absent, route deterministically and record
`route: deterministic (jev_unavailable)` in telemetry — do not block, do not
retry with persuasive wording, do not invent a judgment.

## Candidate judgments

Ask one narrow coherent question per call; batch independent questions over the
same compact structured state. Never dump whole PRs, files or chat transcripts
— structured facts (claim, evidence pointers, checks, diff stats) are enough.

- `milestone_relevance` — does this work belong to the current program?
- `land_candidate` — LAND / FINISH / PARK / SUPERSEDE for one PR.
- `owner_boundary` — does this touch an irreversible, privacy, security or
  product-scope boundary?
- `scope_drift` — has the slice left its stated claim?
- `evidence_sufficiency` — does the evidence meet the claim's profile budget?
- `review_depth` — FAST / STANDARD / CRITICAL review candidate.
- `claim_strength` — does a claim or label sound stronger than the observed
  implementation?

## Taxonomy discipline

Every closed taxonomy must support abstention:

- `insufficient_evidence` — the state is inadequate; say what is missing.
- `other` / `none_of_the_above` — the taxonomy is inadequate; say why.

Preserve probability/confidence information. Low confidence, semantic
abstention and taxonomy failure are different states and route differently:
low confidence → gather the missing observation; abstention → deterministic
fallback; taxonomy failure → fix the taxonomy, not the answer.

## Telemetry

When economical, append one JSON line per meaningful Jev-assisted decision to
`.agents/telemetry/decisions.jsonl` (gitignored — machine-local learning data,
never source):

```json
{"decision_id": "triage-20260919-preview-wip", "repo": "owner/repo",
 "state_schema": "repo-state/v1", "state_hash": "abc123",
 "model": "jev/version", "outputs": {"land_candidate": "park_close"},
 "confidence": 0.7, "route": "deterministic|jev|model|owner",
 "primary_decision": "parked #600, branch kept", "outcome_pending": "reopen-rate"}
```

Record latency/cost only when actually exposed. Never store secrets, personal
data, or unnecessary raw private content.
