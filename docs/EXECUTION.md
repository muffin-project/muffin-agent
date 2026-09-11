# Execution governance

This document owns the **current semantic contract for bounded, observable execution**. `ARCHITECTURE.md` owns the system-wide semantic planes/topology; ADR-0076 owns why this execution contract was chosen; `docs/evidence/execution-governance-2026-09-11.md` owns the measurements, peer comparison, candidate numbers and falsification evidence.

Executable code/config remains authoritative for literal timeout values, counters and wire parameters. A mechanism listed here as a target is not shipped merely because its semantic shape is decided.

## The invariant

> **Muffin may work for a long time, but no execution may consume unbounded time or compute without observable progress.**

Long work is a product capability. An arbitrary round number is therefore not the normal completion policy. The inverse failure is also unacceptable: one provider call must not be able to keep the owner waiting indefinitely while the runtime has no useful account of whether it is alive, stalled or retrying.

## One turn, several budgets

Execution governance is multidimensional:

```text
money / spend
model-call attempts
tool-call attempts
active model time
turn wall-clock time
provider activity / inactivity
progress / stagnation
```

These are not aliases. `activeModelMs` measures cognitive compute pressure; `turnWallMs` measures elapsed owner-facing time and includes tools/waits inside the execution. Spend is already governed by the budget engine and remains a separate axis.

A high model/tool-call count may exist as an emergency fuse against corrupted control flow. It is not the ordinary reason a healthy turn ends.

## Model-call lifecycle

A governed model call distinguishes three clocks:

```text
start
  ├─ first provider activity / TTFT deadline
  ├─ inactivity deadline, reset by real provider activity
  └─ absolute model-call deadline
```

The activity clock may advance on text, reasoning, tool-call or other provider events that prove forward movement. This does not imply rendering private reasoning.

Local models may need a different first-activity envelope because long prefill can be healthy. That is policy/calibration, not a different lifecycle.

## Turn lifecycle

Above individual calls, a turn may have:

- cumulative active-model budget;
- total wall-clock deadline;
- model/tool emergency fuses;
- deterministic stagnation state;
- existing monetary/tenant/job budgets.

If a temporal budget must survive suspend/resume or a process restart to remain meaningful, the minimum state required belongs with durable Work. Pure diagnostic measurements remain tracing/derived state.

## Stop and retry semantics

The minimum typed stop taxonomy is:

```text
transport_timeout
model_deadline_exceeded
user_abort
turn_budget_exhausted
```

They are deliberately different because their next actions differ.

Normal policy:

| Cause | Automatic same-request retry? |
|---|---|
| transient transport failure/timeout | eligible inside the retry budget |
| model deadline exceeded | no |
| user abort | no |
| turn budget exhausted | no |

One layer owns each retry budget. When Muffin's loop owns transport retry/fallback, provider SDK retries for that same class are disabled rather than multiplied underneath it. Retries and fallbacks must be visible to the same accounting that decides whether another attempt is allowed.

## Progress is runtime state

Surfaces render progress; they do not invent it.

The runtime must be able to derive state from facts such as:

```text
modelCallStartedAt
firstProviderActivityAt
lastProviderActivityAt
phase: waiting | reasoning/receiving | tool | retrying | stalled
```

A heartbeat is a projection of those facts. It never spends another LLM call merely to say that the current one is still working.

Current implementation already exposes structural turn events for rounds, completed model calls and tool start/retry/end, and streams text live. The missing seam is provider activity **during** a long model call: reasoning/tool deltas are available on some providers but do not yet feed a surface-visible/activity state machine.

## Stagnation

Elapsed time and lack of progress are different failures.

Current code already detects exact repeated successful idempotent reads and exact repeated failures within a turn and warns the model. That is the deterministic floor.

The intended escalation is:

```text
same action/outcome observed
→ warn / require another route
→ if repetition continues, stop new discovery or return partial work
```

A candidate fingerprint is based on tool name, canonical arguments and normalized result digest. Chunk/range/cursor/resource changes must remain distinguishable so legitimate iterative work is not blocked. More semantic/no-novelty detection is added only if dogfood proves exact/deterministic signals insufficient.

## Reasoning is a capability, execution is a policy

The current `Profile.thinking` field is scaffolding, not a universal model API.

The durable boundary needs to be able to express model/provider capability independently of the requested execution policy:

```ts
type ReasoningCapability = {
  canDisable: boolean;
  efforts?: readonly ReasoningEffort[];
  supportsTokenBudget: boolean;
  mandatory: boolean;
};

type ReasoningRequest = {
  mode: 'off' | 'adaptive' | 'on';
  effort?: ReasoningEffort;
  maxTokens?: number;
};
```

Adapters translate the normalized request to provider dialects. The core loop does not grow model-family conditionals.

A reasoning-token budget constrains reasoning compute/cost; it is not the primary latency guarantee. Time/activity budgets govern waiting.

`interactive`, `deliberate/deep` and `background` are candidate execution-policy classes for different envelopes. They are not current schema until a measured consumer requires them.

The owner installation has negative evidence against globally forcing Qwen reasoning off. Any change to its current adaptive behavior therefore requires an A/B measurement rather than a latency-only decision.

## Execution telemetry

A model call should be diagnosable without recording prompt or private reasoning content. When available, tracing should preserve:

```text
request_id
requested_model
response_model
upstream_provider
attempt
started_at
first_provider_activity_at / ttft_ms
last_provider_activity_at
total_ms
input_tokens
output_tokens
reasoning_tokens
cache_read_tokens
cache_write_tokens
requested_max_output_tokens
requested_reasoning_mode / effort / max_tokens
stop_reason
abort_reason
```

Requested and response model are separate identities: a router such as `openrouter/free` may serve a concrete Qwen model. Billing identity may be a third provider-specific fact; see the 2026-09-11 free-router accounting evidence.

## Current implementation boundary

Already present:

- no arbitrary normal round cap;
- per-turn tool-call ceiling;
- monetary spend/tenant/job budgets;
- loop-level transport retry budget/backoff;
- structural tool/model progress events;
- exact repeated-call/repeated-failure warnings;
- requested max-output token ceiling;
- provider request/response model tracing and upstream provider when supplied.

Not yet a shipped claim:

- first-activity/stall/absolute model-call deadlines as separate runtime mechanisms;
- cumulative active-model and turn-wall budgets;
- typed abort taxonomy through every adapter/loop exit;
- SDK retry disablement coordinated with loop ownership;
- provider-activity heartbeat/state during long calls;
- stagnation escalation beyond the current warning;
- normalized reasoning capability/request model;
- durable requested-vs-response model telemetry in spend records;
- verified interpretation of the owner-observed `~15,914` token figure against a requested 4096 output ceiling.

Do not describe the second list as implemented. ADR-0076 defines its required semantics; narrow implementation slices make each claim true one at a time.
