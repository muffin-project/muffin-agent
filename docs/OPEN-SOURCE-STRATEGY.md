# Open-source, distribution and community strategy

This document owns the **distribution/community shape** of Muffin. It is product
strategy, not a claim that every item below already exists.

The repository may become **source-public/pre-alpha before the product reaches
public alpha**. Public source means people can inspect and contribute to the
project; it does not mean Muffin is stable, supported for general users or ready
for a public product recommendation.

`THESIS.md` owns why Muffin exists. `VISION.md` owns the product destination.
`ARCHITECTURE.md` owns the current semantic runtime shape. `EXTENSIONS.md` owns
the extension/capability design direction. DAY-1 status remains in
`docs/work/day1/requirements-status.md`.

## 1. Owner-run is the default product

One installation is one logical personal agent whose durable continuity is under
the owner's control.

The project does **not** need to host every owner's runtime, memory, turns or
database.

Supported deployment shapes may include:

```text
Desktop → home node / NAS → owner's VPS → future dedicated appliance
```

A hosted multi-tenant Muffin would be a separate product with different privacy,
economics and security boundaries. It must not appear accidentally because
central hosting makes onboarding easier.

The product invariant is:

> **Central infrastructure may simplify birth; it must not be required for
> life.**

Project-operated services may host downloads, release metadata, documentation,
registry/catalog metadata, OAuth bootstrap or provisioning helpers. An already
installed Muffin should continue to retain identity, memory and work if those
services disappear.

## 2. Self-hosted must become consumer-grade

Ownership does not justify developer-only installation.

The normal public path should approach:

```text
Download Muffin
→ choose provider / local inference path
→ connect desired surfaces/capabilities
→ enable startup
→ talk to Muffin
```

Node, npm, SQLite, PATH, launchd/systemd, token files and schema migrations may
remain implementation details. A normal user should not need to understand them
to complete the supported setup.

Source clone remains a contributor/advanced-user path, not the product UX.

### Local control plane

A desktop/control UI is useful as the **cofano** rather than a second agent:

- health and runtime status;
- model/provider and privacy mode;
- spending/budgets;
- open work, waits and approvals;
- surfaces and installed extensions;
- authority grants;
- update/backup/restore/rollback;
- diagnostics and self-inspection.

Conversation may remain primarily on Telegram, voice or other natural surfaces.

## 3. Personal-data acquisition is a first-class product path

Muffin should reduce cold start by connecting to data the owner already has.

Preferred order:

1. connector/API/standard adapter when appropriate continuous access exists;
2. official platform export when continuous access is unavailable or unwanted;
3. a guided nudge that explains how to obtain and import the archive;
4. bespoke scraping/parsing only when the source is stable and the value merits
   the maintenance cost.

Examples include Gmail/Calendar/Contacts/Drive/Photos, browser history, chat
archives, code history, health data and filesystem archives.

Imports must preserve epistemic distinctions:

- original source;
- original event time when available;
- import time;
- speaker/authorship separately from account ownership;
- provenance/trust;
- `imported` separately from native observation/inference.

An email in the owner's mailbox is not automatically owner speech.

The old Muffin database is **not** a required migration source for this rebuild
(ADR-0049). Future legacy import remains opt-in.

## 4. Portability is semantic, not a DB-copy trick

Before stable public releases, Muffin needs a versioned canonical export/import
story for continuity-bearing meaning.

Preserve:

- evidence/provenance;
- identity and constitutional state;
- corrections/retirements/owner-controlled forgetting semantics;
- unfinished work;
- effect intent/outcome information;
- durable grants/authority where appropriate.

Rebuild:

- embeddings;
- vector/FTS indexes;
- summaries/profiles/digests;
- ranking/cache/materialized views.

The eventual test is not merely "copy `muffin.db`". It is that a newer Muffin on
a different machine/model can continue without rewriting the owner's history.

## 5. Forgetting belongs to the owner

Continuity cannot mean accidental immortality of every byte.

The public product eventually needs explicit semantics for:

- correction/supersession;
- retention;
- deletion/forget requests;
- tombstones necessary to prevent resurrection;
- export and purge.

Auditability is not a justification for retaining content the owner deliberately
asked to remove.

