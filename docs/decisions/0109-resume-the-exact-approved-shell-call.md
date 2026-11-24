# ADR-0109 — Resume the exact approved shell call

**Status** Proposed, 2026-11-25.

## Context

A deferred shell approval can reach a terminal answered turn with an unused grant and no effect. The existing wake report asks the model to reconstruct the approved invocation. That decision adds a provider request and can be omitted or produce different arguments. The compiled Telegram reproduction and comparisons are recorded in [the evidence](../evidence/deferred-approval-resume-2026-11-25.md).

## Decision

A new deferred consent for a built-in shell tool identifies the original durable tool call and a digest of its arguments and canonical workspace scope. The runtime validates the directory before asking. A resumed turn reads the saved invocation, applies current policy and starts only the same command in the same scope. Consuming the grant and writing the effect intent share a transaction fenced by the active turn claim.

The first provider request after approval receives the result of that original tool call. A denial or expired grant has no effect. A durable intent without a result is uncertain and the command is not repeated. Previously stored approvals lack this link and keep the legacy replay protocol during recovery. Immediate consent remains available. A tool can use this protocol when it can verify the entire scope of a saved invocation.

## Consequences

An approval question survives gateway downtime and can be answered after restart. The same command resumes on the next valid claim. Full argument and scope validation prevent changes in path or policy from silently reusing the grant. Recovery can report an uncertain outcome after a crash instead of repeating a command with unknown side effects. The database change is additive and stores the call identity and digest alongside the existing approval.

The shell remains contained by the executor. The Telegram ingress and the current turn policy still determine who has authority to request and approve the effect.
