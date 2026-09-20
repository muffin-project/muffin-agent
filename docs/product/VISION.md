# Muffin — Vision

This document owns **where the product is trying to go**. `THESIS.md` owns why
Muffin is worth building; `ARCHITECTURE.md` describes the current semantic shape;
`COGNITIVE-DESIGN.md` owns falsifiable human/cognitive hypotheses;
`requirements-status.md` owns the immediate DAY-1 proof state.

The vision is allowed to be ahead of the runtime. When it is, it must say so
instead of making a future capability sound current.

## One agent, many replaceable bodies

Muffin becomes one continuous personal agent that the owner runs under their
control. It is not a chat, device, app, process, Home host or model. Those are
ports, bodies and compute around the same continuity.

The runtime topology gives "many bodies" a concrete meaning:

- one active **Home** currently holds canonical continuity;
- **Nodes** are paired devices/hosts where Muffin can perceive, act or compute;
- **Surfaces** are how people/systems interact with Muffin;
- a device may be both Node and Surface without becoming another Muffin.

The Mac can therefore remain part of the same Muffin even if the authoritative
Home lives on a VPS or home server. A phone, Watch, speaker or future pendant can
be another specialised body with a much narrower set of local capabilities.
Nodes and the remote Node protocol are architectural direction, not a claim that
those clients are implemented today.

The product ambition is to become the owner's primary interface to the digital
world and, where reliable sensors/actuators exist, the physical one. Success is
not the number of integrations. It is the number of direct interfaces the owner
no longer needs to operate **without losing control, understanding or the
ability to intervene**.

## Do · understand · be present

Muffin **does** real work, including long-running and multi-step work.

Muffin **understands** by accumulating evidence and beliefs with time,
provenance, contradiction and uncertainty rather than flattening everything into
"the owner said".

Muffin **is present**: unfinished work survives sessions and processes; it knows
what is still owed and can wait, resume, ask, revise, interrupt or stay silent.

Presence also means the input side stays alive while work is in progress. A
Surface should be able to receive later text, files, images or voice while Muffin
is already working; the runtime can then steer, collect, queue/follow up or
interrupt at a safe boundary instead of making conversation synonymous with a
blocking request/response call.

Presence does not mean activity. The old Muffin expressed an important product
property that survives the rebuild: **elapsed time alone is not a reason to
interrupt**. A proactive message should have something specific behind it — an
open thread, stalled intention, meaningful change, contradiction, due commitment
or work that genuinely needs the owner.

Likewise, a conversation Muffin says it will follow should not evaporate because
a session ended. Work state exists partly to **close loops**, not merely to make
crash recovery possible.

## Human-first means augmentation, not cognitive theatre

Muffin should make the owner **more capable without making the owner less
agentic**. It can carry memory, comparison, tracking, repeatable execution and
continuity that machines are well suited to carry; it must preserve the owner's
ability to judge, understand, correct, interrupt and take control.

This is a product hypothesis, not a claim that human + AI is automatically better
or that human cognition should be copied. Some ideas from cognitive science and
neuroscience may expose useful problems — prediction error, adaptive forgetting,
episodic versus semantic representation, attention limits — while their software
translation can still be wrong.

Muffin therefore treats cognitive mechanisms as falsifiable unless another
architectural/security reason makes the property independently necessary. The
current hypothesis registry, evidence statuses and kill criteria live in
`COGNITIVE-DESIGN.md`.

A useful failure is allowed to kill a beautiful cognitive story. The old Muffin's
context-blind proactive messages are exactly that kind of evidence: noticing a
long silence is not the same as understanding why the silence exists or earning
the right to interrupt.

## Continuity is portable meaning

Muffin's five current semantic planes are:

```text
Evidence · Beliefs · Work · Effects · Authority
```

See `ARCHITECTURE.md` for their present ownership boundaries.

Physical representation is not the identity of the substrate. Embeddings,
indexes, summaries, rankings and caches can be rebuilt. Evidence/provenance,
identity, unfinished work, effect uncertainty and constitutional authority must
survive replacement in semantic form.

