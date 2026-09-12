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

At the P3 boundary the public metadata lookup was read-only and no owner
credentials or live inference were used. The remaining risks identified there
— capability metadata drift and the absence of a cached live discovery layer —
are addressed by the P4 section below.

## P4 capability discovery and continuity

P4 replaces the single OpenRouter snapshot path with an in-memory discovery
cache. The provider looks up the single-model endpoint
`/api/v1/model/{author}/{slug}` once per `baseURL + requested/canonical model`
and caches valid metadata for six hours. A fresh live result wins over cache;
cache wins over the static Qwen compatibility snapshot; otherwise the result is
`unknown`. Discovery errors do not become `unsupported`, and a known static
snapshot remains usable. The cache is intentionally process-local: no metadata
database or background refresh service was added.

`ReasoningCapabilities` now distinguishes `supported`, `unsupported` and
`unknown`. Explicit `off`, effort and exact-budget constraints are rejected
when capability is unknown rather than silently claimed. An unconstrained
adaptive/default request may proceed with provider defaults and is traced as
omitted/degraded. Explicit constraints still force OpenRouter
`require_parameters: true`.

OpenRouter reasoning continuation is now opaque provider metadata on the
canonical `Message`/`ChatResult` path. Non-stream responses capture
`reasoning_details` (or the string aliases only when details are absent), and
stream chunks reconstruct the ordered details array. The loop persists the
metadata beside the assistant message before tool execution; the OpenRouter
adapter sends it back as `reasoning_details` on the next assistant message.
Local/non-OpenRouter adapters do not receive those fields. The loop never
renders this metadata as user text, and it is not added to logs or traces.

The live public metadata response for `qwen/qwen3.8-27b` on 2026-09-10
returned canonical slug `qwen/qwen3.8-27b-20260814`, `mandatory:false`,
`default_enabled:true`, default `xhigh`, efforts `xhigh/medium/low`, and no
declared `supports_max_tokens`. A live owner acceptance using the configured
secret accepted adaptive, low, medium, xhigh and off. All five calls were
served by `Alibaba`; reasoning tokens observed were 26, 17, 27, 36 and 0
respectively. Request IDs, served model, finish reason and token usage were
captured without printing response content or secrets.

A separate live safe-tool acceptance produced one Qwen tool call, preserved
opaque reasoning metadata, and sent `reasoning_details` on the continuation
request. The continuation was served by `Alibaba`, ended normally, and reported
28 reasoning tokens. The full durable Muffin loop remains covered by the
deterministic P0/P1/P2/P3 tests; the live acceptance was intentionally kept at
the provider boundary to avoid executing an owner-side tool effect.

Qwen's `preserve_thinking` default is a provider/model context behavior, not a
new Muffin policy in this slice. Muffin now preserves the returned continuation
metadata when OpenRouter supplies it, but does not force or disable
`preserve_thinking`. Possible duplicate/context-growth behavior belongs in P5
alongside sampling/effort evaluation.
