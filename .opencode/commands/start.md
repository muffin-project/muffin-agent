---
description: Deterministic fresh-session bootstrap. Reconstructs repository state and helps a contributor choose a compatible claim.
---

Current deterministic snapshot:

!`scripts/agent/repo-state.mjs`

You are starting fresh. You have NOT read any previous session. Do this now:

1. **Re-observe before acting.** If the snapshot may be stale, rerun `scripts/agent/repo-state.mjs`, `gh issue list --state open`, and `gh pr list --state open`.
2. **Navigate the issue graph.** Read candidate issue acceptance and its linked dependencies/PRs. There is no global current issue or required next issue.
3. **Claim one bounded scope in GitHub.** Assign yourself to the issue; if you cannot, comment with the contributor/agent identity, exact owned paths or behavior, and branch. Link the branch/PR back to the issue.
4. **Check for collisions.** Compare the proposed scope with other active issue claims, worktrees and changed files on open PRs. Parallel writers are fine when ownership and acceptance are disjoint. Coordinate or narrow scope when they overlap.
5. State the claim, falsifier, acceptance and FAST / STANDARD / CRITICAL verification profile from `docs/development/ORCHESTRATION.md`.
6. Load `docs/development/RESEARCH.md`, `BRANCHING.md` and `JUDGE.md` only when the claim makes them relevant. Follow `.agents/skills/engineering-loop/SKILL.md`.
