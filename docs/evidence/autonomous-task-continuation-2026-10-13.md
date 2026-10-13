# Autonomous task continuation — 2026-10-13

## Decision this evidence changes

Should an already-authorized interactive task require another owner message
whenever a short execution segment ends?

**Recommendation: revise that requirement.** Continue unfinished, authorized
work within its granted activity allowance. A scheduling/checkpoint boundary
must not itself request more authority. Request owner action for an actual
approval, a changed scope, an exhausted overall allowance, or an unrecoverable
failure. Keep cancellation and bounded provider recovery.

This is a researched behavioral recommendation, not an implemented policy or a
claim that all peers use the same budget metric. A universal models-plus-tools
wall-time cap and a particular numeric default are **not established** by the
sources below. Raising the existing timer alone retains the disputed policy.

## Muffin: measured problem and production cause

Checkout: `6edb42bc06d4c8c6901c1492550c0fe56a267999`.

- The installed-runtime investigation recorded two useful-work leases ending
  at the local 240-second active-model allowance. ChatGPT transport failures were
  a separate classification defect, repaired by #887. Its tests do not prove
  autonomous task completion.
- A fresh read-only database aggregate for leases ending since 2026-10-06 found
  2 `active_model_budget`, 23 `answered`, 9 `error`, 1 `ask`, and 1 `aborted`.
  No currently `continuable` row updated in that interval was found. These are
  lease counts, not task-success rates; they cannot quantify the owner's entire
  history or establish the causes of all nine errors.
- `agent/profiles/frontier.json` still grants 120 seconds per model call,
  240 seconds of main-model invocation time, and a 300-second drive deadline.
  `ExecutionBudget.beginModelCall()` takes the smallest remaining deadline.
  `round.ts` releases a continuable lease after local exhaustion.
- `TurnStore.due()` deliberately excludes interactive continuable work.
  `isSchedulerAutonomous()` admits only scheduler-principal job rows. The lane
  already invokes `continueTurn()` for those rows, with financial gates and at
  most three autonomous renewals. Interactive work needs another owner grant.
- `continueTurn()` preserves the Turn identity, evidence, WAL and taint, but
  refreshes lease counters. Lifetime accounting exists; a durable immutable
  activity allowance does not. Automatically refreshing interactive leases
  without that allowance would not implement bounded cumulative autonomy.

Historical evidence strengthens the challenge to the old assumption:
[the September 28 investigation](abort-locale-e-ripresa-2026-09-28.md) found
20 lease failures around 30.000–30.037 seconds across five upstreams. A local
watchdog was being diagnosed as an upstream failure. The same investigation
found continuation-selection and delivery defects. These are historical
observations, not claims that those repaired defects persist at current HEAD.

[ADR-0086](../decisions/0086-la-lease-finisce-il-lavoro-continua-turno-continuabile.md)
correctly separated unfinished work from a finished execution lease. It also
made owner-only interactive renewal explicit. The original provider-stall
interpretation was later corrected in its own amendment. No comparative
evidence in that ADR establishes repeated human renewal as the best policy.

## Current primary comparison

Retrieved 2026-10-13. GitHub sources are pinned; hosted documentation is a dated
observation. Source code establishes behavior, not comparative performance.

