# Core architecture audit — 2026-08-18

> Snapshot dated and non-normative. This note records a founder/principal-engineer
> pass over the current `dev` architecture and the 2026 ecosystem. Durable product
> decisions belong in `docs/OPEN-SOURCE-STRATEGY.md`, `docs/foundations/VISION.md`
> or an ADR once a concrete implementation decision is made.

## Questions

1. What can Muffin compete on that is not obvious from the current feature list?
2. Are the technical/library choices still right in 2026?
3. Where are we forcing abstractions before use proves them?
4. Which early assumptions were wrong or are becoming doctrine?
5. What should remain core, and what should become an extension boundary?

## 1. Competitive wedges worth protecting

### 1.1 Sovereign continuity, not generic memory

The durable differentiator is not "Muffin remembers". Personalization and memory
are becoming table stakes. The stronger claim is that identity, evidence, work,
effects, authority and corrections remain portable across model/provider/device/
surface/runtime changes.

A versioned canonical export/import (working name: Muffin Capsule) can become more
than backup. It can become a migration surface: import history from other agents,
platform exports and old Muffin versions, preserve provenance, rebuild derived
indexes, continue without pretending imported evidence was observed today.

Potential wedge: **bring your agent history with you**.

### 1.2 Acquisition as an epistemic engine

Connectors/importers are not only integrations. They are sources of evidence.
Gmail, calendar, photos, code history and platform exports can shorten cold start
if each item preserves original author/source/time/trust instead of being flattened
into "owner data".

This is particularly important for received email/chat: ownership of the mailbox
is not authorship of its content. A third-party message remains third-party
content and must keep provenance/taint through extraction and recall.

### 1.3 Capability-governed extension ecosystem

"Plugin" should be a user-facing umbrella, not one universal technical interface.
Providers, connectors, importers, privacy transforms, skills and executable MCP/
plugins have different lifecycle and trust needs.

The common contract worth competing on is a **capability manifest** that can be
inspected before code runs:

```yaml
id: gmail
kind: connector
network:
  - gmail.googleapis.com
secrets:
  - gmail_oauth
filesystem: none
authority:
  read_mail: true
  send_mail: ask
```

Muffin already has unusually strong primitives for this: policy kernel, taint,
provenance, secret references, sandbox and effect semantics. Extending those to
third-party code could produce an ecosystem where installing capability does not
implicitly grant full host trust.

This is a stronger position than "we have more plugins".

### 1.4 Autonomy ledger as product UX

The current kernel/effect work can become a user-visible trust model rather than
remaining security plumbing.

A future control plane should be able to explain:

- what Muffin wants to do;
- why it is allowed / asking / denied;
- which evidence influenced it;
- whether the effect is reversible;
- which scoped grant allowed it;
- how often the same class succeeded before;
- how to revoke or narrow that grant.

Potential wedge: autonomy that becomes quieter because it has evidence, without
becoming globally "trusted".

### 1.5 Continuity evals as a public research surface

If continuity is the moat, it must be measurable. The 2026 benchmark landscape
is moving beyond simple fact retrieval toward temporal evolution, multi-source
memory, provenance, state-writing failures and task reliability.

Muffin can expose adapters/evals for public suites and add its own local,
privacy-preserving continuity battery. Useful dimensions:

- temporal correctness and supersession;
- source/role preservation;
- contradiction handling;
- persistent sycophancy / bad-write resistance;
- recall quality and cost over months;
- work-resume fidelity;
- effect duplication/loss;
- authority/provenance laundering.

This can make the repo useful to researchers even before they adopt Muffin as
their personal agent.

## 2. Stack/library verdicts

### TypeScript + Node

**KEEP.** Good fit for a surface-heavy local orchestrator, async integrations,
Telegram/web tooling and contributor accessibility. Voice/local-model components
can be sidecars or native helpers; they do not justify rewriting the core in
Python.

### SQLite + better-sqlite3

**KEEP.** One owner, local durable state and transactional semantics are an
excellent SQLite workload. `better-sqlite3` remains mature and supports virtual
tables/extensions. Node now ships `node:sqlite`, but in Node 24/26 it is still
release-candidate rather than an obvious reason to migrate. A migration would
buy little today and would consume risk around extension loading and existing
stores.

Watch instead:

- WAL/checkpoint behaviour as multiple workers/processes appear;
- long synchronous DB work blocking the event loop;
- hot backup/migrations;
- an explicit DB access seam so storage can evolve without infecting runtime.

