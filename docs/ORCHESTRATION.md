# Orchestration

This document owns **how repository work is selected, bounded, delegated,
verified and integrated**. It does not own Git mechanics (`BRANCHING.md`), review
rubrics (`JUDGE.md`), coding practices (`PRACTICES.md`) or current project state.

The central rule is:

> **Verification is proportional to the claim and its blast radius.**

The question is not "which checks exist?" but:

> **What is the minimum evidence that could falsify this claim?**

## 1. The control loop

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
`docs/blueprint/gate1/PERCORSO-CRITICO.md` and the relevant rows of
`docs/blueprint/M5-BIS.md`. A PR is an execution/checkpoint vehicle, not the
product's state machine.

## 2. Decision boundaries

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

## 3. Work is claim-oriented

A slice should make one coherent falsifiable claim. FAST maintenance items may be
clustered when they remain independently readable; STANDARD/CRITICAL work should
normally have one primary claim.

Do not use PR/session boundaries to define the product architecture. A claim can
survive a compact, rate limit or new worker because its evidence and Git state
survive them.

A draft PR is useful once scope and the primary decision are stable. Commit
coherent checkpoints before a long experiment can become the only place the work
exists.

## 4. Delegation is a context tool, not the default

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

## 5. Research budget

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

## 6. Verification profiles

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
- user-facing/Gate behaviour → appropriate acceptance;
- type/API/build surface → build/typecheck;
- failure path → only when the change introduces/modifies a material failure;
- mutation → only when the claim is specifically that a guard/wiring prevents
  something and could otherwise disconnect while tests stay green.

The full suite runs once at the integrated PR/head gate (normally CI), not after
every local commit. A fresh judge is not required; the orchestrator may integrate
an unambiguous STANDARD claim when its evidence budget is satisfied.

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

## 7. Profile escalation and evidence reuse

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

## 8. Scope firewall

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

## 9. Repository state and knowledge budget

Repository knowledge follows `docs/README.md`.

Update only the authoritative home whose meaning changed:

| Change | Home |
|---|---|
| literal mechanics/config/schema | executable source |
| current architecture semantics | `docs/ARCHITECTURE.md` |
| current security promise | `docs/SECURITY.md` |
| durable architectural decision/rationale | ADR |
| DAY-1 row/status/evidence | `docs/blueprint/M5-BIS.md` |
| DAY-1 ordering/dependency | `docs/blueprint/gate1/PERCORSO-CRITICO.md` |
| current WIP/next action | `docs/blueprint/LAVORO.md` |
| product destination | `docs/VISION.md` |
| general engineering lesson | `docs/lessons.md` |
| external/research evidence | dated `docs/blueprint/research/` |
| generated/visual view | regenerate/update the derived artifact if relevant |

Do not update history merely so it reads like HEAD. Do not put Gate counts in the
handoff or critical path. Do not put PR chronology in architecture/ADR. A current
finding that has no authoritative home is a signal to choose one, not to copy it
into several files.

## 10. Integration and stopping

A claim is closed when:

> **the claim is satisfied, its profile's evidence budget is satisfied, and no
> known blocker invalidates it.**

Integration mechanics live in `BRANCHING.md`.

After integration:

1. observe the resulting Git/runtime state;
2. update M5 only if Gate status/evidence changed;
3. update critical path only if order/dependency changed;
4. keep LAVORO as the smallest useful next-session handoff;
5. regenerate relevant derived views;
6. do not refresh historical audits into current state.

For a multi-slice goal (notably DAY-1), individual green PRs do not replace an
integrated final check. The final reviewer asks whether the **assembled system**
still satisfies the goal.

## 11. Anti-metric

> **Judge the workflow by material errors caught per unit of time/context, not by
> the number of proofs, agents, documents or review rounds produced.**

A verification step that cannot plausibly change the verdict is ceremony. It
consumes the same context and attention needed by a check that can.
