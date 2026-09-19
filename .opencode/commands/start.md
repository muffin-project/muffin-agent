---
description: Deterministic fresh-session bootstrap. Reconstructs current repo state and selects one deliverable with claim, falsifier and acceptance.
---

Current deterministic snapshot (do not trust handoff prose over this):

!`scripts/agent/repo-state.mjs`

You are starting fresh. You have NOT read any previous session. Do this now:

1. **Re-observe before acting.** If the snapshot above looks stale (you just
   pulled, merged, or time passed), rerun `scripts/agent/repo-state.mjs` and
   `gh pr list --state open` yourself.
2. **Read the current program issue** named in the snapshot (it carries the
   `program/current` label). That issue — not any handoff file — owns what
   matters now.
3. **Read `docs/work/handoff.md` only as a disposable hint**, and fix it first
   if it contradicts what you just observed.
4. **Select exactly ONE deliverable**, then state in your reply:
   - the falsifiable claim (one sentence — what becomes true);
   - the falsifier (what observation would prove it false);
   - the acceptance (what closes it);
   - the verification profile (FAST / STANDARD / CRITICAL per
     `docs/ORCHESTRATION.md`) and why.
5. Load deeper authority (`docs/ORCHESTRATION.md`, `docs/RESEARCH.md`,
   `docs/BRANCHING.md`, `docs/JUDGE.md`) only when the claim makes it relevant.
   Follow `.agents/skills/engineering-loop/SKILL.md` from here on.
