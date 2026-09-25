# Orchestration

This document owns **how repository work is selected, bounded, delegated,
verified and integrated**. It does not own Git mechanics (`BRANCHING.md`), review
rubrics (`JUDGE.md`), coding practices (`PRACTICES.md`) or current project state.

The central rule is:

> **Verification is proportional to the claim and its blast radius.**

The question is not "which checks exist?" but:

> **What is the minimum evidence that could falsify this claim?**

## The control loop

Work is a control loop, not a TODO loop:

```text
OBSERVE
  ↓
RECONSTRUCT REAL STATE
  ↓
CHOOSE ONE DELIVERABLE / CLAIM
  ↓
FIND DECISION FORKS
  ↓
RESEARCH ONLY WHAT CAN CHANGE THE DECISION
  ↓
CLASSIFY VERIFICATION PROFILE
  ↓
IMPLEMENT / DELEGATE
  ↓
VERIFY THE CLAIM
  ↓
INTEGRATE
  ↓
UPDATE ONLY THE AUTHORITATIVE HOMES MADE STALE
  ↓
OBSERVE AGAIN
```

Observed Git/worktree/PR/check/delegation state is part of observation. A handoff
file is not allowed to override reality.

For DAY-1, the deliverable is selected from
`docs/status/day1/critical-path.md` and the relevant rows of
`docs/status/day1/requirements-status.md`. A PR is an execution/checkpoint vehicle, not the
product's state machine.

## Decision boundaries

The orchestrator should not ask the owner to make routine implementation choices,
and should not silently make decisions whose cost belongs to the owner.

| Decision | Default behaviour |
|---|---|
| Local/reversible implementation detail | decide and proceed |
| Reversible architecture with low blast radius | analyse, state the choice, proceed |
| Irreversible architecture | stop with options + recommendation |
| Product scope/behaviour | stop with options + recommendation |
| Security/privacy boundary | stop with options + recommendation |
| Durable data/schema/migration shape | stop with options + recommendation |
| Materially expensive fanout/research | show cost/alternative, ask owner |

Stopping does not mean asking "what do you want?". It means doing the analysis
first: options, trade-offs, recommendation, and the exact decision required.

## Work is claim-oriented

A slice should make one coherent falsifiable claim. FAST maintenance items may be
clustered when they remain independently readable; STANDARD/CRITICAL work should
normally have one primary claim.

### Scope follows the outcome, not a firewall

One primary outcome is a centre of gravity, not a prohibition on repairing what
the work exposes. Fix an opportunistic finding in the current slice when it is
local, reversible, well understood, economically testable, does not collide
with another writer, and neither changes product behaviour nor silently changes
authority, privacy, security or durable-data semantics. Keep the repair visibly
isolated in the diff when it is technically unrelated.

Escalate rather than absorb a finding when it needs an owner/product choice, a
security/authority decision, a risky migration/data-loss trade-off, or an
architecture costly to reverse. Bring the evidence and a recommendation; do not
turn an obvious one-line repair into a new issue merely to preserve a ceremonial
scope boundary.

Do not use PR/session boundaries to define the product architecture. A claim can
survive a compact, rate limit or new worker because its evidence and Git state
survive them.

A draft PR is useful once scope and the primary decision are stable. Commit
coherent checkpoints before a long experiment can become the only place the work
exists.

## Delegation is a context tool, not the default

The orchestrator works directly when the task is local and clear.

Delegate when it buys at least one of:

- context isolation for a large investigation;
- genuinely independent parallel work;
- specialised expertise;
- fresh adversarial review;
- protection of the orchestrator's context from noisy exploration.

Do not delegate a single obvious tool call or a small mechanical edit merely to
create a worker hierarchy.

Before material fanout, use the repository's delegation budget tooling
(`.claude/deleghe.mjs preventivo <n>` where applicable). There is no universal
magic worker count: cost depends on context/tool use and the work's independence.
If a sequential plan buys the same information materially cheaper, prefer it.

A delegation is recorded before dispatch. A child killed by quota/session/529 is
PARKED/resumable rather than silently lost. The durable delegation record should
contain enough scope/evidence/next-action information for another worker to
continue without owner re-paste.

A worker summary is **not evidence**. Verify the load-bearing claims before acting
on them. Empty/placeholder output is failure, not completion.

### What parallel workers actually share

A worktree isolates the checkout. It does not isolate anything else, and three
things collide silently. All three were measured on 2026-08-26, with several
workers in flight at once.

**The scratchpad directory.** Two workers each wrote `pr-body.md` at the same
path; one of them found its PR body replaced by another slice's. Nothing
errored. Say it in the brief: temporary files get names of the worker's own,
never a generic one.

