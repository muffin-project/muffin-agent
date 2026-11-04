# Autonomous memory: evidence and decision

Date: 2026-10-12. Checkout observed: `/private/tmp/muffin-audit-20261011` at
`e9640e5e2ce64485de3ff07ad6b911d909a86e1f`. The checkout has unrelated dirty
provider-configuration work; this note is the only file changed for this task.
This is a source and code-path review. No benchmark, real-model experiment, or
runtime acceptance was run (`NOT_RUN`).

## Decision

Keep original episodes as the evidence/history layer and canonical beliefs as a
compact, attributable projection for ordinary recall. Treat background work as
a scheduling choice, not as a separate memory authority or a required agent
architecture. Keep writes behind the existing proposal/reconciliation path.
Do not replace history with summaries, or add a second memory writer.

The strongest counterthesis is that even canonical beliefs may add more errors
and upkeep than they save: direct episodic retrieval, optionally paired with
owner-authored notes, may answer future questions as well or better at equal
reader, context, latency, and cost. MemDelta's v1 results make this a credible
control, not a foregone conclusion. If it wins on Muffin tasks, reduce or remove
automatic extraction rather than preserving it for architectural symmetry.

The evidence does not establish that fixed-schedule/background curation is
necessary. It does establish that memory must be tested across writes, changes,
retrieval, downstream action, and repair. My recommendation is a bounded paired
comparison before changing memory architecture. If the current background lane
is useful, make restart recovery and queue progress explicit in the contract;
the existing unreferenced idle timer is not by itself a durable worker.

## Production path observed

- `agent/loop/engine.ts:510-530` writes the owner's ingress episode before the
  model call. The episode store redacts content at `core/memory/store.ts:345-360`.
- `agent/runtime.ts:1142-1165,1532-1536` wires a `Consolidator` to
  `ingestPending` using the configured light lane, and notifies it at turn end.
  `core/memory/consolidator.ts:545-564,596-623` schedules a bounded idle batch;
  the timer is `unref()`'d at lines 596-609. There is no immediate startup drain
  in this path. A process that exits before the idle edge does not do the work.
- `core/memory/ingest.ts:303-390` selects unprocessed episodes and extracts
  candidates; the same module reconciles updates against existing beliefs and
  commits through `MemoryStore`. Episodes remain the evidence, while facts are
  the current projection. Failed extraction remains retryable.
- `agent/loop/engine.ts:533-575` retrieves memory before the model sees the turn.
  `agent/tools/memory.ts` exposes the same recall to `memory_search`.
  `agent/tools/memory-propose.ts` stages explicit model intent and sends it
  through `reconcileProposal` rather than letting the model write facts directly.
- `agent/tools/memory-forget.ts:55-61,124-144` retires beliefs/episodes from
  normal recall while retaining history and provenance. Correction, retirement,
  and source evidence are therefore observable separately.

These are code-wiring observations at the commit above, not evidence that
spontaneous consolidation improves this owner's memory or task performance.

## What the prior-art evidence supports

- [HaluMem v3](https://arxiv.org/html/2511.03506v3) evaluates extraction,
  updating, and question answering separately. It uses synthetic evolving
  personas/dialogues and GPT-4o scoring/answer generation. It motivates measuring
  write/update errors and their propagation; it does not pick a runtime schedule.
- [MemoryAgentBench v4](https://arxiv.org/abs/2507.05257) (last revised
  2026-06-28) covers accurate retrieval, test-time learning, long-range
  understanding, and selective forgetting via incremental multi-turn input.
  Metrics differ by task; it is a source of scenarios, not a single transferable
  quality score.
- [MemSecBench](https://arxiv.org/abs/2607.27080) follows 310 constructed cases
  through write, execute, and selective repair across 24 configurations. Its
  reported attack rates are descriptive for the evaluated stacks, not estimates
  of everyday attack frequency. It supports including an untrusted-write and
  selective-repair falsifier with an environment oracle.
- [Hidden in Memory](https://arxiv.org/abs/2605.15338) traces injected content
  into persisted memory, later retrieval, and attacker-directed action. Its
  strong attack results are model- and scenario-specific; the decision-relevant
  lesson is to test the entire path, not just whether a filter accepts text.
- [MemDelta v1](https://arxiv.org/abs/2606.29914) reports that verbatim RAG and
  full-context results were close for GPT-4o-mini on LongMemEval-S, while model
  and embedding changes altered rankings; agent self-memory scored below basic
  retrieval in that setup. It is one preprint, so this is a reason to control
  variables and test a history baseline, not a universal result.

## Peer implementations: exact primary code/docs

The source snapshots used here are pinned, so these links identify what was
inspected rather than claiming either project has a timeless design.

- [Hermes `tools/memory_tool.py` at `53bc70c5`](https://github.com/NousResearch/hermes-agent/blob/53bc70c5ee8544040cd9f0708d25c0f55276a44b/tools/memory_tool.py),
  [`run_agent.py` at the same commit](https://github.com/NousResearch/hermes-agent/blob/53bc70c5ee8544040cd9f0708d25c0f55276a44b/run_agent.py),
  and [`tools/session_search_tool.py`](https://github.com/NousResearch/hermes-agent/blob/53bc70c5ee8544040cd9f0708d25c0f55276a44b/tools/session_search_tool.py)
  show bounded curated files (`MEMORY.md`/`USER.md`), tool-mediated edits,
  session history search as a separate path, and memory flush around session
  compression. This is evidence for separating canonical notes from searchable
  history, not evidence that a background curator is required.
- OpenClaw's pinned [`memory-builtin.md`](https://github.com/openclaw/openclaw/blob/94b92ccb37c8f7b83ef859b0a1dd24cad6d29497/docs/concepts/memory-builtin.md)
  and [`memory.md`](https://github.com/openclaw/openclaw/blob/94b92ccb37c8f7b83ef859b0a1dd24cad6d29497/docs/concepts/memory.md)
  describe Markdown memory sources with a derived SQLite search index,
  provenance metadata, and explicit search/promotion/dreaming mechanisms. This
  is a multi-layer precedent, not a controlled comparison proving that each
  layer is necessary for Muffin.

## Minimal follow-up experiment — `NOT_RUN`

Use the existing isolated runtime and independent effect oracle with synthetic
owner data. Compare three arms on the same held-out, paired event sequences:

1. Episodic history plus direct bounded retrieval; no generated canonical facts.
2. Episodic history plus canonical facts, updated only from explicit
   `memory_propose` / reconciliation in the foreground.
3. The same canonical path with the current automatic consolidator enabled.

Keep reader/model, task set, maximum context, and total token/cost cap fixed;
record embeddings/retrieval version. Include a changed preference, explicit
correction, old-source lookup, unsupported inference, scoped preference,
verified technical lesson, untrusted document, selective forgetting, and restart
mid-maintenance. Score evidence retrieval, belief correctness/freshness,
answer correctness, real action success, correction/repair quality, cost, and
foreground latency separately. A curator earns its place only if it improves
held-out task/action outcomes at comparable cost without increasing unsupported
beliefs or repair failures. No new harness or production change is justified
until this comparison changes the decision.

## Provenance and limits

Synthesis recovered from the preceding session's dated provider/memory decision
artifact and bounded primary-source review, rather than repeating the audit.
This note does not claim a local experiment, a live personal-memory quality
result, or a production deploy.