A future canonical export/import format ("Muffin Capsule" is a working name)
should let a later Muffin on another Home host and another model continue without
pretending today's SQLite layout, device or embedding model is immortal.

Home migration is a concrete consumer of that promise: MacBook → VPS, VPS → Mac
Mini, or another owner-controlled deployment should be migration of one
continuity rather than a new agent.

## Cold start from the life that already exists

A new Muffin generation starts with fresh **native** memory (ADR-0049), but a new
owner does not have to pretend they have no digital history.

Where a service exposes appropriate access, Muffin should be able to connect to
it through a connector/API/standard adapter and ingest evidence with explicit
provenance. Where continuous access is unavailable or unwanted, Muffin should be
able to guide the owner through the platform's official export and import the
archive locally.

Examples include mail, calendars, contacts, photos, chat archives, browser
history, code history, health/fitness data and file archives.

The import contract is epistemic, not merely syntactic:

- source and original timestamp survive when known;
- import time is distinct from event time;
- archive ownership does not imply authorship;
- third-party mail/messages remain third-party evidence;
- imported material never pretends Muffin observed it live;
- derived summaries/embeddings can be rebuilt under the current generation.

This is different from automatically migrating the old Muffin database as native
memory. That predecessor remains optional legacy/archive material under ADR-0049.

## Autonomy grows by evidence, not familiarity

Knowing the owner better improves interpretation; it does not grant authority.

Supervision may compress only for a demonstrated capability/resource/context,
with observable successful history and an appropriate recovery path. Grants are
local, visible, revocable, time-bounded where useful and able to regress after a
failure.

There is no global "Muffin knows me now" trust score.

This applies across bodies too. Pairing a Node proves which device it is; it does
not make the Home omnipotent on that device. A Node may keep a non-bypassable
local ceiling and require physical/local approval for sensitive capabilities.

## Core narrow, capability opt-in

The base installation should remain a narrow continuity/authority core. Gmail,
Spotify, Home Assistant, browser automation, PII transforms, new messaging
platforms and niche workflows do not all belong in that trusted core.

**What the owner does not install should not exist in their Muffin.**

Community breadth comes through extensions whose package, capabilities and
requested authority are inspectable separately. The detailed direction lives in
`EXTENSIONS.md`.

This lets community growth increase usefulness without increasing the trusted
computing base at the same rate.

## A capable community ecosystem

A future Muffin catalog should make third-party capability easy to discover and
install without turning "listed publicly" into "trusted with the machine".

An extension can bundle multiple capability types — connector, importer, tool
provider, provider adapter, privacy transform, skill, hardware/Node bridge or
standard adapter — while the kernel still grants individual authority-bearing
capabilities separately.

The vision is closer to an OS permission model than a generic plugin folder:
users should understand what a package can read, write, send, spend, access on
the network and which secret references it needs before executing it.

## Many ports and bodies, one entity

Telegram is likely an excellent early mobile client because it already supplies
identity, notifications, media, private topics and evolving bot primitives. It
is not Muffin's identity.

Likewise, CLI, desktop control plane, browser, voice, speaker, pendant and future
sensors/actuators are ports or bodies around the same agent. They may have
different delivery/input and local execution capabilities; they may not fork the
person, memory, work or policy.

The distinction is deliberate:

```text
Surface = how I interact with Muffin
Node    = where Muffin can perceive / act / compute
```

A pendant is therefore a plausible future **Node + Surface**: microphone/wake or
push-to-talk on the input side, haptic/status and optionally speaker on the
output side, with a local authority ceiling appropriate to tiny personal
hardware. It should reuse the same Node grammar as a Mac or phone rather than
create a pendant-specific second agent.

The desktop/control UI should be the **cofano**, not a second conversational
product: health, model/provider, spending, work/waits/approvals, Nodes,
capabilities, backup/update and diagnostics when the owner needs to inspect or
govern the agent.

## Data sovereignty, not local-compute dogma

The owner controls durable continuity. Inference may be local or remote and may
run on the Home, on a Node or at a provider.

