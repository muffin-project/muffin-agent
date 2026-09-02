# Architecture

This document is the **current semantic map** of Muffin. It answers how the
system is shaped and which component owns which guarantee. It intentionally does
not copy database columns, config literals or API signatures: executable code,
schemas and shipped config own those mechanics.

For why this shape exists, follow the linked ADRs. For whether a DAY-1 journey is
currently proven, use `docs/work/day1/requirements-status.md`.

A semantic boundary described here may intentionally be ahead of its current
mechanical implementation. When that is true, this document names the gap rather
than presenting planned machinery as shipped.

## 1. The unit is one continuous agent

Muffin is not a chat session, process, model, device or connector.

The logical unit that persists is one agent with:

- a history of evidence;
- beliefs derived from that evidence;
- unfinished work and commitments;
- a record of intended, possible and completed effects;
- an authority constitution that constrains what may happen next.

Surfaces are ports onto that agent. Models and execution processes are
replaceable compute. A process may die without logically creating a new Muffin.
A deployment may use more than one process or host without becoming more than
one agent.

ADR lineage: `0045-l-unita-e-l-agente-continuo.md`,
`0050-una-home-molti-capability-node.md`.

## 2. Five semantic planes

The architecture is easiest to reason about as five planes. They are semantic
ownership boundaries, not a requirement for five modules or five tables.

```text
                       model / reasoning
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
      EVIDENCE            BELIEFS             WORK
   what entered or       what Muffin       what is still
      happened          thinks is true          owed
          │                  │                  │
          └──────────────┬───┴──────────────┬───┘
                         │                  │
                      EFFECTS           AUTHORITY
                 what may have been    what transitions
                  done to the world      are permitted
```

A new persistent structure should have one primary plane. If a design makes one
store authoritative for two planes, the seam must be understood before adding
more state.

### Evidence

Evidence records what actually entered or happened, with source, actor,
provenance and trust preserved where the source supports them.

Current concrete homes include:

- session transcripts (`core/session/`) for append-oriented conversation history;
- memory episodes (`core/memory/`) for durable evidence available to the memory
  system;
- vault/document source material;
- durable inbound identities such as Telegram update records and scheduled
  occurrence identities where they exist.

A transcript is not automatically a belief. A fact is not automatically owner
speech merely because it lives in the owner's installation.

### Beliefs

Beliefs are interpretations that can be reconstructed, contradicted, hedged and
superseded without rewriting the source evidence.

The current memory graph separates entities/identities/facts from episodes and
carries world time, system time, speaker, trust and origin. Profiles, digests,
embeddings and retrieval indexes are **derived representations**, not the
identity of the memory system.

Canonical Beliefs have **one semantic writer**. Extractors, model reasoning,
future importers, Nodes or sub-agents may all produce candidate beliefs, but they
do not independently commit active truth. Agent-intentional memory uses the
conceptual `MemoryProposal` shape from ADR-0051: durable Beliefs-plane staging
that points back to source Evidence and carries runtime-derived provenance/taint.
A proposal is not itself Evidence, Work or an active Belief and must not be
returned by ordinary recall as canonical truth before reconciliation.

The Home-owned reconciliation path is the only semantic path that can activate,
merge, contradict or supersede a Belief. "One writer" is a semantic ownership
rule, not a requirement for a separate service or process. An implementation may
run producer and reconciler in one daemon while preserving the same boundary.

The durable rule is semantic: preserve evidence and the meaning required to
reconstruct useful beliefs. Physical indexes and model-specific representations
may be rebuilt.

The current runtime does **not yet implement an agent memory-proposal tool**; it
currently exposes read/search. ADR-0051 constrains the first intentional write
path without claiming that path is shipped.

### Work

Work owns unfinished obligations: turns, waits, todos, scheduled occurrences and
the state needed to resume without inventing a new task.

A turn is a durable work unit, not a stack frame. Stable external occurrences
must be consumed idempotently so a crash does not create duplicate work. More
than one native ingress event may contribute to the same user intent before one
durable work identity is materialised; transport identity and work identity are
therefore related but not identical.

Work does not own the truth of what happened in the outside world; that belongs
to effects/evidence.

### Effects

Effects own the transition between "we intend to do this" and "the world may or
may not have changed".

The current turn tool-call record provides write-ahead intent and outcome state
for tool calls, with rerunnability separated from reversibility. Delivery has
its own durable state because "work completed" and "answer definitely delivered"
are different claims.

The architecture is deliberately conservative around uncertainty: after a
crash, `not started`, `completed` and `possibly completed` must not collapse into
one state. The reusable undo/reversal layer is still a DAY-1 concern rather than
a claim made by this document.

### Authority

Authority owns which world transitions are permitted.

The policy kernel consumes typed facts — principal, tenant, capability,
resource, taint, risk, budget and sealed policy — and returns a deterministic
decision. The model may interpret meaning and propose work; it does not grant
itself authority.

