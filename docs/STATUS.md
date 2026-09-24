# Muffin status

Muffin is in **Community Preview · PRE-DAY-1**. It is an owner-run runtime being
hardened for real daily use, not a product public alpha and not a promise of
general availability.

## Start here

- To install or evaluate the current checkout: [INSTALL.md](user/INSTALL.md).
- To understand the system's boundaries: [ARCHITECTURE.md](architecture/ARCHITECTURE.md) and
  [SECURITY.md](architecture/SECURITY.md).
- To contribute: [CONTRIBUTING.md](../CONTRIBUTING.md), then the issue and PR
  routes in GitHub.
- To understand the path to an open/community project: [OPEN-SOURCE-STRATEGY.md](project/OPEN-SOURCE-STRATEGY.md).

## What is live, and what is not

Exact implementation, pull-request and check state are observed in Git and
GitHub. They are intentionally not copied into this file. The requirement-level
DAY-1 inventory is [status/day1/requirements-status.md](status/day1/requirements-status.md);
it is evidence-rich and should not be mistaken for a release dashboard.

Current work is observed from Git/GitHub, with `scripts/agent/repo-state.mjs`
providing a deterministic fresh-session summary. Dated plans are historical.

## Release boundaries

| Boundary | Meaning |
| --- | --- |
| Community Preview | Controlled external access to the private repository/runtime; the current boundary. |
| Source-public / pre-alpha | The source can be inspected and contributed to after privacy/history and repository-readiness gates are met. It is not product public alpha. |
| Product public alpha | A later product/release commitment, earned through real use and separate readiness evidence. |

Before source-public, the privacy/history boundary in the release work must be
closed. Before public alpha, claims about supported platforms, security response
and product availability need their own evidence; this document does not create
those promises.

## NOW vs after source-public

**Now:** the repository is still a private Community Preview. Source-public is
not authorized by this status page. The release decision is tracked in the
canonical GitHub publication issue; its live privacy/history proof, exact-head
security evidence and bounded VPS/group dogfood bar determine whether the
visibility boundary is met. See [the issue graph](https://github.com/muffin-project/muffin-agent/issues/464)
for current evidence and ownership.

**At source-public:** publish the repository as pre-alpha with a contributor
path that does not require a particular assistant or maintainer harness. This
opens source inspection and scoped contributions; it does not promise product
support, stable interfaces or public alpha.

**After source-public:** continue measured product and maintainer work through
its own issue owners. The broader maintainer control plane, capability
discovery, project familiarity and temporal salience are not prerequisites for
the source visibility change unless current evidence makes one a concrete
publication blocker. The System One/System Two architecture lane remains
independent work and is not duplicated by this release-preparation pass. Public
alpha remains a later boundary with its own evidence.
