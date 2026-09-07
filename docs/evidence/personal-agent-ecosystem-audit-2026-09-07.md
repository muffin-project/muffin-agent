# Personal-agent ecosystem audit — 2026-09-07

> **Evidence snapshot, not authority and not a backlog.** This document records a
> dated external/internal audit. It does not override executable code,
> `docs/THESIS.md`, `docs/VISION.md`, `docs/ARCHITECTURE.md`,
> `docs/SECURITY.md`, `docs/EXTENSIONS.md`, `docs/OPEN-SOURCE-STRATEGY.md`, the
> DAY-1 authority set, or observed Git/PR state. Any finding that changes a
> current promise must be reconciled into its one authoritative home before it
> becomes implementation work.
>
> **Research rule:** peer systems are prior art, not authority. The purpose of
> comparison is to find cheaper, simpler or more capable shapes and to challenge
> Muffin's assumptions, not to build a parity checklist.

## 1. Executive verdict

Do **not** rewrite Muffin and do not migrate its semantic core to LangGraph,
OpenAI Agents SDK, Letta, Hermes or another agent framework.

The strongest current conclusion is almost the inverse: Muffin already has enough
architectural sophistication. Its main product risk is that it becomes an
extremely rigorous laboratory for building Muffin while the owner still needs
other agents and direct interfaces for ordinary life.

Muffin is comparatively strong in continuity semantics, evidence/provenance,
authority, effect reasoning, durable work and verification discipline. It is
comparatively weak in breadth and productization: browser/computer use, voice,
mail/calendar, Home Assistant/device action, desktop/TUI, easy install/onboarding,
large capability discovery, ecosystem maturity and immediate everyday utility.

The fastest path is therefore:

> **Own only what makes Muffin Muffin; reuse commodity capability aggressively.**

That means preserving the narrow semantic waist — Evidence, Beliefs, Work,
Effects, Authority; one canonical Home; Nodes/Surfaces/Workers; provider-neutral
continuity — while borrowing or adapting proven capability layers through MCP,
extensions, provider-native tools, Nodes and external services.

A second conclusion is equally important: ecosystem parity must not order the
roadmap. Hermes can show what is already possible and what product primitives are
worth stealing; owner dogfood should decide what Muffin needs next.

## 2. Audit scope and observed repository state

The audit covered the current `dev` direction, major branch differences,
architecture/workflow documents, dependencies and external peer systems.

At the time of the audit:

- `dev` was the current integration truth used by active work;
- `main` materially lagged `dev` and should not be used to judge current Muffin;
- the runtime loop had been substantially decomposed from the older monolithic
  shape;
- shared ingress, policy, durability, memory, scheduler and surface work had
  advanced significantly;
- `docs/ARCHITECTURE.md` defined five semantic planes: Evidence, Beliefs, Work,
  Effects and Authority;
- one authoritative Home remained the topology; active-active/leader election
  were explicitly out;
- Nodes were direction, not implemented protocol;
- DAY-1 was very close to its current gate, with remaining work concentrated in
  capability/tool-use behaviour and room capability policy at the observed
  snapshot;
- PR #462 (`slice/f7-capacita-per-stanza`) was open and mergeable and implemented
  explicit room capability grants plus tenant-scoped `vault.write` semantics.

This is a **dated snapshot**. Reconciliation must reconstruct live Git, PR,
checks, worktrees and DAY-1 authority before acting on any item below.

## 3. Thesis that survived adversarial comparison

The audit did not find a peer architecture that invalidates Muffin's core thesis.
The parts worth protecting are:

### 3.1 One continuous personal agent

Muffin is not a session, model, process, connector, device or UI. Those are
replaceable cognition, compute or bodies around one durable relationship with the
owner.

This remains a meaningful differentiator even when peer products expose many
named agents. A personal identity does not imply one context window, one active
process or one model.

### 3.2 Evidence and Beliefs are not the same thing

The separation between source evidence and derived/active beliefs remains one of
Muffin's strongest foundations. Provenance, world time, system time, speaker,
trust/origin and contradiction should survive model replacement.

Do not flatten this into ordinary chat history or a generic vector-memory layer.
The next useful memory work is not inventing more memory categories; it is closing
the actual loop:

```text
evidence
→ proposal / interpretation
→ reconcile
→ active belief
→ use
→ outcome / correction
→ revise / supersede / forget
```

