# Branching and integration

This file owns Git/PR mechanics. Verification profiles live in
`ORCHESTRATION.md`; review semantics live in `JUDGE.md`.

## Shape

```text
main <- dev <- slice/<claim>
```

- **`main`**: integrated state promoted after an independent review of the whole
  release/integration boundary.
- **`dev`**: current integration branch for completed slices.
- **`slice/<claim>`**: short-lived branch for one coherent change.

`dev` exists because integration and release confidence are different questions.
If that distinction stops buying evidence, remove the branch rather than defend
it by tradition.

## Slice rules

1. Normal work starts on `slice/<claim>`, not directly on `main`/`dev`.
2. A STANDARD or CRITICAL slice owns one primary claim.
3. Coherent independent FAST maintenance changes may share a slice/PR when they
   remain separately reviewable.
4. Do not build deep PR stacks. If slice B materially depends on A, integrate A
   into `dev`, then rebase/branch B from the new integration state.
5. Delete the work branch after merge.
6. Integrate with a merge commit, not a squash. Once the branch is gone, the
   subject `Merge pull request #NN from <owner>/<branch>` is the local witness
   `node .claude/deleghe.mjs riprendi` uses to derive that a delegation's work
   is integrated; a squash erases it and finished work shows up as live again.

A good slice title can state the claim without an unrelated "and".

## Before implementation

Record in the PR or work handoff:

- the claim;
- FAST / STANDARD / CRITICAL profile;
- what evidence could falsify it;
- any owner decision that genuinely blocks the shape.

Open a draft PR early when the work is substantial enough that a durable remote
checkpoint buys recovery/reviewability. A trivial FAST edit does not need a
ceremonial draft lifecycle.

## Integration checkpoints

### 1. Scope is stable

The claim and profile are explicit. Architectural decisions that cannot be
recovered from code have the appropriate ADR/current authority update.

### 2. Claim is implemented and evidenced

The branch contains the code/docs and the evidence budget required by
`ORCHESTRATION.md`.

Do not replace evidence with "CI will catch it". Do not replace CI with a local
run when the actual merge gate requires CI. Report what was actually observed.

### 3. Slice -> `dev`

Two doors, one guarantee — a merge lands only on evidence the hook can verify
in that moment (`.claude/hooks/guard-merge-gate.mjs`):

- **local**: `npm run merge -- <pr>` builds the merged result in a throwaway
  worktree, runs `ci:local` on it, merges only on PASS;
- **GitHub**: `gh pr merge` passes the hook when the PR is OPEN, not a draft,
  on `dev`, `mergeStateStatus` is CLEAN, and the head carries the nominal
  FAST (`verifica`) and DEEP (`accettazione`) successes — `skipped` satisfies
  neither — with every other check-run on the head green and none pending.
  Source-public preparation deliberately makes the PR workflows materialize on
  every PR: `dco`, `verifica`, `accettazione`, `install`, `collegamenti`
  and `strumenti` are stable check names instead of trigger-level path-filter
  accidents. Any doubt falls back to the local door.

What CLEAN does and does not prove: it says no conflict is known with the
base right now and the associated status is green. GitHub CI runs on the PR
merge-ref snapshot of that event, so this is evidence about the composition
tested in that run — not proof the base stood still afterwards, and not
byte-identity with the tree the server will merge. Strict up-to-date
semantics waits for branch protection or a merge queue. Until then the local
door stays the composition-strong door: it executes the merged tree itself.

The old docs-only exception is retired. GitHub documents a workflow skipped by
trigger-level `paths` / `paths-ignore` as a permanently Pending required
check; by contrast a conditionally skipped **job** concludes successfully.
Therefore PR-level path filters are not part of the source-public gate. If
runner optimization returns later, do it at job level while preserving the
stable required-check surface.

Draft convention for substantial agent work: open the PR as a draft early
(durable remote checkpoint, per above), so intermediate pushes pay FAST only;
mark ready when the claim is integration-grade — `ready_for_review` starts a
fresh run with DEEP. A draft never passes the GitHub door.

Required evidence still follows the profile:

- **FAST**: orchestrator integrates after relevant checks + diff review.
- **STANDARD**: orchestrator integrates after claim-appropriate evidence and the
  normal integration checks available for the repository.
- **CRITICAL**: requires a fresh independent `JUDGE.md` verdict `MERGE` on the
  relevant head before integration.