The Telegram streaming bug already demonstrated a real scheduling consequence of
synchronous work: a timer could not fire between synchronous SQLite operations.
That is not evidence to abandon SQLite; it is evidence to keep blocking work
bounded and observable.

### sqlite-vec

**KEEP BEHIND AN ADAPTER; PIN CAREFULLY.** The project itself still documents
that it is pre-v1 and breaking changes are expected. It is a good local fit, but
embeddings/vector indexes are derived state and must remain rebuildable.

Do not let `vec0` schema/API become canonical memory semantics. Consider exact
version pinning for public releases and migration/rebuild tests on upgrades.

### Anthropic sandbox-runtime

**KEEP, BUT TREAT AS FRONTIER INFRASTRUCTURE.** It is still described upstream as
a beta/research preview and changes quickly. Muffin's exact pin plus real
containment probes are the correct posture.

The abstraction must remain ours: policy/containment contract first,
`sandbox-runtime` implementation second. This is also the likely primitive to
reuse for MCP/plugin process containment rather than inventing another sandbox.

### MCP TypeScript SDK v2

**KEEP.** v2 is now the stable line. One subtlety remains deliberate/technical:
constructing `Client` without `versionNegotiation` still speaks the legacy 2025
era by default; the 2026-07-28 protocol is opt-in (`mode: auto` or a pin).

The roadmap already records this. Do not conflate "SDK v2" with "modern 2026
wire semantics". Adopt the modern era only when a consumer needs its features
and the compatibility matrix is tested.

### Provider SDKs + Zod

**KEEP.** Anthropic/OpenAI behind the current provider interface and runtime
schemas through Zod are sensible. Provider-specific behavior should stay in
adapters/profiles, not leak into durable turns/memory.

### Telegram transport

**REVIEW AFTER DOGFOOD, NOT NOW.** The current code uses grammY types but owns
Bot API transport, retries, polling, media and streaming. grammY itself is
current with Bot API 10.0 and already provides mature API/retry plumbing.

Custom code is justified where Muffin needs semantics a bot framework cannot
own: durable inbound identity, exactly-once turn creation, provenance/taint,
delivery uncertainty, secret handling. Generic HTTP/retry/update plumbing is
not a differentiation.

Rule for a future review: retain custom boundary semantics; replace commodity
transport code if a mature library can sit underneath without weakening those
semantics.

### No LangChain/LangGraph-style core framework

**KEEP.** Muffin's differentiating contracts are exactly the things a generic
agent framework would otherwise own: durable work, policy, effects, memory and
surface identity. Pulling a broad framework into the core would make its state
model our architecture. Small libraries/standards at explicit seams are a better
fit.

Durable-execution systems such as DBOS/Restate/Temporal are valuable prior art,
but adopting one now would replace a large amount of already-tested local
semantics and add deployment/runtime assumptions. Re-evaluate only if Muffin
moves from one owner-scale runtime to distributed execution or if maintaining
exactly-once/effect recovery demonstrably becomes a dominant cost.

## 3. Where the current architecture may be over-forced

### 3.1 Memory sophistication ahead of real tenure

The memory subsystem already contains temporal facts, hybrid retrieval, graph
expansion, consolidation, absence/pattern logic and multiple judges while the
first real owner tenure is only beginning.

This is not necessarily wrong: memory quality is central to the thesis and 2026
research increasingly validates temporal/multi-source memory as a hard problem.
But it creates a strong risk of optimizing an ontology before enough real life
has contradicted it.

Operating rule after Day 1: no new memory primitive without a concrete failure
from dogfood or a benchmark that current primitives fail. Prefer ablations over
new layers.

### 3.2 `agent/loop.ts` is becoming a God seam

The current file is ~114 KB and is load-bearing for context, provider calls,
streaming, retries, waits, tool policy/effects, persistence and completion.
Having one production path helped expose wiring failures, but it is reaching the
point where every invariant collides in one file.

Do not perform a cosmetic refactor before Gate 1. After dogfood, extract by
**guarantee ownership**, not by arbitrary layers. Candidates:

- context/taint assembly;
- model-call lifecycle;
- tool/effect execution boundary;
- suspension/resume state machine;
- completion/delivery.

One guarantee should still have one authoritative home and one obvious production
path.

### 3.3 "The model reasons; code does not" is useful but too absolute

