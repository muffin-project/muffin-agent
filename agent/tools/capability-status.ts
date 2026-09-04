/**
 * A capability that is off, said instead of only logged.
 *
 * `buildRuntime` used to answer "why is `web_search` missing" with one line on
 * `gateway.err`, written once at boot and read by nobody inside a turn: the
 * model could say "the tool did not reach me" and nothing more, and the owner
 * had to grep a log by hand to learn the fix was one line in `rot/egress.json`
 * (measured 03/09/2026 — the string occurred exactly once in a 415 KB log).
 *
 * `CapabilityGap` is the structured form of that same fact, carried instead of
 * re-derived: `sys.inspect` (agent/tools/inspect.ts) and `muffin doctor`
 * (cli/doctor.ts) both read it from the same producers — `agent/tools/search.ts`
 * for `web_search`, `agent/runtime.ts` itself for `sys.shell` and for tools cut
 * by `profile.maxToolsExposed` — so the two doors cannot drift apart on the
 * word that matters (DAY-1 requirement E7).
 *
 * `kind` is not decoration: a tool that does not exist for this install and a
 * tool that exists and is switched off are two different questions, and
 * collapsing them into one label is exactly the proprioception defect this
 * file exists to close.
 */
type CapabilityGapKind = 'disabled' | 'truncated';

export type CapabilityGap = {
  /** The tool or capability name an owner or the model would recognise. */
  capability: string;
  kind: CapabilityGapKind;
  /** Owner-facing Italian sentence: measured, never generic. */
  reason: string;
  /** An executable next step, or `null` when none is known yet. */
  remedy: string | null;
};

/**
 * One line, for the surfaces that print plain text (the boot log, `doctor`'s
 * plain formatter). `sys.inspect` renders its own richer section from the
 * structured fields directly — this exists so the boot-time stderr line and
 * the structured record are the same sentence, not two.
 */
export function formatCapabilityGap(gap: CapabilityGap): string {
  const parola = gap.kind === 'disabled' ? 'spento' : 'tagliato';
  const base = `${gap.capability} ${parola}: ${gap.reason}`;
  return gap.remedy === null ? base : `${base} — ${gap.remedy}`;
}

/**
 * A tool cut by `profile.maxToolsExposed` — the ceiling that truncates the
 * registered list **by registration order**, with no error and no log
 * (`agent/runtime.ts`, ADR-0008). Reused so the wording is the same wherever
 * the cut is reported, rather than a sentence hand-typed at each call site.
 */
export function truncationGap(opts: { tool: string; profileName: string; maxToolsExposed: number }): CapabilityGap {
  return {
    capability: opts.tool,
    kind: 'truncated',
    reason: `oltre il tetto di ${opts.maxToolsExposed} tool esposti dal profilo "${opts.profileName}"`,
    remedy: `alza maxToolsExposed in agent/profiles/${opts.profileName}.json, oppure riduci quanti tool sono registrati prima di questo`,
  };
}
