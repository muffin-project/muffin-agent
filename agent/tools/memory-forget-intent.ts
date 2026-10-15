import { authenticatedOwnerInput, type OwnerIngress } from './owner-ingress.js';

/** Authenticated ingress and checkpoint, supplied by the runtime, never tool arguments. */
export type ForgetSource = OwnerIngress;

export function ownerForgetRequest(
  source: ForgetSource | null,
  tenant: string,
  turnId: string,
): string | null {
  const text = authenticatedOwnerInput(source, tenant, turnId);
  if (text === null) return null;
  // Recognize the destructive request prefix without interpreting a fact tuple.
  if (forgetDiscoveryQuery(text) === null) return null;
  return text;
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
