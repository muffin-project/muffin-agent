# Repository knowledge model

This repository is the system of record for Muffin, but **not every file has the
same kind of authority**. The fastest way to create drift is to let an ADR, an
audit, a product vision, a generated view and the runtime all answer the same
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
| Which cognitive/human hypotheses is Muffin exploring, with what evidence status and kill criteria? | `docs/COGNITIVE-DESIGN.md` |
| In which phase should a deliberately deferred capability be reconsidered? | `docs/ROADMAP.md` |
| How is Muffin shaped now? | `docs/ARCHITECTURE.md` |
| How is long-running model/tool execution bounded and made observable? | `docs/EXECUTION.md` |
| What security boundary does Muffin claim now? | `docs/SECURITY.md` |
| How should design choices be made? | `docs/DESIGN-PRINCIPLES.md` |
| How is Muffin installed, updated and rolled back on a real machine? | `install.sh`, with `docs/INSTALL.md` for what it does and why |
| How should installable capability grow around the core? | `docs/EXTENSIONS.md` |
| How should the owner-run project become public/community-maintained? | `docs/OPEN-SOURCE-STRATEGY.md` |
| How do public/current/historical claims stay honest outside this repo? | `docs/PUBLIC-NARRATIVE.md` |
| Why was an architectural choice made? | The relevant ADR in `docs/decisions/` |
| What makes DAY-1 true? | `docs/work/day1/readiness-criteria.md` |
| Is a DAY-1 requirement currently satisfied? | `docs/work/day1/requirements-status.md` |
| In which order do remaining DAY-1 blockers get attacked? | `docs/work/day1/critical-path.md` |
| What work is active right now? | Observed Git/PR state first, then `docs/work/handoff.md` as the handoff. |
| How is repository work orchestrated and verified? | `docs/ORCHESTRATION.md`, with `BRANCHING.md`, `JUDGE.md` and `PRACTICES.md` for their scoped concerns. |
| What evidence informed a decision? | `docs/evidence/`, audits and `docs/evidence/lessons.md` |
| What did the project believe or do at an earlier point? | `docs/history/` and rebuild-era material; never a claim about HEAD |

There is no universal "Markdown beats code" or "latest file wins" rule. Authority
is **typed by question**.

## Current authority is intentionally small

Global current documents own different questions:

```text
THESIS             why
VISION             product destination
COGNITIVE DESIGN   falsifiable human/cognitive hypotheses
ROADMAP            phase placement of deliberate deferrals
ARCHITECTURE       current semantic shape
SECURITY           current trust/security boundaries
DESIGN             decision compass
```

`COGNITIVE-DESIGN.md` is intentionally **not** runtime truth. It owns the status
of hypotheses and their falsification criteria. A mechanism may be shipped while
still marked experimental; robust external science may still map to a rejected
Muffin product idea.

`ROADMAP.md` owns **phase placement only**. It does not own whether a DAY-1 row is
READY/BLOCKER, the next implementation slice, or whether an item is already
shipped. Those questions stay with the DAY-1 requirements, the critical path, Git and executable
authority respectively.

Scoped current design documents such as `EXECUTION.md` and `EXTENSIONS.md` are
loaded only when that domain matters. Product/distribution/public-narrative
strategy does not become runtime truth simply because it is current strategy.

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

The same rule applies to cognitive research. A paper can support the existence of
a human phenomenon without proving a Muffin implementation is useful; legacy
Muffin can provide negative product evidence even when the underlying science is
sound.

## Operational state

Operational state is deliberately small and disposable. `docs/work/handoff.md` may name the
current objective, live PR/slice, immediate blockers, owner decisions and next
action. It must be possible to delete it without losing product knowledge.

Observed Git state wins over an operational handoff when they disagree.

## Derived views

Generated indexes, status counts and other projections are outputs. Their job is
navigation, not authority. If a value cannot be generated reliably from its
authoritative source, prefer omitting the value to maintaining a manual copy
that can drift.