**The CPU.** A full suite that normally takes ~85s took 204s under load, and two
acceptance scenarios failed on *timeout* — not on an assertion. Rerun those
files alone before diagnosing: a timeout under contention is not a defect, and
an assertion failure is one even under load. Whichever way it goes, declare the
path in the PR instead of showing only the final green.

**The generated map.** `ancore.json` and `mappa.html` conflict between any two
slices that move cited lines — which is most of them. When that derived
projection is present, its maintenance instructions define the local git driver
and post-merge/post-rewrite hooks that keep "ours" through the
conflict and then regenerate — and, when clean, commit — the map once the
merge/rebase has actually finished, refusing instead of committing when a
citation shows genuine drift rather than a moved line. If a clone never
registered that, or you are resolving by hand, run `npm run mappa:regen` —
one command, both generators, `git add` included — never hand-edit the
artefacts. This is cheaper for the orchestrator to do once at merge time than
for each worker to attempt against a moving base.

## Research budget

Research is commissioned to change a decision, not to make the process look
thorough.

Use current primary documentation when:

- a dependency/API behaviour is unfamiliar or plausibly unstable;
- a library behaviour is load-bearing;
- a new dependency is proposed;
- a public/durable/outward-facing shape is being designed;
- current ecosystem prior art can materially change the architecture.

Reuse a clear local precedent for private/reversible work instead of repeatedly
researching the same shape.

For agent/repository architecture, compare relevant current systems (for example
OpenAI/Anthropic guidance, OpenClaw, Hermes) as prior art, then choose the
smallest shape that fixes a measured Muffin failure. Peer architecture is input,
not authority.

Research belongs in dated evidence documents when it has durable value. Current
architecture/product/security decisions belong in their authoritative homes,
not in the research report.

## Verification profiles

Choose the profile **before implementation** and record it in the PR. Diff size
does not choose the profile; the guarantee does.

### FAST

Use for documentation, handoff/state, generated views, test-only work,
formatting and mechanical changes that do not alter runtime behaviour or a
contract.

Required by default:

- directly relevant check;
- diff read;
- generator/anchor check when the changed artifact has one;
- normal PR CI when available.

Not required by default:

- red-first;
- mutation;
- integration/E2E;
- real-binary acceptance;
- full local suite;
- fresh judge;
- updating every document.

Several coherent independent FAST fixes may share one maintenance PR.

### STANDARD

Default for ordinary reversible runtime/product work that does not touch a
CRITICAL guarantee.

Evidence follows the claim:

- bug/fix → reproduce or red-before;
- local logic → unit;
- cross-module boundary → integration;
- user-facing/DAY-1 behaviour → appropriate acceptance;
- type/API/build surface → build/typecheck;
- failure path → only when the change introduces/modifies a material failure;
- mutation → only when the claim is specifically that a guard/wiring prevents
  something and could otherwise disconnect while tests stay green.

The full suite runs once at the integrated PR/head gate (normally CI), not after
every local commit. A fresh judge is not required; the orchestrator may integrate
an unambiguous STANDARD claim when its evidence budget is satisfied.

Integration into `dev` and promotion to `main` use pull requests, GitHub Actions,
and the active ruleset described in `docs/development/BRANCHING.md` §3–4. Local
tests and `npm run gate:local` can support investigation, but their results do
not authorize integration or replace required Actions checks.

### CRITICAL

Automatic when the claim touches a boundary whose failure can silently lose or
duplicate work/data, violate authority/privacy, leak secrets, or execute unsafe
effects. This includes at least:

- effect WAL/journal and non-rerunnable/irreversible effects;
- authority/capability/policy kernel;
- taint/provenance and egress;
- Root of Trust and known-secret boundary;
- durable schema/migrations;
- backup/restore with data risk;
- concurrency/lease/lock/fencing;
- exactly-once/idempotency;
- crash recovery with loss/duplication risk;
- sandbox/containment;
- destructive operations.

Required evidence is strong **for that guarantee**, not for the entire product:

- reconstruct the production path;
- red-first/reproduction;
- wiring/integration proof;
- load-bearing mutation where a seam/guard is the claim;
- relevant failure/fault matrix;
- fault injection where the guarantee depends on crash/failure timing;
- real-binary acceptance when the claim depends on the binary/runtime path;
- full suite at the integrated head gate;
- authoritative docs updated when their meaning changed;
- fresh independent judge with terminal verdict before integration.

CRITICAL is not permission to run every test type ritualistically.

## Profile escalation and evidence reuse

Profiles may escalate when a hidden risk boundary appears:

```text
FAST → STANDARD → CRITICAL
```

Do not opportunistically downgrade after implementation because the fix became
small.

Evidence can be reused when it is pinned to the relevant branch/head and records
what was observed: command/scenario, pre-fix or mutation state, failure, success.
Worker → orchestrator → judge do not need to repeat the same proof merely because
ownership changed.

Repeat evidence when:

- relevant code/test changed;
- the previous evidence is incomplete;
- a reviewer has a specific reason to doubt what it proves;
- the new mutation/fault is itself the review question.

Merging `dev` invalidates only evidence materially affected by that change, not
the entire epistemic history of the PR.

### A stand-in cannot close a row the owner can see (2026-09-03)

The acceptance harness answers with a fake provider and a fake Bot API so the
suite is deterministic and free. That buys regression, and it is worth keeping.
It does **not** buy the claim that a thing works, and this repository has now
measured the difference twice in one day:

- B11/B13 were green on the fake harness while the Telegram surface was, to the
  owner's eye, deleting the steps of the turn it was reporting;
- the vault ingest was green in every test and **dead in production** — the
  hidden-file filter was applied to the resolved absolute path, the Muffin home
  is `~/.muffin`, and so every file the owner ever sent was refused as
  "hidden". Zero documents indexed, ever. The tests passed because a test home
  is a temp directory with no dot segment: they proved a machine nobody runs.

So, for any requirement whose subject is something the owner **sees or hands to
Muffin** — a surface's shape, an attachment, a voice note, a fetch, a search —
fake-harness green is a *precondition*, never the evidence that closes the row.
The row closes on an observation of the real thing: the local end-to-end lane
(`evals/e2e/`), or a capture of the real screen, or a query against a real
installation, dated in the row.

Two corollaries, both learned the same day. A fixture must be shaped like
production where the shape is what fails — a test home lives under a dot
directory because the real one does. And when a stand-in cannot reach the happy
path at all (no `getFile`, no real network), that is not a reason to call the
row proven by the parts it can reach: say what remains unproven, in the row.

## Scope firewall

A finding enters the current slice only if it:

1. invalidates the current claim;
2. prevents the claim from being verified;
3. creates a concrete current-use risk (data loss, duplicate effects, authority/
   privacy violation, unsafe silent behaviour) that makes the claim misleading;
4. is technically inseparable from the fix.

Otherwise record it as FOLLOW-UP/debt/evidence and finish the current claim.

> **"I found something improvable" does not mean "this PR must improve it."**

Repeated instances of the same failure form justify investigating a shared
primitive. One instance does not automatically justify a new framework.

## Repository state and knowledge budget

Repository knowledge follows `docs/README.md`.

Update only the authoritative home whose meaning changed:

| Change | Home |
|---|---|
| literal mechanics/config/schema | executable source |
| current architecture semantics | `docs/architecture/ARCHITECTURE.md` |
| current security promise | `docs/architecture/SECURITY.md` |
| durable architectural decision/rationale | ADR |
| DAY-1 row/status/evidence | `docs/status/day1/requirements-status.md` |
| DAY-1 ordering/dependency | `docs/status/day1/critical-path.md` |
| current WIP/next action | observed Git/GitHub, summarized by `scripts/agent/repo-state.mjs` |
| product destination | `docs/product/VISION.md` |
| general engineering lesson | `docs/evidence/lessons.md` |
| external/research evidence | dated `docs/evidence/` |
| generated/visual view | regenerate/update the derived artifact if relevant |

Do not update history merely so it reads like HEAD. Do not put DAY-1 counts in the
handoff or critical path. Do not put PR chronology in architecture/ADR. A current
finding that has no authoritative home is a signal to choose one, not to copy it
into several files.

## Integration and stopping

A claim is closed when:

> **the claim is satisfied, its profile's evidence budget is satisfied, and no
> known blocker invalidates it.**

Integration mechanics live in `BRANCHING.md`.

After integration:

1. observe the resulting Git/runtime state;
2. update the DAY-1 requirements only if status/evidence changed;
3. update critical path only if order/dependency changed;
4. leave issue/PR/SHA/check state truthful for the next fresh session;
5. regenerate relevant derived views;
6. do not refresh historical audits into current state.

For a multi-slice goal (notably DAY-1), individual green PRs do not replace an
integrated final check. The final reviewer asks whether the **assembled system**
still satisfies the goal.

## Anti-metric

> **Judge the workflow by material errors caught per unit of time/context, not by
> the number of proofs, agents, documents or review rounds produced.**

A verification step that cannot plausibly change the verdict is ceremony. It
consumes the same context and attention needed by a check that can.