A model may propose semantic changes; the runtime owns canonical activation.

### 3.3 Work is not a chat turn

Unfinished commitments, waits, schedules, long-running execution and resumability
must remain durable independently of one provider run or surface request.

This is important as MCP and providers add their own task/run abstractions: those
should map into Muffin Work rather than becoming competing durable identities.

### 3.4 Effects are first-class

Muffin needs to distinguish what it intended, what may have started, what is
confirmed, what may have happened and what can be undone/compensated. This
becomes more important, not less, as autonomy grows.

The useful product principle is:

> **More autonomy should produce more observability, not more popups.**

Do not equate supervision with asking the owner before every action. Build enough
effect evidence that Muffin can safely compress supervision per capability and
resource while remaining inspectable and recoverable.

### 3.5 Authority is separate from model judgment

The model can interpret meaning and propose work. It must not grant itself
constitutional authority.

The current direction — deterministic policy over principal/tenant/capability/
resource/context plus explicit owner boundaries — remains stronger than a global
"trust score" or prompt-level safety policy.

Taint should describe provenance/flow. Risk can inform a decision. Neither should
become a metaphysical measure of whether Muffin is "trusted now".

### 3.6 One Home; Nodes and Surfaces are orthogonal

Keep one canonical Home until real use demonstrates a need for distributed
continuity. Do not implement leader election, active-active replication, a
message bus or a compute scheduler because the product has multiple devices.

Implement Node only from a concrete journey such as:

> Home lives on a VPS but Muffin needs clipboard/screen/speaker/browser or local
> inference from the owner's Mac.

The minimal Node grammar should then be enough to pair, identify, heartbeat,
advertise capabilities, invoke them, return results and intersect Home authority
with a non-bypassable local ceiling.

## 4. Hermes should become the moving breadth benchmark

As of 2026-09-07, Hermes Agent v0.21.0 (released 2026-08-31) is a strong reference
for what a contemporary personal/power-user agent can expose as product
capability. The release highlights Bot Mode in desktop, cron continuity/memory,
live-steerable subagents, a stronger MCP control surface and browser control.

Muffin should not copy Hermes's architecture or identity model. It should compare
itself continuously against Hermes's **breadth and ergonomics**.

Benchmark dimensions:

- TUI / desktop / control plane;
- browser and computer use;
- terminal/workspace backends;
- scheduled routines with continuity;
- live-steerable subagents;
- skills and self-improvement UX;
- MCP discovery/configuration/health;
- VPS/remote execution paths;
- realtime voice;
- Home Assistant and device integrations;
- tool/provider gateway ergonomics;
- surface breadth;
- setup speed and onboarding;
- credential/profile management.

### What to steal from Hermes

Steal product primitives and integration patterns where they reduce work:

- browser as a normal capability rather than a bespoke project;
- steer/list/stop/resume for long-running child work;
- cron/routine UX that preserves continuity between runs;
- easy MCP discovery, health and management;
- desktop/TUI visibility into what the agent is doing;
- voice and Home Assistant as ordinary installed capabilities;
- simple user-facing profiles/skills where they reduce repeated prompting;
- multi-backend terminal/workspace abstraction where local/VPS/remote execution
  needs it;
- onboarding that hides framework/runtime mechanics.

### What not to steal by default

- a society of independent agents as Muffin's foundational identity model;
- architecture/framework replacement merely to gain feature parity;
- feature work whose need has not appeared in dogfood or an explicit owner
  requirement;
- provider-specific concepts promoted into constitutional core semantics.

The comparative hypothesis is:

> Hermes can currently know/do a great deal immediately. Muffin's potential
> advantage is being able to know **why** it knows, what remains owed, what it
> definitely did versus may have done, what it is allowed to do and for whom,
> while remaining the same personal entity across model/device/process changes.

If Muffin cannot acquire enough commodity breadth, that semantic advantage will
not matter in everyday use.

## 5. Tool/provider gateway: steal the mental model, not a hosted service yet

Hermes's tool gateway is useful mainly as an ergonomics lesson: one capability
can be backed by multiple providers without making the user configure each
provider as a separate mental object.

Muffin should eventually be able to think in a shape like:

```text
capability
  ↓
capability provider
  ├─ local implementation
  ├─ MCP server
  ├─ provider-native hosted tool
  ├─ Node-local implementation
  └─ external service
```

