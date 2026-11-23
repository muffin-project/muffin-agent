# Conversational work messages (2026-11-23)

Claim (CRITICAL): within existing owner-DM Work the model may choose to send
an update and continue or ask one question and await a reply. A final result
uses the original automatic delivery. The request need not contain a keyword
and the runtime does not synthesize acknowledgments.

| Design | Decision |
| --- | --- |
| Fixed receipt plus `schedule_once` | Rejected for this interaction: a receipt is an agent choice and a question must preserve the current Work. One-shot scheduling remains useful for later execution. |
| Reuse draft/step transcript | Rejected: ephemeral progress is not a user-facing durable message or an answerable question. |
| Add a same-origin messaging capability to the existing turn and wait lane | Chosen: reuse the reply policy, effect record, claim fencing and Telegram delivery journal. Stage a question durably before publishing it and route explicit native replies to that exact waiting turn. |

[Dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)
and [Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
document returning with results or a request for input. [Telegram](https://core.telegram.org/bots/api#message)
provides a native reply target. [Temporal](https://docs.temporal.io/activity-definition#idempotency)
explains why restarting a durable task does not itself make a non-idempotent send exactly once.

Falsifiers: fabricated or duplicate receipt, wrong recipient or wrong reply
bound to a turn, replayed effects, stuck work after a valid answer, or a call
from non-owner context. Prove the path with held work, one/no further reply,
and an isolated restart; scripted tool calls prove runtime wiring, not model
judgment in live use.

## Verification

The compiled gateway acceptance uses a loopback provider and Bot API. It
observes one original request → an optional interim message → one result,
with no further owner input. It also observes a native reply resuming the
same Work after restart. If the question's send receipt was lost, a reply
must carry the original bot-authored message and question reference and
match the frozen send in the same chat; the question is not resent. A
definite rejection releases the wait with a diagnostic, not an owner reply.
Another fault test cuts the gateway after the resumed result is accepted but
before its receipt; the restart leaves delivery uncertain without resending
or calling the model. Focused lane tests also cover a crash before the final
delivery plan was created.

The first version is for the paired Telegram owner DM. A question lasts at
most 24 hours. Use Telegram's Reply to attach an answer to the specific
question; other messages remain independent. Same-origin delivery uses the
existing `surface.reply` policy and the current owner binding. Prompt
wording, update usefulness, and native client rendering still need a live
trial; these runs used synthetic data, no model or Telegram credentials.
