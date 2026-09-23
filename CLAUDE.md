@AGENTS.md

# CLAUDE.md — Claude Code adapter

The import above is load-bearing, not decorative. Claude Code reads `CLAUDE.md`
and does **not** read `AGENTS.md`: until 2026-08-30 this file merely *named*
AGENTS.md in prose, so the repository-wide router never entered a session's
startup context and applied only when the model happened to open it. `@AGENTS.md`
is the supported primitive that actually loads it.

Everything below is what is true for Claude Code and for no other agent. The
invariants live above; do not restate them here.

## Which surface carries which procedure

Four surfaces, four different moments. They are not interchangeable, and using
one for another's job is how `.claude/loop.md` became a manual.

| Surface | Moment |
|---|---|
| `/riprendi` | one-shot: observe state, reconstruct, pick the next claim |
| `/goal` | close **one** verifiable claim, turn after turn |
| `/loop` (`.claude/loop.md`) | periodic session maintenance; it stops itself |
| fresh session + `/giudice` | the independent CRITICAL review |

A `/goal` condition must be an **executable check**, never a state described in
prose: its judge is a small fast model, and prose is exactly what this repository
already knows how to fool itself with.

Project skills and path-scoped rules live in `.claude/skills/` and
`.claude/rules/`. Their bodies invoke the authoritative document; they do not
restate it.

For current work use observed Git/worktree/PR/check/delegation state and
`scripts/agent/repo-state.mjs`; then load the ordering and status authority.

## Verification profile

Choose the profile from `docs/development/ORCHESTRATION.md`; the rules are not repeated here.
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