For example, `browser` could be implemented by a local browser adapter, a remote
browser service, provider-native computer use or an MCP capability. The owner
should normally say "use the browser", not manage the backend architecture.

Do **not** build a project-operated hosted Muffin Tool Gateway before there is a
real distribution/economic need. Start with the abstraction boundary and reuse
existing providers.

## 6. Capability discovery must replace a flat growing tool menu

Current frontier provider guidance reinforces a concrete scaling constraint:
large flat tool lists waste context and reduce selection quality.

Anthropic's current tool-search documentation recommends on-demand discovery
when toolsets grow, specifically calling out 10+ tools as a point where search
can become useful and degradation above roughly 30–50 loaded tools. It supports
provider-native deferred loading/search and recommends keeping only a few common
tools always loaded.

Muffin should therefore avoid solving breadth with a hard global tool cap **or**
with a permanently loaded flat list.

A minimal future boundary is enough:

```text
CapabilityCatalog
  = built-in
  + extensions / MCP
  + Nodes
  + provider-native adapters

searchCapabilities(query)
loadCapabilities(ids)
```

Use native provider discovery/tool-search when available. Use a simple local
text/BM25/FTS-style deterministic fallback otherwise. Do not build a router
agent, embedding ontology or new orchestration framework unless measured use
requires it.

This should compose with `docs/EXTENSIONS.md`; it is not a second plugin system.

## 7. Too many owner commands are a product smell

The normal owner should not need to understand a large vocabulary of commands
for memory, jobs, surfaces, runtime, capabilities, backups, policy and lifecycle.

The command surface should be classified into four buckets:

### 7.1 Conversational owner actions

Muffin should do them when asked, subject to authority:

- remember / correct / forget;
- create or change a routine;
- show open work/waits;
- connect, inspect or disable a capability when safe;
- explain why it can/cannot do something;
- recover ordinary failed work.

### 7.2 Automatic system mechanics

The owner should not normally operate these:

- routine backup cadence;
- safe migrations;
- indexing/compaction;
- worker process lifecycle;
- cleanup;
- health/recovery actions that can be performed deterministically and safely.

### 7.3 Explicit constitutional/recovery actions

Human friction is useful here:

- pairing/root-of-trust changes;
- sensitive authority widening;
- destructive recovery/import decisions;
- actions whose explicitness is itself part of the security boundary.

### 7.4 Developer/operator interfaces

These can remain rich without being product UX:

- evals and acceptance runners;
- traces and DB inspection;
- low-level lifecycle commands;
- migration/debug tooling;
- repair commands for maintainers.

A TUI/desktop control plane can expose diagnostic/recovery power without making
those commands prerequisites for owning Muffin.

Do not delete observability to achieve simplicity. Hide mechanics from the normal
path while keeping an operator escape hatch.

## 8. One Muffin does not mean one context; persistent facets are worth preserving as a hypothesis

The audit challenged an earlier simplistic answer to "should there only be one
Muffin?".

There are at least three different problems:

1. one model/context cannot handle all concurrent work;
2. the owner wants a long-lived specialist working relationship;
3. the owner wants a genuinely independent agent/entity.

Problem 1 is solved by Work, context assembly and workers/subagents. It does not
require another identity.

Problem 3 is another Muffin/Home: separate canonical memory/authority/identity.

Problem 2 may justify a **persistent facet/profile** under the same Muffin. This
is a product hypothesis, not current architecture.

Conceptually:

```text
Muffin
├─ persistent facet: Code
├─ persistent facet: Research
├─ persistent facet: Home
└─ workers/subagents for task-scoped execution
```

A facet might have durable standing instructions, preferred model, capability
scope, workspace, long-lived thread/work context and a scoped view of memory.

It should **not** automatically fork canonical facts about the owner/world. If
`Muffin Code` learns a durable owner fact, the Evidence/Belief system should not
silently create a second incompatible world model merely because the context was
specialized.

The important test before implementation is whether facets buy something that
Work + retrieval/context assembly + steerable workers do not already buy. Avoid
creating an "agent zoo" that increases owner cognitive load.

Hermes Bot Mode is useful prior art here, but Muffin's differentiator may be that
specialization can exist **under shared canonical continuity** rather than by
multiplying independent identities.

## 9. Steerable subagents/workers should be explicit capability

