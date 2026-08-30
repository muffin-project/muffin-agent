# Working on this repository

This file is a **router**, not the repository manual. Start with
`docs/README.md`: it maps each kind of question to its authoritative home.

## Step 0 — reconstruct and challenge before implementation

For any non-mechanical implementation, do not jump from request → code.
Follow the repository-wide protocol in `docs/RESEARCH.md`:

1. observe Git/runtime/dogfood reality;
2. inspect the current authoritative docs and production path;
3. reconstruct the existing decision and assumptions;
4. compare relevant current peers by problem — **Hermes Agent and OpenClaw are
   default peers, not sufficient peers**;
5. add domain specialists (for example Letta/Mem0 for memory, CaMeL/Progent for
   security, durable-workflow systems for recovery/process semantics);
6. search primary docs/source and credible research for evidence **for and
   against** the proposed mechanism;
7. write alternatives and a falsification/eval criterion before implementation.

A previous Muffin decision is a hypothesis with history, not a fact that must be
preserved. A peer implementation is prior art, not authority. Prefer an
experiment/eval over prose when the disagreement is empirical.

Mechanical fixes whose desired behaviour is already unambiguous still require
reconstructing the real production path, but not a ceremonial literature review.
If the “small fix” exposes an architectural assumption, escalate into the full
challenge pass.

## Reconstruct reality before changing it

- Observe Git, worktrees/branches, open PRs/checks and durable delegation state;
  do not infer current work from a nearby Markdown file.
- For an autonomous continuation, follow `.claude/loop.md` (Claude) or the same
  control loop in `docs/ORCHESTRATION.md`.
- `docs/blueprint/LAVORO.md` is a disposable handoff. Observed repository state
  wins when they disagree.
- A detailed historical document is not evidence that HEAD still implements its
  claim. Verify load-bearing current-state claims against code/config/runtime.
- When the claim depends on the installed agent, use `docs/MUFFIN-HOME.md` to
  navigate the semantic classes under `~/.muffin` without treating private owner
  state as repository data.

## Know which source owns the question

- **Literal mechanics** → code, schemas and shipped config.
- **Why Muffin exists** → `docs/THESIS.md`.
- **Where the product is trying to go** → `docs/VISION.md`.
- **Current architecture** → `docs/ARCHITECTURE.md`.
- **Current security model** → `docs/SECURITY.md`.
- **How design choices are made** → `docs/DESIGN-PRINCIPLES.md`.
- **How to challenge a design before code** → `docs/RESEARCH.md`.
- **How the live installation home is semantically organised** → `docs/MUFFIN-HOME.md`.
- **Why a decision was taken** → the relevant ADR under
  `docs/blueprint/adr/`.
- **DAY-1 status** → `docs/blueprint/M5-BIS.md`; ordering →
  `docs/blueprint/gate1/PERCORSO-CRITICO.md`.
- **Research/audits/lessons** → evidence and history, never current state by
  themselves.
- **Architecture map** → `docs/blueprint/mappa/`; a derived editorial view,
  never independent authority.

Load deeper/domain material only when the task makes it relevant. Context is a
resource; history is not startup context.

## How work is governed

Classify the claim **before** implementation using FAST / STANDARD / CRITICAL in
`docs/ORCHESTRATION.md`. The verification budget follows the claim and blast
radius, not diff size. For claims covered by `docs/RESEARCH.md`, the challenge
pass comes **before** profile-driven implementation; the profile then controls
how the chosen claim is verified.

- `docs/ORCHESTRATION.md` — control loop, evidence budget, delegation, scope and
  escalation.
- `docs/RESEARCH.md` — pre-implementation research/challenge protocol.
- `docs/PRACTICES.md` — engineering practices and their triggers.
- `docs/JUDGE.md` — independent CRITICAL review semantics.
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
