# Execution governance: long-running without unbounded silence — 2026-09-11

## Question

After removing the arbitrary round cap, what should bound a Muffin turn without reintroducing a scalar limit that kills useful long work?

The measured product requirement is narrower than “make agents faster”:

> Muffin may work for a long time, but it must not consume unbounded time or compute without observable progress.

This evidence record challenges the candidate design before implementation. It does not choose literal timeout values for shipped config.

## Current Muffin reality

At repository state `ef87196` (before this evidence slice):

- the model/tool loop has no arbitrary round ceiling; the per-turn tool-call ceiling remains;
- `TurnRun` records iterations, recovery use, transport retries, tool calls, token usage, spend, resume count and context state, but no active-model time, turn wall time, first provider activity, last provider activity or deadline;
- every main loop request uses `maxOutputTokens: 4096`;
- the OpenAI-compatible client is created without explicit SDK `maxRetries` or `timeout`;
- Muffin then owns an additional `MAX_TRANSPORT_RETRIES = 2` above the SDK. The code already documents the multiplication: three loop-level attempts × three SDK wire attempts can become nine requests;
- streamed `thinking_delta`, `tool_call_delta` and partial usage currently prove provider activity but `drainStream()` intentionally discards them from the surface-facing path;
- the `model` progress event is emitted only after the whole model call completes, so it cannot by itself make a long silent model call observable while it is happening;
- `tool_start`, `tool_retry` and `tool_end` already make tool activity observable;
- exact repeated successful reads and exact repeated failures are already detected from the durable tool-call ledger and warned back to the model. This is a real first stagnation guard, not a hypothetical one;
- the budget engine bounds money by month, remote tenant/day and scheduled job, but not the active compute or wall-clock cost of one interactive turn.

Owner dogfood had already recorded a visible failure on 2026-09-07: roughly 15 seconds with no sign of life while reasoning/tool-call deltas existed below the rendering boundary. Separately, a later owner-observed call was reported at roughly 411 seconds with an accounting figure around 15,914 tokens. The latter number is deliberately **not treated as proven completion tokens** here: it conflicts with the loop's requested `maxOutputTokens: 4096` if interpreted that way and must be decomposed into input/output/reasoning/total provider accounting before it can support a token-limit claim.

## External challenge

### OpenAI Node SDK: retry and timeout ownership currently multiply

Current OpenAI Node documentation states:

- retryable connection/408/409/429/5xx failures are retried **2 times by default**;
- request timeout defaults to **10 minutes**;
- timed-out requests are themselves retried by default;
- both are configurable, including `maxRetries: 0`.

Source: https://github.com/openai/openai-node/blob/main/README.md

A current SDK issue also documents a Node/Undici header-timeout interaction above five minutes that can make one logical call retry at transport boundaries the application did not intend. This is not the reason to choose a short Muffin deadline; it is further evidence that deadline ownership should not be left implicit across layers.

Source: https://github.com/openai/openai-node/issues/2153

**Implication for Muffin:** when the loop already owns retry policy, hidden SDK retries make the execution budget multiplicative. The smallest coherent ownership model is one retry governor. This evidence supports disabling SDK retries when the loop-level retry taxonomy lands; it does not say “never retry”.

### Hermes: unlimited turns and time/activity budgets coexist

Current Hermes documentation independently converges on two relevant choices:

- `agent.max_turns` is unlimited by default because a finite turn cap caused silent mid-task truncation;
- provider request timeouts, stale stream/non-stream detection, session-stall detection and an optional wall-clock `run_budget_seconds` are separate controls;
- activity such as streamed tokens/tool calls resets inactivity budgets; a total ceiling can still prevent a degenerate trickle from holding work forever;
- local models get different stale/prefill treatment because silence before first token can be healthy local prefill rather than a hung connection.

Sources:
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://hermes-agent.nousresearch.com/docs/reference/environment-variables

**Counter-evidence / caution:** copying Hermes's literal seconds would be cargo cult. Muffin's provider mix, interaction contract and local-model ambitions differ. The useful prior art is the separation of clocks and activity, not the numbers.

### LangChain/LangGraph: independent limits are composable safety fuses

Current LangChain exposes model-call and tool-call limit middleware separately, and its production guidance recommends bounding them independently for runaway agents. LangGraph exposes a recursion counter/limit that callers can inspect before exhaustion for graceful degradation.

Sources:
- https://docs.langchain.com/oss/javascript/langchain/middleware/built-in
- https://docs.langchain.com/oss/javascript/deepagents/going-to-production
- https://langchain-ai.github.io/langgraph/concepts/multi_agent/

