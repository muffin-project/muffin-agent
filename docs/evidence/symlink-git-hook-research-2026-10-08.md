# Symlinked `.git/hooks` vs the nested-hook deny (#865)

**Question commissioned:** can the #864 boundary (AppArmor `deny /**/.git/hooks/<active-names> wl`)
be extended to hook paths reached through a symlinked `hooks` directory, and in which shape?

**Status:** research, pre-implementation. Implementation waits for #864 (`codex/shell-nested-git-hook-862`)
to land, because it edits the same profile, leg and tests. No code changed here.

## 1. Measured behavior (2026-10-08, this session)

- **Git follows a symlinked hooks dir.** Local probe (macOS, system git):
  `git init nested`, hook `pre-commit` placed in `nested/redirected-hooks/`,
  `nested/.git/hooks` replaced by a symlink to `../redirected-hooks`, then
  `git commit --allow-empty` executed the hook (marker file created). Git's
  hook lookup is `$GIT_DIR/hooks/<name>` with normal filesystem symlink
  following — no configuration needed.
- **AppArmor mediates the resolved path.** Per the AppArmor 4.0 parser techdoc
  (cited in #865), policy paths are computed after pathname resolution, so the
  mediated path for the probe above contains `redirected-hooks/pre-commit`,
  which matches no `/**/.git/hooks/<name>` rule. The two facts together are the
  bypass: #864 denies the name, the symlink removes the name from the path.
  The AppArmor half is documentary (no AppArmor host here); it must be proven
  on Linux like #864 was.
- **Blast radius note from the probe:** hooks run with the committer's cwd at
  the worktree top level, so a redirected hook's relative paths already escape
  the nested directory. The threat is not confined to the nested repo.

## 2. Existing decision (why #864 stopped at direct paths)

#864's evidence doc records the limit explicitly: `nestedGitHooksDirs()` sees
only pre-existing repos; the host profile sees only resolved direct paths;
`core.hooksPath`/external gitdirs (#657) and symlink redirection (#865) are
separate cases. The claim was kept bounded so the shipped guarantee equals the
proven one. Nothing here reopens that bound retroactively.

## 3. Candidates

| # | Shape | Evidence for | Evidence against / risk |
|---|---|---|---|
| A | `deny /**/.git/hooks l` — deny *link* on the `hooks` path itself, keeping the filename `wl` denies | Smallest change (one rule). Symlink creation at `.git/hooks` is a `link` operation on that path; `git init`/`git clone` create a real directory (`mkdir`), not a symlink, so the #864 positive controls should keep passing. Pre-existing symlinked hooks dirs are visible to a `realpath` pre-scan (existing repos only — no timing gap there). | Unproven on Linux: AppArmor must mediate `symlink()` at that path distinctly from `mkdir()`, and no legit flow (templates, worktrees, clone) may need a symlink there. If either fails, A is dead. |
| B | Post-command verification scan: after each shell call, walk the workspace for active hook files/symlinks under any `.git/hooks` and quarantine-or-report | Catches everything regardless of mediation semantics. | Detection, not prevention; races an owner commit between the shell call and a later scan (narrow but real); quarantine is destructive and needs an owner decision; a new scanner is a new mechanism for a one-rule problem. Only if A fails empirically. |
| C | Declare symlink redirection out of threat model for now | Zero code; honest if the product risk is accepted. | A persisted silent hook firing on a later trusted commit is exactly the persistence #862 was opened for. Product/owner decision, not a maintainer default. |

Rejected without a row: parsing shell text for `ln -s` (same obfuscatable-parser objection as #864), broadening filename denies to `/**/.git/hooks/**` (breaks `*.sample` templates that #864 deliberately kept writable and would still miss resolved targets).

## 4. Falsifiers and kill criteria

- A **wins** iff, on hosted Linux CI: symlink creation at a fresh `nested/.git/hooks`
  is denied through the real `SandboxManager` door, `git init`/`git clone`/`git add`
  plus `*.sample` creation stay green, and removing the `l` rule turns the new
  test red with the same typed failure family.
- A **dies** if the `l` rule breaks any legit flow above or does not mediate
  `symlink()` distinctly — then B goes to the owner as a proposal, not as code.
- The empirical question (does `l` mediate here) is settled by a Linux run, never by prose.

## 5. Chosen direction (pending #864, pending Linux proof)

Candidate A as the implementation bet, with the pre-scan extended to refuse
pre-existing symlinked `hooks` dirs (fail-closed, same typed failure), a new
self-test leg attempting the #865 repro through the production door, and the
CI rule-removal mutation extended to the `l` rule. If the Linux run falsifies
A, stop and bring candidate B/C to the owner instead of stacking workarounds.

Peer note: no peer sandbox comparison was dispositive here — the question is
AppArmor mediation semantics plus Git lookup behavior, both primary-source and
locally probed above. Most peer sandboxes do not protect Git hooks at all;
that is absence of a mechanism, not counter-evidence.
