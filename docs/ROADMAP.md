# Roadmap

This document owns one question only:

> **If a capability or architectural idea is deliberately not required now, in which product phase should it be reconsidered?**

It does **not** own implementation status, DAY-1 truth, architecture or sequencing of current work.

- DAY-1 status belongs to `docs/work/day1/requirements-status.md`.
- Remaining DAY-1 order belongs to `docs/work/day1/critical-path.md`.
- Current work belongs to observed Git/PR state + `docs/work/handoff.md`.
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

DAY-1 is intentionally not duplicated here. `docs/work/day1/readiness-criteria.md` and the reconciled DAY-1 requirements decide what must exist before the fourteen-day window starts.

Architecture work may expose a new DAY-1 candidate; that candidate enters the DAY-1 requirements rather than being silently implemented from this roadmap.

Current architecture findings that must be reconciled into DAY-1 include the owner-required **smart Telegram interaction**: surface-aware event composition, multipart/multimodal input (including multiple files/images and voice), and continued ingress while current work is running. The exact DAY-1 classification belongs to `docs/work/day1/requirements-status.md`.

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
- tool-catalogue pressure: a needed capability exists but is not exposed, or the model repeatedly chooses the wrong tool as breadth grows;
- reasons the owner reaches for another device/interface.

Observed repeated pain outranks speculative roadmap items below.

**Freeze cognitive growth by default during this window.** A new salience,
decay, person-model, consolidation, ranking or other cognitive mechanism needs an
observed failure it is meant to fix and a way to tell whether it helped. A
mechanism does not earn a place merely because it is plausible or inspired by a
paper. Simplifying or deleting harness that no longer earns its cost is a valid
dogfood result.

Likewise, do not turn the current numeric tool-exposure cap into architecture.
Measure whether catalogue breadth actually hurts selection or hides needed
capabilities before adding discovery/deferred-loading machinery.

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

**Open design question, found 2026-09-03, not yet decided.** ADR-0050 §3
already separates Node from Surface on paper. The runtime does not yet keep
them separate: the supervised gateway pins `WorkingDirectory=${home}`
(`core/gateway/unit.ts:278`, and the plist equivalent at line 376),
`cli/gateway.ts:602` calls `buildRuntime(home)` with no `cwd`, and
`agent/runtime.ts:231` defaults `cwd` to `process.cwd()` — so on the
supervised surface `scope.root` and the shell tool's `writeScope`
(`agent/tools/shell.ts:148`) are always the Muffin home, never a repository
checkout elsewhere on the same machine. A REPL started inside that checkout
works, because there `cwd` already is the checkout. The same request from the
owner succeeds or fails depending on which surface it arrived through, and
Muffin cannot tell the difference itself. Full trace in
`docs/evidence/il-lavoro-che-viene-2026-09-03.md`.

The owner's answer names the direction without deciding it yet: **capability
must not depend on the surface, but on where Muffin lives — the node.**
«anche se sta in una vps, e io scrivo da telegram, e il nodo del macbook sta
acceso, deve poter lavorare su quei file». Today's repository conflates two
different meanings of "surface": where a message arrives, and where work
executes. Separating them is this section's Node, made concrete — and it
reopens a security question in the same breath, not after: a forwarded
message at taint 2 arriving on Telegram would, under that separation, be able
to reach a laptop's filesystem. The boundary has to be designed before the
capability — the owner said so himself: «ovviamente tutto questo va gestito
bene e specialmente in modo sicuro, quindi approcciamo tutte queste cose con
il nostro modo di lavorare» — a `docs/RESEARCH.md` pass and an ADR, not a
patch to this section.

This touches two existing ADRs without contradicting either: **ADR-0021** has
already had to amend itself once (§revisione 2026-09-03) for conflating a
delivery channel with conversation identity — the same class of mistake is
the risk here, on the execution axis instead of the conversation axis.
**ADR-0056** ties `sessionKey` to `identify()` regardless of port, which is a
claim about conversation identity, not about where a capability executes; a
future Node ADR must keep the two claims distinct rather than collapsing them.

