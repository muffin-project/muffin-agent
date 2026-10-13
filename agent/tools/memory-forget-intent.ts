import type { Principal } from '../../core/policy/types.js';
import type { Message } from '../providers/types.js';

/** Authenticated ingress and checkpoint, supplied by the runtime, never tool arguments. */
export type ForgetSource = {
  id: string;
  tenant: string;
  principal: Principal;
  inputText: string | null;
  messages: readonly Message[];
};

export function ownerForgetRequest(
  source: ForgetSource | null,
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
  const ingress = source.messages[start]!;
  const text = ingress.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (ingress.origin !== 'owner' || text !== source.inputText) return null;
  // A consumed correction, including an unmarked legacy suspension correction,
  // invalidates the original request. Tool/harness evidence is not owner ingress.
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
  const request = text.trim();
  // Recognize the destructive request prefix without interpreting a fact tuple.
  if (forgetDiscoveryQuery(request) === null) return null;
  return request;
}

/** Remove only request syntax for retrieval; preserve all target qualifiers. */
export function forgetDiscoveryQuery(request: string): string | null {
  const body = request
    .trim()
    .replace(/^@?muffin[,:!]\s*/iu, '')
    .replace(/^(?:per favore|please)[,:!]?\s+/iu, '');
  const match = body.match(
    /^(?:dimentica(?:ti(?:\s+di)?)?|forget|non\s+ricordare(?:\s+più)?|do\s+not\s+remember|don't\s+remember|(?:can|could)\s+you\s+forget|puoi\s+(?:dimenticare|smettere\s+di\s+ricordare))\s+([\s\S]+)$/iu,
  );
  return match?.[1]?.trim() || null;
}
