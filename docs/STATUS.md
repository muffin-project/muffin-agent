# Muffin status

Muffin is **source-public / pre-alpha**. The repository became public on
2026-09-25, so its source can be inspected and contributions can be proposed
through GitHub. The product remains in development: this is not a product public
alpha, a stability promise, or a promise of general availability.

## Start here

- To install or evaluate the current checkout: [INSTALL.md](user/INSTALL.md).
- To understand the system's boundaries: [ARCHITECTURE.md](architecture/ARCHITECTURE.md) and
  [SECURITY.md](architecture/SECURITY.md).
- To contribute: [CONTRIBUTING.md](../CONTRIBUTING.md), then the issue and PR
  routes in GitHub.
- To understand the project's community and longer-term open-source direction:
  [OPEN-SOURCE-STRATEGY.md](project/OPEN-SOURCE-STRATEGY.md).

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
| Community Preview | Previous access boundary; it ended when the repository became public on 2026-09-25. |
| Source-public / pre-alpha | Current repository state: the source is public and contributions can be proposed. This does not mean the product is public alpha. |
| Product public alpha | A future product/release commitment, earned through real use and separate readiness evidence. |

Source-public describes repository visibility. It does not close remaining
privacy, security, history, or repository-readiness work, and it creates no
product stability or support promise. Before product public alpha, claims about
supported platforms, security response and product availability need their own
evidence; this document does not create those promises.
