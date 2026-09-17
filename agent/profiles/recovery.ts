import type { RecoveryStrategy } from './profile.js';

/**
 * What each declared recovery strategy actually does.
 *
 * This file is the *one place* the crutches live, and it lives under
 * `agent/profiles/` on purpose: 07 §3 names that directory as the boundary an
 * impalcatura may not cross ("ogni impalcatura vive in **un** posto con un
 * confine netto: i profili in `agent/profiles/*`"). The loop walks the list the
 * profile declared and pushes whatever comes back; it never branches on a
 * strategy name. Deleting a profile deletes its crutches — `recovery: []` runs
 * bare, and the neutral-profile test proves it. Deleting this FILE is more than
 * a subtraction: the loop imports it at runtime, so the file goes only together
 * with `recover()` and its call sites. Data off is free; code off is an edit.
 *
 * Not beside `agent/completion.ts`, which is the other nudge in the system and
 * the tempting neighbour: the completion gate is **durable** — a deterministic
 * check against a measured false-success rate that every model pays, and one no
 * profile may decline. Putting a removable crutch next to it would blur exactly
 * the line 07 exists to keep.
 *
 * The prior art is Hermes' cascade (nudge → prefill → retry ≤3 → provider
 * switch), per-model rather than wired into the loop (01-verdetti §harness
 * multi-tier). Two of its rungs are deliberately absent: `prefill` needs an
 * assistant-turn prefix the compat surface does not carry uniformly, and
 * `providerSwitch` needs a second configured provider — declared out of scope
 * in 09-contratti §2, and still out of scope here.
 */

/**
 * How the model's turn came back unusable.
 *
 * Two, because the loop can only tell two apart without guessing: the turn was
 * empty, or the provider could not parse what the model emitted. Anything
 * finer would be a classifier, and this repository has demoted two of those.
 */
export type RecoveryFailure =
  /** No text and no tool call: the model said nothing at all. */
  | 'empty'
  /** The tool call would not parse — almost-JSON arguments. */
  | 'malformed';

export type RecoveryContext = {
  failure: RecoveryFailure;
  /**
   * The tool names this turn actually exposed — already filtered by principal
   * and capped by the profile. Never the whole registry: handing a group member
   * the host inventory is the bug the invented-tool message already had once.
   */
  tools: string[];
};

export type RecoveryStep = {
  /**
   * A corrective user turn to append before asking again. Absent means ask
   * again unchanged, which is a step in its own right and not a missing one.
   */
  message?: string;
};

/** What the nudge has always said. Kept verbatim: this behaviour is not new. */
const NUDGE_EMPTY = 'Non ho ricevuto risposta. Continua, oppure dimmi che hai finito.';

/**
 * The intervention for one declared strategy.
 *
 * Only `nudge` reads the failure class, and that asymmetry is deliberate: the
 * nudge's entire content *is* the description of what went wrong, while the
 * other three prescribe a shape, and the shape is the same however the turn
 * came back unusable.
 */