P4 correctly rejects invisible heuristic classifiers and hand-written imitation
of semantic judgment. It must not become doctrine against deterministic
semantics.

Dates, ownership, identity, parsing, idempotency, resource canonicalization,
policy, protocol state and persistence invariants belong in code. The sharper
future wording is closer to:

> Do not hard-code semantic judgment that a model with proper context can perform
> better; do hard-code deterministic contracts whose ambiguity would corrupt
> state, authority or reproducibility.

P7 already permits recalibration; revisit P4 after the 14-day phase rather than
changing it during Gate 1.

### 3.4 Tenant/generalization: keep the axis, stop short of SaaS semantics

Keeping `tenant`, `principal`, `surface`, `provider`, provenance and capability
variable before data accumulates is cheap insurance against accidental host-only
schema. Building a general multi-tenant hosting platform is not.

Retain isolation keys and contracts; do not add operational multi-tenant
complexity until a real group/community use case requires it.

### 3.5 Root of Trust can become UX debt

The RoT is valuable for constitutional/security floors. It becomes harmful if
ordinary preferences and routine plugin grants require manual JSON edits +
reseal ceremonies.

Keep the sealed set small: identity/security floor, authority ceilings, hard
budget/egress constraints. Preferences and earned scoped grants need safe APIs
and user-facing governance rather than expanding the constitutional blob.

### 3.6 One logical agent must not become one-process doctrine

"One Muffin" is an identity/state invariant, not a topology invariant. Voice,
browser workers, local inference, plugins and hardware may eventually require
separate processes. Canonical durable state + one policy authority can remain
singular while compute becomes replaceable.

## 4. Early assumptions already corrected or needing correction

Already corrected in the product/open-source branch:

- "memory/local-first is the moat" → sovereign quality of continuity;
- "embeddings/schema are immortal" → semantic canonical data vs rebuildable
  derived state;
- "never delete rows" → owner-controlled forget semantics plus tombstones where
  necessary;
- "provider is only compute" → remote provider is privileged egress;
- "MCP tool pinning makes MCP safe" → tool semantics and process containment are
  separate boundaries;
- "self-hosted means source install" → consumer-grade distribution is part of
  the product.

Still to watch:

- single-process language in older design records;
- graph/ontology becoming an identity rather than an implementation;
- every new integration being proposed as core instead of an extension;
- Telegram-specific concepts leaking into canonical session/work semantics;
- runtime correctness work continuing after dogfood should have become the
  roadmap source.

## 5. Dependency/versioning posture for public alpha

Before public alpha:

- exact-pin volatile pre-1/security-critical dependencies where upstream churn
  can change semantics (`sqlite-vec`, sandbox runtime, MCP protocol era);
- keep provider/transport libraries behind adapters;
- upgrade one frontier dependency at a time with migration/acceptance evidence;
- treat native dependencies as packaging work, not "npm will handle it";
- publish an OS/architecture support matrix;
- keep derived stores rebuildable so dependency upgrades do not become personal
  data migrations unnecessarily.

## 6. What not to do next

Do not create a giant plugin framework now.

First finish Gate 1 and dogfood. Then define extension contracts from the first
few concrete needs (likely one connector/importer, one executable integration,
one privacy transform). The manifest can share capability vocabulary while each
kind keeps the lifecycle it actually needs.

Do not refactor the 114 KB loop solely because it is large before Gate 1. Split
only when dogfood/change-cost shows a guarantee boundary that deserves a home.

Do not switch database/runtime/framework because a newer primitive exists. The
current stack has earned evidence; replacement needs a measured problem.

## Sources checked (2026-08-18)

Primary/upstream references consulted:

- Node.js `node:sqlite` docs (Node 24/26: release-candidate status).
- WiseLibs `better-sqlite3` README/performance docs.
- `sqlite-vec` README/API docs (pre-v1 warning) and releases.
- Anthropic `sandbox-runtime` repository/releases/security description.
- MCP TypeScript SDK v2 migration/protocol-version docs.
- grammY repository/releases/auto-retry docs.
- OpenAI Agents SDK 2026 harness/sandbox architecture.
- DBOS and Restate durable-execution documentation (prior art, not adoption
  recommendation).
- OpenClaw plugin manifest/permission/security docs.
- Hermes Agent skills/security/plugin trust docs.
- 2026 memory work/benchmarks including RHELM, DynamicMem, STATE-Bench,
  SubtleMemory and persistent-sycophancy evaluations.
