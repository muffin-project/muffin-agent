# Architecture

This document is the **current semantic map** of Muffin. It answers how the
system is shaped and which component owns which guarantee. It intentionally does
not copy database columns, config literals or API signatures: executable code,
schemas and shipped config own those mechanics.

For why this shape exists, follow the linked ADRs. For whether a DAY-1 journey is
currently proven, use `docs/blueprint/M5-BIS.md`.

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
A future deployment may use more than one process without becoming more than one
agent.

ADR lineage: `0045-l-unita-e-l-agente-continuo.md`.

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

The durable rule is semantic: preserve evidence and the meaning required to
reconstruct useful beliefs. Physical indexes and model-specific representations
may be rebuilt.

### Work

Work owns unfinished obligations: turns, waits, todos, scheduled occurrences and
the state needed to resume without inventing a new task.

A turn is a durable work unit, not a stack frame. A stable external occurrence
(such as a scheduled fire or inbound update) should bind to one durable work
identity so a crash does not create a second job by accident.

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
one state. The reusable undo/reversal layer is still a Gate concern rather than
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

## 3. The turn path

At a high level, a user-facing turn crosses these boundaries:

```text
surface / ingress
      │
      ▼
principal + typed content + provenance
      │
      ▼
durable turn / session evidence
      │
      ▼
context assembly
(history + memory recall + work + system prompt)
      │
      ▼
configured model provider
      │
      ▼
model proposes tool/capability call
      │
      ▼
schema validation + canonical resource
      │
      ▼
policy decision
      │
      ├── deny / ask / draft
      │
      └── permitted effect
              │
              ▼
       durable intent → handler → durable outcome
              │
              ▼
       final durable result / delivery
              │
              ▼
             surface
```

The load-bearing property is that safety and durability boundaries live outside
the model call. A model response is a proposal, not proof of an effect.

## 4. Surfaces are ports, not agents

CLI, Telegram, future voice, desktop control plane, wearable and other surfaces
must bind into the same logical agent.

A surface owns transport-specific concerns such as:

- authenticated subject identity and pairing;
- parsing native events into typed ingress;
- rendering/delivery capabilities;
- transport-specific idempotency keys and delivery metadata.

A surface must not fork memory, identity, work or policy. Surface-specific
session boundaries may exist for interaction ergonomics, but they are not a
second personal agent.

## 5. Providers are replaceable compute and privileged data recipients

The configured LLM provider is part of the harness, not Muffin's identity. Model
and provider changes must not reset the agent's durable state.

A remote provider is also an **egress boundary**: context sent to the model has
left the owner's machine and reached that provider. The current runtime trusts
the configured provider to receive the assembled model context; this is a
security/privacy fact, not an implementation detail. More granular `local-only`
versus `cloud-allowed` data policy is a future capability unless Gate evidence
requires it sooner.

Optional local privacy transforms may reduce what reaches a remote provider,
but a detector is not equivalent to a structural secret boundary.

See `docs/SECURITY.md`.

## 6. Core is narrow; capability belongs at the edges

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
extension boundary
introspection
```

Gmail, Spotify, Home Assistant, browser integrations, a PII detector or a future
messaging platform are capabilities around that core, not reasons to expand the
core's trusted computing base.

The intended extension model separates:

- **package** — what the owner installs;
- **capability** — each authority-bearing thing it can do;
- **grant** — what the owner currently permits that capability to do.

Different extension contracts may exist (connector, importer, provider adapter,
privacy transform, skill, MCP adapter). A single giant `Plugin` runtime
interface is not an architectural goal.

The detailed community/extension design is post-DAY-1 product work; current code
continues to expose tools, skills and MCP without pretending the future package
system already exists.

## 7. Canonical state versus derived state

The continuity promise is about **meaning that survives replacement**, not one
physical SQLite layout.

Canonical or continuity-bearing state includes, according to its plane:

- source evidence and provenance;
- owner/agent identity and constitutional authority;
- unfinished work and occurrence identities;
- effect intent/outcome information required to avoid duplication or loss;
- deliberate corrections, retirements and deletion/forget semantics once those
  are supported.

Derived/rebuildable state includes things such as:

- embeddings and vector indexes;
- full-text indexes;
- generated profiles/digests/summaries;
- retrieval caches and materialized views;
- generated repository maps.

A schema migration may be serious because it can damage canonical data, but the
schema itself is not Muffin's identity. A future canonical export/import format
should preserve semantics while allowing indexes and physical representation to
be rebuilt.

## 8. A fresh generation starts with fresh native memory

The current rebuild is not required to ingest the previous Muffin database as
native memory. The old Muffin is a predecessor and archive; the new Muffin starts
its own evidence history under the new provenance and belief semantics.

This does not weaken the continuity thesis. It defines the birth boundary of
this generation. From that point onward, future replacement of model, harness,
device or physical representation must preserve Muffin's own accumulated
continuity.

See ADR-0049.

## 9. Deployment: owner-run, centrally optional

The product model is owner-run. A desktop machine, home node, NAS or the owner's
VPS may host the runtime. Central project infrastructure may make installation,
updates, OAuth bootstrap, discovery or Telegram provisioning easier, but should
not be required for an already-installed Muffin to retain its identity, memory
or work.

A concise product invariant is:

> **Central infrastructure may simplify birth; it must not be required for
> life.**

A hosted multi-tenant Muffin would be a distinct product with a different trust
and data model.

## 10. What this document does not own

- Exact database columns or JSON fields — executable schema/config owns them.
- Current policy literals — shipped Root-of-Trust config owns them.
- Whether a DAY-1 capability is READY — `M5-BIS.md` owns Gate status.
- Why a historical decision was made — the relevant ADR owns that history.
- Which PR is in flight — Git + `LAVORO.md` own operational state.

When code and this document disagree on a mechanical detail, verify the code and
fix this map if its **semantic claim** is wrong. Do not implement prose blindly.