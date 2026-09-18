import type { Message, ProviderError } from '../providers/types.js';
import { harnessMessage } from './message-origin.js';

/** Internal record marker: lets recovery distinguish this terminal reply from partial model output. */
const RECOVERY_MARKER = '[MUFFIN_PROVIDER_ERROR_REPLY_V1]\n';

/** User-facing diagnostics expose only the typed failure class and numeric status, never upstream text. */
export function providerErrorReply(error: ProviderError): string {
  if (error.source === 'output') {
    return 'Il provider ha restituito una risposta non valida; non ho potuto completare il turno. Riprova tra poco.';
  }
  if (error.status !== undefined) {
    return `Il provider non ha completato la richiesta (HTTP ${error.status}). Riprova tra poco.`;
  }
  return 'Non sono riuscito a contattare il provider. Riprova tra poco.';
}

export function markProviderErrorReplyForRecovery(text: string): Message {
  return harnessMessage('assistant', [{ type: 'text', text: `${RECOVERY_MARKER}${text}` }]);
}

/** Return only the explicitly marked terminal reply, never an earlier partial assistant round. */
export function providerErrorReplyFromMessages(messages: readonly Message[]): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return null;
  const first = last.content[0];
  if (first?.type !== 'text' || !first.text.startsWith(RECOVERY_MARKER)) return null;
  const text = first.text.slice(RECOVERY_MARKER.length).trim();
  return text === '' ? null : text;
}