For long-running or delegated work, spawn-only delegation is insufficient.
Muffin should eventually support a small control surface analogous to:

```text
spawn
list/status
steer
stop/cancel
resume/recover where durable work permits it
```

Workers remain replaceable compute/context for Muffin rather than persistent
independent personalities by default.

Steering is especially valuable because it allows the owner or parent Muffin to
correct direction without throwing away accumulated work.

Do not build a multi-agent society merely because steerable workers are useful.

## 10. Muffin should be able to work on Muffin

This is a desired long-term property, but the useful version is broader and more
controlled than "self-modifying agent".

Muffin should eventually be able to:

- observe its own real failures and owner fallback patterns;
- monitor relevant peers/ecosystem changes (Hermes, Anthropic, OpenAI, MCP,
  security/tooling changes and other systems that can materially challenge a
  decision);
- research only when the result could change a real decision;
- write dated evidence/proposals;
- select a falsifiable claim;
- implement a scoped change through a normal worker/session;
- run the same tests/evals and integration process used for other repository
  work;
- learn from the resulting outcome.

The fact that the target is Muffin's own repository must **not** create a magic
bypass around Work, Effects or Authority.

For critical claims, the producer must not be the sole certifier. A strong shape
is:

```text
observe / research
→ evidence / proposal
→ claim
→ producer implements
→ independent evaluator/judge challenges the claim
→ normal integration boundary
→ outcome becomes evidence
```

Owner decision boundaries continue to apply to security/privacy boundaries,
irreversible architecture, durable schema, authority widening and materially
expensive fanout.

Monitoring peers should eventually be scheduled Muffin work. The useful
notification condition is not "Hermes released something"; it is "a current
change materially challenges Muffin's capability gap, design assumption or
implementation choice".

## 11. Memory: do not add more ontology before the write/reconcile/use loop works in life

Letta remains a stronger reference for mature ready-to-use stateful-agent memory
productization: persistent memory blocks, tool attachment/approval and explicit
stateful-agent APIs are already easy to consume.

That does not justify migrating Muffin's memory model to Letta.

Muffin's evidence→belief distinction, provenance and single semantic writer are a
stronger/different bet for a long-lived personal agent. The immediate gap is
functional closure and UX, not lack of theoretical categories.

Priority should therefore be:

```text
real evidence ingestion
→ intentional/candidate memory write
→ reconciliation
→ retrieval/context use
→ correction/outcome feedback
→ forgetting/supersession semantics
```

Embeddings, FTS, profiles, summaries and reranking remain derived and rebuildable.

## 12. Effects: complete observability before expanding unsupervised outward autonomy

The current effect/WAL direction should be completed before Muffin receives
materially broader unsupervised outward authority.

At semantic level an effect record should be able to answer:

- intent;
- principal and tenant;
- capability and target/resource;
- when execution started;
- reversibility/compensation information;
- status such as planned / started / confirmed / uncertain / failed /
  compensated;
- evidence supporting the outcome;
- undo/compensation reference where applicable.

Exact schema is not prescribed by this audit.

Important distinction: **this is not a reason to keep the personal Muffin off.**
Owner dogfood can begin with limited/reversible/read-heavy authority. The gate is
on unsupervised external side effects, not on completeness of every feature.

## 13. Policy: keep the current capability direction, then subtract

The room-grant direction in ADR-0073/#462 is promising because it moves policy
toward explicit capability/resource boundaries rather than broad trust tiers.

After the current room-capability work, perform a subtraction pass before adding
new dimensions.

A useful owner/kernel mental model should remain close to:

```text
who is acting?
which tenant/scope?
which capability?
which resource boundary?
is it irreversible?
is it outward?
what budget/rate applies?
→ allow / ask / deny
```

Taint/provenance and contextual risk can inform this without becoming global
trust metaphysics.

Better policy should usually produce **less visible user friction** because safe
boundaries become mechanically obvious.

## 14. D13/tool use: avoid one-off tool proliferation

When the model reaches for shell for a read operation, the answer should not
automatically be "add a bespoke tool for that one read".

A dedicated tool/capability is justified when it buys materially better:

- semantic clarity;
- authority/resource precision;
- effect/audit semantics;
- cross-platform abstraction;
- structured/stable results;
- reliability/performance.

If a genuinely read-only shell is confined to the correct sandbox/resource
boundary, a generic read via shell may be the simpler capability for some
inspection tasks.

