@AGENTS.md

# CLAUDE.md — Claude Code adapter

The import above is load-bearing, not decorative. Claude Code reads `CLAUDE.md`
and does **not** read `AGENTS.md`: until 2026-08-30 this file merely *named*
AGENTS.md in prose, so the repository-wide router never entered a session's
startup context and applied only when the model happened to open it. `@AGENTS.md`
is the supported primitive that actually loads it.

Everything below is what is true for Claude Code and for no other agent. The
invariants live above; do not restate them here.

## Zero-context continuation

A bare `/loop` runs `.claude/loop.md`.

That loop reconstructs observed repository and delegation state, selects the next
claim, loads only the context that claim makes load-bearing, and verifies it
according to `docs/ORCHESTRATION.md`.

For current work use, in this order: observed Git/worktree/PR/check/delegation
state; `docs/blueprint/LAVORO.md` as a compact handoff; then the ordering and
status authority for the current goal. `docs/blueprint/STATE.md` is a tombstone,
not current state.

## Verification profile

Choose the profile from `docs/ORCHESTRATION.md`; the rules are not repeated here.
The one Claude-specific note: FAST and STANDARD claims do **not** acquire extra
ceremony merely because Claude is running them, and CRITICAL does not lose its
independent terminal review merely because the work went quickly.

## Local execution

On a real owner-machine task, use the local environment to prove what Git alone
cannot: worktree cleanliness, the installed build, `~/.muffin`, launchd/systemd,
process death and restart, the secret backend, real provider/network behaviour.

Do not replace a missing local proof with prose. Do not copy private owner state
into the repository merely to make a proof shareable; record the smallest
redacted or aggregate evidence that lets another agent reproduce the reasoning.
