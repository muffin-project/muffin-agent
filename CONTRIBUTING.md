# Contributing

Muffin is developed claim-first: one change should make one falsifiable thing
become true, and the evidence should be reproducible by somebody other than the
session that wrote it.

This file is a map onto the repository's canonical working rules for an external
contributor. It deliberately does not restate every rule: two copies drift and
only one stays true.

The repository is currently a **private Community Preview**. Public source
access is planned before product public alpha, but remains pending the privacy,
security and repository-readiness gates. Until access opens, contributions are
limited to people invited to this repository. A future public repository will
invite inspection and contribution; it will not claim stability, compatibility
or production readiness.

## License

The code in this repository is licensed under the **GNU Affero General Public
License v3 or later** (`LICENSE`, SPDX `AGPL-3.0-or-later`; rationale in
`docs/decisions/0078-licenza-agpl.md`). By contributing you agree your
contributions enter under the same license. Before submitting a PR, read and
accept `CONTRIBUTOR_AGREEMENT.md`, then sign off every commit with
`git commit -s`. The agreement contains the standard DCO 1.1 plus the narrow
owner-approved grant that permits a future move to another OSI-approved license.
The `Muffin` name and logo are **not** covered by that grant — see
`TRADEMARK.md`.

## Start here

For local development, use Node.js 22 or newer. Running the test suite also
requires Node.js 22.12 or newer, the minimum supported by the pinned Vitest
major; the installed runtime itself continues to target Node.js 22.

Read, in this order:

1. [`AGENTS.md`](AGENTS.md) — repository router; read this regardless of what you
   touch.
2. [`docs/README.md`](docs/README.md) — tells you which document/code surface
   owns which kind of truth.
3. [`docs/development/ORCHESTRATION.md`](docs/development/ORCHESTRATION.md) — how work is selected,
   bounded, delegated, verified and integrated.
4. [`docs/development/RESEARCH.md`](docs/development/RESEARCH.md) — when a research/challenge pass is
   required before code.
5. [`docs/development/BRANCHING.md`](docs/development/BRANCHING.md) — current Git mechanics.
6. [`docs/development/JUDGE.md`](docs/development/JUDGE.md) — review rubric, especially for CRITICAL
   claims.

Load product/security/architecture documents only when your claim makes them
relevant. Research/history are evidence, not automatic authority.

## You do not need Claude Code to contribute

The project uses Claude Code heavily, and `.claude/` contains useful skills,
hooks and orchestration ergonomics. They are **not supposed to be the only
implementation of a repository invariant**.

A human, another coding agent or a different automation environment should be
able to understand the claim, run the relevant repository commands and produce
the same evidence. If you find a load-bearing rule that only exists inside a
Claude-specific hook/prompt and cannot be reproduced independently, report it:
that is portability debt, not a contributor requirement.

## Choose the right contribution boundary

The preferred contribution shape follows Muffin's narrow waist:

- **Core** — continuity, Evidence/Beliefs/Work/Effects/Authority and boundaries
  that every installation depends on. Core changes carry the highest evidence
  burden.
- **Capability / integration breadth** — services, importers, skills, MCP
  adapters, provider/surface/Node integrations should normally use the extension
  boundaries rather than expanding core merely because an integration is useful.
- **Cross-platform / install / recovery** — highly valuable because source-public
  Muffin must work outside the founder's machine.
- **Docs / evals / evidence** — valuable when they make a real claim more
  falsifiable, discoverable or honest.

Propose a new core primitive only when a concrete need cannot be expressed safely
through the current boundaries or when multiple capabilities expose the same
missing invariant.

## Choose and claim work

GitHub issues are a navigable claim and dependency graph, not a single
repository-wide queue. There is no required `current` issue or global
`program/current` label. Contributors can choose any open issue whose stated
prerequisites are satisfied and whose acceptance is clear enough to implement.

Before writing:

- claim the issue with its GitHub assignee; if assignment is unavailable, comment
  with the contributor/agent identity, bounded scope, and branch;
- link the branch and PR to the issue so maintainers can reconcile the same claim;
- compare the scope with other active claims, worktrees and files changed in open
  PRs. Independent scopes may proceed in parallel; coordinate or narrow overlap.

