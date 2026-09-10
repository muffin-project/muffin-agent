# Interactive model budget — 2026-09-10

## P0 result

The round cap removal at `5127b83` left the model loop intentionally open-ended.
The first safety slice therefore adds an execution envelope rather than another
round counter:

- `consumer-local`: 90 seconds per model call, 180 seconds per interactive turn;
- `frontier`: 120 seconds per model call, 300 seconds per interactive turn;
- OpenAI-compatible and Anthropic SDK retries are disabled (`maxRetries: 0`);
- loop-owned transport retries remain separate from model deadlines.

The deadline is a safety fuse, not a progress or round policy. Activity-aware
first-token/stall handling is the next slice.

## Historical anomaly

The observed Qwen/OpenRouter trace for turn
`836b2c80e6d5c1ac986832085141b7fe` records approximately:

```text
requested max output: 4096
observed output_tokens: 15914
duration: 411 seconds
stop reason: tool_use
```

`15914-vs-4096: unresolved historical anomaly`.

The old trace does not prove whether the values describe one upstream
generation, whether OpenRouter/provider routing transformed or ignored the
limit, or whether the accounting joined different attempts. The old adapter
also did not preserve a provider-reported reasoning-token subset.

The new path records the requested output ceiling, requested thinking mode,
duration, abort reason, provider-reported reasoning tokens when available, and
the provider request/generation id when returned, plus the response
model/upstream provider. It still does not log prompts, reasoning content, or
tool results merely to diagnose token accounting.

## Activity-aware follow-up

The follow-up slice keeps the same budget owner and adds first-activity and
stall watchdogs. Semantic stream events count as activity: text, reasoning and
incremental tool-call arguments. Usage-only or keepalive traffic does not.
The surface-facing `model_status` progress event reports waiting, thinking,
receiving and stalled state without making another model call.

## P2 cumulative active model budget

The execution envelope now also owns cumulative active model time for one
durable turn:

- `consumer-local`: 120 seconds active model time inside a 180 second wall budget;
- `frontier`: 240 seconds active model time inside a 300 second wall budget.

Only time while a model lease is active is counted. Tool execution, local
orchestration, retry backoff and waiting outside the provider are not counted,
but they remain inside the wall-clock deadline. The effective deadline for a
new call is the minimum of normal call, remaining active-model and remaining
wall-clock budget. Exhaustion has its own reason,
`active_model_budget_exhausted`, and does not enter transport retry.

The stream attempt and its non-stream fallback acquire separate leases, as do
later transport retries. The chat trace records an invocation index and the
before/this/after active-time values for each lease.

`activeModelMs` is an additive field in durable turn counters. A resumed turn
therefore cannot reset the cumulative envelope. A process crash during an
in-flight provider call can only persist the time once the lease is released;
the exact uncommitted interval is not recoverable without a separate heartbeat
or database write on every activity event, which is deliberately outside this
slice.

## P3 normalized reasoning capability

The reasoning slice separates three things that had previously been mixed in
`thinking` strings:

- `ReasoningRequest` is Muffin's provider-agnostic intent: `off`, `adaptive` or
  `on`, with optional effort or an exact token budget.
- `ReasoningCapabilities` describes what the adapter can prove for the selected
  model/endpoint, including whether reasoning is mandatory and whether it can
  be disabled.
- `ReasoningResolution` records whether the intent was applied, deliberately
  omitted, or rejected as unsupported. Unsupported explicit constraints fail
  before a provider request; omission carries a reason and is emitted in the
  chat trace.

Shipped profiles remain backward compatible: `Profile.thinking` is normalized
once at the loop boundary, while direct adapter callers may still use the
legacy field. Production `ChatCall`s carry only the canonical `reasoning`
intent. `/think` changes the same profile value consumed by that boundary, so
the interactive command and the profile path now share the resolver rather than
having separate wire behavior.

The OpenRouter adapter uses a small dated capability snapshot for
`qwen/qwen3.8-27b` (queried from the public model metadata on 2026-09-10):
reasoning is optional, enabled by default, with `xhigh`, `medium` and `low`
efforts; an exact reasoning token budget is not declared. Other OpenRouter
models use a gateway-default capability with no per-call metadata fetch, so an
effort may be sent only when the gateway cannot prove a model-specific list.
An explicit reasoning constraint also sets provider routing
`require_parameters: true`, which intentionally narrows fallback to providers
that accept the requested parameter. Local OpenAI-compatible endpoints omit
the reasoning field; `off` is an explicit, traced omission there rather than a
claim that the endpoint disabled hidden reasoning.

The Anthropic adapter maps adaptive/on to `thinking: {type:'adaptive'}`, off to
`disabled`, effort to `output_config.effort`, and exact budgets only for the
known 4.5 model shape. It does not turn a reasoning budget into a latency
deadline. Sampling remains unchanged: the current profiles still request their
existing deterministic behavior, and no Qwen decoding retune or live model
acceptance was performed in this slice.

The public metadata lookup was read-only. No owner credentials or live model
inference were used, so acceptance on the actual OpenRouter account remains
open. The remaining risks are capability metadata drift and the absence of a
cached live discovery layer. Those belong with P4 discovery/acceptance, not a
silent fallback in the request path.
