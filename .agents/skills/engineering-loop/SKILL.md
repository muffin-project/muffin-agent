---
name: engineering-loop
description: Run the repository development control loop — observe, reconstruct current, choose one deliverable, verify, integrate. Use when doing any multi-step engineering work in this repository.
---

# Engineering loop

This skill is the procedure. Authority for mechanics lives in the documents it
points to; this file does not restate them. If they diverge, the document wins.

## The loop

```text
OBSERVE → RECONSTRUCT CURRENT → CHOOSE ONE DELIVERABLE → identify decision forks
→ research only what can change the decision → classify routing → state one
falsifiable claim → define falsifier + acceptance → IMPLEMENT → VERIFY
→ INTEGRATE → reconcile only authority surfaces made stale → OBSERVE AGAIN
```

## Rules

- **Observed state wins.** Reconstruct from Git, worktrees, open PRs and their
  checks, and issue state before reading any handoff or summary. A handoff that
  contradicts observation is stale: fix it before choosing work.
- **Evidence precedence:** runtime / observed output > source / schema > tests >
  Git > canonical contracts > issue/PR state > handoff prose > history.
- **WIP write limit = 1 per repository.** One writer lane. A second writer
  needs genuinely disjoint ownership and independent acceptance. Read-only
  evidence workers are allowed alongside the writer.
- **A worker summary is not evidence.** Verify load-bearing claims yourself.
  A deterministic result is not re-audited without new evidence.
- **One claim per slice.** State it in one falsifiable sentence plus what would
  falsify it and the acceptance that closes it. No claim, no implementation.
- **Git / issue / PR state carries work across sessions.** No important state
  may exist only in conversation memory. Commit coherent units; push durable
  checkpoints; keep the active PR and the current program issue truthful.
- **Conversation and compaction summaries are disposable caches.** They never
  override re-observed state.

## Routing

- Verification profile (FAST / STANDARD / CRITICAL): `docs/ORCHESTRATION.md`.
  Budget follows the claim and its blast radius, not the diff size.
- Research/challenge pass, only when the claim triggers it: `docs/RESEARCH.md`.
  Simplifying or removing a mechanism is a valid result.
- Git/PR integration mechanics: `docs/BRANCHING.md`. Slice shape is
  `slice/<claim>` → `dev` → `main`.
- Independent review of CRITICAL claims: `docs/JUDGE.md`.
- Daily practices: `docs/PRACTICES.md`.
- Semantic judgment assistance: the `jev-shadow` skill. Jev never approves,
  merges, overrides deterministic evidence, or grants authority.

## Escalation

Decide routine reversible work and proceed. Stop with options, trade-offs,
recommendation and the exact decision required for: irreversible/destructive
action, privacy/security boundary, product-scope decision, durable high-cost
decision, or genuine ambiguity that changes the milestone contract.
Do not ask routine implementation questions.

## No hidden judgment

Do not encode architectural judgment into hidden hooks or plugins. Deterministic
local guardrails are appropriate only where they buy a concrete property
(secret exposure, destructive Git operations, protected-branch mutation,
recovery instructions during compaction, instrumentation). Repository
scripts, CI and GitHub remain stronger authority than agent hooks.
If no hook is required for a concrete property, do not add one.