This is **not** permission to widen shell authority. It is a warning not to turn
D13 into permanent command/tool proliferation. Measure the model behaviour and
the policy boundary.

## 15. Keep the custom Muffin loop; negotiate provider capabilities

Do not replace Muffin's loop with OpenAI Agents SDK or another general agent SDK.
Those systems contain useful commodity primitives — sandbox execution, realtime
voice, tools, sessions, HITL, tracing, MCP, agent-as-tool/handoff patterns — but
Muffin's core semantics are already more specific than their generic state model.

The right adaptation is provider capability negotiation:

- native deferred tool loading/tool search;
- hosted web/file/computer/code tools where appropriate;
- prompt caching;
- realtime voice transports;
- provider-specific resumability or structured output features;
- server-managed capabilities that can be wrapped without becoming canonical
  continuity.

Muffin's agent loop should not collapse to the lowest common denominator of all
providers.

## 16. MCP should be the primary breadth escape hatch

MCP v2 is a sensible current dependency direction. The current Tasks extension
(2026-07-28 draft at audit time) allows a tool call to return an asynchronous task
handle with get/update/cancel semantics.

Muffin should adapt external MCP task state into Muffin Work rather than creating
another durable long-running-work system.

MCP does not automatically make third-party code safe. `docs/EXTENSIONS.md` is
correct to preserve packaging/authority/containment as a Muffin concern around
standard adapters.

Prefer a few generic extension concepts rather than a framework zoo:

- installed package/extension;
- capability;
- skill/procedure;
- surface/connector where lifecycle is genuinely different.

Do not create a second generic "Plugin" runtime if existing extension contracts
already compose the need.

## 17. Browser, mail/calendar, voice, Home Assistant and Nodes are high-information capability domains

These are **not a committed roadmap order**. They are especially valuable because
each stresses different semantic planes.

### Browser / computer use

High priority when dogfood exposes repeated browser fallback. Reuse Playwright,
Browser Use, provider-native computer use or MCP/remote browser services behind a
Muffin capability adapter. Do not build a browser engine.

### Mail + Calendar

Very high-information personal-agent domain: people, commitments, temporal state,
proactivity, outward side effects, approvals and memory all collide. Prefer
existing APIs/connectors/extensions rather than baking Gmail/Google Calendar into
core.

### Realtime voice

Voice is a Surface/body. Use provider-native realtime speech stacks where they
save codec/VAD/interruption work. Muffin owns identity/context/authority/work, not
speech transport for its own sake.

### Home Assistant

Particularly valuable because it crosses from digital work into the physical
world and exercises read vs act authority, device locality, schedules, recovery
and eventually Nodes.

### Nodes

Implement from a concrete placement failure, not from architecture aesthetics.
A likely first real need is VPS Home + Mac local capability.

### Hardware pendant / speaker

Later than voice and Node proof. First establish the same Muffin across VPS Home,
Mac Node and mobile/voice Surface; then tiny hardware is a specialised body, not
a new agent architecture.

## 18. Surface parity is the wrong abstraction

Telegram, Discord, CLI, desktop and voice do not need identical transport
features. They should negotiate what a `(surface, room)` can actually do:
streaming, drafts/edits, files/media, interruption/steering, topic/thread
semantics, delivery guarantees.

One agent does not imply one giant Surface interface containing every feature of
every transport.

## 19. Concurrency: one agent does not mean a global mutex

Muffin may execute many Work items concurrently while remaining one personal
identity.

Useful separation:

- Work executions can be concurrent;
- canonical Belief reconciliation has a single semantic writer;
- locks should protect genuinely conflicting resources/effects, not the whole
  identity;
- durable Work and Effect identities let activity survive provider/process
  boundaries.

This matters before interpreting "Muffin handles many things" as a reason to
create many independent agents.

## 20. Developer workflow is strong in principle but at risk of becoming a second product

`docs/ORCHESTRATION.md` contains a strong control-loop philosophy:

```text
observe → reconstruct → one claim → research decision forks only
→ proportional verification → implement/delegate → verify → integrate
```

Delegation is correctly treated as a context tool rather than a default. A worker
summary is not evidence. Verification is proportional to claim/blast radius.

The risk is implementation friction around this philosophy:

