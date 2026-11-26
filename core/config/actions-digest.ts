import { createHash } from 'node:crypto';

/**
 * Canonical params + digest, same shape as ADR-0109's invocation digest:
 * `sha256(JSON.stringify([actionId, paramsCanonical]))`, with keys sorted so
 * `{a:1,b:2}` and `{b:2,a:1}` are the same grant.
 */

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((key) => [key, canonicalize(rec[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value ?? null));
}

export function paramsDigest(actionId: string, params: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([actionId, canonicalize(params) ?? null]))
    .digest('hex');
}

/** Binding stored with a single-use approval, matching ADR-0109 / PR #1017. */
export function approvalBindingDigest(input: {
  actionId: string;
  paramsDigest: string;
  principal: string;
  surface: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.actionId, input.paramsDigest, input.principal, input.surface]))
    .digest('hex');
}
