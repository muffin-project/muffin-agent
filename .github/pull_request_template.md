<!--
A PR states one claim and shows the evidence budget that could falsify it.
Verification profiles live in docs/development/ORCHESTRATION.md; do not recreate them here.
Delete optional sections, not the claim/profile/evidence record.
-->

## Claim

<!-- One falsifiable sentence: what becomes true if this PR lands? -->

## Verification profile

**FAST / STANDARD / CRITICAL**

<!-- Why this profile? Name the boundary/blast radius, not the diff size. -->

## Evidence required by this claim

<!-- The minimum evidence that could prove this claim false. Examples: targeted
unit/integration/acceptance, build/typecheck, mutation of one load-bearing seam,
fault injection, real-binary/owner-machine path. Do not list checks merely
because they exist. -->

- 

## Observed evidence

<!-- Commands/scenarios and observed result. For a bug/fix, record the pre-fix
failure when the profile/practice requires it. A subagent report alone is not
evidence. -->

- 

## Decisions made here

<!-- Only durable decisions actually taken by this PR. Link an ADR when the
choice merits one. Owner/security/product decisions that required instruction
should name that instruction rather than hiding it in the diff. -->

## Known residuals / follow-ups

<!-- Findings outside the claim stay visible without silently expanding scope. -->

## Bookkeeping inputs

<!-- Before merge, name the authoritative homes this change makes stale and any
residual finding that must survive the session. Update only sources whose
meaning changed; research/history is not "refreshed" into current state.
After merge, the owning task is not DONE until the repository-level bookkeeping
closure in docs/development/ORCHESTRATION.md has been completed. -->

- [ ] Authoritative homes made stale: none
- [ ] Residual/follow-up state is either empty or durably owned

## Contributor agreement

- [ ] I have read `CONTRIBUTOR_AGREEMENT.md` and signed off every commit in this
      PR with `git commit -s`.