- large `.claude` machinery can become provider-specific project infrastructure;
- a single expensive local merge gate serializes agentic throughput;
- local hooks are useful UX but are a weak constitutional integration boundary;
- two plausible current branches and many stale branches increase cognitive
  surface for agents and humans.

Direction to challenge/reconcile:

1. move load-bearing invariants into repo-neutral executable commands;
2. keep Claude hooks, Codex adapters and human CLI as thin surfaces over the same
   invariants;
3. use FAST local targeted checks for fast feedback;
4. require the integrated claim check at the server/repository boundary;
5. keep heavier acceptance/post-merge/scheduled verification where proportional;
6. use GitHub rulesets/required checks rather than relying on local hooks as the
   final trust boundary;
7. automatically delete merged claim branches and require an explicit reason/TTL
   for parked branches;
8. revisit `main`/`dev` before community scale so external contributors have one
   obvious current integration truth.

Do not optimize CI mechanically before measuring what actually blocks claim
throughput. The audit's concern is mismatch between proportional-verification
policy and universal expensive execution.

## 21. Verification: keep fault injection at critical seams, not global ceremony

Mutation/fault-injection is valuable when it proves a guard cannot silently
become disconnected:

- authority decisions;
- effect durability/idempotency;
- tenant isolation;
- delivery exactly-once/uncertain outcome seams;
- provenance/root-of-trust boundaries.

Avoid global mutation-score religion. A check that can stay green while the
property it claims to prove is false is worse than no check because it creates
false confidence.

## 22. Open source sooner: separate source-public/pre-alpha from product public-alpha

Owner direction on 2026-09-07: make Muffin open source as soon as it is safe to
publish. Several people are already interested in contributing.

This changes an assumption in the earlier community sequence.

**Public source and public product readiness are different milestones.** The repo
can be source-public/pre-alpha while Muffin is still in owner dogfood and not
recommended as a public-alpha product.

The publication boundary must be safe first:

- scan HEAD **and full Git history** for secrets, tokens, credentials, owner
  private data, dumps, machine-specific private content and artifacts that must
  not become public;
- decide whether Git history can be published intact or requires rewriting;
- explicitly confirm the intended license (current project metadata is MIT;
  changing it is an owner/ADR decision);
- make root/public docs honest about pre-alpha maturity;
- provide a contributor route that does not require Claude Code or founder-only
  context;
- provide the minimal security-reporting/support boundary appropriate to a
  source-public pre-alpha project without inventing stable-product SLAs;
- keep maintainer authority earned, not granted merely because somebody is an
  early collaborator.

Early collaborators are useful before public alpha. "Do not recruit
co-maintainers yet" can remain true while "accept contributors now" becomes
true.

A healthier sequence is approximately:

```text
owner RETURN / source-public preparation may overlap
→ repository source-public/pre-alpha when safe
→ owner 14-day dogfood
→ deliberately different trusted-alpha users
→ product public alpha
→ contribution volume grows
→ maintainership is earned from observed work
```

Publication work must not become a cosmetic blocker for owner dogfood.

## 23. Contributor experience is an architecture pressure test

As Muffin opens, external humans/agents will expose hidden founder context.
Useful constraints:

- one fact, one authoritative home;
- semantic names over opaque historical IDs;
- issues own attributable work;
- PRs make one falsifiable claim;
- evidence must be reproducible, not "Claude said it works";
- important repo invariants must be runnable without a specific coding-agent
  product;
- core changes have a higher evidence burden than extension/integration breadth;
- contributors should be able to add useful capability without understanding or
  editing the continuity kernel.

This is not only community hygiene. If a capable contributor cannot find the
right boundary without founder context, the architecture/document model is
probably too implicit.

## 24. Product scorecard from the audit

This table is subjective evidence, not a metric dashboard.

| Dimension | Muffin relative assessment | Interpretation |
|---|---:|---|
| Continuity semantics | very strong | ahead/differentiated |
| Evidence → belief provenance | very strong | ahead/differentiated |
| Authority model | very strong | ahead |
| Effect semantics | strong but incomplete | competitive; finish real loop |
| Durable work/crash semantics | strong | competitive |
| Memory product functionality | mid | behind mature stateful agents |
| Tool breadth | weak | far behind Hermes-class breadth |
| Browser/computer use | very weak | major product gap |
| Voice | weak | major product gap |
| Surface breadth | mid-low | behind |
| Ecosystem/plugins/extensions maturity | low-mid | direction good, product immature |
| Onboarding | mid-low | behind mature personal agents |
| Everyday usefulness | mid-low | biggest near-term risk |
| Semantic rigor | very strong | moat if product catches up |
| Verification rigor | very strong | strength; can become friction |
| Engineering throughput | mid-low | process can serialize itself |
| Runtime provider neutrality | strong | keep |
| Dev-workflow provider neutrality | weak-mid | improve before community scale |
| Product polish | low | expected pre-alpha, but consequential |
| Differentiation | very strong | thesis still worth pursuing |

