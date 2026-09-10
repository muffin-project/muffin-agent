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
