# Public narrative and external surfaces

This document owns **how Muffin distinguishes current, planned and historical
claims outside the private repository**. It is not final marketing copy.

The need exists already: `muffin-public-docs`, `giusto.dev` and machine-readable
surfaces such as `llms.txt` are being used by people and agents to learn what
Muffin is, while those surfaces still describe much of the H1 2026 architecture.

## 1. Do not rewrite history into the present

The old public material is valuable precisely because it shows how the project
thought before the rebuild: awareness loop, Predictor/Scheduler/Decider, dream
cycle, living profile/counterpoint/self-narrative, older memory layers and the
older "dataset is the moat" framing.

Do not silently overwrite those documents as if the project had always believed
the current thesis.

Prefer a public split such as:

```text
Current / vNext
Historical / H1 2026
```

or an unmissable historical banner on the existing corpus.

## 2. Claims that must migrate

### Moat

Old: the accumulated dataset is the unique durable advantage.

Current: **quality, ownership and portability of personal continuity** — history,
provenance, corrections, work, effects and authority that survive provider,
model, surface and machine replacement.

### Incumbents

Old: a large vendor structurally cannot know the owner as deeply.

Current: vendors may know enormous amounts. Muffin's stronger claim is that the
owner controls continuity and can take it across vendors.

### Capability

Old framing sometimes positioned Muffin against "productivity assistant" work.

Current: Muffin is not a productivity optimizer as identity, but real mail,
calendar, browser, file and process work is absolutely part of the vision when
it removes direct interfaces without losing control or point of view.

### Local compute

Old: fully local inference as the destination.

Current: **data sovereignty + local-capable + explicit provider egress**. An
owner may deliberately use frontier cloud compute; Muffin should make the data
boundary inspectable and preserve a path to local compute.

### Cognitive mechanisms

Old: dream cycle/awareness loop mechanisms read like the architecture itself.

Current: those are historical implementations/experiments. Durable product
properties are continuity, useful understanding, closed loops, provenance,
work/effects/authority and calibrated presence. The mechanism may change.

The public language should be **human-first, not neuroscience-certified**.
Prefer:

> Muffin borrows ideas from cognitive science and neuroscience when they expose
> useful problems or constraints, then tests the software interpretation against
> real use.

Avoid:

> Muffin is neuroscience-based / brain-inspired, therefore it understands you
> better.

The latter turns analogy into authority and makes removing a failed mechanism
look like abandoning the product. `COGNITIVE-DESIGN.md` owns the current
hypothesis/evidence status.

Public cognitive examples may deliberately include ideas that are still
experimental — prediction error, absence as signal, adaptive forgetting,
importance versus frequency — but their maturity must be legible. A compelling
idea is allowed to fail.

### Release readiness

Old: open source after the personality/narrative is mature enough.

Current: owner DAY-1 → source-public/pre-alpha (inspectable and contributable;
not product alpha) → 14-day real use → trusted alpha → product public alpha
when install/update/recovery/security boundaries are understandable to an
outsider. Voice remains important; it is not the only release gate.

## 3. Root README contract — structure before copy

The root README is the first public pitch and the first navigation layer. It must
work for a general reader before asking them to understand the architecture.
Technical depth should be progressively disclosed through short sections,
diagrams and `<details>` blocks rather than front-loaded.

The currently chosen flow is:

```text
Muffin hero
  ↓
What is Muffin?
  ↓
Built around the human
  ↓
Some unusual ideas behind Muffin
  ↓
One agent · continuous life
  ↓
Evidence · Beliefs · Work · Effects · Authority
  ↓
What it feels like
  ↓
What works today
  ↓
Run your Muffin
  ↓
Capabilities / extensions + owner control
  ↓
Technical depth for the curious
  ↓
Roadmap + community
```

### Hero direction

The emotional/semantic north star is:

> **A personal agent built to make you more capable, not more dependent.**

Candidate supporting language:

> Muffin remembers what matters, notices what changes, and acts across time —
> while you stay in control.

`personal agent` is intentionally understandable rather than a new category
name. Differentiation should arrive in the next sentence through continuity,
human-first design and owner control, not through invented terminology.

Avoid putting Telegram, SQLite, MCP or a specific model in the hero. They are
replaceable ports/implementation.

### Built around the human

The README should explain complementarity without claiming a scientific division
of labour:

```text
owner
  ├─ goals / values / judgement / changing their mind
  │
  └──────── works with ────────┐
                               │
Muffin                         │
  ├─ continuity               │
  ├─ tracking                 │
  ├─ remembering commitments  │
  ├─ comparison               │
  └─ delegated action         │
                               ▼
                    more capable owner
                    who remains in control
```

This is product framing, not a neuroscience diagram.

### Some unusual ideas behind Muffin

A visually memorable card/grid section can expose the cognitive lineage:

```text
Absence can be data       Importance ≠ frequency
Forgetting can be useful  Memory is evidence, not truth
Silence is an action      Understanding ≠ authority
Prediction → outcome → learn from the difference
```

The heading should say **ideas**, not guarantees. Each card may link to
`COGNITIVE-DESIGN.md`, where its grounding and Muffin evidence are explicit.

Do not use old mechanisms (`dream cycle`, Predictor/Scheduler/Decider, living
profile) as the card titles. The property/problem may survive while the old
implementation is historical.

### What it feels like

This section must be tested against real Muffin behaviour before public alpha.
Draft micro-scenarios are allowed while the repo is private, but they cannot
become fabricated testimonials or imply a shipped feature.

The best examples should reveal multiple properties at once, such as:

- preserving who actually said something rather than flattening imported data;
- keeping a commitment alive across sessions;
- noticing a meaningful change without treating every silence as an
  interruption;
- explaining why an action needs authority and whether it is reversible;
- changing a belief after evidence changes instead of protecting a stale profile.

Before public alpha, every scenario should be reproducible against the real
product or explicitly labelled conceptual.

### Technical depth

The public/general path stays concise. Curious readers can expand/link into:

- architecture and the five semantic planes;
- cognitive design and evals;
- provenance/taint/security;
- durable work/effects;
- extensions/capabilities;
- deployment and self-hosting trade-offs.

The README should not duplicate those documents.

## 4. Update the external graph together

A public narrative change is incomplete if it updates only one visible page.
When the current story is ready to publish, reconcile at least:

- root repository README;
- `muffin-public-docs` README and affected chapters;
- public roadmap/FAQ;
- `giusto.dev` Muffin project page;
- Home/About/project cards that repeat claims;
- `llms.txt`;
- `llms-full.txt` where present;
- metadata/structured data/SEO;
- links back to the current public source of truth.

Machine-readable documentation is part of the public product surface. A crawler
repeating a stale architecture is the same category of problem as a human reader
doing it.

## 5. Use explicit maturity and evidence labels

Public product documents should distinguish where relevant:

```text
CURRENT
DOGFOOD
EXPERIMENTAL
PLANNED
HISTORICAL
```

Cognitive claims need an additional distinction: external scientific grounding
is not the same axis as Muffin product evidence. Do not collapse
`externally grounded` into `supported in Muffin`.

A product vision can be ambitious; a current-runtime claim must be grounded.

The repo's own authority rule applies externally too:

> **a documented decision does not prove the runtime implements it.**

## 6. Public docs are a community asset, not only marketing

The fact that people already analyze Muffin's documents before the code is public
is useful distribution.

The public corpus can become:

- a research/design history;
- an explanation of architectural choices;
- a source of contributors already interested in the problem;
- a bridge to trusted alpha;
- a place to publish continuity/security/cognitive eval methodology;
- a record of ideas that were tried and superseded.

An unusual advantage of publishing the lineage is that failed cognitive ideas
can remain visible with their evidence instead of disappearing from marketing.
That makes the project more falsifiable and gives contributors a reason not to
reintroduce an attractive mechanism whose failure was already paid for.

Do not erase the old ideas to make the current project look cleaner. Make their
status legible.

## 7. Timing

Do not chase every private DAY-1 edit across public sites in real time.

Preferred sequence:

1. private repo establishes stable current authority and the README structure;
2. owner reaches DAY-1 and begins real dogfood;
3. README micro-scenarios and cognitive claims are tested against actual use;
4. wording/examples are revised from evidence, including removing ideas that did
   not earn their place;
5. before trusted alpha, update public docs + `giusto.dev` coherently;
6. before public alpha, current/historical/experimental labels and source links
   are reliable for both humans and machine-readable consumers.

This keeps the public layer fresh enough to be honest without turning every
private slice into a marketing migration.
