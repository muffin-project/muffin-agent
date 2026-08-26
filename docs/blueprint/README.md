# Blueprint lineage and live Gate

`docs/blueprint/` contains **two different generations of knowledge**. Do not
infer authority from being in this directory.

For the current repository authority map start at `docs/README.md`.

## Live operational/current material

These paths still have a current role:

- `M5-BIS.md` — **DAY-1 status inventory**. It is currently pending a dedicated
  evidence reconciliation; individual rows remain the inventory, but stale
  global summaries must not be treated as fresh measurements.
- `LAVORO.md` — compact disposable handoff; observed Git state wins.
- `gate1/MANDATO-DAY-1.md` — DAY-1 exit condition.
- `gate1/PERCORSO-CRITICO.md` — ordering/dependencies of remaining blockers.
- `knowledge/` — curated cognitive problem/evidence corpus, loaded only for
  relevant work; implementation status does not belong there.
- `adr/` — decision history: why choices were made, not proof of current HEAD.
- `research/` — dated evidence snapshots, never current authority by themselves.
- `proposals/` — proposals with no authority until a decision accepts them.

## Rebuild-era design corpus

The following root documents are preserved because they contain the design
lineage of the 2026 rebuild, but **they do not govern current mechanics or
status**:

```text
00-findings.md
01-verdetti.md
02-ontologia.md
03-threat-model.md
04-roadmap.md
05-testing-evals.md
06-modelli.md
07-durevole-vs-impalcatura.md
08-assunzioni.md
09-contratti-m0-m1.md
10-risoluzioni-fase-c.md
11-salvataggio-documentale.md
12-casi-uso-primitive.md
BRIEF.md
validazione-contratti.md
critique/
```

Use them when reconstructing why the rebuild took a shape or when testing whether
a historical assumption still matters. Do **not** use them as a shortcut for
what HEAD accepts today.

In particular:

- current architecture → `docs/ARCHITECTURE.md`;
- current security → `docs/SECURITY.md`;
- literal schemas/config/contracts → executable code/schema/shipped config;
- current verification workflow → `docs/ORCHESTRATION.md`;
- current Gate status → `M5-BIS.md`.

The files remain at stable paths for now because ADRs/code/history cite them. A
physical archive move is intentionally deferred until a reverse-reference check
can prove it will not turn semantic cleanup into broken lineage.

## STATE.md

`STATE.md` is no longer a state source. Its accumulated chronicle was frozen at
`docs/history/rebuild-2026/STATE-chronicle.md`; the path itself is now a small
tombstone so old links fail safely toward the current authority map instead of
feeding stale state to an agent.

## Why this folder is not being deleted

The rebuild corpus is valuable precisely because it records mistakes,
alternatives and assumptions that disappeared from the current design. History
has evidentiary value without having operational authority.

The desired property is not "few files". It is:

> **a fresh agent can ignore history by default without losing the ability to
> reconstruct it when a decision needs lineage.**
