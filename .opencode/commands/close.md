---
description: End a session cleanly. Reconciles Git, PR and issue state and reports exact position for the next session.
---

1. Run `/checkpoint` first — everything durable before anything else.
2. Reconcile: no hidden chat-only work remains; the working tree state
   (branch, clean/dirty, HEAD) is understood and stated.
3. Final compact report, exactly:
   - branch + HEAD SHA (short) and clean/dirty;
   - `main` / `dev` SHAs and their divergence;
   - open PRs that remain and why;
   - remaining WIP, blockers, and the next accepted action;
   - owner-only actions required, if any.

Do not start the next program of work. The next session begins with `/start`.
