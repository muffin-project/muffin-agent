# Compound capability discovery — 2026-10-10

Question: does the progressive menu correctly guide completion when visible tools
cover the reads but the requested filesystem effect remains hidden?

Measured baseline: G0 compiled CLI at `a61e275c3ae77c414176b0b75951cb06b9f0188d`,
isolated real install, `nvidia/nemotron-3.5-lightning:free` served by Nvidia,
six-schema installation profile. The natural request reads two synthetic notes
and creates their shared decision document. The first request contains
`capability_search`, omits `fs_write`, and has one preloaded `document_read`.
Eight successful provider calls read the real notes repeatedly and list the
workspace; none selects discovery or writes the artifact. The oracle fails.
Reported usage: 71,801 aggregate input tokens, 1,330 output, 45,696 cache-read,
1,229 reasoning, cost 0. Individual prompt sizes grow from 8,342 to 9,658 tokens;
this is not the earlier local context truncation hypothesis.

Production wiring: `engine.ts` inserts `CAPABILITY_DISCOVERY_GUIDANCE` as volatile
harness context immediately before the owner input; the request snapshot proves
it reaches the provider. The schema from `makeCapabilitySearchTool` reaches the
same request. Both descriptions say to search when no visible tool fits the
task. A visible reader fits a part, while the missing write is still required.
This ambiguity is a hypothesis for the failure, not a proven model diagnosis.

The architecture challenge in `capability-exposure-challenge-2026-10-07.md`
remains applicable: eligible catalogue, bounded projection, local search,
normal kernel execution. The relevant prior art remains on-demand expansion;
[Anthropic's guidance](https://www.anthropic.com/engineering/advanced-tool-use)
also warns that discovery adds a step and can be less useful for small menus.

| Candidate | Evidence / limitation | Decision |
|---|---|---|
| Clarify coverage of every requested effect in the existing guidance and search description | Removes ambiguous partial matching; no new primitive or authority change. May still fail on this model. | First bounded experiment |
| Reduce the eager kernel via the existing installation profile | Fewer irrelevant choices may help. It changes the menu and does not repair the general partial-completion wording. | Diagnostic alternative if the first experiment fails |
| Expose all eligible tools / remove progressive discovery | Can test whether ordinary writing works and removes search overhead. Cannot itself prove G0's hidden-capability requirement. | Control experiment only; no G0 PASS |
| Add another planner/router or forced tool choice | No evidence that existing primitives are insufficient; would replace the model's choice. | Reject |

Chosen claim: under pressure, guidance must direct discovery for an uncovered
requested effect even after a visible tool completes another part. Change only
these descriptions, preserving ranking, preloading, filtering, kernel, grants,
schema cap and provider configuration. Reuse the same scenario/model/profile.
No task-specific filename or forced call enters product guidance. The real
oracle must prove search -> loaded schema -> model-selected write -> settled
effect, plus the negative authority scene. If it still loops, do not pile on
prompt exceptions; compare the declared alternatives.

Verification: targeted existing exposure production-path tests, recorded actual
request guidance, then bounded real CLI acceptance. A final independent review
must assess the exposure/authority guarantee before integration. No success is
claimed from this decision record alone.

## Second observation and instruction conflict

At `793a3028109dc9e7733bd7f34542b3b4b11b378b`, the same NVIDIA Free
scenario/profile still fails: eight successful responses, no discovery or write.
Aggregate input 72,115, output 1,338, cached 56,576, reasoning 1,236, reported
cost 0. The local budget correctly stops the owned CLI at the ninth attempted
request; only eight are forwarded. The wording-only partial-coverage hypothesis
is insufficient. Negative authority remains NOT_RUN.

The actual captured system prompt contains a contrary unconditional rule:
“I tool che hai sono quelli che vedi” and asks the model to report absence
when none is visible. Both WORK_RULES versions in `agent/context/assemble.ts`
still encode this closed-menu assumption. Producer: buildSystemPromptBlocks;
consumer: buildRuntime systemPrompts then runTurn provider request. The existing
volatile discovery guidance arrives in a lower-role user message and cannot
consistently override the static system rule. This is a factual instruction
conflict; its contribution to this model's failure remains an experiment.

Remove the obsolete closed-menu assertion from both versions, replacing it
with one truthful conditional rule: when capability_search is visible, search
for the authorized missing capability before reporting absence. Preserve the
prohibition on inventing tools, policy and permission; preserve kernel grants
and fenced data. This changes the stable prefix once, recorded explicitly in
the existing cache-pin test. It needs no new context manager or dynamic system
prompt mechanism. Keep the model, scene and profile unchanged for comparison.

If this reconciliation does not suffice, use the declared diagnostic alternatives
rather than accumulating more prompt exceptions. Independent review found the
artifact oracle's normalized substring accepted unrelated extra content; tighten
that oracle to the existing fixture's exact decision before any PASS claim.
