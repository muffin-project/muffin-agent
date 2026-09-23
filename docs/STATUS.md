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