export function recoveryStep(strategy: RecoveryStrategy, ctx: RecoveryContext): RecoveryStep {
  switch (strategy) {
    /**
     * Failure class: the model narrated instead of acting, or returned an empty
     * turn on a turn that expected work. The gentlest rung — an open corrective
     * that returns the floor to the model without telling it what to say.
     */
    case 'nudge':
      return {
        message:
          ctx.failure === 'malformed'
            ? 'La tua ultima tool call non era leggibile: gli argomenti non erano JSON valido. Rifalla per intero.'
            : NUDGE_EMPTY,
      };

    /**
     * Failure class: mid-conversation the model has lost track of *which* tools
     * it may call, and starts inventing names or freezing.
     *
     * What this is NOT, after checking the wire: re-sending the tool schemas.
     * Our request is stateless — `agent/loop.ts` rebuilds `call.tools` from
     * `exposed` inside the iteration loop, so every single call already carries
     * every schema in full. "Reinject the definitions" would re-send bytes that
     * were never absent: theatre, and a step that cannot fail cannot help.
     *
     * What actually degrades is attention over position, not presence. The tool
     * array sits at the head of the request and the model's own failure sits at
     * the tail, thousands of tokens later. So the intervention is the *names*,
     * inline, at the tail — which is also what 09-contratti §2 asked for in the
     * first place ("rilista i tool validi"), rather than the schemas.
     *
     * Not a duplicate of the invented-tool `tool_result`: that one answers a
     * wrong *name* and is already written (`agent/loop.ts`, the `!tool` branch);
     * this one answers a turn that produced nothing to name. Two triggers, and
     * the contract's own row for the wrong-name case says "reinjectTools *or* a
     * structured error tool_result" — we do the second, so this must not become
     * a second copy of it.
     */
    case 'reinjectTools':
      return {
        message:
          ctx.tools.length > 0
            ? `Puoi usare solo questi tool: ${ctx.tools.join(', ')}. ` +
              `Rispondi con una chiamata a uno di questi, oppure di' a parole perché non ne serve nessuno.`
            : // No menu to restate. The honest remedy is the fact itself: the
              // step keeps its slot rather than silently shifting the cascade
              // by one, because attempt N is strategy N or the profile lies.
              'In questo turno non hai nessun tool a disposizione. Rispondi a parole.',
      };

    /**
     * Failure class: transient garbage from the model itself — a sampler that
     * fell off a cliff, a truncated emission, a one-off unparseable call.
     *
     * The only step that adds nothing to the context, and that is the point: by
     * the time it runs, earlier rungs have already appended corrective turns,
     * and on a small model every extra turn is attention spent on the harness
     * instead of the task. Cheapest rung, and the one with no side effect on
     * the transcript.
     *
     * Honest limit: this only pays where the failure was non-deterministic —
     * it is not a way out of a genuinely deterministic refusal. That used to
     * mean "every profile", because the loop hardcoded temperature 0; it does
     * not any more (N1, judge, 2026-08-13; frontier.json is the one this
     * comment forgot to catch up with). On a profile with `sampling:
     * 'deterministic'` (`consumer-local`, `CONSERVATIVE`) it is still what it
     * always was — a bare re-ask pays off on a local server whose batching or
     * KV-cache reuse makes it non-reproducible in practice, not on a
     * deterministic one. On `frontier` (`sampling: 'model-default'`, no
     * temperature sent at all) there is no temperature-0 request for a resend
     * to be byte-identical *to* — the model samples with its own defaults, so
     * this step is a real retry there, not a rung kept for a case that cannot
     * fire (frontier.json's own note: "retryOnce … finally does something").
     * A profile that declares this step first gets exactly one such request;
     * that is the profile's declaration, executed.
     *
     * Distinct from the transport retry in `agent/loop.ts`: that one answers a
     * 429 or a 502, waits with backoff, and is not a per-model crutch at all.
     */
    case 'retryOnce':
      return {};

    /**
     * Failure class: the model emits prose where a tool call was needed, or
     * arguments that are almost-JSON. The hardest rung: a two-option contract
     * with no third shape, stated in the fewest words that still say it.
     *
     * Why a user turn and not `tool_choice: 'required'`, which would force the
     * call at the wire: (1) `ChatCall.toolChoice` is `'auto' | 'none'` and both
     * adapters map anything-not-'none' to 'auto', so 'required' would degrade
     * *silently* — and the one place we would use it is the weak local model,
     * i.e. exactly the endpoints most likely to ignore or reject the field
     * (this adapter has already paid once for assuming a field travels:
     * `openai-compat.ts`, the explicit-cache history); (2) forcing a call after
     * an *empty* turn manufactures an action the model never chose, which is
     * the same dishonesty `completion.ts` refuses when it declines to rewrite
     * an answer. Adding the wire flag later does not change this step's
     * contract, so it stays a follow-up rather than a dependency.
     *
     * Why not a system-suffix: `agent/providers/openai-compat.ts` warns that at
     * two or more system blocks the two dialects concatenate differently, so
     * the model would read different bytes depending on an endpoint flag — and
     * the stable prefix is the one thing in the request we pay to keep warm.
     */
    case 'strictJson':
      return {
        message:
          'Due sole risposte sono ammesse: una tool call con argomenti JSON validi, ' +
          "oppure una riga che dice che non puoi e perché. Nient'altro.",
      };
    /**
     * Failure class: every gentler rung already ran and the turn still came
     * back unusable — an empty turn, an announced-but-absent call, prose
     * where a call was needed.
     *
     * The message is the contract; the wire flag is the enforcement. The loop
     * (`recover()` in `agent/loop/round.ts`) sends the next attempt with
     * `tool_choice: required` when this strategy runs, once, then back to
     * `auto`. Message and flag travel together so a transcript reader sees
     * why the request demanded a call.
     *
     * Amendment to this file's own `strictJson` note (ADR-0082): that note
     * rejected `tool_choice: 'required'` because `ChatCall.toolChoice` was
     * `'auto' | 'none'` and both adapters mapped anything-not-`'none'` to
     * `'auto'` — the flag would have degraded silently, on the weakest
     * endpoints. The flag now exists on the type and both adapters map it
     * (`required` on openai-compat, `{type:'any'}` on Anthropic), and it runs
     * only here, as the last rung, after the transcript already holds the
     * gentler corrections — never after an empty turn as a first resort, so
     * it cannot manufacture an action out of silence without the model first
     * being told a call is due.
     */
    case 'requireTool':
      return {
        message:
          'Devi rispondere con una tool call adesso, oppure con una riga che dice ' +
          "che non puoi e perché. Nient'altro.",
      };
    default:
      // Unreachable through production: `loadProfiles` refuses a profile whose
      // recovery names anything outside the union. The belt exists for the
      // fifth strategy someone adds to the type but not to this switch — a
      // bare re-ask instead of a TypeError thrown mid-recovery, on the one
      // turn that was already failing.
      return {};
  }
}