**Implication for Muffin:** a high model/tool-call fuse remains useful even if it is not the normal completion policy. Removing the arbitrary round cap does not require removing every catastrophic last-resort bound.

### Test-time compute research: more reasoning is not uniformly valuable

Snell et al., ICLR 2025, show that the value of additional test-time compute depends on prompt difficulty and that adaptive allocation can outperform a uniform compute policy.

Source: https://openreview.net/pdf?id=4FWAwZtd2n

This supports treating reasoning effort/budget as a resource policy rather than globally forcing maximum reasoning. It does **not** establish the correct latency budget for Muffin.

AgentBoard (NeurIPS 2024) argues for fine-grained progress-rate measurement rather than evaluating only final success. That supports measuring novelty/progress through a long agent trajectory, but it does not justify a semantic “progress judge” in Muffin core.

Source: https://proceedings.neurips.cc/paper_files/paper/2024/hash/877b40688e330a0e2a3fc24084208dfa-Abstract-Datasets_and_Benchmarks_Track.html

### OpenRouter: reasoning is a provider/model capability, not one Anthropic-shaped enum

Current OpenRouter model/API pages expose a `reasoning` object for supported models that can include enablement, effort and maximum reasoning tokens. Qwen-family pages advertise this parameter as well.

Sources:
- https://openrouter.ai/docs
- https://openrouter.ai/qwen/qwen3.6-max-preview/api

This contradicts a provider-agnostic reading of the current Muffin comment “there is no budget any more”. That statement is valid only for the particular Anthropic frontier API shape it was written against. Muffin's current `Profile.thinking = adaptive | off | unset` is therefore implementation scaffolding, not a durable universal reasoning vocabulary.

## Candidate decision table

### A — restore a finite round/tool cap as the normal policy

Pros: tiny, deterministic, easy to test.

Cons: repeats the failure that motivated cap removal; one cheap round and one expensive reasoning round count the same; healthy long work dies because an iteration number was reached.

Verdict: reject as the normal termination mechanism. Retain only high emergency fuses.

### B — one wall-clock timeout for the whole turn

Pros: simple upper bound on owner wait.

Cons: conflates healthy active work, provider silence, local prefill, tool execution and model compute; cannot distinguish a hung call from a long but productive turn; does not tell the user what is happening.

Verdict: insufficient alone.

### C — multidimensional execution governor

Separate observable facts and budgets:

```text
model call:
  first provider activity / TTFT
  inactivity (time since provider activity)
  absolute model-call deadline

turn:
  cumulative active model time
  total wall-clock time
  model/tool emergency fuses
  progress / stagnation state
```

Provider events and tool transitions feed the activity clock. The turn can remain long while it keeps making useful progress, subject to the outer safety envelope.

Verdict: chosen architecture direction, with literal defaults to be measured.

## Chosen invariants

1. **No single scalar is “the agent budget”.** Time, model compute, money, tool/model attempts and observable progress are different dimensions.
2. **`activeModelMs` and `turnWallMs` are separate facts.** Waiting on/inside tools still consumes owner wall time even when it does not consume model compute.
3. **First activity, inactivity and absolute deadline are distinct.** A call can fail before first activity, stall after activity, or remain active until an absolute ceiling.
4. **Abort reasons remain typed.** At minimum the runtime must distinguish `transport_timeout`, `model_deadline_exceeded`, `user_abort` and `turn_budget_exhausted` instead of routing all of them through one retryable transport error.
5. **Only a transport failure is normally eligible for automatic same-request retry.** A generation that consumed its model-compute deadline is not automatically run again; doing so simply doubles the guardrail it just hit.
6. **One layer owns retry budget.** Provider SDK retry defaults must not multiply a Muffin-owned retry policy. The implementation slice should set SDK retries to zero where Muffin owns the equivalent retry/fallback decision.
7. **Progress is evidence, not animation.** Provider activity, reasoning/tool-call deltas, tool transitions and completed model output may advance an activity clock even when the raw reasoning is not rendered. Heartbeats are projections of this state; they never make another model call just to say “thinking”.
8. **Stagnation is not the same as elapsed time.** The existing exact-repeat warning is retained as a deterministic floor. Escalation should be `warn -> force replan/stop discovery -> terminate/return partial` only when repeated action/outcome evidence supports it. Legitimate chunked reads/writes must not be collapsed as duplicates.
9. **Emergency fuses remain.** A high model-call/tool-call ceiling can stop corrupted control flow. It is a last-resort safety fuse, not the normal reason a healthy turn ends.
10. **Reasoning is a capability negotiated at the model/provider boundary.** The durable vocabulary needs to represent whether reasoning can be disabled, which effort levels exist, whether a token budget exists and whether reasoning is mandatory. Provider adapters map that normalized request to their wire dialect.
11. **A reasoning-token limit is not a latency SLA.** Throughput and provider behavior vary; token budget constrains compute/cost, while time/activity budgets constrain waiting.
12. **Execution policy and model capability are different axes.** `interactive`, `deliberate` and `background` are useful candidate execution classes; model capability says what can be requested. Do not bake those classes into the current profile schema until a consumer/eval needs them.
13. **Do not globally force Qwen reasoning off.** The owner installation already recorded a regression when `off` became real on OpenRouter; `adaptive` restored model-default behavior. The next change should A/B the policy rather than infer quality from latency alone.
14. **Requested and observed limits must be traceable.** A limit that cannot be compared with the provider response/accounting cannot protect or diagnose the system.

