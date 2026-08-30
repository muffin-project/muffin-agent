# Memory composition contract — 2026-08-29

Status: research/implementation contract. It does not claim the current memory
runtime already has this shape.

Question: **what should Muffin remember, where should it live, and when may it
influence a later turn?**

This pass is motivated by real dogfood, not by a desire to add another memory
framework.

## 1. Current measured failure

The current installation can present the same old content through more than one
context path:

1. recent session history is reinjected as conversational continuity;
2. automatic semantic recall can independently retrieve an episode containing
   the same prior message;
3. some recalled episodes are Muffin's own previous answers, not owner evidence;
4. recall raises intrinsic turn taint, while history now raises only the
   permission ceiling.

The result is both cognitive and security debt:

- duplicated content consumes context and can make the model repeat itself;
- agent-authored summaries can become apparently independent evidence about what
  was true;
- the same source can affect authority twice through different composition paths;
- a useful fix to history taint can be undone by auto-recalling the history as a
  durable episode.

Separately, the current real home shows weak long-term memory health:

- embedding/indexing has degraded to textual recall for recent runs because the
  configured Ollama embedder is unavailable;
- profiles/digests/identities are effectively unused in the observed database;
- durable facts are dominated by request-event predicates (`asked_to`,
  `asks_to`) rather than a compact person/world model;
- contradiction judging has been discarding otherwise useful model verdicts
  when explanatory text exceeds a schema limit (PR #240 addresses that narrow
  defect).

These are different failures and should not be hidden behind one “memory quality”
metric.

## 2. Peer challenge

### Hermes Agent

Hermes makes a sharp distinction between:

- `USER.md`: compact user profile/preferences;
- `MEMORY.md`: compact agent/environment/project notes;
- persisted sessions: complete conversation evidence searched on demand.

Core memory is bounded and injected as a frozen snapshot at session start;
session search returns actual messages rather than a generated memory summary.
This is intentionally simpler than Muffin's graph, but the separation of
**profile / agent notes / transcript evidence** is valuable.

Important counterpoint: Hermes lets the agent curate its own core memory and
uses content scanning to reject some injection-like writes. Muffin should not
copy “agent says remember → trusted system-prompt memory” without stronger
provenance governance; the security literature below shows why pattern scanning
is not a complete boundary.

### OpenClaw

OpenClaw separates:

- compact curated `MEMORY.md` loaded at session start;
- dated operational memory notes indexed/searchable but not all bootstrapped;
- raw/session context;
- optional prospective commitments;
- dreaming/review artifacts.

It also exposes explicit memory status/deep/index/fix operations. This is useful
prior art for Muffin's current embedder degradation: semantic search health must
be inspectable and repairable rather than silently becoming lexical-only for
weeks.

### Letta

Letta treats memory/state as an explicit part of a stateful agent and exposes
memory blocks rather than pretending persistent memory is one vector store. The
important lesson for Muffin is state **typed by role/meaning and lifecycle**, not
the specific API or hosted architecture.

### Mem0

Mem0 reports gains on LOCOMO from selective extraction/consolidation/retrieval
versus full-context/RAG baselines, with large token/latency reductions. This is
evidence that “store everything and replay it” is not the right default.

It does not prove that every extracted memory deserves promotion to a user's
canonical person model, nor that LOCOMO captures action safety.

### MIRIX

MIRIX explicitly models multiple memory types (core, episodic, semantic,
procedural, resource, knowledge-vault). Its results support typed memory as a
useful design dimension, but its multi-agent architecture is not evidence that
Muffin needs six stores or multiple memory agents.

## 3. Contrary/security evidence

Persistent memory creates a delayed trust boundary.

Recent 2026 work on memory poisoning demonstrates several failure modes directly
relevant to Muffin:

- adversarial content can be written once, retained, and influence many later
  sessions;
- aggressive memory write/retrieval policies can increase exploitability;
- ordinary prompt-injection defenses do not necessarily cover memory poisoning;
- sleeper attacks can poison a user fact through external context and trigger an
  agentic action only after later retrieval;
- provenance can be laundered when an agent writes a summary/conclusion derived
  from attacker-controlled evidence.

Therefore a memory system cannot answer only “is this relevant enough to save?”
It must answer **who/what said it, what kind of assertion it is, how it was
derived, what promoted it, and what authority later retrieval may influence**.

This also means Security v2 and memory architecture are coupled at the
provenance/action-flow boundary, even though their stores and evals remain
separate.

## 4. Memory is not one plane

The current Architecture already has Evidence / Beliefs / Work / Effects /
Authority. Memory should respect those semantic planes rather than invent a
parallel ontology.

The practical context/memory surfaces should be:

### A. Current conversational history — Evidence

What the user and Muffin just said in this conversation, ordered and bounded.
Purpose: conversational continuity.

Rules:

- a current-thread message already in the injected history should not normally
  re-enter the same turn as an independently retrieved episodic memory;
- incomplete/failed/ask turns need rendering that marks them as incomplete work,
  not an indefinitely live user request;
- tool outputs may be condensed in history while the canonical trace/effect
  evidence remains elsewhere.

### B. Active working state — Work

What Muffin is currently trying to accomplish: plan/todos, open waits,
background-task handles, unresolved blockers, current project/task context.

This is not long-term memory. An unfinished obligation should be queryable and
visible because it is still owed, not because semantic similarity happened to
retrieve it.

### C. Episodic evidence — Evidence

Past conversations/documents/events retained for later search/reconstruction.

Rules:

- append-oriented and provenance-preserving;
- agent messages remain agent messages; they do not become owner facts;
- explicit search may retrieve current/old sessions, but automatic recall should
  avoid duplicating what is already present in current history;
- raw evidence can survive even when no durable belief is promoted from it.

### D. Durable facts / beliefs — Beliefs

Reconciled assertions about user/world/environment with source lineage,
confidence/time/supersession.

Rules:

- extraction produces **candidates**, not automatically canonical truth;
- one semantic promotion/reconciliation path owns activation/supersession;
- requests such as “asked me to X” should not crowd out stable user/world facts
  merely because they are easy to extract;
- contradictory/temporal facts must coexist/supersede without rewriting source
  evidence.

### E. User/person model — Beliefs-derived view

A compact, queryable representation of stable preferences, identity links,
communication/work patterns and other useful personal context.

It should be derived from/refer to canonical beliefs/evidence, not become a
second independent truth store. A profile sentence must be explainable by its
supporting evidence and confidence.

### F. Agent procedural/environment memory — Beliefs / reusable knowledge

Things Muffin learned about its own environment/workflow: tool quirks, local
conventions, recurring useful procedures.

Do not confuse this with user preferences. Hermes' MEMORY vs USER distinction is
useful prior art.

Project-specific conventions already owned by a repository (`AGENTS.md`, docs)
should not be copied into personal memory unless the copy serves a distinct
cross-project purpose.

### G. Prospective intentions — Work

“Ask Giusto how the meeting went tomorrow”, “finish indexing when download
completes”, scheduled reminders/jobs.

These are obligations with expiry/state, not beliefs. Storing them as evergreen
facts is a semantic error.

## 5. Composition order for one turn

The model should receive a deliberate composition, not a union of every retrieval
mechanism that happens to match.

Proposed conceptual order:

```text
identity/persona + repository/project instructions
current user intent
current bounded conversation history
active working state relevant to this intent
compact user/person model
selective cross-session episodic/belief retrieval
explicit source/provenance markers
```

The exact prompt ordering remains a caching/model concern, but the semantic
composition has two invariants:

1. **deduplicate by source identity across history and recall before rendering**;
2. **preserve the highest-risk/true provenance when representations collapse** —
   deduplication is not a taint/provenance downgrade.

## 6. Current-thread recall rule

The first concrete candidate to fix the measured self-recall defect is:

> Automatic semantic recall should not return an episode/message already
> represented in the bounded current-session history. Explicit `memory_search`
> remains capable of searching sessions when the model intentionally asks.

Prefer identity/source-aware exclusion over fuzzy content deduplication.

To implement this safely we must first establish which identifiers flow between
session messages, episodes and recall hits. If current storage cannot map them
reliably, add explicit lineage at the write boundary rather than guessing from
text equality/timestamps.

Do **not** solve the problem by globally excluding agent-authored episodes.
An old Muffin answer may contain useful reconstruction context, and — more
importantly — an answer derived from tier-3 evidence must retain that provenance
so it cannot become a remember→act laundering path.

## 7. Memory write/promotion policy

A durable memory write needs a typed reason.

Candidate classes:

```text
explicit_owner_memory       “remember that …”
observed_stable_user_fact    repeated/direct evidence about user/world
operational_environment      stable local/tool/environment knowledge
project_decision             durable decision not already owned by project SoT
session_episode              raw evidence retained for search
candidate_belief             extractor/reasoner proposal awaiting reconciliation
```

The point is not those exact enum names; it is preventing “every salient sentence
and every request becomes the same durable fact”.

Promotion must consider:

- provenance/speaker;
- novelty vs existing belief;
- temporal scope/expiry;
- contradiction/supersession;
- expected future utility;
- sensitivity/privacy;
- whether the assertion belongs in Work or project source-of-truth instead;
- poisoning risk / whether external content is attempting to create an owner
  preference/instruction.

## 8. Agent-authored memory

Muffin needs to learn from its own work, but self-authorship cannot create a
trusted fact ex nihilo.

An agent note should distinguish:

- **observation**: “command X failed because tool Y requires Z” with trace/source;
- **procedure**: “for this environment, do A before B” supported by repeated or
  explicit evidence;