The old generated architecture map was deliberately retired and deleted. There
is **no current architecture-map artifact or regeneration command** to consult.
Architecture navigation starts from this authority table and
`docs/ARCHITECTURE.md`; historical versions remain recoverable from Git. A live
document that points to the retired artifact is stale by definition.

## A name is the first thing read

> **Semantic name = primary identity. Opaque ID = optional stable handle.**
>
> A durable artifact or requirement must be understandable without decoding its
> historical or ordinal identifier.

A path and a filename are read before anything inside them, and they are read by
people and agents who do not know this project's history. `M5-BIS.md`, `gate1/`
and `MANDATO-DAY-1.md` failed that test: each needed a sentence of the form «X
means Y» before it could be used, and that sentence is a cost paid on every
read. If a name needs one, it is probably the wrong name.

The rule reaches prose, not just filenames. A comment that says «requirement B5»
and nothing else asks the reader to go look B5 up; the same comment that says
what B5 *is* does not. The opaque id may stay where a machine needs a stable
key — `manifest.ts` binds acceptance scenarios to `A1`…`E7`, and `report.ts`
parses them back out of test titles — but it is never the whole of what a human
sentence says.

Historical identifiers remain in Git, `docs/history/` and dated records, where
they are how those documents actually referred to things. They are not the
canonical identity of anything current.

## Progressive disclosure

Agents and humans should start with a map, not a manual.

- Root `AGENTS.md` and `CLAUDE.md` are routers, not encyclopedias.
- Global semantics live in the small authority set above.
- Domain-specific detail is loaded when the task makes it relevant.
- `EXECUTION.md` is loaded for model/tool loop lifetime, timeout/retry ownership,
  runtime progress/stagnation or reasoning-budget questions.
- `COGNITIVE-DESIGN.md` is loaded when a task proposes or evaluates a cognitive
  mechanism, person-model behaviour, memory salience/decay or proactivity claim.
- `ROADMAP.md` is loaded when the question is when a deliberate deferral should
  be reconsidered, not as a substitute for current DAY-1 or Git state.
- Product strategy is not required to fix a runtime bug unless it changes the
  product claim being implemented.
- Research and history are opt-in context, not startup context.

A scoped document may eventually declare a `read_when`/scope hint if tooling
uses it. A hint controls discoverability, not authority.

## Rebuild-era material

The 00–12 rebuild corpus, the old threat model/roadmap/contracts, `BRIEF`,
`critique/` and the contract validation were archived on 2026-08-31 to
`docs/history/rebuild-2026/`. They are lineage/evidence, never current mechanics.
The inherited foundations corpus went to `docs/history/foundations/legacy/`.
`docs/history/README.md` carries the old path → current home map.

The architectural decisions moved to `docs/decisions/` and the durable cognitive
corpus to `docs/knowledge/`: neither is history, and neither needed the blueprint
name to be found. The dated evidence went to `docs/evidence/` and the design
lineage to `docs/history/design-notes/`. A generated architecture projection
existed for a period of the rebuild and was later removed once it stopped
earning its maintenance cost; Git preserves that lineage rather than a live
compatibility path pretending it still exists.

`docs/blueprint/` and `docs/foundations/` **no longer exist**. Both had shrunk to
a single compatibility redirect, and on 2026-09-01 both were removed. The retired
`docs/blueprint/STATE.md` chronicle is preserved byte-for-byte at
`docs/history/rebuild-2026/STATE-chronicle.md`, and the inherited foundations are
under `docs/history/foundations/`. A deleted path is not a lost path — Git keeps
the rename, and `docs/history/README.md` carries the map. Nothing current points
at either namespace, which is the condition that let them go.

## A change is complete when its authoritative home is not stale

Do not update every document "for consistency". Update the one authoritative
home whose meaning changed, plus any mechanically derived view that depends on
it. If a change only supplies new evidence for an unchanged decision, keep that
evidence in the evidence layer.

This is the documentation equivalent of the runtime rule already used across
Muffin: **one guarantee, one owner.**