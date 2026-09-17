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
- **GitHub**: `gh pr merge` passes the hook when the PR is OPEN on `dev`,
  `mergeStateStatus` is CLEAN (base ferma: il risultato unito coincide con la
  head), and every check-run on the head is green with none pending — any
  doubt falls back to the local door.

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

## Current-state reconciliation is part of integration

After an integration that changes active work, DAY-1 status or ordering:

- update the authoritative DAY-1 requirement only if its evidence/status changed;
- update `critical-path.md` only if ordering/dependency changed;
- update `docs/work/handoff.md` when live work/next action changed;
- do not update the retired `STATE.md` chronicle.

Run `.claude/riconcilia.mjs` when its checked surfaces are affected. Keep that
checker narrow: its job is to catch known handoff/PR/branch drift, not to become
a universal consistency engine.

## CI and branch protection are observed facts

Do not encode temporary GitHub quota, branch-protection availability or current
plan limits as permanent branching policy.

At integration time, observe which checks/protections actually exist and report
limitations. A convention is not an enforced gate merely because this file says
it should be one.

Observed 2026-09-26: GitHub minutes are back and CI runs per-PR, but branch
protection is unavailable (private repo on the free plan — 403 from the API),
so nothing server-side enforces green checks or blocks direct pushes; the hook
above is the enforcement for agent sessions until the 25/09 source-public
milestone unlocks protection. `ci.yml` skips `verifica` on docs/`.claude`-only
changes (`paths-ignore`): a PR that touches only those paths has almost no
GitHub evidence, and the hook's zero-check-run rule sends it to the local door.

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
