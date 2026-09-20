# Operating practices

This file owns **how work is performed while changing the repository**.
`ORCHESTRATION.md` owns control flow and verification profiles. `BRANCHING.md`
owns Git/PR mechanics. `JUDGE.md` owns independent CRITICAL review.

The default is not ceremony. A practice applies when its trigger applies.

## Reconstruct reality before editing

**Trigger:** every new task or resumed slice.

Observe before trusting prose:

1. current branch, diff and PR state;
2. the executable source relevant to the claim;
3. `docs/work/handoff.md` for the operational handoff;
4. `docs/README.md` to discover the authoritative document for the question.

Observed Git/runtime state beats a stale handoff. Historical documents never beat
HEAD for mechanical facts.

SessionStart injects `docs/work/handoff.md` automatically through
`.claude/hooks/inject-state.mjs`; it does not inject the old `STATE.md` chronicle.

## Read upstream before depending on upstream

**Trigger:** adding a dependency, using an unfamiliar external API, or relying on
behaviour that is unstable or load-bearing.

Prefer, in order:

1. official documentation/specification;
2. upstream source/types/tests when documentation does not settle the point;
3. a small local probe when the behaviour is still ambiguous.

A clear local precedent may be reused without repeating vendor research unless
the relied-on behaviour is security-, durability- or compatibility-critical.

A new dependency must justify what it replaces and why the existing runtime or
stdlib is insufficient.

## Prior art before durable shape

**Trigger:** designing a public, durable, expensive-to-change or agent-facing
shape: CLI, config/schema, file format, extension contract, workflow/harness,
repository knowledge architecture, contributor protocol or release boundary.

Before choosing the shape:

- inspect the field/vendor guidance that defines the contract;
- compare live implementations that solve a genuinely similar problem;
- for agentic repository/workflow decisions, include current OpenAI/Anthropic
  guidance and relevant active agent repos such as OpenClaw/Hermes when they
  illuminate the question;
- record only the differences that could change the Muffin decision.

Do not cargo-cult a peer. Start from Muffin's observed failure or requirement,
then use prior art to challenge the proposed shape.

Private reversible implementation details with a clear in-repo precedent do not
need a literature review.

## Parse at boundaries; preserve provenance

**Trigger:** untrusted or external data enters a process/domain.

Parse and validate at the crossing. Types derive from the parser/schema where
possible; a type assertion is not validation.

For model-visible or effect-bearing data, preserve the attributes that policy or
causality depends on: principal, tenant, provenance, taint, resource identity,
call/turn identity and effect state. Do not reconstruct them later from text.

## Model judgement and deterministic contracts stay separate

**Trigger:** about to encode a classifier, heuristic, ranking or decision in
code.

The model owns semantic judgement when the answer depends on meaning and context.
Code owns deterministic contracts when ambiguity would corrupt authority,
causality, durability or reproducibility.

Examples of code-owned contracts: schema validity, canonical resource/path,
permission/budget, taint monotonicity, ids/idempotency, leases/fencing,
transaction/migration semantics, secret boundaries and effect ordering.

A hard-coded semantic classifier needs a measured reason to exist and a way to
observe when it is wrong.

## Prove the claim, not the existence of code

**Trigger:** implementing or fixing behaviour.

Choose the FAST/STANDARD/CRITICAL profile in `ORCHESTRATION.md` before
implementation.

Then use the smallest evidence that can falsify the claim:

- bug/fix -> reproduce or red-before when STANDARD/CRITICAL requires it;
- local logic -> unit;
- cross-module contract -> integration;
- "production reaches this" -> wiring test;
- user-visible/DAY-1 behaviour -> appropriate acceptance journey;
- a guard/cut prevents something -> mutation when load-bearing;
- crash/concurrency/exactly-once -> relevant fault injection/matrix.

Do not run a larger suite merely because it exists. Do not skip a production
path merely because a unit test is green.

## Repair at the lowest layer that removes the class

**Trigger:** fixing a defect, especially one already seen before.

Owner directive, 2026-08-15, restated after the 2026-08-17 no-framework
correction: repair at the **lowest semantic layer that makes the invalid state
unrepresentable**, not at the widest layer you can plausibly redesign.

```text
line -> function -> contract between modules -> type/schema -> architectural boundary
```

Stop at the first level where the defect can no longer be expressed. Climb one
level only when the lower repair would leave the same class of invalid state
representable, recurrent, or structurally likely. A `void`-returning delivery
that cannot say "not delivered" is a signature problem, not three call-site
problems; an unreadable source that becomes `[]` is a representation problem,
not a `catch` problem.

Two occurrences justify **investigating** a common root, not building an
abstraction. A wider refactor is not more "root" because it is wider: "root"
means the smallest form that fails by itself — an exhaustive `switch`, a type
that forces the caller to handle the outcome, a mandatory sink in the
signature — instead of one that depends on someone remembering.

## Mechanise repeated or load-bearing rules

**Trigger:** the same mistake happens twice, or violating a rule would create a
material failure.

Escalation ladder:

```text
local comment / explicit contract
        -> targeted test/invariant
        -> deterministic checker
        -> hook / merge gate when enforcement is necessary
```

Mechanisms must themselves be tested against the failure they claim to prevent.
A checker that only checks its own output is not an independent guarantee.

## Persist findings in the right home

**Trigger:** a finding, decision or new evidence would otherwise live only in the
conversation/session.

Use `docs/README.md` to choose the owner:

- DAY-1 requirement/status -> `requirements-status.md`;
- DAY-1 ordering/dependency -> `day1/critical-path.md`;
- active work/handoff -> `docs/work/handoff.md`;
- durable architecture decision -> ADR;
- current architecture/security/product promise -> its current authority doc;
- research/audit/peer comparison -> dated evidence under `docs/evidence/`;
- generalisable engineering lesson -> `docs/evidence/lessons.md`;
- historical narrative -> history, not a current authority file.

Do not write the same fact into several homes "for consistency".

## Research is evidence, not authority

**Trigger:** committing external research/audit results.

A useful research artifact states:

- date written/verified;
- what source/version/commit it was checked against;
- the decision or question it was meant to inform;
- what was observed vs inferred;
- what remains unresolved;
- what new fact would invalidate the conclusion.

Use primary sources for technical contracts where available. Prefer a new dated
snapshot over silently rewriting an old audit into apparent current truth.

## Pure Muffin and one owner's data are different layers

**Trigger:** adding personality, defaults, examples, preferences or learned
behaviour.

- **Pure Muffin** ships: product identity, default persona/voice, primitives and
  constitutional/security floors.
- **Learned relationship/person model** belongs to owner data and evidence.
- **Governance/configuration** is explicit and inspectable; familiarity does not
  grant authority.

A personal fact must not enter repository defaults. A product identity property
must not depend on one owner teaching it after install.

## Keep operational context disposable

The handoff may contain the current objective, live PRs, blockers, owner decisions
and next action. It must stay small enough to inject whole at SessionStart and be
safe to delete without losing product knowledge.

Finished work moves out of the handoff. Git history, DAY-1 requirements/ADR/evidence and current
authority documents retain what matters.

## Documentation follows the claim

Update only the authoritative home whose meaning changed, plus a derived view if
it is genuinely generated/checked from that source.

An architecture-map projection, when checked in, is a **derived editorial
snapshot with verified anchors**, not executable truth. Its code citations can
be checked mechanically; its prose can still age. No such projection is present
in this checkout.

A docs-only change is not automatically harmless if it changes an instruction,
DAY-1 contract, security promise or generated consumer. Profile the claim, not the
file extension.
