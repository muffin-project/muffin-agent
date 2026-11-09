# One-shot arming from conversation

On `a30384c7`, an authenticated private Telegram request reached the compiled
runtime using a fixture Bot API and inference. The recurring handler rejected
the CLI's one-shot sentinel and persisted zero jobs. The owner-turn `wait`
journey and Todo reminders use different execution paths. See the
[baseline in #598](https://github.com/muffin-project/muffin-agent/issues/598#issuecomment-6739146297).

| Candidate | Trade-off |
| --- | --- |
| Extend or rename the recurring tool | One schema, with a misleading existing name or compatibility cost for saved calls. |
| Expose a short one-shot action under the same capability | Preserves recurring calls and reuses scheduling, effect policy, and discovery. Adds one tool schema. |
| Reuse `wait` or Todo | Existing conversational paths for suspended owner turns and reminders. Neither arms a separate scheduler-principal job. |

[Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#creating-scheduled-tasks)
uses a unified conversational scheduler and denies recursive admission.
[OpenClaw](https://docs.openclaw.ai/automation/cron-jobs) separates one-shot
schedules, payloads, and delivery. Those patterns support a bounded admission
surface. They do not show that configurable schedules, destination or authority
belong in Muffin's first one-shot action.

The selected action is due on the next gateway beat. The active turn supplies
provenance and destination. It uses the existing manual delegation, delivery
and runtime limits. The model provides the goal only. A dated action or different
delegation would require separate evidence.

Falsify the path by removing the tool from the runtime. The Telegram acceptance
must lose its job row. With the tool present, assert one job before restart,
one fire and scheduler turn afterwards, a rejected scheduler attempt to arm
another job, an exact workspace file, and one visible final receipt. Fixture
transport and inference do not establish installed Telegram acceptance.

Two crash probes then found a lost resumed reply and a duplicate acknowledged
send on the existing scheduled Telegram path. Both are release blockers for
this entry point. See [#949](https://github.com/muffin-project/muffin-agent/issues/949).
