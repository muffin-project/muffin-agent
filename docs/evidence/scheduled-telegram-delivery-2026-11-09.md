# Scheduled Telegram delivery across restart

On the compiled gateway from #948, the turn lane failed to route a resumed job
to its Telegram address. Independently, the regular scheduler sent through
the unjournaled surface method. A Bot API fixture accepted the final message
while a proxy withheld its response. After SIGKILL, recovery delivered a second
copy. Both failures are recorded in [#949](https://github.com/muffin-project/muffin-agent/issues/949).

| Candidate | Consequence |
| --- | --- |
| Reuse the Telegram turn journal | Both paths resolve the existing channel, use the same Work and lease identity, and share the connector's recovery policy. |
| Add a generic outbox | Would duplicate Telegram's attempt state and need a second reconciliation contract. Useful only if replacing the existing journal. |
| Suppress scheduled replies | Avoids duplicate sends by removing delivery, including valid replies for existing jobs. |

The [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage) does not
offer a client idempotency key for a send. [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#admission-recovery)
also preserves uncertain delivery without automatically replaying it. Muffin
already has a journal with that behavior for replies to ordinary turns.

Scheduled sends now carry their turn identity to that journal. A pending or
unstarted plan can send, a sent plan is retained, and an interrupted attempt
becomes possibly sent. An old terminal turn with no plan and no journal
version cannot prove that it had not sent before the upgrade. Recovery records
that uncertainty. The marker lives in the existing reply address.

The scheduler already advances an occurrence when it suspends so a recurring
job can fire again on schedule. A terminal Telegram reply still pending on a
settled occurrence goes through the ordinary turn lane after runnable work.
The lane reads the saved reply for that Work and uses the same journal. It
leaves silent successes and already classified deliveries alone.

The regression suite covers interrupted work, a new turn killed before sending,
an accepted send with its response lost, the equivalent legacy state, and
lost responses after one-shot and recurring waits. The recurring test checks
the next fire stays unchanged during receipt recovery. Compiled fault probes
also stop a resumed turn before any send plan and after Telegram accepts a
send. Uncertain recovery requires no second message or model request. These
are isolated processes with a fixture provider and Bot API. They establish
neither external Telegram acceptance nor safety of running a legacy writer
after downgrading.
