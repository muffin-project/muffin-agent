import { randomBytes } from 'node:crypto';
import { formatP, type Absence } from '../core/memory/absence.js';
import type { ComposeAbsence, Composed } from '../core/scheduler/observe.js';
import { runTurn, type LoopDeps } from './loop.js';

/**
 * Stage 2 for an absence: the model writes the message, having been given no
 * say in whether there is one.
 *
 * Same bridge as `scheduler-run.ts` and for the same reasons — the scheduler
 * principal so the kernel treats this as itself rather than as the owner
 * (threat model §3), a fresh session per composition so nudges are not one
 * growing conversation, and the owner-class context because the nudge is
 * written to the owner about the owner's own memory.
 *
 * The one thing this file decides is the goal text, and it is not styling. An
 * absence is **inferred**, and `knowledge/03-observing-spine.md` §"Disciplina di
 * provenienza" makes the behavioural consequence structural: what was said may
 * be asserted, what was deduced goes out as a question or a hypothesis. Without
 * that clause the model writes "hai smesso di occuparti della tesi" — an
 * assertion about the owner's life derived from counting rows, which is the old
 * "ho notato" with better arithmetic behind it.
 */

/** Kept separate and pure: the discipline is testable without a provider. */
export function absenceGoal(a: Absence): string {
  return [
    `Scrivi un solo messaggio breve all'owner su una cosa di cui ha smesso di parlare.`,
    ``,
    `Il dato — dedotto contandogli le occasioni in memoria, non detto da lui:`,
    `- di cosa si tratta: "${a.name}" (${a.kind})`,
    `- il suo ritmo: ${a.occasions} occasioni distinte in ${a.spanDays} giorni`,
    `- da quanto tace: ${a.gapDays} giorni`,
    `- probabilità di un silenzio così lungo, dato quel ritmo: ${formatP(a.p)}`,
    ``,
    `Vincoli, non di stile:`,
    `- È un'inferenza tua. Esce come domanda o ipotesi, mai come affermazione su di lui.`,
    `- Nomina la cosa e il ritmo concreto che te l'ha fatta notare. Mai "ho notato un pattern".`,
    `- Un punto solo, due righe. Niente analisi del perché, niente elenco, niente diagnosi.`,
    `- Non chiamare tool: quello che ti serve è tutto qui sopra.`,
  ].join('\n');
}

class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeError';
  }
}

export function makeAbsenceComposer(deps: LoopDeps, channel: string): ComposeAbsence {
  return async (absence: Absence): Promise<Composed> => {
    const session = deps.sessions.open(`observe-${absence.entityId}-${randomBytes(3).toString('hex')}`);
    // No memory, and this is not an optimisation: `runTurn` records its own
    // input as a `role: 'user'` episode, tier 0 — that is, as if the owner had
    // spoken. Here the input is a goal we wrote ourselves and one that **names
    // the entity**. From there the loop closes on its own: recall fishes it
    // back out with no role filter, the vector index indexes it, and `memory
    // extract` mines it into `facts` with `origin: 'said'` — the exact table
    // `detectAbsences` counts mentions from. The message about X's absence
    // would end up *being* a mention of X, and the system would manufacture its
    // own evidence (`ingest.ts` has the rule written down, and this is exactly
    // it).
    //
    // Stage 2 does not need it either: the goal closes with "quello che ti serve
    // è tutto qui sopra". What the nudge *said* is recorded below instead, on
    // the agent side only — see there for why that direction is safe.
    const result = await runTurn({ ...deps, memory: undefined }, {
      principal: { kind: 'system', source: 'scheduler' },
      tenant: 'host',
      surface: channel,
      session,
      text: absenceGoal(absence),
    });
    // A turn that hit the cap, queued an ASK or errored has produced no message,
    // and the caller must not record a fire for it: the silence stays open and
    // is reconsidered next run. Loud rather than an empty string, because
    // delivering nothing and delivering "" are different bugs.
    if (result.stopped !== 'answered' || result.text.trim() === '') {
      throw new ComposeError(`stage 2 non ha prodotto un messaggio (${result.stopped})`);
    }
    const text = result.text.trim();

    // Handed back rather than run here, and the difference is measurable: an
    // episode written at compose time survives a delivery that throws — which
    // this slice made the *designed* outcome on an unwired channel — so memory
    // accumulates one message per failed run that the owner never received, and
    // recall would ground a later answer on a nudge that was never sent. The
    // caller runs this next to `recordFired`, after the delivery, so one rule
    // governs both: only what reached the owner is written down.
    //
    // Only the agent side goes back in, and the asymmetry is the whole point.
    // The input episode is what closed the loop — a goal we wrote, naming the
    // entity, recorded as the owner's own tier-0 word and then mined into
    // `facts`. The *reply* cannot do that: `ingest.ts` skips `role: 'agent'` at
    // extraction, so it can never become a fact and can never move the
    // `last_seen` this detector counts from.
    //
    // Recorded because without it nothing holds what was said. The fire log
    // holds the anchor and the arithmetic, not the sentence, and the session
    // file is one randomly-named jsonl no command surfaces — so when remote
    // delivery lands and the owner replies to a nudge, recall would have
    // nothing to ground the answer on.
    const record = (): void => {
      deps.memory?.store.addEpisode({
        tenantId: 'host',
        connector: channel,
        threadKey: session.id,
        role: 'agent',
        kind: 'message',
        content: text,
        /**
         * The composing turn's own tier, and not the `0` this used to hardcode.
         *
         * The tempting argument for `0` is that stage 1 is clean by
         * construction: `detectAbsences` counts only `trust_tier <= 1` facts,
         * and the goal above ends with "non chiamare tool". Both are true and
         * neither is a guarantee. The first bounds the *anchor*, not the
         * sentence — and the sentence is what gets written. The second is a
         * line of Italian in a prompt: the tools are still exposed, the loop
         * will still run one, and a model that reaches for `web_search` here
         * comes back at tier 3. "The prompt asked it not to" is the one kind of
         * argument 03's opening paragraph rules out of the threat model.
         *
         * So it is read, not assumed. Cheap, and it makes the guarantee
         * structural instead of a property of two files staying in agreement.
         */
        trustTier: result.taint,
        createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      });
    };
    return { text, record };
  };
}
