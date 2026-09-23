# Working on this repository

A **router**, not a manual. `docs/README.md` maps questions to authoritative
homes. Load deeper material only when relevant; history is not startup context.

## Observe before you read, read before you change

- Observe Git, worktrees, open PRs/checks and delegation first; nearby Markdown
  does not establish current work.
- Current work is observed from Git/GitHub and `scripts/agent/repo-state.mjs`.
- Verify load-bearing claims against code, config or runtime; docs do not prove
  HEAD still implements them.
- Literal mechanics belong to code, schemas and shipped config, never to prose.

## Challenge the design before writing it

For a non-mechanical change to runtime, harness, security and authority, memory,
processes or durable schema, follow `docs/development/RESEARCH.md` **before** implementing.

A prior Muffin decision is a hypothesis, not binding fact; peer code is prior
art, not authority. Simplifying or removing a mechanism is valid.

A mechanical fix with clear behavior still requires tracing production, not a
literature review. If it exposes an architectural assumption, do the full pass.

## Classify the claim before implementing it

Choose FAST / STANDARD / CRITICAL using `docs/development/ORCHESTRATION.md`.
Verification follows the claim and blast radius, not diff size.

A subagent's claim is not evidence; a module's existence does not prove production
uses it. Prefer falsifying evidence; prove wiring when wiring is the guarantee.

## Conventions that do not move

Follow ADR-0020 for language: code, identifiers, commits and outward technical
interfaces are English; internal design material may be Italian. No duplicate
bilingual copies.

Never put personal data or owner state in the repository. Installation data
belongs under the Muffin home, not in Git.

Do not reopen a recorded decision merely because another design is possible.
Bring new evidence; a material reversal is a new ADR, not a rewrite of the old.

## Engineering harness

Procedures: `.agents/skills/` (`engineering-loop`, `jev-shadow`); entry points
`/start`, `/checkpoint`, `/close` in `.opencode/commands/`; roles in
`.opencode/agents/`. `scripts/agent/repo-state.mjs` summarizes GitHub issues,
claims, open PRs and checks. GitHub issue/PR state owns contributor claims; no
global `program/current` queue. Disjoint scopes may proceed in parallel.
OpenCode commands/roles are optional; repository invariants are harness-neutral.

## The failure pattern to remember

Muffin has repeatedly had mechanisms that existed and passed unit tests but were
not on the production path. Therefore:

> **A mechanism working is not the same claim as the outcome being right.**

For load-bearing claims, trace producer → consumer → failure path and ensure
evidence fails if the wiring is removed.
