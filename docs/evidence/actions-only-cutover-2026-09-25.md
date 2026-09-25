# Actions-only integration authority: cutover decision

**Date:** 2026-09-25  
**Observed repository:** public `muffin-project/muffin-agent`; `dev` at `db2bb7ac28d1c21f6113e18667361f7f4fa4364a`  
**Question:** after the source-public flip, should local workflow emulation remain an integration authority?

## Observed behavior

- GitHub reports the repository as public. Standard GitHub-hosted runners on public repositories are free; the official runner documentation describes those standard runners as unlimited. This does not apply to larger runners, and Actions still has other usage and storage limits. Sources: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- Ruleset `muffin protected branches` (ID `23974724`) is active on `dev` and `main`. It requires a PR, blocks deletions and force pushes, and requires up-to-date `dco`, `verifica`, `accettazione`, `install`, `collegamenti`, and `strumenti` checks from GitHub Actions. The bypass list is empty. GitHub documents strict checks as requiring the topic branch to be current with its base: [ruleset status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).
- The open PR heads were rerun after the public flip. At the time of this decision, all observed checks were green except #683 `install` (failed in `root-boundary.sh`: the runner rejected `/usr/local/bin` as writable by an untrusted identity before reaching the fixture's expected command-collision assertion) and #650 `accettazione` (still running). Draft PRs report `accettazione` as skipped; `.github/workflows/ci.yml` already includes `ready_for_review`, so the ready transition starts a run that evaluates the real job condition.
- `npm run ci:local` parses the GitHub workflow files and replays their jobs locally. `npm run merge` and the Claude pre-tool hook use it as a second merge authority. That duplicates the workflow's execution contract and leaves a local host/Docker verdict in competition with the now-active server checks.
- `npm run gate:local` is a separate developer diagnostic: it builds/tests a clean clone and has no merge operation. It is not needed on the public contributor path.

## Options considered

| Option | Evidence for | Counter-evidence / cost | Decision |
|---|---|---|---|
| A. Keep `ci:local` as an offline merge fallback | It can run when GitHub Actions is unavailable and gives a local reproduction path. | It reimplements workflow orchestration, depends on a maintainer Docker host, creates two verdict authorities, and can differ from hosted runner behavior. The branch ruleset already requires the GitHub checks. | Reject as integration authority. Keep ordinary local test commands and the distinct `gate:local` diagnostic for maintainers only. |
| B. Make GitHub Actions and branch rulesets the only integration gate | Exact PR head checks, GitHub's merge-ref/up-to-date handling, and enforcement are visible in the same system contributors use. Current ruleset and public-runner execution exist. | Requires Actions availability and successful jobs; false failures and runner differences must be fixed in the workflow or test, not bypassed locally. Draft-only skipped acceptance is not full acceptance evidence. | **Choose.** Remove `ci:local`, `merge`, `promote`, and the local merge hook; document the required Actions path. Keep CRITICAL independent-review policy as a separate review requirement. |
| C. Add a merge queue or another CI orchestrator now | Could serialize and test queued merge groups. | No observed integration race currently justifies another service/path; strict required checks already require up-to-date branches and force a rerun after base advances. | Defer unless merge contention or merge-ref evidence demonstrates a concrete gap. |

## Consequences and boundaries

- GitHub Actions is the only CI verdict used for integration to `dev` or promotion to `main`. Local commands remain useful for iteration but cannot merge, promote, or substitute for a required check.
- Required checks are source-pinned to the GitHub Actions integration. No branch bypass actor is configured. The ruleset intentionally does not impose a universal approval count; repository policy still requires a fresh independent `JUDGE.md` verdict for CRITICAL changes.
- `accettazione` is not proven by a skipped draft job. The existing `ready_for_review` trigger must be retained and verified on an integration-ready PR before calling its acceptance evidence complete.
- The #683 `install` failure is a concrete runner incompatibility in its root-only fixture. Keep that PR on HOLD until its owner resolves the expected-precondition mismatch and reruns the exact head; do not mark the failed check green by reinterpreting it.
- This change does not redesign System One/System Two, product execution loops, provider architecture, or the `gate:local` diagnostic.

## Falsifiers

Reverse or narrow this decision only if one of these is measured:

1. required Actions jobs cannot execute on the public repository or exact merge candidate;
2. GitHub rulesets do not enforce the selected check names/source and strict up-to-date behavior;
3. an integration path can land changes without the required checks;
4. a deterministic local check catches a production-relevant failure that hosted Actions cannot express, and moving that check into Actions is infeasible.

If a falsifier occurs, add the missing assertion to the hosted workflow or change the platform configuration before inventing a second integration authority.
