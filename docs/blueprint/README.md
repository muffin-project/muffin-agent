# Blueprint: what is still here, and what left

`docs/blueprint/` no longer holds two generations of knowledge. On 2026-08-31 the
rebuild-era design corpus was archived; what remains is operational or reference
material that still has a current role.

Do not infer authority from being in this directory. For the current repository
authority map start at `docs/README.md`.

## What is still here

One thing, and it is not authority: `STATE.md`, a tombstone. See below.

This README stays only as long as the old paths need a router.

## What left, and where it went

| Was here | Now |
|---|---|
| `00`–`12`, `BRIEF.md`, `validazione-contratti.md` | `docs/history/rebuild-2026/` |
| `critique/` | `docs/history/rebuild-2026/critique/` |
| `adr/` | `docs/decisions/` — decisioni, non storia: append-only ma vive |
| `knowledge/` | `docs/knowledge/` — il corpus cognitivo durevole |
| `proposals/` | **removed** — the routine was never active; `docs/history/README.md` records the archaeological pointer and ties it to F4 |
| `M5-BIS.md`, `LAVORO.md`, `gate1/` | `docs/work/` — current work, under names that read without the history |
| `research/` | `docs/evidence/` — what we observed, measured, compared or audited |
| six design contracts inside `research/` | `docs/history/design-notes/` — design lineage: a proposal is a lifecycle state, not a document class |
| `mappa/` | `docs/derived/architecture-map/` — a **derived** subsystem, not merely generated output: editorial inputs, generators, checkers, template and generated views are one thing |

The move waited for a reverse-reference check that could prove semantic cleanup
would not become broken lineage. That check was done on 2026-08-30: five of the
corpus documents are cited by live code and by the architecture map, and their
citations were updated in the same commit as the move.

The corpus was archived **whole**. Its value is that it records mistakes,
alternatives and assumptions that disappeared from the current design; splitting
it by citation count would have destroyed the thing that makes it readable.

## `STATE.md`

`STATE.md` is no longer a state source. Its accumulated chronicle was frozen at
`docs/history/rebuild-2026/STATE-chronicle.md`; the path itself is now a small
tombstone so old links fail safely toward the current authority map instead of
feeding stale state to an agent.

## Where current answers live

- current architecture → `docs/ARCHITECTURE.md`;
- current security → `docs/SECURITY.md`;
- literal schemas/config/contracts → executable code/schema/shipped config;
- current verification workflow → `docs/ORCHESTRATION.md`;
- current DAY-1 status → `docs/work/day1/requirements-status.md`.

The desired property has not changed:

> **a fresh agent can ignore history by default without losing the ability to
> reconstruct it when a decision needs lineage.**
