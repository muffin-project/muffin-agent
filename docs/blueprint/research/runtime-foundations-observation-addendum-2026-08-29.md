# Runtime foundations addendum — observation is already a substrate

Date: 2026-08-29. Status: evidence / correction to the same-day runtime
foundations challenge, not an independent current-architecture authority.

## Finding

The first version of the runtime-foundations challenge proposed a new typed
lifecycle event substrate before guardrails. A deeper trace of the current
production path falsified that proposal.

Muffin already has **two deliberately different observation surfaces**:

1. structured tracing (`muffin.turn`, `muffin.chat_call`, `muffin.tool_call`,
   `muffin.policy_decision`, memory spans) persisted under the installation's
   trace boundary;
2. `TurnEvent` / `onProgress`, the live surface-facing stream for facts such as
   rounds, model completion, tool start/end, approval waits and retries.

A third generic lifecycle bus would not create a missing primitive. It would
create a second/third taxonomy for the same transitions, plus new ordering,
privacy and failure semantics to maintain.

This was caught before integration: an experimental `LifecycleBus` branch was
created and intentionally not merged.

## Revised decision

Do **not** add another observation bus merely because peer frameworks expose
“hooks”. Reuse/extend tracing for durable diagnostics and `TurnEvent` for live
surface progress when an observation is actually missing.

The foundation Muffin still lacks is **execution interception**: an explicit,
testable place for warning/blocking guardrails around proposed/executed actions,
separate from both observation and the mandatory policy kernel.

The ordering invariant remains:

```text
model proposes action
        ↓
optional deterministic guardrail/interceptor
        ↓
mandatory policy kernel (cannot be bypassed)
        ↓
effect WAL / sandbox / handler
        ↓
post-result guardrail when relevant
        ↓
model receives result
```

Observation may watch these boundaries but does not gain authority by doing so.

## First consumer

The first guardrail is still the measured no-progress/tool-loop failure. Start
warning-first, as Hermes does by default, and do not infer “no progress” from a
high call count alone.

A successful repeated result is safe to classify only when the tool explicitly
has read/idempotent progress semantics. `CapabilityDecl.rerunnable` and
`reversible` answer different questions and must not be reused as a hidden
idempotence flag.

## Why this correction matters

This is the intended output of `docs/RESEARCH.md`: prior art suggested a useful
concept, but the current Muffin production path showed that half of it already
exists. The right implementation is therefore smaller than the initial
roadmap, not a closer copy of a framework.
