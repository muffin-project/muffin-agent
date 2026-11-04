# #605 acceptance and evidence closure — 2026-10-07

## Claim

Current Muffin `dev` can converge existing schedule and message producers plus embedded Event Intelligence on one small typed execution seam:

```text
RuntimeEvent
  -> AutomationRule
  -> ActionRequest
       -> deterministic
       -> agent
       -> deterministic_then_agent_on_signal
```

without adding a second scheduler, agent loop, authority path, generic event bus or canonical event store.

This record is evidence for PR #851. The durable non-time rule representation is now resolved by the store audit below; model-visible EI tool projection remains owned by #469.

## Canonical owners kept intact

- scheduler clock + occurrence identity: `JobStore` / `JobFireStore`;
- inbound message identity/routing: shared ingress claim/work path;
- agent execution + continuation: canonical Turn/Work loop;
- authority/policy/effects: existing kernel/WAL;
- internal event-log direction: #780;
- MCP credentials/transports: Muffin-owned verified MCP sessions;
- persistent complex external conditions: embedded Event Intelligence only.

## Executable acceptance map

### A — schedule, deterministic / no model

Current `script` jobs now enter `schedule.fire -> AutomationRule -> ActionRequest(mode=deterministic)` before executing the existing sandboxed script path.

Existing production-path scheduler tests prove:
- provider call count remains zero for script work;
- a durable Turn receipt is written before the deterministic effect;
- a crash/re-observation of the same `JobFire` does not execute the script a second time;
- missing sandbox fails closed without invoking the model.

The refactor therefore changes composition, not durability ownership.

### B — deterministic first, optional agent

`agent/automation.test.ts` pins the three action modes independently:
- deterministic action does not fall through to agent;
- `agent` is an explicit executor choice;
- `deterministic_then_agent_on_signal` does not invoke agent on `signal:false`;
- `signal:true` forwards only the emitted evidence to the agent callback.

The current durable schedule projection already covers deterministic-only and agent-only through the same seam. For non-time rules, `core/automation/rules.ts` now persists the action mode plus a host-owned action reference, and `compileStoredAutomationRule` projects that data into the same executable seam without giving the store an executor.

### C — `message.received`

The shared ingress `work` stage now emits a stable `RuntimeEvent` using the already-committed Work identity.

Production-path tests prove:
- a matching owner `"buongiorno"` rule executes its deterministic action exactly once;
- the matched deterministic path performs zero model calls and does not mint a hidden Turn;
- an unrelated owner message evaluates the matcher once, executes no automation action, and takes the ordinary conversation path with exactly one normal model call;
- no connector-specific `preTurn` or `onMessage` hook exists.

The execution proof still dependency-injects resolved rules into the shared work stage, while the durable definition is now explicit: `AutomationRuleStore` owns only non-time rule definition/matcher/action + provenance/authority + enabled/version. The audit at `docs/evidence/automation-rule-store-audit-2026-10-07.md` shows why JobStore, TurnStore, TodoStore, wait, SessionStore and the existing decision/fire/approval stores are not semantic homes for that state.

### D — EI external condition -> canonical durable work

The embedded EI adapter now enters the same seam as `external.condition.matched`.

Tests prove:
- EI reuses only verified host-owned MCP sessions;
- suspended/rug-pulled MCP servers are not exposed to EI;
- trigger create/list/inspect/pause/resume/update/delete pass the public EI v0.11 management conformance contract;
- a matched external event persists exactly one runnable Muffin Turn in the real `TurnStore`;
- that wake is `system:automation`, not owner authority;
- external evidence starts at taint 3 and remains fenced;
- the original source Turn remains owner-authored and unchanged;
- `enqueueTurn` now honors a caller-supplied durable `TurnInput.id` instead of silently minting a competing random id;
- the EI deterministic receipt id is therefore the canonical Turn id written to `TurnStore`;
- replaying the same external MCP event occurrence does not mint a second durable wake.

## Negative-space / forbidden mechanisms

Absent by construction in this PR:
- generic event bus;
- second scheduler;
- second agent loop;
- owner impersonation for autonomous wakes;
- model call to decide whether a deterministic action should call the model;
- process-local event occurrence identity where a durable producer identity already exists;
- EI-owned canonical Muffin event log;
- Jev/TypeSafe in production authority, policy, idempotency or exactly-once paths.

## #606 shadow decomposition

The current doctrine in #606 supersedes mandatory semantic-judge ceremony: deterministic evidence is sovereign, and Jev/TypeSafe may be used only as shadow/calibration where it materially helps.

The bounded judgment pack for this slice is still recorded so the design remains auditable:

