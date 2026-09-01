# Errata — information architecture audit 2026-08-19

**Extends:** `information-architecture-audit-2026-08-19.md`

The original audit is a frozen evidence snapshot. These corrections are recorded
separately instead of silently rewriting that snapshot.

## Path corrections

Section 11 used the shortened/non-existent prefix `docs/mappa/`. The actual map
lives at:

```text
docs/blueprint/mappa/
```

Therefore the listed files are `docs/blueprint/mappa/{ancore.json,data-*.json,
mappa.html,template.html}`.

Section 12 listed `docs/proposals/README.md`. The actual path is:

```text
docs/blueprint/proposals/README.md
```

These are navigation corrections only; the role classifications are unchanged.

## #73 reconciliation outcome

The audit described PR #73 as a pending overlay requiring reconciliation. Later
on 2026-08-19, #81 absorbed its durable product decisions by role into
`docs/VISION.md`, `docs/EXTENSIONS.md`, `docs/OPEN-SOURCE-STRATEGY.md` and
`docs/PUBLIC-NARRATIVE.md`, moved the supporting research into the repository
research corpus, and preserved the original drafts in
`docs/history/product-direction-2026-08-18/`.

PR #73 was then closed as superseded. This is subsequent state, not a correction
to what the audit observed when it was written.