- **hypothesis**: useful but not canonical belief until verified;
- **summary**: a compressed representation inheriting provenance of its sources.

The last rule is security-critical: summarization changes bytes, not source
authority.

## 9. Health and repair are product features

Current dogfood shows semantic memory can degrade while the agent continues to
answer. A personal agent must be able to say *how healthy its memory is*.

`muffin memory status` / doctor / `sys_inspect` should eventually expose:

- embedder configured/available/fallback-active;
- vector index backlog and last successful indexing;
- lexical vs hybrid recall mode;
- extraction/reconciliation backlog;
- contradiction-judge failures by reason;
- profile/person-model freshness/support;
- duplicate/self-recall rate;
- memory write/promote/reject counts by class/source tier;
- poisoned/quarantined/review-needed candidates where such a policy exists.

Repair actions such as reindexing must be explicit/idempotent and observable.

## 10. Evals before a larger redesign

Separate **memory retrieval quality**, **memory write quality**, **person-model
quality** and **memory action safety**.

### Retrieval

Can Muffin find the right old evidence under paraphrase, temporal questions and
multi-hop questions? Measure lexical-only and hybrid modes separately so a dead
embedder cannot hide behind aggregate accuracy.

### Write/promotion

From realistic conversations, which candidate memories are saved, rejected,
merged, superseded or routed to Work instead? Measure precision as well as
recall — “remember everything” should score poorly.

### Person model

After 1/7/14/30 days of synthetic + real consented interaction, can Muffin answer
stable user-preference/identity questions, show support, update when corrected,
and avoid turning one-off requests into traits?

### Action safety

Use the Security-v2 memory scenarios:

- third-party instruction saved then retrieved later;
- poisoned “user preference” derived from web/mail;
- agent summary of poisoned source;
- current-history + recall duplication;
- old legitimate external fact used as a value inside a newly owner-authorized
  action.

A memory architecture that improves LOCOMO-like QA while increasing delayed
action attack success is not an improvement for Muffin.

## 11. Work order

### P0 — restore observable retrieval health

Fix/configure live embedder fallback and backlog reindex/doctor path. The current
installation is empirically degraded; redesigning retrieval while the vector
path is dead confounds every measurement.

### P1 — current-history / auto-recall source dedup

Trace episode/session lineage, then prevent automatic recall from duplicating
current history without downgrading provenance. Add dogfood/eval measurement of
self-recall duplication.

### P2 — incomplete-history rendering

Prior ask/error/aborted work becomes a bounded explicit marker/state, not an
unresolved user message that later turns accidentally answer.

### P3 — write/promotion taxonomy + person-model eval

Reduce request-event pollution, identity fragmentation and unsupported profile
claims before adding richer user-model output.

### P4 — compact derived person/agent memory surfaces

Only after promotion quality is measurable should compact profile/procedural
views become routine injected context.

### P5 — memory-poisoning hardening integrated with Security v2

Use provenance/action-flow to ensure recalled evidence can inform authorized work
without granting new authority.

## 12. Kill criteria

Revisit this design if evidence shows:

- the duplicate self-recall problem disappears once the embedder/config defect is
  repaired and current-thread identity exclusion adds no measurable value;
- a simpler Hermes-style curated USER/MEMORY + session-search model beats the
  graph architecture on Muffin's own long-horizon/person-model evals;
- richer person-model inference causes more stale/incorrect traits than useful
  personalization;
- automatic memory writing cannot be made robust to poisoning at acceptable
  utility, in which case explicit-owner promotion may need to dominate;
- typed memory surfaces add complexity without improving retrieval, continuity,
  explainability or action safety.

The existing graph is not protected by sunk cost.

## 13. Primary/current evidence

- Hermes Agent persistent memory/session docs, August 2026: bounded `USER.md` +
  `MEMORY.md`, separate SQLite session search and clean transcript resume.
- OpenClaw memory docs, August 2026: curated long-term memory, dated operational
  notes, hybrid retrieval, explicit memory health/index/fix commands and optional
  prospective memory.
- Letta current stateful-agent/memory-block architecture.
- Mem0, *Building Production-Ready AI Agents with Scalable Long-Term Memory*,
  arXiv:2504.19413.
- MIRIX, *Multi-Agent Memory System for LLM-Based Agents*, arXiv:2507.07957.
- *From Untrusted Input to Trusted Memory: A Systematic Study of Memory Poisoning
  Attacks in LLM Agents*, arXiv:2606.04329.
- *Hidden in Memory: Sleeper Memory Poisoning in LLM Agents*, arXiv:2605.15338.
- *When Agents Remember Too Much: Memory Poisoning Attacks on Large Language
  Model Agents*, arXiv:2607.06595.

Implementation PRs should pin exact source versions when particular behavior
becomes load-bearing.
