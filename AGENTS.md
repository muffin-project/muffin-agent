# Working on this repository

This file is a **router**, not the repository manual. Start with
`docs/README.md`: it maps each kind of question to its authoritative home.

## Reconstruct reality before changing it

- Observe Git, worktrees/branches, open PRs/checks and durable delegation state;
  do not infer current work from a nearby Markdown file.
- For an autonomous continuation, follow `.claude/loop.md` (Claude) or the same
  control loop in `docs/ORCHESTRATION.md`.
- `docs/blueprint/LAVORO.md` is a disposable handoff. Observed repository state
  wins when they disagree.
- A detailed historical document is not evidence that HEAD still implements its
  claim. Verify load-bearing current-state claims against code/config/runtime.

## Know which source owns the question

- **Literal mechanics** → code, schemas and shipped config.
- **Why Muffin exists** → `docs/THESIS.md`.
- **Current architecture** → `docs/ARCHITECTURE.md`.
- **Current security model** → `docs/SECURITY.md`.
- **How design choices are made** → `docs/DESIGN-PRINCIPLES.md`.
- **Why a decision was taken** → the relevant ADR under
  `docs/blueprint/adr/`.
- **DAY-1 status** → `docs/blueprint/M5-BIS.md`; ordering →
  `docs/blueprint/gate1/PERCORSO-CRITICO.md`.
- **Research/audits/lessons** → evidence and history, never current state by
  themselves.
- **`docs/mappa/`** → derived navigation views, never independent authority.

Load deeper/domain material only when the task makes it relevant. Context is a
resource; history is not startup context.

## How work is governed

Classify the claim **before** implementation using FAST / STANDARD / CRITICAL in
`docs/ORCHESTRATION.md`. The verification budget follows the claim and blast
radius, not diff size.

- `docs/ORCHESTRATION.md` — control loop, evidence budget, delegation, scope and
  escalation.
- `docs/PRACTICES.md` — engineering practices and their triggers.
- `docs/JUDGE.md` — independent review semantics.
- `docs/BRANCHING.md` — Git/PR/promotion mechanics.

A subagent saying something is not evidence. A module existing is not proof that
production reaches it. Prefer the smallest evidence that could falsify the claim
and prove wiring when wiring is the guarantee.

## Repository-wide conventions

Follow ADR-0020 for language instead of inventing a new policy: code,
identifiers, commits and outward technical interfaces are English; internal
design/persona material may be Italian; do not maintain duplicate bilingual
copies merely for translation.

Never put personal data or owner state in the repository. Installation data
belongs under the Muffin home, not in Git.

Do not reopen a recorded architectural decision merely because another design is
possible. Bring new evidence; if the decision materially reverses, record a new
ADR rather than rewriting history until the old decision disappears.

## The failure pattern to remember

Muffin has repeatedly had mechanisms that existed, had unit tests and were still
not on the production path. Therefore:

> **A mechanism working is not the same claim as the outcome being right.**

When the claim is load-bearing, trace producer → consumer → failure path and make
the evidence fail when the wiring is removed. The repository should make that
path easier to inspect, not compensate with more prose.