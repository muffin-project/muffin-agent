# CLAUDE.md — Claude Code adapter

Follow `AGENTS.md` first. It is the repository-wide router; this file only adds
Claude-specific entry points and must stay small.

## Zero-context continuation

A bare `/loop` follows `.claude/loop.md`.

That loop reconstructs observed repository/delegation state, selects the next
DAY-1 claim from the current Gate path, loads only the context made load-bearing
by that claim, and verifies it according to `docs/ORCHESTRATION.md`.

Do **not** start by reading `docs/blueprint/STATE.md`: it is project chronology,
not current-state authority.

For current work use, in this order:

1. observed Git/worktree/PR/check/delegation state;
2. `docs/blueprint/LAVORO.md` as a compact handoff;
3. `docs/blueprint/gate1/PERCORSO-CRITICO.md` for Gate ordering;
4. the relevant rows in `docs/blueprint/M5-BIS.md` for Gate status.

## Verification profile

Choose FAST / STANDARD / CRITICAL **before** implementation using
`docs/ORCHESTRATION.md`. Do not recreate the profile rules here.

CRITICAL claims need the independent terminal review required by that document;
FAST/STANDARD do not acquire extra ceremony merely because Claude is running
them.

## Context discipline

`docs/README.md` maps questions to sources of truth. Prefer progressive
disclosure:

- current semantics → THESIS / ARCHITECTURE / SECURITY as relevant;
- mechanics → inspect code/schema/config;
- rationale → relevant ADR;
- cognitive design → relevant `docs/blueprint/knowledge/` file;
- historical research/audits → load only when evidence from that period is
  actually needed.

A document saying something happened is not proof that HEAD still does it.
Verify current-state claims before asserting or implementing against them.

## Local execution

On a real owner-machine task, use the local environment to prove claims that
cannot be established from Git alone: worktree cleanliness, installed build,
`~/.muffin`, launchd/systemd, process death/restart, Keychain/secret backend,
real provider/network and cutover behaviour.

Do not replace a missing local proof with prose.