# Roadmap

This document owns one question only:

> **If a capability or architectural idea is deliberately not required now, in which product phase should it be reconsidered?**

It does **not** own implementation status, Gate truth, architecture or sequencing of current work.

- DAY-1 status belongs to `docs/blueprint/M5-BIS.md`.
- Remaining Gate order belongs to `docs/blueprint/gate1/PERCORSO-CRITICO.md`.
- Current work belongs to observed Git/PR state + `docs/blueprint/LAVORO.md`.
- Semantic shape belongs to `docs/ARCHITECTURE.md` / `docs/SECURITY.md` and ADRs.
- Public/community strategy belongs to `docs/OPEN-SOURCE-STRATEGY.md`.

A phase placement is a commitment to **revisit**, not a promise to implement. Dogfood evidence may promote, demote or delete an item.

## Product phases

```text
DAY-1 READY
    ↓
14-day owner dogfood
    ↓
MVP / trusted alpha
    ↓
public alpha / open-source readiness
    ↓
post-MVP product & hardware
    ↓
research only / consumer-triggered
```

### DAY-1 READY

DAY-1 is intentionally not duplicated here. `MANDATO-DAY-1.md` and the reconciled M5 inventory decide what must exist before the fourteen-day window starts.

Architecture work may expose a new DAY-1 candidate; that candidate enters M5 rather than being silently implemented from this roadmap.

Current architecture findings that must be reconciled into the Gate include the owner-required **smart Telegram interaction**: surface-aware event composition, multipart/multimodal input (including multiple files/images and voice), and continued ingress while current work is running. The exact Gate classification remains M5's job.

### 14-day owner dogfood

This phase is primarily an observation window, not a preloaded feature sprint.

Record and count:

- fallbacks to another general-purpose agent;
- input/UX friction and incorrect grouping/steering;
- missing capabilities that interrupt real work;
- memory misses, wrong beliefs and duplicate/conflicting beliefs;
- ASK fatigue and unsafe-looking effects;
- retries/recovery failures;
- ignored or annoying proactive behaviour;
- context/latency/cost pressure;
- reasons the owner reaches for another device/interface.

Observed repeated pain outranks speculative roadmap items below.

## MVP / trusted alpha

These are the strongest post-DAY-1 candidates. They are not automatically required before dogfood.

### First Mac capability Node

Default placement: **MVP / trusted alpha**.

Promote to DAY-1 only if the chosen dogfood deployment requires a remote Home (for example a VPS) **and** normal daily use requires Mac-local capability during those fourteen days.

Minimum useful Node, not a general distributed platform:

```text
stable Node identity + pairing
presence / reconnect
capability advertisement
request identity / idempotency
Home authorization ∩ Node local ceiling ∩ OS permission
ExecutionPlan-bound local approval
ACK / started / outcome separation
```

Candidate first capabilities come from actual use: contained `system.run`, a narrow filesystem scope, notification, local inference or another concrete Mac-local need.

### Intentional memory proposals

ADR-0051 owns the architecture: many producers, one semantic writer.

When the product needs explicit `remember` / agent-intentional memory, implement a durable proposal path into canonical reconciliation rather than direct writes to active Beliefs.

This can be promoted into DAY-1 if reconciliation of M5 shows that inability to intentionally remember a fact would force a fallback during the dogfood window.

### Home migration / Capsule v0

Before trusted users accumulate continuity that is painful to lose, provide a verified way to move/restore one Home while preserving canonical state and rebuilding derived state.

This is distinct from active-active replication.

### Consumer control plane

A desktop/consumer UI may expose Home health, Nodes, provider/model, work, approvals, budget, backup/update and capability status. It is a control surface for the same Muffin, never a second agent.

### Local / owner-controlled compute experiments

Evaluate local models, transcription, embeddings and other compute against Muffin-specific tasks before building an automatic router.

Placement may be Home-local, Node-local, dedicated owner-controlled compute or remote provider. Automatic scheduling/routing is earned by measured benefit.

### Overflow / context-pressure UX

Revisit together rather than as unrelated polish:

- large tool output → durable file/vault object + compact handle instead of destructive placeholder-only compaction;
- visible context-pressure signal if real sessions show it changes behaviour usefully;
- structured long-running progress if placeholder/streaming proves insufficient.

Current Gate lineage: M5 B12, B13, C9. Dogfood decides which of these are product needs versus unnecessary machinery.

### Proactivity beyond explicit jobs

