# Evidence

This directory owns one question:

> **what did we observe, measure, compare, audit or learn?**

Nothing here is current authority. A document does not govern HEAD because it is
detailed, because it is recent, or because it is the only place a subject is
discussed at length. Current architecture lives in `docs/ARCHITECTURE.md`,
current security in `docs/SECURITY.md`, decisions in `docs/decisions/`, and the
state of current work in `docs/work/`.

Evidence **justifies** a current decision. It never becomes one by sitting here.

## What is not evidence

A **proposal** is not. Observing, measuring, comparing, auditing and learning are
all backward-looking; a proposal is forward-looking, and a document that says
«do not add that column» or «acceptance tests required before merge» is giving
instructions, not reporting.

Proposal is a **lifecycle state, not a document class**. Whatever stays live in a
proposal has a current owner — an ADR, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`.
Once promoted, implemented, superseded, rejected or distilled, the dated artifact
becomes design lineage and moves to `docs/history/design-notes/`. There is no
permanent proposals layer in this repository, and `docs/blueprint/proposals/` was
removed in 2026-08 precisely because the routine it implied never ran.

Also not here: generated or derived views, product vision, and operational
state. No generated architecture map is currently checked in; use
`docs/ARCHITECTURE.md` and executable sources instead.

## Freshness: evidence is faithful to the observation, not to HEAD

This is the rule that makes the corpus readable years later, and the one most
often broken by good intentions:

> **A document here is not updated to make it true again.**

Its claims are true *of the moment it was written*, against the commit, database
or external source it names. When the world moves on, the document does not
follow it — the current authority does. Rewriting a snapshot to match today
destroys the only thing it was keeping: what we believed, and on what basis,
before we knew better.

Two consequences worth stating, because the corpus already relies on both:

- a correction to a snapshot is recorded **beside** it, not inside it —
  `information-architecture-audit-2026-08-19-errata.md` corrects
  `information-architecture-audit-2026-08-19.md` without touching it;
- a document that has been overtaken says so in its own banner and keeps its
  conclusions. Read `riconciliazione-requisiti-day1-2026-08-22.md`, the two
  `runtime-topology-*` files or `repository-wide-reconciliation-2026-08-22.md`
  as lists of work and you will redo things that closed weeks ago.

## The lifecycles actually present here

Observed in the corpus, not postulated for it. They are not sub-directories: the
distinction is in how you should read a file, not in where it sits.

| Kind | What it is faithful to | Example |
|---|---|---|
| external scout | sources open on a stated date | `prior-art-agenti-personali-e-harness.md` |
| peer comparison | the peer repositories at named commits | `confronto-harness.md`, `system-prompt-architecture.md` |
| internal audit | this repository at a named commit | `core-architecture-audit-2026-08-18.md` |
| runtime measurement | a real `~/.muffin`, database or trace | `cache-prompt-2026-08-26.md`, `dogfood-autonomia-2026-08-29.md` |
| reconciliation | a repository pass already declared superseded | `riconciliazione-requisiti-day1-2026-08-22.md` |
| rolling compendium | each entry to the observation that produced it | `lessons.md` |

A dated filename is common here but is not a rule: many documents carry their
date inside instead. Neither form makes a document more or less authoritative.

### Role is not lifecycle

`lessons.md` is the one file here that keeps growing, and that does not make it
current authority. **An epistemic role and a lifecycle are different axes**: a
scout is evidence and a snapshot; the lessons ledger is evidence and a rolling
compendium. Being maintained over time is not the same claim as governing HEAD.

The freshness rule above applies entry by entry, which is what makes the growth
safe: each lesson stays faithful to the failure that produced it and is **not**
rewritten to match HEAD. When a later observation corrects or extends an earlier
one, it arrives as a **new entry** — the ledger gains a line, it does not lose
one. The distinction is the same one this whole directory rests on: an
observation is true of its moment, and a compendium of such observations is
still a compendium of moments.

## Legacy names

The corpus was `docs/blueprint/research/` until 2026-09-01. Fourteen files
carried an ordinal from the research batch that produced them — `a1`…`a6` were
Fase A scouts, `b1`…`b3` were **Fase D** despite the letter, `m3`/`m5` were build
milestones. None was ever a machine key. They are gone from the canonical
identity, and this is the map, so that citations in `docs/history/` — which
correctly record the names of their own moment and are not rewritten — stay
followable.

Le righe sono ordinate con il nome corrente per primo, e non è una scelta
grafica: `docs/collegamenti.test.ts` legge il nome di file nella **prima cella**
di una riga di tabella dentro un README come la promessa di un vicino che esiste.
Un nome legacy in quella posizione sarebbe una promessa falsa — e l'ordine che il
checker impone è lo stesso che la regola di naming chiede già: identità canonica
prima, handle storico dopo.

| Current name | Was, until 2026-09-01 |
|---|---|
| `stato-componenti-vecchio-muffin.md` | `a1-inventario-codebase.md` |
| `prior-art-agenti-personali-e-harness.md` | `a2-prior-art.md` |
| `standard-ed-ecosistema-agenti.md` | `a3-standard.md` |
| `sota-memoria-agenti.md` | `a4-memoria.md` |
| `economia-dei-modelli.md` | `a5-modelli-economia.md` |
| `brain-hands-e-sandboxing.md` | `a6-brain-hands-sandbox.md` |
| `runtime-di-processo-nei-peer.md` | `b1-runtime-processo.md` |
| `catalogo-openrouter-e-multimodale.md` | `b2-modelli-openrouter-multimodale.md` |
| `media-ingestione-e-rendering.md` | `b3-media-rendering.md` |
| `sandbox-runtime-libreria-o-profili.md` | `m3-a-sandbox-runtime-lib.md` |
| `spec-skill-md-e-shell-nei-peer.md` | `m3-b-skillmd-shell.md` |
| `capability-output-telegram-e-discord.md` | `m3-connector-capabilities-telegram-discord.md` |
| `divergenza-per-connector-nei-peer.md` | `m3-connector-timing-hermes-openclaw-goose.md` |
| `riconciliazione-requisiti-day1-2026-08-22.md` | `m5-reconciliation-2026-08-22.md` |

Everything else kept its name, including the two families that move whole:
`audit-2026-08-16/` and `triage-2026-08-17/`.

No alias files, no tombstones, no redirect mechanism: this table is the map, and
a table that is read is cheaper than a mechanism that must be maintained.

## This file is current, and is checked as such

`docs/collegamenti.test.ts` classifies the corpus as archived — it is dated and
append-only — but **not this README**. It is a router: it is edited, its sections
renumber, and a broken link in it points a reader at nothing. An unwatched router
inside a watched repository is the failure this project keeps rediscovering, so
the classifier carves it out explicitly.
