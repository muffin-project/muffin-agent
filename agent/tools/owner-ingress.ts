import type { Principal } from '../../core/policy/types.js';
import type { Message } from '../providers/types.js';

/**
 * Authenticated ingress supplied by the runtime, never tool arguments — the
 * single source of truth for "the owner said X right now". Both the forget
 * door (`memory-forget-intent.ts`) and the propose door (`memory-propose.ts`)
 * derive authority from here instead of each re-implementing the checks.
 */
export type OwnerIngress = {
  id: string;
  tenant: string;
  principal: Principal;
  inputText: string | null;
  messages: readonly Message[];
};

/**
 * The current turn's owner-authored input text, or null when anything about
 * the authority is off: foreign turn/tenant, non-host tenant, non-owner
 * principal, missing text, no owner-origin user message matching the input,
 * or a later user message (a consumed correction, including unmarked legacy
 * suspension corrections, invalidates the original request). Tool/harness
 * evidence is not owner ingress.
 */
export function authenticatedOwnerInput(
  source: OwnerIngress | null,
  tenant: string,
  turnId: string,
): string | null {
  if (
    !source ||
    source.id !== turnId ||
    source.tenant !== tenant ||
    tenant !== 'host' ||
    source.principal.kind !== 'owner' ||
    !source.inputText
  )
    return null;
  const start = source.messages.findIndex(
    (m) => m.role === 'user' && (m.origin === 'owner' || m.origin === 'external'),
  );
  if (start < 0) return null;
  const ingress = source.messages[start];
  if (ingress === undefined) return null;
  const text = ingress.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (ingress.origin !== 'owner' || text !== source.inputText) return null;
  if (
    source.messages
      .slice(start + 1)
      .some(
        (m) =>
          m.role === 'user' &&
          (m.origin === 'owner' || m.origin === 'external' || m.origin === undefined),
      )
  )
    return null;
  return text.trim();
}
