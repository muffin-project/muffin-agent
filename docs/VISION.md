# Muffin — Vision

This document owns **where the product is trying to go**. `THESIS.md` owns why
Muffin is worth building; `ARCHITECTURE.md` describes the current semantic shape;
`M5-BIS.md` owns the immediate DAY-1 proof state.

The vision is allowed to be ahead of the runtime. When it is, it must say so
instead of making a future capability sound current.

## One agent, many replaceable bodies

Muffin becomes one continuous personal agent that the owner runs under their
control. It is not a chat, device, app, process or model. Those are ports and
compute around the same continuity.

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

Presence does not mean activity. The old Muffin expressed an important product
property that survives the rebuild: **elapsed time alone is not a reason to
interrupt**. A proactive message should have something specific behind it — an
open thread, stalled intention, meaningful change, contradiction, due commitment
or work that genuinely needs the owner.

Likewise, a conversation Muffin says it will follow should not evaporate because
a session ended. Work state exists partly to **close loops**, not merely to make
crash recovery possible.

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
should let a later Muffin on another machine and another model continue without
pretending today's SQLite layout or embedding model is immortal.

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
provider, provider adapter, privacy transform, skill or standard adapter — while
the kernel still grants individual authority-bearing capabilities separately.

The vision is closer to an OS permission model than a generic plugin folder:
users should understand what a package can read, write, send, spend, access on
the network and which secret references it needs before executing it.

## Many ports, one entity

Telegram is likely an excellent early mobile client because it already supplies
identity, notifications, media, private topics and evolving bot primitives. It
is not Muffin's identity.

Likewise, CLI, desktop control plane, browser, voice, speaker, pendant and future
sensors/actuators are ports. They may have different delivery/input capabilities;
they may not fork the person, memory, work or policy.

The desktop/control UI should be the **cofano**, not a second conversational
product: health, model/provider, spending, work/waits/approvals, capabilities,
backup/update and diagnostics when the owner needs to inspect or govern the
agent.

## Data sovereignty, not local-compute dogma

The owner controls durable continuity. Inference may be local or remote.

A cloud provider is both compute and a data recipient. The long-term product
should be able to express which information may reach cloud compute and which
must stay local, and optionally apply local privacy transforms before a cloud
provider. A PII detector such as Rizzo can be one adapter; it is not a universal
privacy guarantee and must never replace the structural secret boundary.

## Owner-run without developer UX

Self-hosted describes ownership, not an installation punishment.

The public product should support progressively simpler owner-run profiles:

```text
Desktop → home node/NAS → own VPS → future dedicated appliance
```

A normal person should not need to understand Node, npm, SQLite, launchd/systemd
or token files to create and operate a standard installation.

Central project infrastructure may simplify download, updates, discovery, OAuth
bootstrap or Telegram provisioning. **It must not be necessary for an already
installed Muffin to retain identity, memory or work.**

## The roadmap question after DAY-1

During dogfood, the most useful product question is:

> **Which part of my digital life am I still forced to manage directly?**

Every observed fallback to Gmail, a browser, calendar UI, another agent or a
manual tool is stronger roadmap evidence than a speculative feature list.

Presence adds two more:

> **What work did Muffin say it would follow and then forget?**
>
> **How often did Muffin interrupt without having something specific to say?**

Those observations should drive post-DAY-1 capability and cognitive work.

## Public success condition

Before a public alpha, Muffin must be understandable by someone who did not help
build it: installable, diagnosable, updateable, recoverable and explicit about
its authority boundaries. Contributors should be able to extend useful breadth
without needing to understand or modify the core.

The route is not "find co-maintainers before the product exists". It is:

```text
owner DAY-1 → 14-day dogfood → small trusted alpha → public alpha
→ contributors emerge → maintainership is earned through observed work
```

`OPEN-SOURCE-STRATEGY.md` owns that distribution/community path;
`PUBLIC-NARRATIVE.md` owns how current versus historical claims are presented to
people and machine-readable public docs.