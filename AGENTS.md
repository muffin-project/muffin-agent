# Working on this repository

A **router**, not the manual. `docs/README.md` maps each question to its
authoritative home. Load deeper material only when the task makes it relevant:
context is a resource, and history is not startup context.

## Observe before you read, read before you change

- Reconstruct observed state first — Git, worktrees, open PRs and checks,
  delegation state. Do not infer current work from a nearby Markdown file.
- `docs/work/handoff.md` is a disposable handoff. Observed repository state
  wins when the two disagree.
- A detailed document is not evidence that HEAD still implements its claim.
  Verify load-bearing current-state claims against code, config or runtime.
- Literal mechanics belong to code, schemas and shipped config, never to prose.

## Challenge the design before writing it

For a non-mechanical change to runtime, harness, security and authority, memory,
processes or durable schema, follow `docs/RESEARCH.md` **before** implementing.
For model/tool-loop lifetime, timeout/retry ownership, progress/stagnation or
reasoning-budget work, load `docs/EXECUTION.md` as the current scoped contract.

A previous Muffin decision is a hypothesis with history, not a fact that must be
preserved. A peer implementation is prior art, not authority. Simplifying or
removing a mechanism is a valid result.

A mechanical fix whose desired behaviour is already unambiguous still requires
tracing the real production path, but not a literature review. If it exposes an
architectural assumption, the full pass becomes mandatory.

## Classify the claim before implementing it

Choose FAST / STANDARD / CRITICAL using `docs/ORCHESTRATION.md`. The verification
budget follows the claim and its blast radius, not the size of the diff.

A subagent saying something is not evidence. A module existing is not proof that
production reaches it. Prefer the smallest evidence that could falsify the claim,
and prove the wiring when the wiring is the guarantee.

## Conventions that do not move

Follow ADR-0020 for language: code, identifiers, commits and outward technical
interfaces are English; internal design material may be Italian. No duplicate
bilingual copies.

Never put personal data or owner state in the repository. Installation data
belongs under the Muffin home, not in Git.

Do not reopen a recorded decision merely because another design is possible.
Bring new evidence; a material reversal is a new ADR, not a rewrite of the old.

## The failure pattern to remember

Muffin has repeatedly had mechanisms that existed, had unit tests, and were
still not on the production path. Therefore:

> **A mechanism working is not the same claim as the outcome being right.**

When the claim is load-bearing, trace producer → consumer → failure path, and
make the evidence fail when the wiring is removed.