A cloud provider is both compute and a data recipient. A paired owner-controlled
Node is a different trust/locality relationship, not merely another spelling of
"remote". The long-term product should be able to express which information may
reach third-party cloud compute, which may move only between owner-controlled
hosts and which must remain on one host.

Optional local privacy transforms can reduce what reaches a cloud provider. A
PII detector such as Rizzo can be one adapter; it is not a universal privacy
guarantee and must never replace the structural secret boundary.

Local inference is a replaceable compute choice, not Muffin's identity. A model
already warm on a Mac Node may be preferable for some work; a frontier provider
may be preferable for another. The architecture should make placement observable
before it tries to optimise it automatically.

## Owner-run without developer UX

Self-hosted describes ownership, not an installation punishment.

The public product should support progressively simpler owner-run profiles:

```text
Desktop → home node/NAS → own VPS → future dedicated appliance
```

The Home location is deployment configuration. An always-on VPS can be the Home
while a personal Mac participates as a Node; a future Mac Mini or appliance can
later become the Home without creating a new Muffin.

A normal person should not need to understand Node.js, npm, SQLite,
launchd/systemd, wire protocols or token files to create and operate a standard
installation.

The same rule applies after installation. **Owner decision, 2026-09-07:** the
normal owner operates Muffin by talking to it, not by learning a command
vocabulary. Mechanics fall into four buckets — conversational (remember,
correct, forget, create a routine, show open work, connect or disable a
capability where authority allows), automatic (backups, migrations, indexing,
cleanup, safe recovery), explicit constitutional/recovery actions (pairing,
root-of-trust changes, authority widening, destructive recovery: the friction is
the boundary) and developer/operator interfaces (evals, traces, database
inspection, low-level lifecycle). Only the third bucket belongs in the normal
owner surface; a new command must say which bucket it is in and why it is not
conversational or automatic. Observability and recovery are never deleted to
achieve this.

Central project infrastructure may simplify download, updates, discovery, OAuth
bootstrap or Telegram provisioning. **It must not be necessary for an already
installed Muffin to retain identity, memory or work.**

## What we deliberately do not promise yet

The multi-body vision does not imply active-active distributed intelligence.
For the MVP direction there is one authoritative Home. Nodes may disconnect and
reconnect; they do not automatically elect themselves leader when the Home is
offline.

A future degraded local mode, replicated continuity, authority handoff or
multi-Home design is valid research only if real use justifies its distributed
systems cost.

Likewise, the existence of Nodes does not require microservices, a message
broker, a compute scheduler or one process per component. Logical topology and
process topology are intentionally separate.

## The roadmap question after DAY-1

During dogfood, the most useful product question is:

> **Which part of my digital life am I still forced to manage directly?**

Every observed fallback to Gmail, a browser, calendar UI, another agent or a
manual tool is stronger roadmap evidence than a speculative feature list.

Presence adds two more:

> **What work did Muffin say it would follow and then forget?**
>
> **How often did Muffin interrupt without having something specific to say?**

Cognitive design adds another:

> **Which mechanism actually made me more capable, and which one merely made
> Muffin feel more clever?**

And the multi-body direction adds a placement question:

> **Which useful thing could Muffin not do because the capability or data lived
> on the wrong device?**

Those observations should drive post-DAY-1 capability, Node and cognitive work.

## Public success condition

Before product public alpha, Muffin must be understandable by someone who did not help
build it: installable, diagnosable, updateable, recoverable and explicit about
its authority boundaries. Contributors should be able to extend useful breadth
without needing to understand or modify the core.

The route is not "find co-maintainers before the product exists". It is:

```text
owner DAY-1 → source-public/pre-alpha (contributions welcome; not product alpha)
→ 14-day dogfood → small trusted alpha → product public alpha
→ community breadth → maintainership is earned through observed work
```

`ROADMAP.md` owns phase placement for deliberate deferrals;
`OPEN-SOURCE-STRATEGY.md` owns the distribution/community path;
`PUBLIC-NARRATIVE.md` owns how current versus historical claims are presented to
people and machine-readable public docs.