**Sequencing: this cannot start before the sandbox write scope already in
flight lands** (observed Git/PR state owns whether that work is open right
now, not this file). A shell command in a turn can today write `muffin.db`,
`sessions/`, `.rot-anchor` and `voice.md`, because none of the four sit under
the paths `core/rot/guards.ts`
denies (`rot/`, `config.json`, the two secret directories, `.git/hooks`,
shell dotfiles) and `scope.root` is the whole Home. Widening *where* work can
run while the write scope is already this loose would widen the blast radius
before the boundary is narrowed — narrow the scope first.

### Five items from the owner's conversation, 2026-09-03

Recorded in `docs/evidence/il-lavoro-che-viene-2026-09-03.md`. All five queue
behind what is already in flight — the sandbox write scope above, the
derived architecture map's rebase conflicts, and the character eval
(`requirements-status.md` A2/A3, `evals/character/`, never yet on a path in
`docs/work/day1/critical-path.md`) — because none of the five change what
closes the dogfood in progress. Ordered below by what unblocks what, not by
which feels most wanted; no effort estimate is claimed for any of them.

#### A maintenance tick, not a heartbeat conversation

First, because in the owner's own words a capability nobody ever re-checks
does not exist for him — the other four assume a Muffin that is still there
to use them. Measured today on the owner's live database: `todos` holds seven
rows still `pending` from 2026-08-27, a plan written and never surfaced
again. `B4` (READY) reads the plan on every turn of a session; nothing today
starts a turn on its own to do that reading when no one has written to the
session.

This is not `COGNITIVE-DESIGN.md` §5's rejected "proactivity as regular
heartbeat conversation" — elapsed time is still not a reason to interrupt the
owner. The gap is narrower: whether the runtime's own scheduler tick
re-checks durable `pending`/`waiting` state (todos, `interrupted` turns, due
jobs) at all when nothing is due, so it does not rot silently, independent of
whether anything is ever surfaced to the owner. Adjacent to, not the same as,
"Background process ownership" and "Proactivity beyond explicit jobs" below —
those are about owning a long-lived process and about initiating dialogue;
this is about the runtime's own liveness cadence over its own durable state.
Record repeats of this pain the same way as any other dogfood signal
(`docs/work/day1/critical-path.md` "Da qui ordina l'uso" already asks for
"lavoro promesso e dimenticato").

#### GitHub delivery: plan, implement, test, commit, PR

Second, because it is the cheapest large step and the item after it depends
on the same egress door. What is missing for coding is delivery, not
authorship: Muffin can already write code, run tests and commit locally.
Missing is push/PR — no network egress exists today (`defaults/rot/egress.json`
ships an empty allow list) — and, secondarily, parallelism through subagents,
which the runtime has no mechanism for yet either. The candidate shape is a
coding skill in the existing sense (`defaults/skills/`, D9 — plan → implement
→ test → commit → PR) plus `github.com` added through the existing
capability-setup widen-and-reseal flow (ADR-0058,
`widenEgressForCapability`), not a new mechanism.

#### Issues are plans; without read-back Muffin is a blind planner

Third, because it opens the same egress door as the item above, for reading
instead of writing, and has no reason to land before it. Muffin's own
framing: writing a GitHub issue is a plan, not code, and reversible — it fits
inside a revocable boundary. But without reading back the resulting pull
request, comments and reviews, Muffin is a blind planner: it writes, the plan
vanishes, and it never learns whether the work was done well. The item is
"write issues **and** read back their consequences," never just the first
half — the read-back needs the same `github.com` door the section above
would open for writing.

#### Per-task egress boundaries, not one flat allowlist

