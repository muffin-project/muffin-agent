# Repository knowledge model

This repository is the system of record for Muffin, but **not every file has the
same kind of authority**. The fastest way to create drift is to let an ADR, an
audit, a generated map and the runtime all answer the same question.

The rule is simple:

> **One fact, one authoritative home. Everything else links to it, explains why
> it exists, records evidence, or is generated from it.**

This page is the current authority map. If tooling later needs a machine-readable
registry, add it only together with the checker/generator that consumes it; an
unused manifest would be another source of drift.

## Start from the question

| Question | Authority |
|---|---|
| What does the system literally do or accept? | Executable code, schemas and shipped config; tests/evals are evidence that the path is exercised. |
| Why does Muffin exist? | `docs/THESIS.md` |
| How is Muffin shaped now? | `docs/ARCHITECTURE.md` |
| What security boundary does Muffin claim now? | `docs/SECURITY.md` |
| How should design choices be made? | `docs/DESIGN-PRINCIPLES.md` |
| Why was an architectural choice made? | The relevant ADR in `docs/blueprint/adr/` |
| What makes DAY-1 true? | `docs/blueprint/gate1/MANDATO-DAY-1.md` |
| Is a DAY-1 requirement currently satisfied? | `docs/blueprint/M5-BIS.md` |
| In which order do remaining Gate blockers get attacked? | `docs/blueprint/gate1/PERCORSO-CRITICO.md` |
| What work is active right now? | Observed Git/PR state first, then `docs/blueprint/LAVORO.md` as the handoff. |
| How is repository work orchestrated and verified? | `docs/ORCHESTRATION.md`, with `BRANCHING.md`, `JUDGE.md` and `PRACTICES.md` for their scoped concerns. |
| What evidence informed a decision? | `docs/blueprint/research/`, audits and `docs/lessons.md` |
| What did the project believe or do at an earlier point? | History/legacy material; never a claim about HEAD |
| What does a generated map show? | `docs/mappa/`; a view, never an independent source of truth |

There is no universal "Markdown beats code" or "latest file wins" rule. Authority
is **typed by question**.

## The six document roles

### 1. Current authority

A small set of documents owns current semantics that cannot sensibly live in a
type or config file: thesis, architecture, security, design principles, Gate
contract and engineering workflow.

Current authority documents must:

- describe semantics, boundaries and ownership rather than copy implementation;
- link to executable sources for volatile mechanics;
- avoid PR numbers, transient branch names and handoff history unless the
  document's job is explicitly operational;
- be corrected when the promise changes.

### 2. Executable authority

Code, database schemas, typed contracts, shipped configuration and workflow
files own mechanical facts. Examples: the current `paramsMaxTaint` value belongs
in `defaults/rot/policy.json`; the database shape belongs in its schema/migration
code; CI behaviour belongs in `.github/workflows/`.

A prose document may explain **why** a value or shape exists. It must not become
a second editable copy of the same fact.

### 3. Decision history

ADRs own **why a decision was taken**, its alternatives and consequences. They
do not own whether HEAD still implements every line in the ADR.

An ADR is historical evidence once written. A material reversal should create a
new ADR that supersedes or amends the old one instead of repeatedly rewriting
history until the original decision is unreadable.

### 4. Evidence

Research, audits, critiques and lessons answer "what did we observe, compare or
learn?" They are dated snapshots. They may justify a current decision but do not
become current architecture by proximity or detail.

Do not "refresh" an old audit into current state. Record the new evidence or
change the current authoritative document.

### 5. Operational state

Operational state is deliberately small and disposable. `LAVORO.md` may name the
current objective, live PR/slice, immediate blockers, owner decisions and next
action. It must be possible to delete it without losing product knowledge.

Observed Git state wins over an operational handoff when they disagree.

### 6. Derived views

Maps, generated indexes, status counts and other projections are outputs. Their
job is navigation, not authority. If a value cannot be generated reliably from
its authoritative source, prefer omitting the value to maintaining a manual
copy that can drift.

## Progressive disclosure

Agents and humans should start with a map, not a manual.

- Root `AGENTS.md` and `CLAUDE.md` are routers, not encyclopedias.
- Global semantics live in the small authority set above.
- Domain-specific detail should live close to the domain and be loaded when the
  task makes it relevant.
- Research and history are opt-in context, not startup context.

A future scoped document may declare a `read_when`/scope hint, but the hint only
controls discoverability. It does not raise that document's authority.

## Transition rule

The repository predates this knowledge model. During the documentation refactor,
several files under `docs/blueprint/` still look current while actually mixing
historical design, current promises and operational state.

Until they are reclassified:

- `docs/blueprint/STATE.md` is a project chronicle, **not** authoritative current
  state;
- `docs/blueprint/09-contratti-m0-m1.md` is rebuild-era design material, **not**
  mechanical authority over code/schema/config;
- `docs/blueprint/03-threat-model.md` is the historical threat-model lineage;
  `docs/SECURITY.md` owns the current security map;
- `docs/blueprint/04-roadmap.md` records the rebuild plan and historical gates;
  current DAY-1 status lives only in the Gate documents named above.

Nothing is deleted merely because it lost authority. Knowledge moves to history
only after any still-live decision has an explicit current home.

## A change is complete when its authoritative home is not stale

Do not update every document "for consistency". Update the one authoritative
home whose meaning changed, plus any generated view that is mechanically derived
from it. If a change only supplies new evidence for an unchanged decision, keep
that evidence in the evidence layer.

This is the documentation equivalent of the runtime rule already used across
Muffin: **one guarantee, one owner.**
