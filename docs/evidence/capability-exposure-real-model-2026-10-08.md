# Capability exposure real-model comparison — 2026-10-08

Issue: #469  
PR: #854  
Candidate measured: `cee329644c60416c43a7c7526b5fff53cc9ef50e`  
Provider: OpenAI-compatible  
Model: `gpt-4o-mini`  
Environment: Railway staging service `muffin-capability-469-e2e`

## Question

Does progressive capability projection still preserve task success at Muffin's
current catalogue breadth, and what does it trade in model-visible context,
rounds and latency?

The production-path deterministic evidence already proved that authorization is
filtered before discovery, loaded tools still execute through the normal kernel,
and a forbidden tool cannot be discovered. This lane measures the model-facing
tradeoff only.

## Current-scale comparison

The real-model lane uses twenty-two ordinary capability schemas in the flat
condition — comparable to Muffin's current native catalogue breadth — and a
four-schema initial projection in the progressive condition. The requested
inventory capability starts outside the small core.

The progressive path uses the same deterministic authority-filtered lexical
selection as production to preload an obvious task-relevant hidden capability
from the owner request. `capability_search` remains visible as the fallback for
needs the preload does not recover.

Five repetitions per condition:

| Metric | Flat 22-tool exposure | Progressive 4-tool projection |
| --- | ---: | ---: |
| task success | 5/5 | 5/5 |
| avg model iterations | 2.0 | 2.0 |
| avg input tokens | 1,196 | 898 |
| avg output tokens | 35 | 35 |
| avg wall time | 1,287 ms | 1,500 ms |
| first-call tool schemas | 22 | 4 |
| explicit `capability_search` calls | 0 | 0 |
| target tool calls | 1/run | 1/run |

Observed delta:

- input tokens: **-24.9%** (1,196 -> 898);
- model rounds: **no increase** on this obvious task because deterministic
  task preload recovered the hidden tool before the first provider call;
- task/tool-selection success: **unchanged at 5/5**;
- average wall time: **+16.6%** (1,287 ms -> 1,500 ms) in this ten-run sample.

The latency sample is too small to claim a provider-level latency win or loss,
but it is intentionally recorded rather than hidden: the context reduction did
not make this sample faster.

Railway deployment:
`d51c4f59-7aa9-400c-9c37-74c208bf0206`

Machine line:

```text
CAPABILITY_REAL_MODEL {"model":"gpt-4o-mini","reps":5,"flat":{"pass":"5/5","avgIterations":2,"avgInputTokens":1196,"avgOutputTokens":35,"avgMs":1287},"deferred":{"pass":"5/5","avgIterations":2,"avgInputTokens":898,"avgOutputTokens":35,"avgMs":1500}}
```

## Small-catalog counterevidence

Before widening the lane to current catalogue breadth, the same model was also
run with only six ordinary schemas in the flat condition versus four in the
progressive condition.

Five repetitions per condition:

| Metric | Flat 6-tool exposure | Progressive 4-tool projection |
| --- | ---: | ---: |
| task success | 5/5 | 5/5 |
| avg model iterations | 2.0 | 2.0 |
| avg input tokens | 606 | 902 |
| avg output tokens | 35 | 35 |
| avg wall time | 2,129 ms | 1,282 ms |

At that small scale the progressive harness cost **more** input tokens despite
showing fewer schemas. This is useful negative evidence and supports the issue's
latest owner direction: progressive disclosure must not become a mandatory hop
when the catalogue already fits. The under-cap fast path therefore remains
static and does not expose `capability_search` or its harness guidance.

Railway deployment:
`af2e268a-323e-40be-ab18-5496e229bf1e`

## Interpretation

The data supports a conditional mechanism rather than a universal discovery
architecture:

```text
catalogue fits profile ceiling
  -> ordinary static exposure

catalogue exceeds profile ceiling
  -> authority-filtered small core
  -> deterministic task preload where lexical evidence is sufficient
  -> capability_search fallback for unresolved needs
  -> normal runTool -> kernel execution
```

This preserves the concrete #469 guarantee — authorized needed capabilities no
longer disappear because of registration order — while respecting the strongest
counterevidence in the issue: at a genuinely small tool surface, discovery
overhead can be worse than flat exposure.

## Limits

This is not a universal provider benchmark:

- one model/provider;
- one unambiguous target task;
- five repetitions per condition;
- synthetic capability bodies around a real Muffin turn loop;
- no provider cache telemetry was exposed by this lane.

The result is sufficient for the #469 mechanism decision because it directly
tests the acceptance delta at current catalogue breadth, but it does not justify
embeddings, semantic routing, a universal registry rewrite, or provider-specific
tool-search semantics.