The precise contract is a pre-stable-release architectural decision, not a
DAY-1 feature unless dogfood makes it necessary sooner.

## 6. Cloud inference is an explicit privacy choice

A cloud LLM provider receives the context sent to it. Public UX should make that
fact inspectable rather than treating provider selection as only a quality/cost
choice.

Longer term, Muffin should support a boundary such as:

```text
local-only data ───────► local compute
cloud-allowed data ────► optional local privacy transform ─► provider
```

A local privacy transform is optional/pluggable. Rizzo PII is a strong candidate
for Italian-first reversible PII replacement; other models/filters can fit the
same contract. Detection is best-effort and must never be presented as the
structural secret guarantee.

## 7. Core narrow, ecosystem broad

Open source will multiply integration requests. The response is not to merge
every useful service into core.

Core owns continuity and the boundaries required to compose capabilities safely.
Third-party services and niche workflows should normally arrive through the
extension ecosystem described in `EXTENSIONS.md`.

The important distinction is:

```text
package installed ≠ authority granted
```

The catalog can grow while each owner installs only what they need.

## 8. Community extension catalog

A future catalog is primarily **metadata + curation**, not runtime hosting.
Artifacts may live in GitHub releases, package registries or signed archives.

A listing can expose:

- publisher/namespace identity;
- immutable version/artifact digest;
- requested capabilities;
- filesystem/network/secret/effect authority;
- supported platforms;
- maintenance/security contacts;
- validation/review tier;
- permission changes from the previous version.

Public listing never bypasses the local policy kernel.

Possible quality states:

```text
Local/Unlisted → Community → Reviewed → First-party
```

These communicate provenance/maintenance/review, not universal safety.

## 9. Contribution policy follows the narrow waist

The common contribution paths should be obvious **before the repository becomes
public**, not postponed until product public alpha:

- bug/security/cross-platform fix in core;
- new extension or importer outside core;
- documentation/eval improvement;
- proposal for a new core primitive only when multiple capabilities require a
  boundary the core does not yet expose.

This mirrors a healthy pattern visible in mature agent repos: breadth goes to
extensions/skills/plugins; core changes carry a higher evidence burden because
they expand the trusted base and affect every installation.

`CONTRIBUTING.md` is the external contributor router. It links to the canonical
working rules instead of duplicating them. The repository's important invariants
must remain executable by humans and agents that do **not** use Claude Code;
Claude-specific hooks/skills may improve ergonomics but must not be the only
place a contribution rule exists.

Early contribution does not imply maintainer authority. A contributor can submit
useful work before the product is publicly released; maintainership is earned
through observed work and judgement over time.

## 10. Source-public/pre-alpha and product public-alpha are separate milestones

The owner wants the repository open source as soon as it is safe to publish, and
several people are already interested in contributing. Therefore the earlier
assumption that contributors only emerge after public alpha no longer holds.

What remains valid is the stronger statement:

> **Do not grant co-maintainer authority merely because somebody arrived early.**

A repository can be public while the product is explicitly pre-alpha and owner
dogfood is still running.

Preferred progression:

```text
owner RETURN / source-public preparation may overlap
→ repository source-public/pre-alpha when publication is safe
→ owner 14-day dogfood
→ 2–5 deliberately different trusted-alpha users
→ product public alpha
→ contribution volume grows
→ maintainership is earned through observed contributions
```

Interested contributors may participate before public alpha through scoped
issues/PRs, review, documentation/evals, cross-platform work and extension
experiments. This is useful pressure on hidden founder context; it does not make
them public-alpha testers by default.

Trusted-alpha selection should still cover different failure surfaces rather than
five copies of the founder: macOS, Linux/VPS, technical non-contributor,
less-technical user, and someone with security/open-source instincts where
possible.

The product-alpha question remains:

> can you install, understand, update, recover and use Muffin without calling the
> founder?

## 11. Publication safety comes before changing repository visibility

Making a private repository public exposes more than current HEAD. Before the
visibility change, treat publication as a privacy/security boundary and inspect
**the full Git history**.

The minimum publication claim is:

- no secrets, API keys, tokens, credentials or private signing material in HEAD
  or history;
