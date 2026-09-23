---
description: Make work durable before a risky transition, compaction or session exit. Commits, pushes, and aligns PR and issue state.
---

Do not exit, compact, rebase or merge until all of these hold:

1. **Working tree durable.** Coherent units are committed on the slice branch;
   the branch is pushed. No important change exists only in the working tree,
   the stash (shared across worktrees — never a store), or conversation memory.
2. **PR truthful.** The active PR's title, description, claim, profile and head
   match the actual branch. Draft status matches integration-readiness.
3. **Issue claim truthful.** The issue owned by this branch reflects actual
   scope and blockers; linked PR/head SHA/check state is current. Do not update
   or select a repository-wide current issue. Acceptance boxes need evidence pointers.
4. **Acceptance preserved.** The falsifier and acceptance for the current claim
   are written in the PR or issue — recoverable without this session.
5. Report any owner-only boundary you are stopped at (destructive action,
   privacy/security, product scope) with the exact evidence and action required.

Session and compaction summaries are disposable caches. Durability lives in
Git, PRs and issues or it does not exist.