## Normalized reasoning shape to evaluate

Architecture-level capability, not yet a shipped TypeScript contract:

```ts
type ReasoningCapability = {
  canDisable: boolean;
  efforts?: readonly ('minimal' | 'low' | 'medium' | 'high')[];
  supportsTokenBudget: boolean;
  mandatory: boolean;
};

type ReasoningRequest = {
  mode: 'off' | 'adaptive' | 'on';
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  maxTokens?: number;
};
```

Do not add model-family `if` branches to the loop. Capability discovery/config belongs at the adapter/model boundary; execution policy consumes the normalized capability.

## Qwen experiment before changing default behavior

Measure the same representative prompts/tool trajectories under at least:

```text
adaptive + deterministic sampling
adaptive + model-recommended/default sampling
off      + deterministic sampling
low/bounded reasoning + deterministic sampling   (where the endpoint supports it)
```

Metrics: success, tool selection, repeated work, TTFT, total latency, output/reasoning tokens, cost, user-visible stalls. A current upstream issue/anecdote is evidence to run the experiment, not evidence to select the winner.

## Telemetry needed at each model call

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
reasoning_tokens (when observable)
cache_read_tokens
cache_write_tokens
requested_max_output_tokens
requested_reasoning_mode/effort/budget
stop_reason
abort_reason
```

Raw prompts/reasoning are not required for this telemetry. The purpose is execution accounting, not logging private content.

## The 15,914 vs 4,096 anomaly

Before relying on a reasoning-token guard, classify the owner-observed `~15,914` value. Possible meanings include total tokens, cumulative turn tokens, hidden reasoning tokens, provider-specific accounting or a broken max-token/request mapping.

Required check:

1. capture the outbound requested output/reasoning limits without prompt content;
2. capture raw provider usage fields and normalized `ChatResult.usage`;
3. compare requested model/router, response model and upstream provider;
4. prove whether any **single completion** exceeded its requested 4096 output-token ceiling.

If yes, the adapter/provider contract is broken and reasoning-budget policy must not be built on the normalized number until repaired.

## Starting numeric hypotheses — explicitly not canonical defaults

These values came from the design analysis and exist here so the next session does not have to reinvent them. They are candidates to test against real p95/p99 latency, not architecture:

```yaml
interactive_candidate:
  model:
    firstActivityMs: 30_000
    inactivityMs: 25_000
    hardDeadlineMs: 90_000
    maxAttempts: 2
  turn:
    activeModelBudgetMs: 120_000
    wallDeadlineMs: 180_000
    emergencyMaxModelCalls: 32
    emergencyMaxToolCalls: 64
    duplicateActionLimit: 2
```

A light lane may deserve a materially shorter hard model-call deadline (the earlier working hypothesis was ~45s). Local endpoints may deserve longer first-activity/prefill allowance. Neither becomes config until measured.

## Falsification criteria

Reverse or narrow this direction if real dogfood shows any of the following:

- inactivity detection kills healthy calls often enough to reduce task success more than it removes stalls;
- a separate active-model budget adds complexity without predicting owner wait/cost better than wall time alone;
- reasoning capability normalization cannot stay small and instead becomes a model-id exception catalog;
- stagnation escalation stops legitimate iterative work because deterministic novelty cannot distinguish it;
- high emergency fuses fire in healthy work often enough to act as the old round cap under another name;
- provider-native retry/fallback behavior proves strictly better and can be made observable/budgeted without multiplication.

The implementation should therefore land in narrow, reversible slices with telemetry first and literal thresholds measured afterwards.