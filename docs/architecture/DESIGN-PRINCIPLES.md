# Design principles

`THESIS.md` says why Muffin is worth building. `VISION.md` says where the product
is trying to go. This document says **how to decide** when multiple technical or
product shapes could satisfy them.

These principles are intentionally few. They are a decision compass, not a
replacement for evidence, architecture or the verification workflow.

## P1 — Neuroscience is a lens, not a blueprint

Biology and cognitive science are useful for identifying computational problems
and comparing solutions. They are not structures Muffin copies by default.

Before adopting a biological mechanism:

1. isolate the computational problem it solves;
2. verify that the problem exists here;
3. ask whether humans solve it well enough to be useful prior art;
4. choose the software mechanism that best satisfies the problem, even if it no
   longer resembles the biological metaphor.

A term such as consolidation, activation, decay or dreaming should be paired at
least once with a functional description independent of the metaphor. The name
may inspire the design; it must not smuggle in requirements.

## P2 — The double filter on cognitive harness

Every module that performs a cognitive operation faces two independent tests.

### Capability

Would a current frontier-class model do this better itself if given correctly
assembled context, tools and structured output?

If yes, custom cognitive code is scaffolding unless it provides another proven
property such as determinism, cost control or auditability.

### Existence

Is the computational problem real **here, now**?

If not, remove or defer the mechanism regardless of how elegant it is.

These tests filter harness that already exists. They do **not** justify refusing
the model a primitive it genuinely lacks. A model cannot reason its way into a
filesystem, browser, secret store or durable scheduler that the runtime does not
expose.

When evidence is ambiguous, simplify before replacing. Do not preserve a complex
mechanism indefinitely merely because its value is hard to measure.

## P3 — Separate what Muffin is, what Muffin learns and what an owner configures

Personalisation has different layers and each needs a different home.

### Shipped Muffin identity

A fresh installation must already be recognisably Muffin. The repository ships
its default persona/voice and constitutional identity floor in `defaults/`.

That is product identity, not owner memory. An open-source user should not have
to invent Muffin's personality before first use.

### Learned relationship and person model

Facts, preferences, patterns, interaction history and the evolving relationship
with one owner emerge from evidence over time. They belong to the owner's data,
not to repository code or a hard-coded founder profile.

The learned relationship may change register and interpretation; it does not
silently rewrite the constitutional identity floor.

### Explicit governance/configuration

Budgets, provider choices, hard security policy, installed capabilities and
other governable settings are explicit, inspectable and versioned where needed.
They are not inferred merely because Muffin has become familiar with the owner.

### Calibrated preferences

Some numeric/cadence choices — proactivity, notification spacing, thresholds —
may start as parameters and later become evidence-backed adaptations. Do not
bake personal taste into architecture merely because the first installation has
one owner.

The working question is always: **identity, learned data, governance, or
calibration?** If a design cannot answer, it probably mixes responsibilities.

## P4 — The model owns semantic judgement; code owns deterministic contracts

The model should handle the kind of judgement that depends on context, language,
ambiguity and changing world knowledge.

Code should enforce the contracts where ambiguity would corrupt state,
authority, causality or reproducibility.

### Good model-owned judgement

- what a request means;
- whether two descriptions probably refer to the same real-world concept before
  an explicit identity merge;
- what information is relevant to a question;
- whether an observation is worth mentioning;
- how to explain, summarise, compare and hypothesise.

### Good code-owned contracts

- authenticated principal identity;
- canonical resource/path representation;
- schema validity and actual calendar dates;
- durable ids and idempotency keys;
- taint monotonicity;
- permission/budget decisions;
- transaction and migration semantics;
- crash ownership/fencing;
- intent/outcome ordering;
- secret boundaries;
- deterministic protocol state.

The smell is not "code makes a decision". The smell is **hard-coded semantic
judgement that a correctly contextualised model can perform better and whose
errors are hard to observe**.

