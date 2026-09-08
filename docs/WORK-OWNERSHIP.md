# Work ownership and context preservation

This document owns one narrow part of repository orchestration: **what it means
when a durable work item is created, who is expected to act on it, and how
product/architecture context survives before a narrow execution claim is
handed to an implementation agent.**

It complements `docs/ORCHESTRATION.md`; it does not replace its claim selection,
verification profiles, scope firewall or integration rules.

## Creating an issue is not delegating work

Every durable issue, research pack or reconciliation item must declare one
execution mode near the top:

```text
Execution mode: SELF | PRESERVE | DELEGATE
```

The meanings are strict:

- **SELF** — the creator is actively doing the investigation/reconciliation/work.
  The issue is the durable working surface and evidence index. Another agent
  must not silently take it over.
- **PRESERVE** — the item exists to keep product direction, evidence, a decision
  fork or a future claim from being lost. Nobody is authorised to implement it
  merely because the issue exists.
- **DELEGATE** — the item is explicitly intended to be handed to another agent.
  The intended executor and bounded claim must be named in the brief before
  execution starts.

If no mode is written, the safe interpretation is **PRESERVE**, never DELEGATE.

A pull request means something different: concrete repository changes already
exist. The PR author/worker owns those changes until handoff or integration; the
existence of a PR still does not authorise unrelated follow-up work.

## Tell the owner what was just created

Whenever a durable item is created, say explicitly which of these happened:

```text
I am working this myself.
I am preserving this only.
I am delegating this to <executor>.
```

Do not make the owner infer ownership from whether an issue or PR appeared.

## Preserve full product shape before compressing to a claim

For work that can materially distort product or architecture, keep two layers:

```text
PRODUCT / ARCHITECTURE PACK
        ↓
EXECUTION BRIEF
```

The pack preserves the complete reasoning that should survive sessions:

```text
product principle
architecture / state-transition shape
concrete good and bad UX examples
diagrams where useful
preferred implementation seam or pseudocode
relevant peer/prior-art evidence
trade-offs and rejected alternatives
non-goals
falsifiers / evidence that would change the decision
```

The execution brief then compresses this into **one falsifiable claim** with the
minimum context required to implement it correctly.

Do not compress first and hope a coding agent reconstructs the product intent
from the task sentence.

## Context amount is proportional to semantic blast radius

A one-line mechanical repair does not need an architecture essay.

A claim that changes onboarding, memory semantics, authority, privacy, Home/Node
placement, capability boundaries, extension shape or normal owner UX does need
enough product context to prevent a locally-correct implementation from shaping
the wrong product.

A useful execution brief for those claims contains, in order:

```text
CONTEXT / PRODUCT PRINCIPLE
CURRENT OBSERVATION
TARGET SHAPE
CONCRETE GOOD/BAD EXAMPLES
PREFERRED MINIMUM IMPLEMENTATION
NON-GOALS
FALSIFIER / ACCEPTANCE
ECONOMY
```

This is a quality constraint, not a prompt-length target. Reuse the durable pack
instead of pasting its full contents into every session.

## Research and reconciliation default to SELF/PRESERVE, not coding delegation

Historical archaeology, ecosystem research, owner-intent recovery and
chat-to-authority reconciliation should normally be completed far enough to know
what is actually true **before** a coding agent receives a claim.

Preferred flow:

```text
conversation / historical source
        ↓
SELF research / audit
        ↓
durable evidence or product pack
        ↓
reconciliation into the correct authoritative home
        ↓
choose one falsifiable claim
        ↓
DELEGATE only when implementation or an independent judge is useful
```

The point is not that one specific assistant must always research and another
must always code. The point is that **preservation, investigation and delegation
are separate acts** and must not collapse into “issue created → coding starts”.

## Handoffs must preserve ownership and source context

A phase/session handoff for an active item should be able to answer:

```text
What is the current execution mode?
Who is acting now?
What durable pack/evidence contains the full context?
What single claim is active, if any?
What owner decision is still required?
What must NOT be started automatically after completion?
```

A session should be able to die without losing any of those answers.

## Examples

### Product direction discovered in conversation

```text
Issue: product-first onboarding/deployment direction
Execution mode: PRESERVE

→ preserve diagrams, UX and architectural boundaries
→ reconcile later
→ do not implement Docker/Python/onboarding just because they are named
```

### Historical audit

```text
Issue: old chats → current authority/code
Execution mode: SELF

→ investigator performs the comparison
→ publishes classifications/evidence
→ only then choose corrections or coding claims
```

### Concrete implementation

```text
Issue/brief: governed conversational forget
Execution mode: DELEGATE
Executor: Claude Code
Claim: owner can retire an active belief through the canonical semantic writer

→ implementation agent receives the product pack plus this bounded claim
```

## Economy

This protocol exists to save context and rework, not add ceremony.

- Do not create an issue for every thought.
- Do not duplicate a product pack in several documents.
- Do not repeat research already preserved and still current.
- Do not turn `SELF` into a prohibition on asking a specialised worker for a
  bounded sub-investigation.
- Do not turn `PRESERVE` into a hidden backlog.
- Do not write a long pack for a mechanical claim whose product shape is already
  obvious.

The test is simple:

> **Does preserving this context now save a future agent from reconstructing the
> product decision, or prevent it from implementing the wrong thing?**

If not, keep the process smaller.