The Root of Trust and shipped policy configuration set constitutional floors.
Familiarity with the owner does not raise authority. Any future reduction in
supervision must be scoped, observable, revocable and evidence-backed rather
than expressed as a global trust score.

## 3. Semantic planes and runtime topology are orthogonal

The five planes answer **what kind of meaning/state this is**. Runtime topology
answers **where it lives or executes, under which trust/failure/lifecycle
boundary**.

The current topological vocabulary is:

```text
Muffin continuity
      │
      ▼
authoritative Home
      │
      ├── Surfaces       how principals communicate
      ├── Nodes          where local capability/context/resources exist
      ├── Workers        replaceable computation/effect executors
      └── Compute targets local or remote model/inference endpoints
```

These roles are not additional semantic planes and do not justify duplicated
canonical stores.

### Home

A **Muffin Home** is the deployment authority boundary that currently holds the
canonical continuity of one Muffin. For the current product phase there is
exactly one authoritative Home at a time.

The Home logically owns canonical identity, Work, Effects, Authority, budget,
scheduler, Node registry/pairing and canonical Evidence/Beliefs transitions.
The Home is not the identity of Muffin and must be migratable between valid
owner-controlled deployments.

No active-active Home, automatic leader election or replicated authority is part
of the current architecture. If the Home is unavailable, Nodes do not silently
promote themselves to a new canonical Home.

### Node

A **Node** is a paired host or device that can offer capabilities, sensors,
actuators, local data or compute to the same Muffin. A Node has a stable identity
separate from its current connection; reconnecting a laptop must not create a
new device identity.

A Mac can be both Node and Surface. Telegram can be a Surface without being a
Node. A headless compute box can be a Node without being a human Surface.

The Node protocol is not implemented by the current runtime yet. ADR-0050 owns
the semantic and security contract so the implementation does not later have to
change what a Node means.

### Workers and execution placement

A Worker/Executor performs computation or effects without becoming the owner of
the canonical transition its result informs. Process or host separation is used
when it buys security isolation, crash isolation, resource/lifecycle
independence, untrusted-code containment or placement on another host.

This means the logical architecture is multiprocess-ready without requiring a
microservice deployment. The current DAY-1 implementation may remain mostly one
daemon plus the process isolation already required for execution.

## 4. Ingress: native event, composed intent, durable work

A transport event is not automatically a user intent and a user intent is not a
transport id.

The semantic path is:

```text
native surface event(s)
      │
      ▼
typed fragments + per-fragment provenance
      │
      ▼
surface-specific composition
      │
      ▼
user intent
      │
      ▼
durable work identity
```

The Surface owns transport-specific composition rules because Telegram albums,
split messages, edits/replies and a future voice stream do not have the same
native grouping semantics.

The durability rule is:

```text
each native event is consumed idempotently
N native events may compose one intent
one sealed intent produces one durable work identity
```

This distinction does **not** require a first-class `Intent` table today. The
current `Turn` may remain the concrete durable Work identity after composition
until a real consumer requires intent state independent of a turn.

The current implementation is still predominantly text-shaped (`TurnInput.text`)
and does not yet implement the final multimodal envelope or general surface
assembler. DAY-1 status for those capabilities remains owned by `docs/work/day1/requirements-status.md`.

## 5. Work remains interactive while execution is busy

Receiving input and executing current work are separate responsibilities. A
long-running turn must not make a Surface unable to durably receive later input.

The runtime vocabulary must be able to represent at least:

```text
STEER      amend current work at a safe boundary
FOLLOWUP   create subsequent work
COLLECT    coalesce compatible input before/subsequent work materialisation
INTERRUPT  cancel/abort according to effect semantics, then redirect work
```

The model may help judge semantic intent, but durable ordering, target work
identity and effect safety remain deterministic contracts.

A safe boundary must never pretend an already-started non-rerunnable effect did
not happen. Current code does not yet implement the complete busy-input contract;
ADR-0050 and the Work/Effects planes constrain the implementation.

## 6. Surfaces are ports, not agents

CLI, Telegram, future voice, desktop control plane, wearable and other surfaces
must bind into the same logical agent.

A surface owns transport-specific concerns such as:

- authenticated subject identity and pairing;
- native-event receipt and transport idempotency;
- surface-specific composition into typed ingress;
- rendering/delivery capabilities;
- transport-specific reply/delivery metadata.

A surface must not fork memory, identity, work or policy. Surface-specific
session boundaries may exist for interaction ergonomics, but they are not a
second personal agent.

## 7. Node authority can only narrow Home authority

A paired Node is not an unconditional remote root.

For a capability executed on a Node, effective executable authority is the
intersection of:

```text
Home-authorized request
        ∩
Node local policy
        ∩
OS / physical device permission
```

The Node may deny, require local approval or narrow resource scope. The Home
cannot remotely widen or bypass that local ceiling, including by asserting that
the owner already approved elsewhere.