Interpretation: Muffin is not materially behind as a semantic research/product
architecture and may be ahead in several important dimensions. As an installable
personal agent with broad daily capability, it is roughly one or two product
generations behind the best power-user harnesses. The gap is primarily
integration/productization debt rather than missing fundamental research.

## 25. Capability model: verbs of life

A useful completeness lens is not "number of tools" but the verbs a real
personal agent must support.

### Perceive

- text;
- images;
- audio;
- documents;
- web;
- events/messages;
- browser/screen;
- device/sensor state where installed.

### Remember

- conversations;
- people/entities;
- preferences;
- commitments;
- temporal facts;
- contradictions/corrections;
- outcomes;
- why/how it knows;
- forgetting/supersession.

### Act

- filesystem/workspace;
- terminal/code;
- browser;
- search;
- communication;
- calendar/mail;
- reminders/tasks;
- documents/APIs/MCP;
- local device actions through Nodes/extensions.

### Continue

- resume after process/model interruption;
- wait/schedule;
- long-running calls/tasks;
- crash recovery;
- uncertain-effect recovery;
- proactive wakeups.

### Judge

- principal/owner authority;
- tenant/resource scope;
- reversibility/outward boundary;
- spending/rate budgets;
- privacy/data locality;
- evidence/outcome confidence.

### Be present

- silence when nothing useful changed;
- relevance/timing;
- interruption/steering;
- remembering conversational commitments;
- background awareness;
- cross-surface continuity.

## 26. Metrics that matter more than feature count

### Product/dogfood

- consecutive days the owner actually uses Muffin;
- direct-interface fallbacks per day/domain;
- unnecessary human interventions;
- tasks completed without follow-up correction;
- commitments/open loops forgotten;
- duplicate effects;
- unresolved uncertain effects;
- memory corrections;
- useful vs annoying proactive interventions;
- capability/device-placement failures.

### Agentic engineering

- claim → integrated evidence latency;
- material defects escaping integration;
- post-merge rework;
- PR conflict rate;
- time blocked on verification/gate rather than productive work;
- context/tool cost per merged claim where measurable;
- owner decisions requested unnecessarily;
- contributor time-to-first-correct-claim once source-public.

## 27. Immediate ordering principle

Do not implement this audit as a roadmap.

The near-term transition should be:

```text
complete the current safe RETURN boundary
→ install/use the real personal Muffin
→ dogfood becomes primary roadmap evidence
→ compare each observed failure against Hermes/peers/native capabilities
→ choose the smallest falsifiable claim
→ use /goal or equivalent persistence on that claim, not on the whole audit
```

A likely clean owner cutover boundary is still:

- current room/policy work reconciled/merged where it belongs;
- real Telegram owner E2E;
- real target install (including the actual VPS architecture, not only a
  simulated/container path);
- Home backup/recovery/doctor safety checked;
- an identifiable build/tag/commit starts the real dogfood period.

Do **not** wait for desktop, browser, voice, Home Assistant, facets, all skills or
all future tools before using the personal Muffin. That would eliminate the most
valuable source of product evidence.

Do gate materially broader **unsupervised outward autonomy** on sufficient
Effects/Authority observability instead of gating all use on feature
completeness.

## 28. Reconciliation protocol for this memo

The next session should not "verify ChatGPT" and should not "implement the
recommendations".

It should:

1. reconstruct live repository/PR/worktree/check/delegation state;
2. read the authoritative map in `docs/README.md`;
3. read this memo as dated evidence;
4. classify each load-bearing finding as:
   - already true;
   - current authority stale because an owner decision changed;
   - compatible direction/hypothesis that remains evidence;
   - conflict requiring an owner decision or superseding ADR;
   - actionable only after observed dogfood need;
   - stale/invalid;
