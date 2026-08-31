# History

This directory preserves project lineage that is useful to reconstruct **how we
got here** but does not govern current HEAD.

History is intentionally outside normal startup context. It may contain old
status, superseded architecture, prior workflow rules and owner directives in
the form they had at the time.

Use current authority first (`docs/README.md`), then enter history only when a
decision needs lineage or an old assumption must be re-evaluated.

## What belongs here, and what belongs to Git alone

Git is the complete forensic record: every version of every file that ever
existed is recoverable from it. This directory is **curated** history — it keeps
only what still has a concrete, statable reason to be read directly in the
current checkout.

Neither rule applies mechanically. «Old, therefore `history/`» would fill this
directory with material nobody reads; «it is in Git, therefore delete» would
force archaeology for material that is still consulted.

## Current snapshots

- `day1-2026-08-19/` — pre-refactor DAY-1 mandate/path/handoff snapshots.
- `product-direction-2026-08-18/` — drafts that preceded the current product
  documents.
- `rebuild-2026/` — the 2026 rebuild design corpus (`00`–`12`, `BRIEF`,
  `validazione-contratti`, `critique/`) plus the pre-authority snapshots and the
  frozen `STATE-chronicle.md`. Five of its documents are still cited by live
  code and by the architecture map, which is why the corpus is readable here
  rather than only in Git.
- `foundations/` — see below; two different materials, deliberately not merged.

## `foundations/`: two materials, one family

- `VISION-pre-authority.md` — the single foundation document extracted on
  2026-08-19, in the form it had before `docs/VISION.md` became the authority.
  Its provenance is distinct and it is kept distinct.
- `legacy/` — the inherited foundations corpus in full (`COGNITIVE_BASES`,
  `INVARIANTS`, `REFERENCES`, `UNDERSTANDING`, and its own `README`). It is kept
  whole because the architecture reconciliation (**F2**) will read it
  explicitly; whether it still earns a place in curated history afterwards is a
  question for after F2, not now.

Neither governs HEAD. Nothing here was extracted, promoted or rewritten when it
was archived.

`docs/foundations/VISION.md` deliberately stays at its old path as a
compatibility tombstone; it is not part of this corpus.

## Old path → current home

The 2026-08-31 archive moved these; Git preserves the renames, so
`git log --follow` still works from either end.

| Old path | Now |
|---|---|
| `docs/blueprint/{00..12}-*.md`, `BRIEF.md`, `validazione-contratti.md` | `docs/history/rebuild-2026/` |
| `docs/blueprint/critique/` | `docs/history/rebuild-2026/critique/` |
| `docs/foundations/{COGNITIVE_BASES,INVARIANTS,REFERENCES,UNDERSTANDING,README}.md` | `docs/history/foundations/legacy/` |
| `docs/blueprint/STATE.md` chronicle | `docs/history/rebuild-2026/STATE-chronicle.md` |

Old references inside ADRs, research and other dated documents were **not**
rewritten: they record what was true when they were written.

## Workflow before the 2026-08-19 knowledge refactor

The pre-refactor workflow documents are preserved by Git at commit
`451cd9162ee4a84d3dac617b31d52d1ca41be513`. This section previously lived at
`docs/history/workflow-2026-08-19/README.md` and was absorbed here unchanged.

Use that commit when a historical rule, incident or rationale was intentionally
removed from the current workflow but still matters for archaeology:

```bash
git show 451cd9162ee4a84d3dac617b31d52d1ca41be513:docs/ORCHESTRATION.md
git show 451cd9162ee4a84d3dac617b31d52d1ca41be513:docs/PRACTICES.md
git show 451cd9162ee4a84d3dac617b31d52d1ca41be513:docs/BRANCHING.md
git show 451cd9162ee4a84d3dac617b31d52d1ca41be513:docs/JUDGE.md
```

Current repository work is governed by the files at their normal paths.

## Removed: the weekly proposals routine

`docs/blueprint/proposals/` held one file — the paste-in prompt for a weekly
research routine that **was never active** (it was configured against a private
repository and returned 403). It was removed on 2026-08-31: it had no live
readers, and its prompt still routed a fresh agent to the `STATE.md` START HERE
block, which stopped being current state on 2026-08-19.

**It is not a current workflow and must not be treated as one.** It is recorded
here as a *prior attempt* relevant to **F4** (whether a proposals workflow should
exist at all), not as material to restore — a future design would be written
against the current taxonomy, not recovered from this text.

```bash
git show b24088def4f145a23c8e3be05ad34f4fccf2296b:docs/blueprint/proposals/README.md
```

Historical path: `docs/blueprint/proposals/README.md`.

Git history remains an additional record; the files here exist so historical
context is explicit and discoverable without pretending it is current.