- `repair_layer`: **runtime-primitive** — repeated scheduler/message/external-event composition is the missing primitive, not a leaf fix;
- `deterministic_first`: **yes** — known matching/execution stays in code;
- `parallel_mechanism`: **no** for the chosen design — scheduler/ingress/Turn authority remain canonical;
- `semantic_owner`: **runtime-composition**;
- `special_case_risk`: material if EI or one connector bypasses the seam; reduced by routing all three through it;
- `counterevidence_material`: **yes** — peer runtimes show useful automation without requiring a universal EventBus, which is why this PR stops at the narrow waist.

No TypeSafe/Jev result is a merge gate or runtime dependency.

## Freshness / counterevidence pack

Reconciled against the current #606 research pack and #605 follow-up:

- **SUPPORTS** — Anthropic's current workflow-vs-agent guidance and OpenAI's current agent guidance both support deterministic/programmatic paths when the transition is known, reserving agent execution for open-ended judgment.
- **SUPPORTS** — current Hermes independently demonstrates zero-LLM scheduled scripts plus optional agent escalation/external triggers.
- **CONTRADICTS / pressure against overbuilding** — Hermes does not need a universal event bus for useful automation; AutoGen/OpenHands analogues have broader distributed/runtime scope than Muffin needs.
- **SUPPORTS smaller model horizon** — `How Fast Do Agents Rot?` reports compounding long-horizon reliability degradation; this pressures deterministic work out of the model-controlled path.
- **SUPPORTS selective context** — `Less Context, Better Agents` pressures against retaining every intermediate/tool result merely because it exists.
- **DOES NOT SETTLE** — none of those sources prove Muffin's exact type names, storage representation, tool projection or rule persistence model. Those must be decided from Muffin's own constraints/tests.

## CI / verification profile

PR #851 is CRITICAL because it changes the unattended-execution boundary.

Required before ready-for-review:
- current-head DCO;
- typecheck;
- full suite;
- install;
- links/tools workflows;
- Symphony/OpenCode fixture;
- targeted #605 acceptance above;
- public EI management conformance;
- fresh independent judge once #469/tool projection is resolved and the candidate stops moving.

## Remaining external dependency

### EI model-visible tool projection

Current consumer profile has no spare permanent tool slots. The old spike's answer — raising `maxToolsExposed` for EI — is deliberately rejected.

#469 owns the structural catalogue/truncation problem. The accepted direction is an authority-filtered catalog, a small always-visible kernel and discovery/load, implemented as a separate composable slice rather than EI-specific discovery.

The durable rule-store decision is no longer open: the store audit found no existing semantic owner for non-time rule definitions, and this PR now carries the minimum definition-only store described above.

## Integration audit — 2026-10-08 (after #854, before CRITICAL verdict)

The PR is **not** a claim that arbitrary persisted `message.received`
definitions already execute in production. These three facts are distinct:

1. **Shipped candidate path:** `attachMcp -> attachEventIntelligence`
   registers embedded EI tools through the ordinary runtime registry and
   #469's authorized capability discovery. Real EI matches enter
   `external.condition.matched -> system:automation` and use the canonical
   TurnStore receipt and existing loop. Production loop discovery and direct
   kernel denial are exercised by
   `agent/event-intelligence-discovery.test.ts`.
2. **Executable but injected only:** `connectors/shared/ingress/work.ts`
   dispatches `message.received` against `deps.automationRules ?? []`.
   The in-memory deterministic/agent seam is tested. **No current live gateway,
   connector or REPL caller provides compiled definitions from
   `runtime.automationRules` with a host-owned action resolver**. Persisted
   `message.received` definitions are *definition-only*, **not live
   automations**. Promoting them requires a separately reviewed production
   resolver/authority + receipt/replay contract, without a second work lane.
   This residual must not be used to advertise an active feature.
3. **Restart read-scope boundary:** `WakeOwnerBindings` maps an EI wake Turn
   ID to explanatory owner-read scope **in memory** (max 1024, erased on close).
   The canonical wake Turn and owner-authored watch definition are durable;
   the autonomous read association is not. After restart/eviction, resumed
   autonomous work can lose the ability to list/inspect the watch, but cannot
   gain owner write authority. `agent/event-intelligence-restart.test.ts`
   pins the fail-closed restart semantics. Owner-initiated management remains
   the supported read/write path.

### #469 + EI autonomous authority

The sealed `POLICY_FLOOR.forbiddenForSystem` now excludes
`events.trigger.create` and `events.trigger.manage` for all autonomous
principals before preload/discovery; the embedded EI host action-control still
independently rejects non-owner mutations. The new production-loop test
falsifies a leaked system discovery schema or direct-name mutation bypass.

This audit narrows the acceptance statement rather than asserting that
green unit tests prove production wiring which does not yet exist. Fresh
independent CRITICAL judgment and exact-head CI/acceptance remain mandatory
before upstream integration.