5. update only authoritative homes whose meaning has actually changed;
6. create/split attributable work only for claims that are genuinely current;
7. do not create another master roadmap/status document;
8. finish with one falsifiable executable next outcome suitable for `/goal`.

The reconciliation itself may correctly produce **no runtime code**.

## 29. `/goal` usage after reconciliation

`/goal` is useful as a persistence mechanism for one outcome. It is not the
strategic governor.

A good goal should approach an executable boolean, for example:

```text
RETURN_TO_OWNER is true when the current authoritative RETURN blockers are
closed or proven non-blocking; the candidate build is installed on the real
owner target; the real owner surface completes its required E2E; Home
backup/recovery/doctor checks required by the threshold pass; no claim-owned
PR/worktree/delegation is left ambiguous; and authoritative homes made stale by
this claim are updated.

Do not implement post-RETURN capability merely because the ecosystem audit names
it. Stop on owner decision boundaries defined by ORCHESTRATION.
```

Do not use a goal such as "make Muffin as capable as Hermes" or "implement the
2026-09-07 audit". Those are open-ended strategic programs with too many decision
forks and encourage scope creep.

## 30. Things this audit explicitly does **not** authorize

Do not implement merely from this memo:

- migration to LangGraph/OpenAI Agents SDK/Letta/Hermes;
- multi-agent personality society as Muffin core;
- persistent facets before the hypothesis is reconciled and dogfood justifies
  them;
- a custom browser engine;
- a project-hosted tool gateway;
- a vector database replacing SQLite;
- Kafka/Redis/Temporal/event bus/workflow DSL;
- active-active Home or leader election;
- a generic plugin runtime separate from existing extension direction;
- a custom tool-router model;
- a large capability ontology;
- a new policy dimension for every new risk;
- broad self-modifying/autonomous production updates;
- a full mobile app before an observed need chooses that product surface;
- global mutation-score requirements;
- an open-source launch that publishes unreviewed history/private owner data;
- ecosystem parity work that delays safe owner dogfood.

## 31. Primary external sources used in the audit

These links are included so a future contributor can challenge the evidence
without needing the conversation that produced this memo. They are dated inputs;
current docs should be checked again before a new decision relies on volatile
behaviour.

### Hermes Agent

- Releases / v0.21.0 (2026-08-31):
  https://github.com/NousResearch/hermes-agent/releases
- Repository/docs for current capability and product surface:
  https://github.com/NousResearch/hermes-agent

### Anthropic tool discovery

- Tool search tool — on-demand discovery/deferred loading:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Claude Code/Agent SDK tool-search guidance:
  https://code.claude.com/docs/en/agent-sdk/tool-search

### Model Context Protocol

- Tasks extension (2026-07-28 draft at audit time):
  https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks
- MCP specification/project:
  https://modelcontextprotocol.io/

### OpenAI Agents SDK TypeScript

- SDK overview:
  https://openai.github.io/openai-agents-js/
- Sessions:
  https://openai.github.io/openai-agents-js/guides/sessions/
- Human-in-the-loop:
  https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
- Voice agents:
  https://openai.github.io/openai-agents-js/guides/voice-agents/
- Tracing:
  https://openai.github.io/openai-agents-js/guides/tracing/

### Letta

- Current stateful-agent documentation:
  https://docs.letta.com/
- Memory block model/reference:
  https://docs.letta.com/tutorials/attaching-detaching-blocks/

### OpenHands

- Agent SDK architecture/workspaces:
  https://docs.openhands.dev/sdk/arch/overview
  https://docs.openhands.dev/sdk/arch/workspace

### GitHub repository governance

- Rulesets / required status checks:
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets

## 32. Final synthesis

Muffin's current problem is not that its architecture is unserious or obsolete.
The audit found the opposite: it has enough serious semantics to support a
personal agent that can remain coherent as capability explodes.

The dangerous failure mode is spending that advantage on ever more internal
sophistication while the owner still has to live in Chrome, Gmail, another coding
agent, a Home Assistant UI and separate tools.

The practical north star is:

> **new real experiences per unit of new architecture.**

Hermes and other peers should continuously reduce the amount Muffin has to invent.
Dogfood should continuously reveal which borrowed capability matters next.
Muffin should increasingly do the mechanical work itself, including eventually
researching and improving Muffin — but under the same evidence, authority,
effect and independent-verification boundaries it applies everywhere else.