The permanent boundary: the model may interpret meaning and propose an effect;
it never grants itself authority.

## P5 — Proprioception before power

A system that cannot tell whether it worked should not receive more authority.

Traces, self-inspection, durable outcomes, explicit uncertainty and acceptance
that reaches the production path are not observability polish. They are the
precondition for acting safely in a system whose characteristic failure has
repeatedly been "mechanism exists, reports success, production does not actually
reach it".

Proprioception also enables lower-friction autonomy: a scoped grant can only be
earned if outcomes are observable enough to support or revoke it.

## P6 — YAGNI is active and symmetric

Every proposed feature faces two questions:

1. **Is Muffin materially broken without this for the current use horizon?**
2. **Does it advance the continuous agent by replacing a direct interface,
   improving continuity/understanding/presence, or exposing a boundary the core
   actually needs?**

If neither answer is yes, the feature waits.

But YAGNI cuts both ways:

- do not build a world-state database before a consumer proves its shape;
- do not refuse a browser capability the owner repeatedly needs merely because
  browser automation is "a feature";
- do not create manifests, registries or abstractions before something consumes
  them;
- do not keep custom plumbing when a mature library can own generic behaviour
  without weakening Muffin-specific guarantees.

Infrastructure/product-distribution work is judged by whether the product is
usable and maintainable, not whether it gives Muffin more personality. A
consumer installer can be essential even though it adds no cognitive insight.

## P7 — Principles are calibrated to a phase

These principles are durable guidance, not a claim that one phase lasts forever.

A private rebuild, owner dogfood, trusted alpha and public ecosystem create
different failure costs. For example:

- before DAY-1 a schema can still change aggressively;
- after real continuity accumulates, migration becomes a first-class obligation;
- before public release, a local integration can be founder-maintained;
- after a community forms, extension contracts, compatibility and governance
  matter much more.

At a phase transition, reread these principles whole. Change them when evidence
shows the instincts are miscalibrated; do not let a principle become doctrine
because it has an identifier.

## P8 — Muffin owns agency; models own replaceable cognition

Do not let the active model, provider, conversation or interface become the
accidental owner of durable agent state.

Muffin's continuity-bearing semantics must survive replacement of the cognitive
engine. The model may reason, interpret, propose, plan and communicate; Muffin
owns the durable identity of the relationship and the state required to continue
responsibly across turns and runtimes.

A proposed mechanism should therefore answer:

1. **What disappears if the current model/provider/session disappears?**
2. **Is that disposable cognition/context, or would losing it change what Muffin
   knows, owes, has done or may do?**
3. **Can a different model continue from bounded composed state rather than
   replaying the effective lifetime transcript?**
4. **Does a new surface/body reuse the same identity, Work, provenance,
   authority and effect semantics, or fork another assistant?**

Useful invariants are:

- model replacement is a context switch, not an identity reset;
- interface replacement is a transport switch, not a relationship reset;
- process restart is runtime recovery, not amnesia;
- untrusted information may change knowledge but must not silently expand
  authority.

This principle does **not** require a model router, MCP, distributed runtime or
multi-model execution feature today. Those are possible implementations or
acceptance-test surfaces. Do not build them merely to demonstrate the slogan.

Likewise, "agency ownership" is not yet a proven market moat. Treat it as an
architectural lens whose value must survive dogfood, provider evolution and
simpler competing designs. The supporting synthesis and falsification test live
in `docs/evidence/agency-ownership-character-2026-08-29.md`.

## Applying the set

A useful order is:

```text
Does the problem exist?                   P6 / P2 existence
Who should own the judgement?             P4
Which personalisation/governance layer?   P3
Does durable agency survive replacement?  P8
Does cognition need special evidence?     P1 / P2 capability
Can we observe whether it worked?         P5
Has the project phase changed the cost?   P7
```

Then use `ARCHITECTURE.md`, `SECURITY.md`, the relevant ADR and executable state
to design the actual change. These principles do not own current implementation
or DAY-1 status.