| System | Observed behavior | Implication and limit |
| --- | --- | --- |
| [Codex, `6fbfc352`](https://github.com/openai/codex/blob/6fbfc352cafb50332d62dbdc8720cb5d7fe3b7c7/codex-rs/core/src/session/turn.rs#L548) | After sampling and tool processing, `needs_follow_up` includes model follow-up and pending input; the loop continues. Completion, cancellation and errors have separate exits. | Continued tool work does not require another human message at each loop step. This inspected path alone does not prove all Codex limits or completion reliability. |
| [Hermes, `8f817911`](https://github.com/NousResearch/hermes-agent/blob/8f817911723e3ec13e7f47fc022fdcc9e2149354/agent/conversation_loop.py#L1648) | The conversation loop continues within its iteration budget; [configuration](https://github.com/NousResearch/hermes-agent/blob/8f817911723e3ec13e7f47fc022fdcc9e2149354/hermes_cli/config.py#L1826) resolves an unspecified iteration limit to `sys.maxsize`. | A configurable cap exists without a small mandatory iteration ceiling. The old `iteration_budget.py` comment describing a default 500 is insufficient to establish current caller behavior. Unlimited iterations do not mean unlimited provider recovery or guaranteed completion. |
| [OpenAI Agents SDK, `f53c6245`](https://github.com/openai/openai-agents-python/blob/f53c62451c7f34c15f0c87fa745e05404025420f/.agents/references/runner-lifecycle.md) | Logical-turn accounting and `max_turns` survive interruption/resume; `NextStepRunAgain` continues execution. Approval interruptions retain processed state. | Supports durable consumption and distinct approval boundaries. An SDK turn cap is not evidence for a particular Muffin time allowance. |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/python#claudeagentoptions) | `max_turns` and `max_budget_usd` are optional. The latter estimates the current query's spend; restored-session totals do not count. | Supports optional task limits, but copying query-local cost accounting would not establish Muffin's desired cumulative activity ceiling. |
| [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/budgets) | A shared session spend budget pauses new model requests at the cap while retaining state; requests already started finish. The budget includes priced model/tool/runtime consumption. | Strong prior art for an overall grant and explicit budget exhaustion. Requires priceable consumption; list-cost accounting cannot be transplanted unchanged to subscription providers. |
| [OpenClaw](https://docs.openclaw.ai/concepts/agent-loop#timeouts) | Client wait timeout does not cancel the run. Runtime attempt limits, provider idle/progress watchdogs and scheduler deadlines are separate. Its documented default attempt budget is 48 hours; fallback refreshes it. | Short client waits need not require task renewal. Fresh attempt budgets can exceed the total implied by one attempt setting; the numeric default is not a validated Muffin budget. |

Anthropic's [March 2026 harness experiment](https://www.anthropic.com/engineering/harness-design-long-running-apps)
provides empirical evidence against preserving imposed work segmentation:
after Opus 4.6, it removed the sprint construct and moved evaluation to the end
of a run; the builder worked coherently for over two hours. Evaluation still
found functional omissions. This is a disclosed application-development
experiment, not a controlled benchmark of Muffin or every task type.

## Alternatives and decision

| Alternative | Evidence for | Evidence against / disposition |
| --- | --- | --- |
| Increase 240 seconds, retain human renewal | Small configuration change; delays a demonstrated local cutoff. | Does not remove repeated renewal or establish continuity across segments. Insufficient as the product fix. |
| Automatically issue fresh short leases forever | Existing continuation primitive and scheduler wiring. | Resets capacity; permits unbounded consumption. Rejected. |
| Retain Turn/WAL, continue internally within an activity grant | Existing durable identity plus convergent peer lifecycle patterns; directly addresses the owner intervention. | Requires cumulative allowance and correct cancellation/approval/restart accounting. Recommended claim. |
| Remove all limits and recovery bounds | Some peers permit unlimited loop iterations. | Does not follow from evidence; cannot govern failed-provider loops or spending. Rejected. |
| Add another Work/Goal orchestrator | Could carry a grant. | Turn already represents this unfinished task; no evidence that another layer is necessary. Rejected for this claim. |

The established product failure is unnecessary human renewal. Testing whether
the owner should keep tolerating that failure is not a prerequisite for changing
the policy. Tests must instead falsify the new continuity and control guarantees.
The precise allowance metric/default still needs provider-neutral accounting;
absence of consensus on seconds versus calls does not justify keeping the old
human-intervention boundary.

## Implementation acceptance (not yet run)

Use the existing Turn, WAL, lane and continuation primitive. Classify the
implementation CRITICAL because it changes durable allowance, claims and effect
recovery. A material change to ADR-0086 requires a new ADR.

1. Authorized work crosses a former local segment boundary and completes
   through the real CLI/gateway runtime without an injected owner `riprendi`.
2. Approval suspends execution without fabricated consent; responding settles
   the existing action and continues the same work without replaying its effect.
3. `/stop`, changed scope, denied authority and terminal credential failures do
   not silently restart. A provider stall exhausts bounded recovery visibly.
4. Restart/resume retains both granted capacity and consumption; concurrent
   pickup cannot duplicate effects or refresh the total grant.
5. Genuine activity-budget exhaustion retains the checkpoint and requests an
   explicit extension. Removing the cumulative-accounting/claim guards must
   fail the relevant tests.

Real model acceptance and independent effect/state oracles remain required.
No execution limit, personal installation setting or autonomy policy was changed
by this research. No measured completion-rate improvement is claimed.

## Implementation evidence (integration pending)

PR #889 implements ADR-0100 using an additive allowance in the existing Turn
counter JSON. The initial candidate is `091b9d59`. Focused watchdog/store/loop
coverage passed 133 tests; restoring the former aggregate timing policy makes
healthy-work coverage fail (three unnecessary renewals instead of zero).

Fresh independent review found a real composition defect: AsyncLocalStorage
propagated the completed activity claim into the consolidator's idle timer,
preventing background light requests. A registered production-loop regression
failed before repair. The post-turn dispatch now exits that scope; active task
main/light calls remain scoped. Idle and ceiling consolidation, concurrent owner
activities, lane recovery after a crash, and independent recorded-effect oracles
are covered. Reviewed focused follow-up: 43 PASS, including 15 existing real
runtime consolidation wiring tests. Typecheck and compilation passed.

The first real CLI duration witness was **FAIL**, not accepted: the driver used
its checkout as cwd while its chain files were in a separate workspace. The
model received missing-file errors, concluded after 495,802 ms, and did not
write a receipt. The report's CLI exit 0 was insufficient; the independent
receipt/duration oracle correctly rejected it. The driver was corrected.

A real-model duration witness must preserve actual provider responses and
verify elapsed time, terminal Turn state and receipt independently. Controlled
latency injection demonstrates the absence of aggregate cutoffs; it does not
benchmark natural task completion or establish optimal numeric resource limits.
The required >=15-minute successful witness remains pending here.

A second independent review confirmed a supported rollback hazard: previous
writers recognize schema v9 but omit the new allowance when serializing run
counters. The existing schema-ahead boundary now protects this semantic JSON
change with a no-op v10 migration. Red-before populated-v9 coverage failed;
27 focused migration tests then passed, checking unchanged canonical rows,
validated v9 backup, idempotence and prior-writer refusal before execution.
