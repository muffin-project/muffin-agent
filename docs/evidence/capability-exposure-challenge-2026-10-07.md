# Capability exposure challenge pass — 2026-10-07

## Question

Should Muffin replace registration-order truncation with progressive capability
discovery, and if so what is the smallest shape that preserves its authority
model?

This challenge pass governs issue #469 and draft PR #854.

> Process note: the draft implementation had already started when this
> repository-mandated challenge pass was reconstructed. This document does not
> retroactively claim that the pass happened before code. Its purpose is to
> decide whether the current draft should survive, be narrowed, or be removed
> before it can leave Draft.

Observed integration base: `dev@b178dd3201d13a658a054e3cf28a005ea724afd5`.

## Measured Muffin failure

The production turn path currently derives the principal-eligible tool set and
then applies `profile.maxToolsExposed` as an ordered slice. A tool past that
boundary is absent from the provider request even when the kernel would
authorize it.

That means registration order and a context-budget knob can decide whether an
authorized capability is reachable by the model.

The failure is now concrete rather than hypothetical:

- #469 records the current registration-order truncation;
- #851 needs an ordinary host projection for Event Intelligence lifecycle tools;
  raising `maxToolsExposed` only for EI was explicitly rejected because it
  would preserve the structural failure;
- late tools such as MCP and surface-attached tools expand the catalogue after
  the runtime was initially assembled.

The execution authority boundary is separate and load-bearing:
`runTool` resolves a named registered tool and sends the capability through the
normal policy kernel. In particular, a principal that guesses a host-only tool
must receive a kernel denial rather than a fake "tool does not exist" answer.
Discovery must not replace this boundary.

## Current mechanism and invariant

Before #469:

```text
registered tools
  -> principal/grant visibility
  -> registration-order slice(maxToolsExposed)
  -> provider-visible schemas
  -> runTool
  -> kernel decision
```

Required invariant:

```text
installed/registered tools
  -> principal/grant eligibility
  -> small model-visible projection
  -> task-relevant discovery/load when needed
  -> provider-visible schemas
  -> the SAME runTool
  -> the SAME kernel decision
```

`maxToolsExposed` may remain a schema/context ceiling. It must stop being the
mechanism that makes an otherwise authorized capability unreachable.

## Current external prior art

### OpenAI tool search

Current OpenAI API guidance supports deferred tool loading and explicitly
separates hosted search from client-executed search. Client-executed search is
recommended when availability depends on application-controlled state such as a
project or tenant. The guidance also says deferred loading trades an additional
discovery step for lower tool-schema context and recommends comparing task
completion, token use and latency before choosing it as a default.

Primary source:
https://developers.openai.com/api/docs/guides/tools-tool-search

Important implication for Muffin: provider-native search is a useful projection,
not a reason to move authority into a provider. Muffin's principal/grant
eligibility remains host-owned.

### Anthropic Tool Search

Anthropic's Tool Search guidance reports the same basic shape: keep a small
frequent set eager, defer the rest, search names/descriptions, then expand only
the relevant definitions. Their published guidance says the trade is most useful
around 10+ tools / material schema context, and explicitly notes an added search
step and therefore additional latency.

Primary source:
https://www.anthropic.com/engineering/advanced-tool-use

Important implication for Muffin: dynamic discovery is not automatically better
for a small catalogue. The ordinary under-cap path should remain ordinary.

### Artemis as local prior art

Artemis already separates a governed capability inventory/projection from a
small model-facing surface. Its useful lesson here is the control-plane split:
authority/policy filters the reachable inventory before model selection.

The part not copied is the universal `capability_call` invocation facade.
Muffin already has a mature normal tool execution path and policy kernel; adding
a second invocation protocol would widen this slice without fixing the measured
failure.

Prior-art locations inspected:
- `sarooo17/artemis-agent-runtime/src/capabilities/compiler/compileCapabilityProjection.ts`
- `sarooo17/world-capability-mcp/src/protocol/core/capabilityRegistry.ts`
- `sarooo17/world-capability-mcp/src/protocol/policy/providerProjection.ts`

Peer architecture is input, not authority for Muffin.

## Decision table

