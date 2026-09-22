---
description: Close one completed deliverable. Persists post-integration bookkeeping before the next task starts.
---

This command closes a **task**, not a session.

A merge, green gate, worker return or issue comment is not enough. Follow the
canonical closure contract in `docs/development/ORCHESTRATION.md`.

Do this in order:

1. Re-observe the actual result:
   - merged/integrated SHA;
   - PR state;
   - current `dev`;
   - work branch state;
   - the one open issue carrying `program/current`.
2. Persist final evidence on the PR and owning issue. Close the claim issue only
   if its acceptance is satisfied; otherwise record the exact residual/blocker.
3. Reconcile only authoritative homes made stale. If none changed, record
   `authoritative homes: none`. Update `docs/development/handoff.md` only if
   live work or the next accepted action changed.
4. Classify every residual/follow-up: existing owner, genuinely new independent
   claim, or explicitly rejected/non-actionable. Leave nothing only in chat.
5. Do branch hygiene. Delete the integrated work branch when safe; run
   `npm run igiene` and give every unowned non-integrated branch an explicit
   keep/park/delete verdict. Never delete unintegrated work by appearance.
6. Re-observe once more. The next task must be recoverable from Git, GitHub and
   authority docs without this conversation.

Return exactly:

- TASK=
- RESULT_SHA=
- PR=
- ISSUE=
- AUTHORITATIVE_HOMES=
- RESIDUALS=
- BRANCH_HYGIENE=
- PROGRAM_CURRENT=
- NEXT=

Do not start NEXT. Task closure ends here.
