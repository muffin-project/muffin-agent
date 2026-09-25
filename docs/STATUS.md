# Muffin status

Muffin's source is **public · pre-alpha**. The product remains PRE-DAY-1. It is an owner-run runtime being
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
| Source-public / pre-alpha | Public source for inspection and scoped contributions; the product remains pre-alpha. |
| Product public alpha | A later product/release commitment, earned through real use and separate readiness evidence. |

The repository is already public. Continue handling privacy, security and
repository-readiness findings through their canonical issues; publication does
not claim the product is public alpha. Before public alpha, claims about
supported platforms, security response and product availability need their own
evidence; this document does not create those promises.

## NOW vs after source-public

**Now:** the repository is public at source-public / pre-alpha. This opens source
inspection and scoped contributions; it does not promise product support,
stable interfaces or public alpha. Continue tracking publication cleanup and
remaining release evidence in [issue #464](https://github.com/muffin-project/muffin-agent/issues/464).

**Source-public milestone:** reached on 2026-09-25. Contributor routing and
remaining repository cleanup continue through the issue graph.

**After source-public:** continue measured product and maintainer work through
its own issue owners. The broader maintainer control plane, capability
discovery, project familiarity and temporal salience are not prerequisites for
the source visibility change unless current evidence makes one a concrete
publication blocker. The System One/System Two architecture lane remains
independent work and is not duplicated by this release-preparation pass. Public
alpha remains a later boundary with its own evidence.
