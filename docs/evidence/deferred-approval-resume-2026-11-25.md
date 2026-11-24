# Resuming the invocation after deferred approval

This investigation scopes #1013 on `dev` `f3960aaa`. It concerns approval for the built-in shell lanes within a foreground turn. Other tools can keep their existing approval flow until their resource scope can be prepared and rechecked. The owner, current policy, resource scope and approval surface continue to decide whether the effect is allowed.

## Evidence from Muffin

On the compiled gateway with loopback Telegram, a scripted model asked to run a workspace command. The owner granted it, and the provider then returned a final answer. The file stayed absent, the tool ledger was empty, the grant remained unconsumed and the turn settled as delivered. The existing positive fixture only exercises the physical effect when the model repeats the call.

The loop already checkpoints the original assistant tool-use block before dispatch. For a deferred consent the approval register currently records the capability and the human-readable resource. The wake report tells the model to construct another call. An exact link from the approval to the already-checkpointed invocation is missing. Recording completed intent and reporting an uncertain effect from the journal are existing mechanisms.

## Alternatives

| Approach | Evidence and trade-off |
| --- | --- |
| Give the model a stronger retry prompt or detect an unused grant at finalization | A prompt can improve compliance but asks the model to make the same decision twice. A reliable finalization warning could prevent false success, but the approved work would still be skipped. |
| Hold the live tool invocation open until consent | OpenClaw documents a wait in the originating native-chat invocation and invalidation on turn close. Hermes has a blocking gateway round trip. This makes the common case straightforward, but Muffin's process can exit before the owner answers. Holding the process or an in-memory closure would lose that recovery path. [OpenClaw](https://docs.openclaw.ai/tools/exec-approvals) · [Hermes source](https://github.com/NousResearch/hermes-agent/blob/main/tools/approval_gateway_wait.py) |
| Bind consent to the checkpointed invocation, then resume it through the same kernel | The Agents SDK can resolve and resume a specific persisted interruption. Muffin can keep its existing turn and effect ledger and add the identity needed to recover that call. Recover recorded outcomes, and leave an honest uncertain result after an intent with no outcome. A retryable workflow pattern would be inappropriate for a non-repeatable tool if the process dies after the effect but before acknowledging it. [Agents SDK](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) · [Temporal activity definition](https://docs.temporal.io/activity-definition#idempotency) |
| Remove approval for these operations | That would change the separate authority decision for host effects. A failed resume supplies evidence for removing the model's duplicate tool choice rather than the owner's authorization. |

## Candidate and falsifiers

This is CRITICAL. Keep the persisted wait, current authorization checks and ordinary sender validation. For shell, bind new approvals to the exact original call, arguments and canonical workspace/directory before sending a question. Validate the working directory before interrupting the owner. Resume eligible approved invocations before inference, let a denial become a tool result, and consume the exact grant and record the effect intent in one fenced transaction. A process crash after intent must not turn uncertainty into an automatic retry. Recover the result in the original transcript so the next model request can report what occurred. Legacy rows without an invocation link must remain readable and must never acquire automatic execution authority from a heuristic match.

The primary falsifier is a real workspace file and one receipt after a gateway restart and an owner tap, with a scripted provider that never repeats the invocation. The effect must not appear on denial, expired consent, cancellation, a stale claim or changed policy. A crash after a non-repeatable effect must produce no second effect. Provider requests, the persisted turn, and the approval and effect ledgers should agree.

## Local results

- Compiled baseline `f3960aaa` failed the two-request, one-consent scenario with the expected file absent. The candidate produced exactly the file and stdout after the tap, even with a gateway restart before the decision. The resumed provider request contained the actual tool result and no reissue.
- A variant changed an in-workspace directory symlink after the approval question. The original and substituted directory both stayed untouched.
- A temporary compiled fault exited the real gateway after one file append and before outcome persistence. The replacement gateway saw an unfinished effect, made one provider request carrying the uncertainty, and did not append again. The normal binary was restored.
- Focused test coverage includes another scope, denied and late consent, a stale or cancelled claim, current policy refusal, a duplicate consumer and atomic rollback of both the grant and intent on a failed write.

The Telegram and model in these proofs were fixtures. The workspace bytes, macOS shell containment, SQLite decisions, intent/outcome and gateway restarts were real in isolated profiles. Owner installation and native Telegram are separate acceptance.

The System One shadow fixture includes a token that the checkpoint must redact. The first candidate did not consume that grant, because the persisted arguments could not match the original digest. The adjusted candidate keeps the existing replay behavior for this case and does not persist another copy of the original arguments.
