# Live main-model switching: evidence and design challenge

Date: 2026-09-13
Checkout: `codex/live-main-model-switch` at `904ee19267a92e67dbadbb066a8ea9a2d3ff3fa9` (`origin/dev`)
Question: should a running Muffin Gateway apply a saved main model/provider-routing change without restart, and where is the safe boundary?

## Observed Muffin behavior

The Gateway calls `buildRuntime(home)` once, then gives `runtime.deps` to the durable `TurnLane` (`cli/gateway.ts`). `buildRuntime` reads `config.json` once, constructs `OpenAICompatProvider` with the then-current routing, and selects the model profile once (`agent/runtime.ts`). `enqueueTurn` persists `deps.model` to the durable turn (`agent/loop/entry.ts`). The provider constructor stores routing, so changing only `runtime.config` cannot change the next provider request.

The user-visible failure and current contract are recorded in issue #532: after saving `models.main=openrouter/free` and removing the stale model-derived route, a fresh CLI used the new route but Telegram on the still-running Gateway kept the boot-time provider/model/profile. The smallest falsifier tests already present in this checkout give **29 pass / 2 fail** before the implementation: a fresh queued turn records the old model, and a retry can move from provider A to mutated provider B within one turn.

Falsifiable claim: after a valid main model/provider/thinking change has been persisted, the next newly enqueued or directly started turn uses a provider built from the current main provider config and the matching profile; every subsequent call/retry in a turn already running continues to use its starting provider/model/profile, billing endpoint, and model-facing `sys_inspect` facts. A queued row that has never built context may adopt the newly selected model before its first attempt; suspended durable turns stay pinned and retain the existing refusal when the current model differs.

## Existing invariant and options

Current safety invariant: a durable turn records its model; `resumeTurn` refuses a turn when the recorded model differs from the current one because provider reasoning signatures may not be portable (ADR-0037). Model/provider changes must not reset Muffin's durable identity or session state (`docs/ARCHITECTURE.md`). Provider choice is also an egress boundary (`docs/SECURITY.md`); applying it only at a clean turn boundary makes the destination change observable and avoids one turn crossing providers mid-flight.

| Option | Evidence for | Counter-evidence / cost | Decision |
|---|---|---|---|
| A. Rebuild main provider/profile from persisted config immediately before a fresh turn; snapshot `LoopDeps` for the whole turn | Directly fixes both red falsifiers; preserves current durable model pin; limited to main lane | Requires one explicit refresh seam and tests proving the Gateway's queue path reaches it | **Choose.** Existing #532 contract and owner setting already authorize main model/provider config; no setup or authority model changes |
| B. Watch config continuously and mutate the live runtime | OpenClaw documents configuration reload planning with hot-apply/restart/no-action classes; this can keep broad runtime state fresh | More moving lifecycle; risks mutating an in-flight turn and refreshing unrelated light/surface/MCP state | Reject for this slice; reconsider only if new runtime facts prove turn-boundary reads inadequate |
| C. Restart Gateway or preserve boot snapshot until restart | Hermes documents new model config applying to new Gateway sessions while active sessions keep their model | Reproduces Muffin's measured Telegram failure: one long-lived Gateway never sees the saved change | Reject for main model because Muffin issue #532 explicitly requires next-turn activation |

OpenClaw's current hot-reload docs classify `agents` and `models` among settings that do not require a Gateway restart and describe reload planning by changed path: [Configuration hot reload](https://docs.openclaw.ai/gateway/configuration/hot-reload). Hermes' current model guide keeps an existing Gateway session on its starting model and applies persisted changes to the next new session, with an explicit `/model` path for a live session: [Configuring models](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuring-models.md). These peers demonstrate two viable lifecycle boundaries; neither overrides Muffin's measured failure or #532's next-turn contract.

## Verification and reversal conditions

The selected boundary is falsified if any of these are true:

- changing the persisted main model and provider routing does not change a fresh turn's stored model and provider routing in an already-running runtime;
- changing the model does not reselect owner thinking/profile behavior or live tool exposure/introspection;
- a turn that started with provider/model/profile A sends any later call/retry with B after config refresh;
- a turn that started with provider A is priced using B's billing endpoint after config refresh;
- `sys_inspect` in turn A reports B's model/provider/profile after another turn refreshes the runtime;
- a queued, never-started user message is refused or dropped after the model changes before its first lane tick;
- light/embed behavior changes as a side effect;
- a suspended A turn is silently sent to B instead of refused.

Required proof: the existing tests fail against the old behavior; targeted runtime-wiring and turn-atomicity tests pass; deliberate mutations independently disable provider refresh, profile/exposure refresh, and turn snapshotting and make their corresponding regressions fail; typecheck and `git diff --check` pass. The complete integrated merge-result check remains the canonical gate before `dev`.

Verification profile: **CRITICAL**, because applying provider routing selects an outbound model-provider egress destination. Independent fresh review is required before integration.