- no owner personal data, private conversation dumps, private Muffin Home data,
  sensitive machine-specific paths/content or artifacts that cannot become
  public;
- a deliberate decision on whether existing history can be published intact or
  needs rewriting before visibility changes;
- the intended license is explicit rather than accidental package metadata;
- public/root documentation clearly says source-public/pre-alpha when the product
  is not public-alpha;
- `CONTRIBUTING.md` gives an external human/agent enough context to submit one
  scoped claim without founder-only instructions;
- there is a minimal security-reporting/support route appropriate to pre-alpha
  source, without inventing a stable-product SLA;
- issue/PR templates and branch/integration rules are understandable to people
  who did not participate in the rebuild.

Publication safety is a **CRITICAL boundary** where relevant, even if many of the
resulting documentation edits are individually FAST.

Source-public work must not become a cosmetic blocker for owner dogfood. If the
privacy/history audit finds a real publication blocker, fix it before changing
visibility; otherwise product capability work and community polish may continue
in parallel.

## 12. Public-release repository surface grows progressively

Some community surface is required for source-public/pre-alpha; more can be added
before product public alpha as the actual boundary becomes known.

### Before source-public/pre-alpha

At minimum:

- honest root/public maturity wording;
- `CONTRIBUTING.md`;
- publication/privacy/history audit;
- explicit license decision;
- a minimal security-reporting/support route;
- issue/PR contribution path that does not rely on founder-only context.

### Before product public alpha

Add or stabilize as evidence requires:

- consumer-oriented root README and install journey;
- security-reporting instructions appropriate for the released product boundary;
- issue forms/support boundary;
- version/release/channel policy;
- supported-platform matrix;
- changelog/releases;
- extension authoring/validation path;
- good-first issues derived from observed needs, not filler.

Do not write compatibility promises, support SLAs or a detailed security
disclosure process before the corresponding public product boundary is actually
known.

## 13. Licensing: decided pre-public (ADR-0078)

On 2026-09-14 the owner chose **AGPL-3.0-or-later**, superseding ADR-0019 (MIT).
Rationale, rejected alternatives (GPLv3, MIT/Apache, source-available) and the
dependency consequences live in `docs/decisions/0078-licenza-agpl.md`; the grant
is `LICENSE`, the SPDX field is in `package.json`, inbound rules are in
`CONTRIBUTING.md`.

Two things remain deliberately open and must not be silently assumed closed:

- the `Muffin` name/logo are outside the copyright grant (`TRADEMARK.md`);
  formal registration is deferred for budget, first-use evidence from 2026-09-14;
- without a CLA, relaxing the license later needs every external author's
  consent — the DCO-minimal vs CLA-light decision is due before accepting
  external PRs post-25.

## 14. Telegram as early distribution/surface leverage

Telegram is likely to remain an unusually useful early mobile surface, including
new bot provisioning and richer private-chat capabilities. It should be used
aggressively where it reduces onboarding/interaction friction without becoming a
required central trust dependency.

An optional project-operated Commander/managed provisioning path may simplify bot
creation, but a sovereign/manual path must remain where the manager relationship
would retain authority the owner does not want to delegate.

The runtime/database still belongs to the owner; a CommanderBot is a provisioning
surface, not a free hosted Muffin fleet.

## 15. Public docs are already distribution

People and automated agents already consume the public Muffin documents and
`giusto.dev`. Treat them as a real external API of the project's ideas.

The migration plan lives in `PUBLIC-NARRATIVE.md`: current claims, historical
snapshots and machine-readable surfaces must change coherently rather than
leaving `llms.txt` teaching an old architecture after the code has moved on.

## 16. What does not enter DAY-1 just because this document names it

Installer GUI, canonical capsule, marketplace, capability manifests, public
community governance, Telegram managed provisioning, external-data importers and
source-public polish are product/community direction. They enter the current
DAY-1 requirements only if the owner would otherwise be unable to start the
fourteen-day dogfood window or if a concrete privacy/security boundary makes the
work inseparable.

The first roadmap after DAY-1 should be driven by observed direct-interface
fallbacks, not by turning this strategy document — or an ecosystem audit — into
a feature checklist.