A change in `dev` invalidates only evidence whose production path/test/contract
was materially touched. Evidence is reusable by commit/head, not globally reset
by every merge.

### 4. `dev` -> `main`

This is an integrated-system checkpoint, not a replay of every slice review.
Run the suite/journeys appropriate to the release boundary and review the
composition of changes since the previous promotion.

Honest current mechanics (reconstructed from git history, 2026-09-18 — not a
policy, a fact): promotion is a fast-forward of `main` to a `dev` commit,
outside both merge doors. Neither the hook (which only sees `gh pr merge`
commands) nor `npm run merge` (which refuses non-`dev` bases) participates,
and with branch protection unavailable nothing server-side checks anything
before the ref moves. The `main`-push CI fan-out is therefore kept on purpose:
it is the first execution of CI on the exact promoted commit, since nothing
runs on pushes to `dev`. Do not narrow the `main` push trigger until a real
pre-promotion gate tests the promotion commit and proves the post-push run
adds no signal.

## Integration is not the end of the task

After a successful merge, run the task-bookkeeping closure owned by
`ORCHESTRATION.md` before calling the deliverable DONE or selecting the next
one. That closure owns issue/PR truth, authoritative-home reconciliation,
residual classification, branch hygiene and the final re-observation.

Useful narrow helpers may detect drift (for example the current handoff
reconciliation checker and `npm run igiene`), but they are evidence for the
portable bookkeeping contract, not the contract itself. Do not make a
Claude-specific hook the only way task closure happens.

A task whose code is merged but whose issue/docs/branch state still describes the
pre-merge world is **integrated but not closed**.

## CI and branch protection are observed facts

Do not encode temporary GitHub quota, branch-protection availability or current
plan limits as permanent branching policy.

At integration time, observe which checks/protections actually exist and report
limitations. A convention is not an enforced gate merely because this file says
it should be one.

Observed 2026-09-21: the repository is still private on GitHub Free for
organizations. Hosted jobs are currently failing before useful execution under
the account billing/quota state, and branch protection/rulesets are unavailable
for this private repository (GitHub returns 403 and requires a paid plan or a
public repository). The local `npm run merge -- <pr>` door therefore remains
the enforceable integration gate before source-public.

The workflow shape is nevertheless prepared for the visibility cutover:
pull-request workflows have no trigger-level path filters; external PRs get an
early DCO preflight before the expensive `verifica` job; and first-party
Actions are pinned to immutable commit SHAs. Once public hosted CI has produced
real green checks, configure branch/ruleset protection against the stable check
names rather than treating this prose as enforcement.

## Commits are recovery points, not activity counters

Commit a coherent verified unit before a risky transition or when losing the
worktree/context would be materially expensive. Do not create a commit per file
or per thought.

The PR tells reviewers what claim is being promoted; Git history tells them what
changed; evidence tells them why the claim should be believed.

## La stash è condivisa, quindi non è un posto dove lasciare lavoro

`git stash` non appartiene al worktree in cui lo esegui: la pila è **una sola
per repository** e la vedono tutti i worktree, compresi quelli di altre
sessioni che lavorano in parallelo. Un `git stash pop` fatto altrove estrae la
*tua* voce, in un albero che non è il tuo.

Misurato il 2026-09-04: una fetta aveva parcheggiato in `stash@{0}` la metà di
due lavori che non poteva integrare (il file era in riscrittura altrove) e
l'aveva dichiarata in una PR come se fosse un luogo di conservazione. Nella
stessa notte, un'altra fetta si era già accorta di aver lasciato una voce non
ripresa, perdendo dal proprio albero quattordici file di correzioni già fatte.

Quindi:

- **Per mettere via del lavoro, fai un commit WIP su un ramo e spingilo.** Un
  ramo remoto è l'unica forma durevole; un file di patch in `/tmp` non lo è, e
  la stash nemmeno.
- **Se devi proprio usare la stash**, mai `git stash` e `git stash pop` nudi:
  `git stash push -u -m "<etichetta-unica>"`, prendi subito lo SHA della tua
  voce con `git stash list --format='%H %gs'`, e recupera con
  `git stash apply <sha>` — mai `pop`, che prende la cima della pila e la cima
  può non essere tua.
- **Una PR non può rimandare alla stash.** `stash@{0}` non è un riferimento
  stabile: cambia numero a ogni push altrui e sparisce a ogni pop altrui.