Fourth: no stated dependency on the other four, and generalizing egress ahead
of the item above would be answering a question dogfood has not asked yet.
Today `rot/egress.json` is a single sealed allow-only list — in or out, with
no perimeter scoped to a task. This is the technical form of the owner's own
boundary: «se giri nel perimetro hai governance e quindi puoi fare cose più
liberamente». It changes authority/egress semantics, so it needs a
`docs/RESEARCH.md` pass before any implementation, not a direct patch to
`core/rot/egress-writer.ts`. It is a different axis from ADR-0050's Node
ceiling: that intersection (`Home ∩ Node ∩ OS`) narrows what a *paired
device* may do; this would narrow what a *single task/turn* may reach on the
same Home. Read the two together when the research pass happens — do not
conflate them into one mechanism by default.

#### New senses: calendar, email, half-finished projects

Last: purely additive, nothing else in this list unblocks or is unblocked by
it. Today Muffin senses the vault and messages. Not the calendar, not email,
not half-finished projects. Candidate capabilities follow the same rules
already governing every other source: consumer-before-schema (ADR-0045) and
the typed multipart ingress model (ADR-0052) for whatever a new source
parses into.

### Intentional memory proposals

ADR-0051 owns the architecture: many producers, one semantic writer.

When the product needs explicit `remember` / agent-intentional memory, implement a durable proposal path into canonical reconciliation rather than direct writes to active Beliefs.

This can be promoted into DAY-1 if reconciliation of the DAY-1 requirements shows that inability to intentionally remember a fact would force a fallback during the dogfood window.

### Home migration / Capsule v0

Before trusted users accumulate continuity that is painful to lose, provide a verified way to move/restore one Home while preserving canonical state and rebuilding derived state.

This is distinct from active-active replication.

### Consumer control plane

A desktop/consumer UI may expose Home health, Nodes, provider/model, work, approvals, budget, backup/update and capability status. It is a control surface for the same Muffin, never a second agent.

It should also make **data placement** legible rather than forcing the owner to infer it from config: which model provider receives assembled context, whether embeddings are local or remote, which network destinations a capability may reach, and which execution paths are locally sandboxed. This is visibility over existing boundaries, not a promise of automatic privacy routing.

### Capability discovery / deferred tool loading

Default placement: **MVP / trusted alpha, only after measured catalogue pressure**.

If dogfood shows that useful capabilities are being hidden by a static exposure cap, or tool choice degrades as the catalogue grows, replace repeated cap increases with a two-stage shape:

```text
small always-visible primitive set
        ↓
capability/tool discovery
        ↓
load the relevant definition when needed
```

The point is not token optimization by itself. It is to let capability breadth grow without forcing every model to choose among the whole catalogue on every turn. Preserve the same policy kernel: discovery changes what the model can see, not what it is authorised to execute.

Do not build this merely because external agent SDKs support tool search/deferred loading. The trigger is Muffin-specific evidence.

### Local / owner-controlled compute experiments

Evaluate local models, transcription, embeddings and other compute against Muffin-specific tasks before building an automatic router.

Placement may be Home-local, Node-local, dedicated owner-controlled compute or remote provider. Automatic scheduling/routing is earned by measured benefit.

### Overflow / context-pressure UX

Revisit together rather than as unrelated polish:

- large tool output → durable file/vault object + compact handle instead of destructive placeholder-only compaction;
- visible context-pressure signal if real sessions show it changes behaviour usefully;
- structured long-running progress if placeholder/streaming proves insufficient.

Current DAY-1 lineage: requirements B12, B13, C9. Dogfood decides which of these are product needs versus unnecessary machinery.

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

Hot revocation/removal may be promoted here if MCP is a supported public extension path. DAY-1 currently accepts restart-based removal because the supervisor makes restart an explicit lifecycle operation.

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

When an item becomes DAY-1 relevant, add/reclassify it in the DAY-1 requirements. When it becomes active work, Git + `docs/work/handoff.md` own execution state. When its semantic shape changes, update Architecture/Security or write/supersede an ADR.

This file never says that something is implemented merely because its phase has arrived.
