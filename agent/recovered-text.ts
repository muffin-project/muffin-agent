import type { SessionStore } from '../core/session/store.js';
import type { TurnRecord } from '../core/turns/store.js';
import { providerErrorReplyFromMessages } from './loop/provider-error-reply.js';

/**
 * Recover the text a completed Work would have delivered after a crash.
 *
 * The final text-only assistant round lives in the append-only session file,
 * not in `TurnRecord.messages`. Session history may contain answers from many
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
export function recoveredText(sessions: SessionStore, record: TurnRecord): string {
  if (record.outcome === 'answered') {
    const messages = sessions.read(sessions.open(record.sessionId));
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (
        message.role === 'assistant' &&
        message.traceId === record.id &&
        message.content.trim() !== ''
      ) {
        return message.content;
      }
    }
  }
  if (record.outcome === 'error') {
    const providerFailure = providerErrorReplyFromMessages(record.messages);
    if (providerFailure !== null) return providerFailure;
  }
  return (
    `Il turno ha concluso con esito "${record.outcome ?? 'sconosciuto'}" prima che la consegna fosse ` +
    `registrata; il testo originale non è stato recuperato dopo un riavvio.`
  );
}