Any local approval is bound to the canonical execution plan actually being
executed: target Node, capability, authority-bearing arguments/resource, work or
effect identity and validity window. Changing those facts invalidates the prior
approval.

Pairing establishes Node identity; it does not grant every capability. See
`SECURITY.md` and ADR-0050.

## 8. Providers are replaceable compute and privileged data recipients

The configured LLM provider is part of the harness, not Muffin's identity. Model
and provider changes must not reset the agent's durable state.

Inference placement may eventually be Home-local, Node-local, on a dedicated
owner-controlled compute host or at a remote provider. The selector of compute
does not own Authority or canonical Work.

A remote provider is also an **egress boundary**: context sent to the model has
reached that provider. Crossing from a Home host to an owner-controlled Node is
also a locality/transport change, but it is not automatically the same trust
boundary as sending data to a third-party provider. Both must be observable when
policy begins to depend on locality.

The current runtime trusts the configured provider to receive the assembled
model context; it does not yet claim a per-evidence
`local-only`/`owner-controlled-only`/`cloud-allowed` policy.

Optional local privacy transforms may reduce what reaches a remote provider,
but a detector is not equivalent to a structural secret boundary.

See `docs/SECURITY.md`.

## 9. Core is narrow; capability belongs at the edges

Muffin core should own the semantics that make one continuous agent safe and
coherent:

```text
identity
continuity
evidence / beliefs
work
effects
authority
provenance
provider boundary
surface boundary
node boundary
extension boundary
introspection
```

Gmail, Spotify, Home Assistant, browser integrations, local model servers, a PII
detector or a future messaging platform are capabilities around that core, not
reasons to expand the core's trusted computing base.

The intended extension model separates:

- **package** — what the owner installs;
- **capability** — each authority-bearing thing it can do;
- **grant** — what the owner currently permits that capability to do.

Different extension contracts may exist (connector, importer, provider adapter,
privacy transform, skill, Node/hardware bridge, MCP adapter). A single giant
`Plugin` runtime interface is not an architectural goal.

The detailed community/extension design is post-DAY-1 product work; current code
continues to expose tools, skills and MCP without pretending the future package
system already exists.

## 10. Canonical state versus derived state

The continuity promise is about **meaning that survives replacement**, not one
physical SQLite layout or one host.

Canonical or continuity-bearing state includes, according to its plane:

- source evidence and provenance;
- owner/agent identity and constitutional authority;
- unfinished work and occurrence identities;
- effect intent/outcome information required to avoid duplication or loss;
- Node identity/pairing state once Nodes exist;
- deliberate corrections, retirements and deletion/forget semantics once those
  are supported.

Derived/rebuildable state includes things such as:

- embeddings and vector indexes;
- full-text indexes;
- generated profiles/digests/summaries;
- retrieval caches and materialized views;
- generated repository maps;
- worker-local caches and model warm state.

A schema migration may be serious because it can damage canonical data, but the
schema itself is not Muffin's identity. A future canonical export/import format
should preserve semantics while allowing indexes and physical representation to
be rebuilt.

## 11. A fresh generation starts with fresh native memory

The current rebuild is not required to ingest the previous Muffin database as
native memory. The old Muffin is a predecessor and archive; the new Muffin starts
its own evidence history under the new provenance and belief semantics.

This does not weaken the continuity thesis. It defines the birth boundary of
this generation. From that point onward, future replacement of model, harness,
device, Home host or physical representation must preserve Muffin's own
accumulated continuity.

See ADR-0049.

## 12. Deployment: owner-run, one active Home, centrally optional

The product model is owner-run. A desktop machine, Mac Mini/home node, NAS or the
owner's VPS may host the Home. Placement is deployment configuration, not product
identity.

Central project infrastructure may make installation, updates, OAuth bootstrap,
discovery or Telegram provisioning easier, but should not be required for an
already-installed Muffin to retain its identity, memory or work.

A concise product invariant is:

> **Central infrastructure may simplify birth; it must not be required for
> life.**

A hosted multi-tenant Muffin would be a distinct product with a different trust
and data model.

A future canonical migration/Capsule should be able to move the same Home
continuity between valid deployments. Automatic active-active replication or
local leader election is explicitly not part of the current product phase.

## 13. What this document does not own

- Exact database columns or JSON fields — executable schema/config owns them.
- Current policy literals — shipped Root-of-Trust config owns them.
- Node transport choice or wire schemas — the first real implementation owns
  mechanics under ADR-0050's semantic/security contract.
- Whether a DAY-1 capability is READY — `docs/work/day1/requirements-status.md`
  owns status.
- Why a historical decision was made — the relevant ADR owns that history.
- Which PR is in flight — Git + `docs/work/handoff.md` own operational state.

When code and this document disagree on a mechanical detail, verify the code and
fix this map if its **semantic claim** is wrong. Do not implement prose blindly.