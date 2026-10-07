# Capability exposure measurement — 2026-10-07

Candidate: `0a1f56b322c283732494b68220efbf6a19e33d86`  
PR: #854  
GitHub Actions run: `verifica` 37643138069

## What was measured

The measurement uses the real `buildRuntime` native owner catalogue, applies
the same `visibleTools` authority filter as the production loop, then compares
the full authorized native tool schema set with the #469 initial projection
under the shipped conservative ceiling (`maxToolsExposed = 10`).

It also asks the deterministic local discovery path for fourteen representative
native capabilities using task-shaped queries rather than raw tool ids.

Observed in GitHub Actions:

```text
CAPABILITY_EXPOSURE_METRICS {"fullToolCount":21,"initialToolCount":6,"fullSchemaBytes":24471,"initialSchemaBytes":6252,"schemaByteReductionPct":74.5,"representativeTasks":14,"selectionHits":14,"selectionSuccessPct":100,"extraDiscoveryModelRoundsPerHiddenTask":1}
```

The full verification gate at this candidate reported:

```text
Test Files 393 passed (393)
Tests      5185 passed | 3 skipped (5188)
```

## Result

| Metric | Observed |
| --- | ---: |
| authorized native tools in flat baseline | 21 |
| schemas in initial pressured projection | 6 |
| flat serialized ToolSpec bytes | 24,471 |
| initial serialized ToolSpec bytes | 6,252 |
| schema-byte reduction | 74.5% |
| representative deterministic-search tasks | 14 |
| expected capability in loaded top-3 | 14/14 |
| deterministic selection success | 100% |
| structural extra model rounds for a hidden capability | 1 |

This falsifies the old claim that the current catalogue is too small for
progressive disclosure to save meaningful schema context: at the conservative
ceiling the initial serialized schema payload is about one quarter of the flat
native catalogue.

It does **not** prove that every model benefits. A hidden capability adds one
model/discovery round, and these fourteen cases measure the deterministic search
layer, not a real model deciding whether and how to invoke `capability_search`.

## Current external guidance rechecked

OpenAI's current Tool Search documentation says deferred loading trades an
additional discovery step for lower up-front tool context, supports
client-executed search when availability depends on tenant/project/application
state, and recommends comparing task completion, input-token usage and latency
before choosing it as a default.

Anthropic's current advanced-tool-use guidance likewise recommends keeping a
small frequent set eager and discovering the remainder, while its strongest
published gains come from much larger MCP catalogues than Muffin's current one.

Sources:
- https://developers.openai.com/api/docs/guides/tools-tool-search
- https://www.anthropic.com/engineering/advanced-tool-use

## Remaining evidence

Before this CRITICAL slice can integrate:

1. a load-bearing wiring mutation must show that bypassing the production
   projection makes the beyond-cap production-path proof fail for the expected
   reason;
2. real-model/provider task success and latency should be measured on a lane
   with owner-controlled credentials rather than fabricated in CI;
3. the branch must be current with `dev`, full Ready-for-review acceptance must
   run, and a fresh independent judge must return terminal `MERGE`.

The deterministic measurement above is reusable only while the relevant
catalogue/projection/search code remains unchanged.
