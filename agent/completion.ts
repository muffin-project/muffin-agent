/**
 * Did the turn do what its answer says it did?
 *
 * This is the intervention with the highest measured return in the whole design:
 * an ablation on GAIA loses **31 points** when the completion check is removed,
 * and the failure it catches is common rather than exotic — a study over 9,876
 * agent trajectories puts false-success between **13% and 79%** depending on the
 * model family, with the worst rate belonging to a model that has reasoning
 * *on*. Thinking does not protect against this; the same work finds reasoning
 * traces rationalise completion rather than verify it.
 *
 * So the check is deterministic and the check is narrow, for two reasons that
 * both come from evidence:
 *
 *  - **An LLM judge is the wrong instrument.** The same study measures judges
 *    systematically fooled by assertive language — a +0.27 to +0.36 shift on the
 *    "completed" scale for identical real outcomes. A judge that can be talked
 *    out of its verdict is not a check.
 *  - **A keyword classifier is the wrong instrument too**, and this project has
 *    the receipts: an intent classifier was demoted to monitoring-only twice
 *    because its errors were invisible, and a narration detector anchored to
 *    generic words ("tool", "search") missed the real case the day a new tool
 *    existed — because the model named the *actual tool*.
 *
 * What is left is one signal that is neither: **the answer names a tool of this
 * turn, and this turn called nothing at all.** Both halves are facts, not
 * interpretations. The tool names come from the registry, so it cannot go stale
 * when a tool is added; "called nothing" comes from the trace.
 *
 * Why the zero-calls condition rather than per-tool: a denied or failed call
 * still *is* a call, so a model legitimately saying "non ho potuto usare
 * fs_write" has a tool result in its turn. Zero calls plus a tool name is the
 * shape of a model narrating an action instead of taking it — which is exactly
 * the case on record.
 *
 * Why the gate survives the EFFECT WAL rather than being deleted by it: the
 * WAL grounds every call the turn EXECUTED (intent before the handler,
 * outcome after), but narration-without-action writes zero rows — there is
 * nothing for the ledger to contradict. The failure this catches is
 * uncovered by any structured invariant today, so the minimum correct change
 * is not removal but precision: an answer that EXPLICITLY disclaims use
 * ("non ho avuto bisogno di fs_write", "I did not use X") makes no false
 * claim and must never receive the reprimand. The check is therefore
 * sentence-scoped — a mention inside a disclaimed sentence is not a claim —
 * instead of punishing every linguistic mention of a tool name.
 *
 * And it does not rewrite the answer. It gets the model one more attempt with a
 * specific nudge, and if that fails the answer stands and the fact is recorded.
 * Silently editing what the agent said would be a second dishonesty on top of
 * the first.
 */

export type CompletionVerdict = {
  /** False when the answer claims something the turn did not do. */
  ok: boolean;
  /** Tools named in the answer that were never called. Empty when ok. */
  named: string[];
};

export type CompletionInput = {
  /** The answer the model wants to end on. */
  text: string;
  /** Tool names exposed this turn — from the registry, never a hardcoded list. */
  available: string[];
  /** How many tool calls the turn actually made, successful or not. */
  toolCallsMade: number;
};

export function checkCompletion(input: CompletionInput): CompletionVerdict {
  // A turn that called something is out of scope: this catches narration in
  // place of action, not imperfect action.
  if (input.toolCallsMade > 0) return { ok: true, named: [] };

  // Sentence-scoped: only a mention that CLAIMS use counts. A tool named
  // inside an explicit non-use statement ("non ho avuto bisogno di X") is
  // the model truthfully explaining it did nothing — reprimanding that is
  // the linguistic punishment the invariant forbids.
  const named = input.available.filter((tool) => claimsUse(input.text, tool));
  return { ok: named.length === 0, named };
}

function claimsUse(text: string, tool: string): boolean {
  return text.split(/[.!?\n]+/).some((sentence) => mentions(sentence, tool) && !disclaimsUse(sentence));
}

/**
 * An explicit statement of non-use, in the model's own languages.
 *
 * Narrow on purpose: bare negations ("non lo so") do not disclaim, and a
 * disclaimer names the absence of USE — usato/chiamato/bisogno, used/called/
 * needed — so "non ho potuto" (which implies an attempt) is not silently
 * exempted either. That case is already out of scope via `toolCallsMade > 0`
 * whenever the attempt really happened; when it did not, the mention still
 * claims an attempt and the gate still fires.
 */
function disclaimsUse(sentence: string): boolean {
  return (
    /\bnon\b[^.!?\n]{0,60}?\b(usato|usata|usati|usate|chiamato|chiamata|bisogno)\b/i.test(sentence) ||
    /\b(didn['’]t|did not|have not|haven['’]t|never|no need|not using|without using|without calling)\b[^.!?\n]{0,60}?\b(us(e|ed|ing)|call(e[ds]?|ing)?|need(e[ds]?)?)\b/i.test(sentence) ||
    /\b(no need (for|of|to)|did not need)\b/i.test(sentence)
  );
}

/**
 * The tool name as a word, so `fs_read` matches in prose, in backticks and in a
 * bracketed pseudo-call, and `fs_readme` does not match `fs_read`.
 */
function mentions(text: string, tool: string): boolean {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w])${escaped}([^\\w]|$)`, 'i').test(text);
}

/** The nudge, naming what it saw. Vague feedback produces a vague retry. */
export function completionNudge(named: string[]): string {
  const list = named.map((n) => `\`${n}\``).join(', ');
  return (
    `Hai nominato ${list} ma in questo turno non hai chiamato nessun tool. ` +
    `Una delle due: chiamalo davvero adesso, oppure riscrivi la risposta dicendo ` +
    `che non l'hai fatto e perché. Non descrivere una chiamata come se fosse avvenuta.`
  );
}
