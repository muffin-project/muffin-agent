/**
 * A capability that is unavailable, reported as a structured diagnostic rather
 * than a one-time boot log. Providers such as search and shell own the actual
 * disabled reasons; doctor and sys_inspect render those same facts.
 *
 * Under #469 a capability beyond the current model-visible schema ceiling is
 * discoverable rather than disabled. New code must not report registration-
 * order "truncation" as an unavailable capability. The legacy kind remains in
 * this transport shape for compatibility with older status records.
 */
type CapabilityGapKind = 'disabled' | 'truncated';

export type CapabilityGap = {
  /** Tool or capability name recognized by the owner or model. */
  capability: string;
  kind: CapabilityGapKind;
  /** Owner-facing Italian cause, measured at the actual producer. */
  reason: string;
  /** Executable next step, or null when none is known. */
  remedy: string | null;
};

/** One consistent plain-text form for boot logs and status surfaces. */
export function formatCapabilityGap(gap: CapabilityGap): string {
  const parola = gap.kind === 'disabled' ? 'spento' : 'tagliato';
  const base = `${gap.capability} ${parola}: ${gap.reason}`;
  return gap.remedy === null ? base : `${base} — ${gap.remedy}`;
}
