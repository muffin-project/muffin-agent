# #605 durable rule-store audit — 2026-10-07

## Question

Can a non-time-based automation rule such as a deterministic `message.received`
matcher be represented durably by an existing Muffin store without changing that
store's semantic owner?

The required row is definition state only:

- event/matcher definition;
- action definition;
- authority/provenance of the intent that created or changed it;
- enabled state and optimistic version.

It must not own event occurrences, scheduler state, Turn execution state, receipts,
or a canonical event log.

## Existing durable homes checked

### `JobStore`

Not suitable.

`core/scheduler/jobs.ts` is structurally and semantically a clock-owned store:
rows require `cron`, `timezone` and `next_fire_at`; `due()` selects by the
next fire and `markRan()` advances or retires that schedule. Encoding
`message.received` as a fake cron would make the scheduler own a rule that has
no time occurrence.

Keep:

`JobStore -> schedule.fire`

### `JobFireStore`

Not suitable.

`core/scheduler/job-fires.ts` maps one concrete `(job_id, scheduled_for)`
occurrence to one Turn and its settlement. It explicitly is not a second
TurnStore and has no rule-definition semantics.

### `TurnStore` / Turn tables

Not suitable.

`core/turns/schema.ts` owns runnable/waiting/continuable/done work plus its
leases and tool-call WAL. A rule definition exists before any matching message
occurs and must survive without minting a Turn. Putting it here would turn
definition state into execution state.

The incoming message already has the durable occurrence identity #605 needs:
`runWork` projects the port-owned `workId` into
`RuntimeEvent.occurrenceId`. No new `MuffinEvent` row is needed for
`message.received`.

### `TodoStore`

Not suitable.

`core/turns/todo.ts` owns session-scoped plan steps, state transitions and
optional due dates. A rule is neither a plan step nor session-local work. Reuse
would also couple automation lifecycle to prompt-visible plan state.

### `wait`

Not suitable.

Wait state suspends one existing Turn until a wake condition/deadline. A
message rule exists independently of any Turn and may match many future
occurrences.

### `SessionStore`

Not suitable.

`core/session/store.ts` is the append-only conversational transcript and
conversation-generation boundary. Rule definitions are control/runtime state,
not something that was said verbatim.

### approvals / proactive decisions / fire log

Not suitable.

- `core/approvals/store.ts` owns one-use pending permission questions.
- `core/scheduler/decisions.ts` is explanatory history of proactive gate
  decisions.
- `core/scheduler/firelog.ts` is dedup/history for already-spoken proactive
  anchors.

None is definition state, and reusing one would merge future-behaviour
configuration with history/receipts.

## Decision

The audit found no existing store with the right semantic owner. The minimum new
home is therefore justified by #605's own condition for a new table.

`core/automation/rules.ts` adds `AutomationRuleStore` with only:

- stable rule id and tenant;
- non-time `event_kind`;
- deterministic serialized matcher;
- serialized action reference + #605 action mode;
- creation/update principal, surface, Turn and taint;
- `enabled`;
- optimistic `version`;
- timestamps.

Explicitly absent:

- scheduler/clock state;
- event occurrence rows;
- execution status;
- Turn/work payload;
- delivery or effect receipts;
- model calls;
- a generic event log.

`schedule.fire` is rejected by the store so scheduled automation cannot drift
out of `JobStore`.

## Runtime boundary

A persisted action is data, not executable code.
`compileStoredAutomationRule` projects the durable definition into the
existing in-memory `AutomationRule` shape, while an injected host-owned action
resolver creates the `ActionRequest`.

That keeps policy, authority re-checks, Effect WAL and canonical Turn execution
where #605 already owns them. The store cannot execute anything by itself.

## #780 boundary

This does not pre-empt #780.

`message.received` already has a durable producer identity through `workId`.
A future producer that genuinely requires a canonical internal event log remains
a #780 question. This table stores rule definitions only.
