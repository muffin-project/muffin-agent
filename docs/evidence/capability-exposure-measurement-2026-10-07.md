# Capability exposure deterministic measurement — 2026-10-08

Measured candidate: `87e8b594907fda3feffe60ac1371c371ea84b548`  
PR: #854  
GitHub Actions run: `verifica` 37694712266

## What was measured

The measurement uses the real `buildRuntime` native owner catalogue after the
current `dev` reconciliation, applies the same `visibleTools` authority filter
as the production loop, then compares the full authorized native ToolSpec set
with the #469 initial projection under the conservative ceiling
(`maxToolsExposed = 10`).

It also asks the deterministic local discovery path for fourteen representative
native capabilities using task-shaped queries rather than raw tool ids.

Observed in GitHub Actions:

```text
CAPABILITY_EXPOSURE_METRICS {"fullToolCount":22,"initialToolCount":6,"fullSchemaBytes":26319,"initialSchemaBytes":6318,"schemaByteReductionPct":76,"representativeTasks":14,"selectionHits":14,"selectionSuccessPct":100,"extraDiscoveryModelRoundsPerHiddenTask":1}
```

The same verification gate reported:

```text
Test Files 396 passed (396)
Tests      5237 passed | 3 skipped (5240)
```

## Result

| Metric | Observed |
| --- | ---: |
| authorized native tools in flat baseline | 22 |
| schemas in initial pressured projection | 6 |
| flat serialized ToolSpec bytes | 26,319 |
| initial serialized ToolSpec bytes | 6,318 |
| schema-byte reduction | 76.0% |
| representative deterministic-search tasks | 14 |
| expected capability in loaded top-3 | 14/14 |
| deterministic selection success | 100% |
| explicit-search extra model rounds for a hidden capability | 1 |

This proves that, at the current native catalogue breadth, the profile ceiling is
not merely theoretical pressure: an initial progressive projection can remove
about three quarters of serialized tool-schema bytes while deterministic local
selection still recovers all fourteen representative targets in the test set.

The final mechanism does not force that extra round for every hidden
capability. An obvious task-relevant hidden tool may be selected from the owner
request and preloaded before the first provider call; `capability_search`
remains the fallback when the task text does not recover the need.

## Real-model evidence

Model behavior, token use and latency are measured separately in:

`docs/evidence/capability-exposure-real-model-2026-10-08.md`

At a 22-schema flat baseline versus a four-schema progressive projection,
`gpt-4o-mini` completed 5/5 tasks in both conditions with the same two model
iterations. Progressive exposure reduced average input tokens from 1,196 to 898
(-24.9%) while average wall time in the small sample increased from 1,287 ms to
1,500 ms (+16.6%).

The same lane intentionally records the small-catalog counterexample: with only
six flat schemas, progressive exposure used more input tokens. That is why the
under-cap path remains static.

## Current external guidance rechecked

OpenAI's Tool Search guidance supports deferred loading and client-executed
search for application-controlled catalogues, while recommending comparison of
task completion, input-token usage and latency before choosing a default.

Anthropic's advanced-tool-use guidance likewise supports a small eager set plus
search for broader catalogues, with its strongest published gains at much larger
tool counts than Muffin currently has.

Sources:
- https://developers.openai.com/api/docs/guides/tools-tool-search
- https://www.anthropic.com/engineering/advanced-tool-use

## Remaining gate

The mechanism, production wiring, authority-negative path, load-bearing mutation
and model comparison are all recorded. Integration still requires:

1. Ready-for-review acceptance green on an unchanged current head;
2. current `dev` still matching the integration base immediately before review;
3. a fresh independent CRITICAL judge returning terminal `MERGE`.

This deterministic evidence is reusable on a later documentation-only head
because the catalogue/projection/search code and test remain byte-identical.