ADR-0028's high-confidence posture remains the constraint. Revisit concrete detectors only after real memory/work data exists and usefulness/noise can be measured.

Do not reintroduce a generic “I noticed…” firehose.

### Background process ownership

Starting/owning long-lived background processes beyond current wait/process inspection remains consumer-triggered. Add it when a real daily workflow requires Muffin to own such a process lifecycle.

## Public alpha / open-source readiness

These matter before broad public use if the corresponding surface/extension is shipped.

### Stable lifecycle across supported Home platforms

- install/update/rollback with schema migration safety;
- hot backup/restore and canonical export/import sufficient for accumulated continuity;
- supported Home/Node platform matrix;
- diagnostics that distinguish Home, Surface, Node, Worker and provider failures.

### Node security and lifecycle, if Nodes ship publicly

- pairing/revocation documented and tested;
- local-ceiling permission UX;
- protocol authentication/replay protection;
- capability/authority diff on updates;
- reconnect and failure semantics visible to owner and `sys.inspect`.

### Extension containment and authority

`package != capability != grant` remains the architecture.

Before community/third-party code is presented as meaningfully isolated, add the containment boundary justified by its authority and lifecycle. A manifest is not a sandbox and locally executed third-party code remains part of the TCB until a real boundary exists.

### MCP hot lifecycle

Hot revocation/removal may be promoted here if MCP is a supported public extension path. Gate 1 currently accepts restart-based removal because the supervisor makes restart an explicit lifecycle operation.

### Discord completion

If Discord is a public supported Surface, finish any currently deferred parity such as resumed-turn delivery and run the same ingress/identity/provenance guarantees expected of supported surfaces.

### General ingress contract

After more than the initial Telegram consumer exists, generalize only the semantics proven common: typed parts, provenance, authenticated principal, transport idempotency and surface-owned composition. Do not create a universal field catalog before consumers exist.

## Post-MVP product and hardware

### Pendant

The pendant is a specialized **Node + Surface** of the same Muffin.

Prototype after voice and the Node contract have real consumers:

```text
Node capabilities:
  audio.capture
  optional speaker
  haptic/status

Surface semantics:
  push-to-talk / wake
  interrupt / steer
  voice reply
```

The experiment succeeds only if this body materially reduces the need to open a conventional interface enough to justify battery/network/hardware cost.

### Ambient speaker / Watch / phone-native body

Use the same Node + Surface grammar. No device-specific memory or second policy/agent.

### Richer media

Video ingestion, full visual-document understanding/OCR pipelines and richer rendering are post-DAY-1 capability work unless dogfood proves a narrower subset is necessary earlier.

Original media remains Evidence; transcripts/OCR/captions are derived representations with provenance.

## Research only / consumer-triggered

These are deliberately **not roadmap commitments**. A measured failure mode or new product requirement must promote them first.

### Replicated continuity / multi-Home

- active-active Home;
- automatic leader election;
- CRDT/conflict-free continuity merge;
- Nodes autonomously taking canonical authority when Home is unreachable;
- complete canonical memory replicas on Nodes.

Current rule: one authoritative Home. Home outage may make Muffin unavailable; a Node does not silently become leader.

### Degraded offline local Muffin

A Node that continues limited local cognition while disconnected could eventually be useful, but reconciling its work/effects/memory with the Home is distributed-systems complexity. Research only until outages make it a concrete product problem.

### Generic distributed compute scheduler

No service mesh, broker, cluster scheduler or resource optimizer merely because Nodes make them imaginable. Add only when explicit placement is measurably insufficient.

### World-state schema

World state is conceptually distinct from Evidence, Beliefs and Work, but no generic world-state table is created before a consumer proves which state must be represented. ADR-0045's consumer-before-schema rule remains in force.

### Hosted multi-tenant Muffin

A centrally hosted multi-tenant product has a different trust/data/operations model. It is not treated as an incremental deployment mode of the owner-run architecture.

## How an item moves

An item may change phase only with a reason:

```text
observed dogfood pain
new supported-surface requirement
security finding
measured performance/cost pressure
new public compatibility promise
new hardware/product experiment
or explicit owner decision
```

When an item becomes DAY-1 relevant, add/reclassify it in M5. When it becomes active work, Git + `LAVORO.md` own execution state. When its semantic shape changes, update Architecture/Security or write/supersede an ADR.

This file never says that something is implemented merely because its phase has arrived.