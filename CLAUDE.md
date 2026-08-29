# CLAUDE.md — Claude Code adapter

Follow `AGENTS.md` first. It is the repository-wide router; this file only adds
Claude-specific entry points and must stay small.

## Zero-context continuation

A bare `/loop` follows `.claude/loop.md`.

That loop reconstructs observed repository/delegation state, selects the next
claim, loads only the context made load-bearing by that claim, runs the
pre-implementation challenge in `docs/RESEARCH.md` when its triggers apply, and
verifies the chosen claim according to `docs/ORCHESTRATION.md`.

Do **not** start by reading `docs/blueprint/STATE.md`: it is project chronology,
not current-state authority.

For current work use, in this order:

1. observed Git/worktree/PR/check/delegation state;
2. `docs/blueprint/LAVORO.md` as a compact handoff;
3. the current goal/ordering authority relevant to the task;
4. the relevant status/evidence rows when a Gate owns the goal;
5. `docs/RESEARCH.md` before implementing a material runtime/security/memory/
   harness design.

## Verification profile

Choose FAST / STANDARD / CRITICAL **before implementation** using
`docs/ORCHESTRATION.md`. Do not recreate the profile rules here.

CRITICAL claims need the independent terminal review required by that document;
FAST/STANDARD do not acquire extra ceremony merely because Claude is running
them.

The research/challenge pass and the verification profile answer different
questions: `RESEARCH.md` challenges **what should be built**; ORCHESTRATION
specifies **what evidence proves the chosen claim**.

## Context discipline

`docs/README.md` maps questions to sources of truth. Prefer progressive
disclosure:

- current semantics → THESIS / ARCHITECTURE / SECURITY as relevant;
- mechanics → inspect code/schema/config;
- rationale → relevant ADR;
- cognitive design → relevant `docs/blueprint/knowledge/` file;
- installed runtime state → `docs/MUFFIN-HOME.md`, then only the relevant live
  state/evidence;
- historical research/audits → load only when evidence from that period is
  actually needed.

A document saying something happened is not proof that HEAD still does it.
Verify current-state claims before asserting or implementing against them.

For a material design, do not stop at the first confirming peer or paper. Follow
`docs/RESEARCH.md`: Hermes Agent and OpenClaw are default agent peers; add the
systems/research strongest in the domain, and deliberately look for evidence
that would falsify Muffin's preferred design.

## Local execution

On a real owner-machine task, use the local environment to prove claims that
cannot be established from Git alone: worktree cleanliness, installed build,
`~/.muffin`, launchd/systemd, process death/restart, Keychain/secret backend,
real provider/network and cutover behaviour.

Do not replace a missing local proof with prose. Do not copy private owner state
into the repository merely to make a proof shareable; record the smallest
redacted/aggregate evidence that lets another agent reproduce the reasoning.
