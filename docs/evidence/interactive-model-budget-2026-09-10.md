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
the response model/upstream provider. It still does not log prompts, reasoning
content, or tool results merely to diagnose token accounting.