Use the issue body for durable dependencies and acceptance, and the linked PR for
candidate SHA and check/review evidence. When work is duplicated or superseded,
link the surviving issue/PR and close the stale claim with a short reason. Do not
close a valid issue just because another issue is currently attracting maintainer
attention.

## Before you open a pull request

- **Base your branch on the repository's current integration branch described in
  `docs/development/BRANCHING.md`.** At the time this file was written that is `dev`; do not
  infer current branch policy from an old PR or cached contributor guide.
- **Use the branch naming rule in `docs/development/BRANCHING.md`**; current claim branches use
  `slice/<what-becomes-true>`.
- **Name one primary falsifiable claim.** A PR is a checkpoint/integration vehicle,
  not the product state machine.
- **Classify the verification profile** — FAST / STANDARD / CRITICAL — before
  writing code using `docs/development/ORCHESTRATION.md`. Blast radius chooses the profile,
  not diff size.
- **Run the research/challenge pass when required** by `docs/development/RESEARCH.md`,
  especially for runtime/harness architecture, security/authority, provenance,
  memory/person-model behaviour, processes or durable schema.
- **Trace the production path.** A unit test around disconnected code is not
  evidence that Muffin can reach the behaviour.
- **Language:** code, identifiers, commit messages and PR text are English
  (ADR-0020, `docs/decisions/0020-lingua-del-progetto.md`). Internal design
  material may remain Italian where the project already uses it; do not maintain
  duplicate translations as separate truths.

## What review expects

The PR template (`.github/pull_request_template.md`) asks for a single
falsifiable claim, a verification profile and the evidence that could falsify
it — **observed, not asserted**.

That normally means:

- commands you actually ran and their actual output;
- minimum local signal before opening a PR: `npx tsc --noEmit` plus the targeted
  tests for the files you touched (`npx vitest run <paths>`); the template
  defines the rest of the evidence budget, not this file;
- for a bug fix, the pre-fix failure/reproduction before the green result;
- integration/acceptance evidence when the claim crosses a real boundary;
- for CRITICAL work, the independent judge path described in `docs/development/JUDGE.md`,
  run by a fresh evaluator rather than the same session being its sole certifier.

A subagent, coding assistant or reviewer saying "it works" is not itself
evidence. The evidence is the executable observation.

## Open an issue before non-trivial work

For anything beyond a small, obviously correct fix, open an issue first with:

- the problem/failed or missing behaviour;
- the evidence that it is real;
- the one claim you think should become true;
- important decision forks or authority/schema/security consequences you can
  already see.

This prevents large speculative PRs and gives maintainers a chance to point you
to an existing authoritative home or extension boundary before you invest in the
wrong shape.

A trivial typo, dead link or clearly mechanical repair may go directly to a PR.

Do not create an issue merely to convert a dated audit or competitor feature list
into backlog. Peer systems are input; current Muffin failures/requirements decide
what becomes work.

## What must never enter the repository

- **No owner private state.** No private conversation content, Muffin Home data,
  personal documents, database dumps, private machine-specific data, installed
  secrets or API keys.
- **No secrets in history.** A later deletion does not make a committed secret
  safe for a public repository. Stop and report the incident through the current
  security/maintainer channel instead of trying to hide it in a follow-up commit.
- **No duplicate copies of a decision.** If a guarantee already has an
  authoritative home, link to it rather than restating an editable second copy.
- **No silent ADR rewrite.** ADRs record why a decision was taken. New evidence
  that reverses one should produce the appropriate new/superseding decision,
  not edit history until the original choice disappears.

## Contributor is not maintainer

Early contributors are welcome before product public alpha. Contribution access
and maintainer authority are intentionally separate.

A useful PR does not automatically grant merge/release/security authority, and a
maintainer role is not assigned because somebody happened to arrive early.
Maintainership is earned through repeated observed work, judgement and the needs
of the project.

This protects both sides: contributors can participate immediately without the
project pretending its governance is mature before it has evidence for it.

## Before asking "what should I work on?"

Prefer, in order:

1. an existing issue with a concrete claim/evidence;
2. a bug or friction you can reproduce on your own installation/platform;
3. a missing integration/capability that fits an existing extension boundary;
4. a docs/eval/recovery problem that makes a real guarantee easier to understand
   or falsify.

Avoid speculative core abstractions and parity work whose only evidence is that
another agent has a feature. The repository's owner dogfood and observed user
fallbacks are the primary source of product ordering.
