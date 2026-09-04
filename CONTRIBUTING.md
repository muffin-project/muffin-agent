# Contributing

This repository already has strong, written working rules. This file is a map
onto them for an external contributor — it does not restate them, because two
copies of a rule drift and only one of them stays true.

**Read first**, in this order: [`AGENTS.md`](AGENTS.md) (the router — read this
one regardless of what you touch), [`docs/RESEARCH.md`](docs/RESEARCH.md) (when
a challenge/research pass is required before writing code),
[`docs/ORCHESTRATION.md`](docs/ORCHESTRATION.md) (how work is scoped and
verified), [`docs/BRANCHING.md`](docs/BRANCHING.md) (Git mechanics),
[`docs/JUDGE.md`](docs/JUDGE.md) (review rubric). `docs/README.md` is the
router for everything else.

## Before you open a pull request

* **Base your branch on `dev`, not `main`.** `main` is promoted from `dev` after
  an independent review of the integration boundary (`docs/BRANCHING.md`); a PR
  against `main` will need to be redirected.
* **Name your branch `slice/<what-becomes-true>`**, one coherent claim per
  slice (`docs/BRANCHING.md#slice-rules`).
* **Classify your change's verification profile** — FAST / STANDARD / CRITICAL
  — before writing code, using `docs/ORCHESTRATION.md`. The profile follows the
  claim's blast radius, not the size of the diff: a one-line change to an
  authority or schema boundary can still be CRITICAL.
* **Run the research/challenge pass first** (`docs/RESEARCH.md`) when your
  change is non-mechanical and touches runtime, harness, security/authority,
  provenance, memory, processes, or a durable schema. A mechanical fix with an
  unambiguous desired behaviour does not need the full pass, but still needs to
  trace the real production path, not just the unit under test.
* **Language**: code, identifiers, commit messages, PR text, and this file's
  own siblings are English (ADR-0020, `docs/decisions/0020-lingua-del-progetto.md`).
  Internal design material may be Italian where the project already writes it
  that way. Never duplicate the same content in both languages.

## What a review expects

The PR template (`.github/pull_request_template.md`) asks for a single
falsifiable claim, a verification profile, and the evidence that could falsify
it — **observed**, not asserted. Concretely, that means:

* commands you actually ran and their actual output, not a description of what
  they should show;
* for a bug fix, the pre-fix failure — a red test, a reproduced error — before
  the green result;
* for anything CRITICAL, the independent judge pass `docs/JUDGE.md` describes,
  run in a fresh session against the diff, not by the same session that wrote
  it.

A subagent's or an assistant's report that something works is not itself
evidence. The evidence is the command and its output.

## What does not belong in this repository

* **No owner private state.** No conversation content, no home-directory paths
  specific to the owner's machine, no personal data, no installed secrets or
  API keys, no contents of an owner's `~/.muffin` home. Installation data lives
  under the Muffin home, never in Git.
* **No duplicate copies of a decision.** If a rule already lives in `AGENTS.md`,
  an ADR, or one of the documents above, link to it instead of restating it —
  the same discipline this file follows for itself.
* **No decision reversal without new evidence.** A previous ADR is a decision
  with history, not a fact to relitigate on taste; propose a new ADR with the
  evidence that changed, rather than rewriting the old one.

## Opening an issue before a non-trivial PR

This repository is currently private, so day-to-day open work is tracked
partly in GitHub Issues and partly in `docs/work/` (see that directory's own
files for what is currently open). For anything beyond a small, obviously
correct fix, open an issue first describing the problem and the evidence for
it, so the approach can be discussed before code is written. A trivial fix
(typo, dead link, a clearly broken build step) can go straight to a PR.