| Candidate | Evidence for | Evidence against / failure mode | Decision |
| --- | --- | --- | --- |
| A. Keep ordered truncation and raise caps as tools arrive | Smallest code change | Does not fix reachability; repeats the failure every time catalogue breadth grows; #851 would need an EI-specific exception | Reject |
| B. Remove the cap and expose the full authorized catalogue | Restores reachability immediately | Loses the context/token bound and makes every task pay for every schema | Reject |
| C. Add an Artemis-style universal `capability_call` facade | Stable tiny surface; proven useful in Artemis/World Capability | Creates a second invocation protocol around a kernel/tool path Muffin already has; broader than measured failure | Reject for this slice |
| D. Provider-native deferred search only | Best cache/context integration where supported | Provider/model specific; cannot be Muffin's only semantic path | Keep as an adapter/projection option, not the canonical mechanism |
| E. Host-owned eligible catalogue + small core + deterministic local discovery/load + normal execution | Fixes measured reachability; provider-neutral; preserves kernel; reversible; composes with native deferred search later | Adds a discovery step under pressure and requires evidence that selection is good enough | **Chosen minimum** |
| F. Embedding/router-agent/ontology-backed discovery | Could improve fuzzy retrieval at very large scale | No measured need; new model/dependency/index lifecycle and more authority-adjacent complexity | Reject until a falsifier requires it |

## Chosen claim

> A needed authorized capability remains model-reachable beyond the profile
> schema ceiling without exposing forbidden tools or bypassing Muffin's normal
> execution kernel.

Minimum implementation shape:

```text
registered tools
    |
visibleTools(principal, grants)        <- authority eligibility first
    |
    +-- catalogue fits cap ----------> ordinary existing schema set
    |
    +-- catalogue exceeds cap
            |
            +-- small core + capability_search
            |
            +-- deterministic local name/description search
            |
            +-- selected schemas at next model boundary
                        |
                     runTool
                        |
                     kernel
```

No EI-specific discovery, no new plugin runtime, no universal
`capability_call`, no embedding index, no router model.

## Security / authority consequences

The search catalogue is derived only after principal/grant eligibility. A
host-only tool therefore cannot be returned to a member by discovery.

This is defence in depth, not replacement. Directly naming a registered hidden
tool still enters the existing `runTool -> kernel` path, because kernel denial
is the canonical authority decision. The discovery projection must never become
an alternate authorization check.

The discovery tool itself is a low-risk context capability. It chooses schema
visibility; it does not execute the selected capability and does not mint a
grant.

## Falsifiers / acceptance

The draft is not integration-grade until all relevant observations hold on the
current candidate:

1. Put a needed authorized tool beyond the old registration-order ceiling.
2. Prove the first provider call does not contain its schema.
3. Search/load it through the production turn path.
4. Prove the next provider call contains it while the full catalogue remains
   hidden and the profile ceiling still bounds loaded schemas.
5. Invoke it through the ordinary tool path, not a discovery executor.
6. For a non-owner principal, prove a host-only capability is absent from search
   results.
7. Deliberately guess that forbidden tool name anyway and prove its handler does
   not run because the canonical kernel refuses it.
8. Preserve the under-cap fast path without adding a discovery schema.
9. Compare the representative flat and deferred paths on:
   - model-visible schema bytes / input-token proxy;
   - task success / correct tool selection;
   - added model/tool round trips;
   - latency on a representative real/provider path before choosing a default
     provider-native strategy.
10. Remove/bypass the production projection wiring as the CRITICAL mutation:
    the beyond-cap production-path proof must fail for the expected reason.

## Kill / simplify conditions

Reverse or narrow the mechanism if representative evaluation shows any of:

- under-cap turns pay a discovery step;
- forbidden capability metadata becomes discoverable;
- a discovered capability bypasses the normal kernel;
- deterministic search cannot reliably recover the unambiguous needed tool;
- context savings are immaterial while the added round materially harms task
  success/latency;
- a provider-native primitive can replace host search without moving
  principal/tenant eligibility out of Muffin.

## Verification profile

**CRITICAL.**

Reason: the slice changes capability exposure adjacent to Muffin's authority
boundary. Per `docs/development/ORCHESTRATION.md`, authority/capability/policy
claims require production-path reconstruction, red/reproduction evidence,
integration/wiring proof, a load-bearing mutation, relevant failure cases, the
full integration gate, and a fresh independent judge before merge.

The judge reviews the guarantee, not merely the search algorithm.
