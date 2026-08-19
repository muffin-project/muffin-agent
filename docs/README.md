# Repository knowledge model

This repository is the system of record for Muffin, but **not every file has the
same kind of authority**. The fastest way to create drift is to let an ADR, an
audit, a product vision, a generated map and the runtime all answer the same
question.

The rule is simple:

> **One fact, one authoritative home. Everything else links to it, explains why
> it exists, records evidence/history, or is generated from it.**

This page is the current authority map. If tooling later needs a machine-readable
registry, add it only together with the checker/generator that consumes it; an
unused manifest would be another source of drift.

## Start from the question

| Question | Authority |
|---|---|
| What does the system literally do or accept? | Executable code, schemas and shipped config; tests/evals are evidence that the path is exercised. |
| Why does Muffin exist? | `docs/THESIS.md` |
| Where is the product trying to go? | `docs/VISION.md` |
| How is Muffin shaped now? | `docs/ARCHITECTURE.md` |
| What security boundary does Muffin claim now? | `docs/SECURITY.md` |
| How should design choices be made? | `docs/DESIGN-PRINCIPLES.md` |
| How should installable capability grow around the core? | `docs/EXTENSIONS.md` |
| How should the owner-run project become public/community-maintained? | `docs/OPEN-SOURCE-STRATEGY.md` |
| How do public/current/historical claims stay honest outside this repo? | `docs/PUBLIC-NARRATIVE.md` |
| Why was an architectural choice made? | The relevant ADR in `docs/blueprint/adr/` |
| What makes DAY-1 true? | `docs/blueprint/gate1/MANDATO-DAY-1.md` |
| Is a DAY-1 requirement currently satisfied? | `docs/blueprint/M5-BIS.md` |
| In which order do remaining Gate blockers get attacked? | `docs/blueprint/gate1/PERCORSO-CRITICO.md` |
| What work is active right now? | Observed Git/PR state first, then `docs/blueprint/LAVORO.md` as the handoff. |
| How is repository work orchestrated and verified? | `docs/ORCHESTRATION.md`, with `BRANCHING.md`, `JUDGE.md` and `PRACTICES.md` for their scoped concerns. |
| What evidence informed a decision? | `docs/blueprint/research/`, audits and `docs/lessons.md` |
| What did the project believe or do at an earlier point? | `docs/history/` and rebuild-era material; never a claim about HEAD |
| What does a generated map show? | `docs/mappa/`; a view, never an independent source of truth |

There is no universal "Markdown beats code" or "latest file wins" rule. Authority
is **typed by question**.

## Current authority is intentionally small

Global current documents own different questions:

```text
THESIS          why
VISION          product destination
ARCHITECTURE    current semantic shape
SECURITY        current trust/security boundaries
DESIGN          decision compass
```

Scoped current design documents such as `EXTENSIONS.md` are loaded only when
that domain matters. Product/distribution/public-narrative strategy does not
become runtime truth simply because it is current strategy.

Current authority documents must:

- describe semantics, boundaries and ownership rather than copy implementation;
- link to executable sources for volatile mechanics;
- avoid PR numbers, transient branch names and handoff history unless the
  document's job is explicitly operational;
- distinguish **current** from **planned** instead of making vision sound shipped;
- be corrected when the promise itself changes.

## Executable authority

Code, database schemas, typed contracts, shipped configuration and workflow
files own mechanical facts. Examples: the current `paramsMaxTaint` value belongs
in `defaults/rot/policy.json`; the database shape belongs in its schema/migration
code; CI behaviour belongs in `.github/workflows/`.

A prose document may explain **why** a value or shape exists. It must not become
a second editable copy of the same fact.

## Decision history

ADRs own **why a decision was taken**, its alternatives and consequences. They
do not own whether HEAD still implements every line in the ADR.

An ADR is historical evidence once written. A material reversal should create a
new ADR that supersedes/amends the old one instead of repeatedly rewriting
history until the original decision is unreadable.

## Evidence

Research, audits, critiques and lessons answer "what did we observe, compare or
learn?" They are dated snapshots. They may justify a current decision but do not
become current architecture by proximity or detail.

Do not "refresh" an old audit into current state. Record new evidence or change
the current authoritative document.

## Operational state

Operational state is deliberately small and disposable. `LAVORO.md` may name the
current objective, live PR/slice, immediate blockers, owner decisions and next
action. It must be possible to delete it without losing product knowledge.

Observed Git state wins over an operational handoff when they disagree.

## Derived views

Maps, generated indexes, status counts and other projections are outputs. Their
job is navigation, not authority. If a value cannot be generated reliably from
its authoritative source, prefer omitting the value to maintaining a manual
copy that can drift.

## Progressive disclosure

Agents and humans should start with a map, not a manual.

- Root `AGENTS.md` and `CLAUDE.md` are routers, not encyclopedias.
- Global semantics live in the small authority set above.
- Domain-specific detail is loaded when the task makes it relevant.
- Product strategy is not required to fix a runtime bug unless it changes the
  product claim being implemented.
- Research and history are opt-in context, not startup context.

A scoped document may eventually declare a `read_when`/scope hint if tooling
uses it. A hint controls discoverability, not authority.

## Rebuild-era material

`docs/blueprint/README.md` classifies the mixed-generation blueprint directory.
The root 00–12 rebuild corpus, old threat model/roadmap/contracts, BRIEF,
critique and contract validation are lineage/evidence, not current mechanics.

`docs/blueprint/STATE.md` is now a tombstone; its full chronicle is preserved in
`docs/history/rebuild-2026/STATE-chronicle.md`.

Historical files are not being mass-moved while unresolved ADR/code references
may point to their paths. Stable lineage is more valuable than folder aesthetics.

## A change is complete when its authoritative home is not stale

Do not update every document "for consistency". Update the one authoritative
home whose meaning changed, plus any mechanically derived view that depends on
it. If a change only supplies new evidence for an unchanged decision, keep that
evidence in the evidence layer.

This is the documentation equivalent of the runtime rule already used across
Muffin: **one guarantee, one owner.**
