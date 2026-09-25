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

Open a pull request into `dev`. GitHub Actions and the active repository
ruleset are the sole integration gate; local commands can help diagnose a
change but cannot merge it or substitute for a required check. The current
ruleset requires a PR, an up-to-date branch, and these GitHub Actions checks:
`dco`, `verifica`, `accettazione`, `install`, `collegamenti`, and `strumenti`.
The required check source is GitHub Actions and there is no bypass actor.
Reconcile this list against GitHub when the ruleset changes.

A merge commit is required. Do not squash: the subject
`Merge pull request #NN from <owner>/<branch>` is the local witness
`node .claude/deleghe.mjs riprendi` uses to derive that a delegation's work is
integrated; a squash erases it and finished work shows up as live again.

GitHub evaluates the PR merge candidate. Strict up-to-date rules require the
branch to include the current base before merge, so a base advance invalidates
the old candidate checks. A successful head check is evidence for the tested
PR composition, not for a later changed head.

Required checks are stable on every pull request: do not use trigger-level
`paths` / `paths-ignore` on required workflows because an unstarted workflow
can leave a required check pending. Use job-level conditions only when skipped
jobs produce a successful conclusion and the complete required-check surface
remains enforced.

Substantial work can open a draft PR as a durable checkpoint. Draft checks may
skip `accettazione`; that is not complete acceptance evidence. Mark the PR ready
when its claim is integration-grade. The `ready_for_review` trigger starts the
full run, including acceptance.

Required evidence still follows the profile:

- **FAST**: integrate after relevant required checks and diff review.
- **STANDARD**: integrate after claim-appropriate evidence and all required
  Actions checks.
- **CRITICAL**: requires a fresh independent `JUDGE.md` verdict `MERGE` on the
  relevant head before integration.

A change in `dev` invalidates evidence whose production path, test, or contract
was materially touched. Evidence is reusable by commit/head, not globally reset
by every merge.

### 4. `dev` -> `main`

Promotion is a pull request from `dev` to `main`, subject to the same Actions
checks and active ruleset. Review the integrated changes since the previous
promotion and the release-boundary evidence. Do not move `main` by a local
fast-forward or treat a push-triggered run after promotion as the gate. The
required PR checks run against the promotion candidate; strict up-to-date rules
require current `main` before merge. The push-to-`main` workflows remain useful
as post-merge verification for their configured paths, but they do not authorize
the promotion.

## Current-state reconciliation is part of integration

After an integration that changes active work, DAY-1 status or ordering:

- update the authoritative DAY-1 requirement only if its evidence/status changed;
- update `critical-path.md` only if ordering/dependency changed;
- do not update the retired `STATE.md` chronicle.

## CI and branch protection are observed facts

Do not encode temporary GitHub quota, branch-protection availability or current
plan limits as permanent branching policy.

At integration time, observe which checks/protections actually exist and report
limitations. A convention is not an enforced gate merely because this file says
it should be one.

Observed 2026-09-25: the repository is public and the `muffin protected
branches` ruleset is active for `dev` and `main`. It requires pull requests,
strict up-to-date branches, the six checks named above, and has no bypass actor.
This is a time-bound observation, not a substitute for rechecking GitHub when
integration settings change.

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
