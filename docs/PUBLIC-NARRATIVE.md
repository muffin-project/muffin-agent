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

### Release readiness

Old: open source after the personality/narrative is mature enough.

Current: owner DAY-1 → 14-day real use → trusted alpha → public alpha when
install/update/recovery/security/contributor boundaries are understandable to an
outsider. Voice remains important; it is not the only release gate.

## 3. Update the external graph together

A public narrative change is incomplete if it updates only one visible page.
When the current story is ready to publish, reconcile at least:

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

## 4. Use explicit maturity labels

Public documents should distinguish:

```text
CURRENT
DOGFOOD
EXPERIMENTAL
PLANNED
HISTORICAL
```

A product vision can be ambitious; a current-runtime claim must be grounded.

The repo's own authority rule applies externally too:

> **a documented decision does not prove the runtime implements it.**

## 5. Public docs are a community asset, not only marketing

The fact that people already analyze Muffin's documents before the code is public
is useful distribution.

The public corpus can become:

- a research/design history;
- an explanation of architectural choices;
- a source of contributors already interested in the problem;
- a bridge to trusted alpha;
- a place to publish continuity/security eval methodology;
- a record of ideas that were tried and superseded.

Do not erase the old ideas to make the current project look cleaner. Make their
status legible.

## 6. Timing

Do not chase every private-Gate edit across public sites in real time.

Preferred sequence:

1. private repo establishes stable current authority;
2. owner reaches DAY-1 and begins real dogfood;
3. wording/examples are tested against the actual product during the 14 days;
4. before trusted alpha, update public docs + `giusto.dev` coherently;
5. before public alpha, current/historical/experimental labels and source links
   are reliable for both humans and machine-readable consumers.

This keeps the public layer fresh enough to be honest without turning every
private slice into a marketing migration.