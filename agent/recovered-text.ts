import type { SessionStore } from '../core/session/store.js';
import type { TurnRecord } from '../core/turns/store.js';
import { providerErrorReplyFromMessages } from './loop/provider-error-reply.js';
import { providerMessages } from './loop/provider-checkpoint.js';

/**
 * Recover the text a completed Work would have delivered after a crash.
 *
 * The final text-only assistant round lives in the append-only session file,
 * not in `TurnRecord.providerLease.checkpoint`. Session history may contain answers from many
 * Works, so recovery is deliberately bound to the Work identity written by
 * the production `drive()` path (`SessionMessage.traceId === TurnRecord.id`).
 * Falling back to the latest assistant message would let Work A redeliver
 * Work B's answer from the same session.
 *
 * Non-provider errors and other outcomes (`ask`, `cap`, `budget`) do not
 * persist enough of their original wording to reconstruct it honestly, so
 * callers receive an explicit recovery failure instead of invented text.
 * Typed provider failures are the exception: their fixed, sanitized terminal
 * reply is marked in the durable turn messages and can be recovered exactly.
 */
export function recoveredText(
  sessions: SessionStore,
  record: TurnRecord,
  options?: { preserveEmptyAnswer: true },
): string {
  if (record.outcome === 'answered') {
    const answer = sessions.read(sessions.open(record.sessionId)).findLast(
      (message) =>
        message.role === 'assistant' &&
        message.traceId === record.id &&
        (options?.preserveEmptyAnswer || message.content.trim() !== ''),
    )?.content;
    if (answer !== undefined) return answer;
  }
  if (record.outcome === 'error') {
    const providerFailure = providerErrorReplyFromMessages(providerMessages(record));
    if (providerFailure !== null) return providerFailure;
  }
  return (
    `Il turno ha concluso con esito "${record.outcome ?? 'sconosciuto'}" prima che la consegna fosse ` +
    `registrata; il testo originale non è stato recuperato dopo un riavvio.`
  );
}
