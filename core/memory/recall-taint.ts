import type { TrustTier } from '../policy/types.js';
import type { RecallResult } from './recall.js';

/**
 * Policy taint inherited from recalled items that are actually untrusted
 * (group/web/tool, tier >= 2). Owner and known-contact memories (tier 0-1)
 * are private data, not the "external content" leg of the lethal trifecta:
 * they must not, by themselves, take a clean owner turn to tier 3.
 *
 * The caller applies this with `raiseCeiling`, not `raiseTaint`: recalling a
 * year-old web note in a greeting is not the same as reading that page now,
 * and must not stamp the new reply as tier 3.
 */
export function recallUntrustedTaint(result: RecallResult): TrustTier {
  return result.items.reduce<TrustTier>((max, item) => {
    if (item.trustTier < 2) return max;
    return item.trustTier > max ? item.trustTier : max;
  }, 0);
}

/**
 * Honest Italian origin for an untrusted recall, or null when nothing
 * untrusted entered the prompt. Never "la memoria richiamata" for the
 * owner's own identity facts.
 */
export function recallTaintOrigin(result: RecallResult): string | null {
  const untrusted = result.items.filter((item) => item.trustTier >= 2);
  if (untrusted.length === 0) return null;
  const hasWeb = untrusted.some((item) => item.trustTier === 3);
  const hasGroup = untrusted.some((item) => item.trustTier === 2);
  if (hasWeb && hasGroup) return 'un ricordo preso dal web o da un gruppo';
  if (hasWeb) return 'un ricordo preso dal web';
  return 'un messaggio di un gruppo';
}
