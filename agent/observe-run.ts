import { randomBytes } from 'node:crypto';
import type { Absence } from '../core/memory/absence.js';
import type { ComposeAbsence } from '../core/scheduler/observe.js';
import { runTurn, type LoopDeps } from './loop.js';

/**
 * Stage 2 for an absence: the model writes the message, having been given no
 * say in whether there is one.
 *
 * Same bridge as `scheduler-run.ts` and for the same reasons — the scheduler
 * principal so the kernel treats this as itself rather than as the owner
 * (threat model §3), a fresh session per composition so nudges are not one
 * growing conversation.
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
    `- probabilità di un silenzio così lungo, dato quel ritmo: ${a.p.toFixed(4)}`,
    ``,
    `Vincoli, non di stile:`,
    `- È un'inferenza tua. Esce come domanda o ipotesi, mai come affermazione su di lui.`,
    `- Nomina la cosa e il ritmo concreto che te l'ha fatta notare. Mai "ho notato un pattern".`,
    `- Un punto solo, due righe. Niente analisi del perché, niente elenco, niente diagnosi.`,
    `- Non chiamare tool: quello che ti serve è tutto qui sopra.`,
  ].join('\n');
}

export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeError';
  }
}

export function makeAbsenceComposer(deps: LoopDeps, channel: string): ComposeAbsence {
  return async (absence: Absence): Promise<string> => {
    const session = deps.sessions.open(`observe-${absence.entityId}-${randomBytes(3).toString('hex')}`);
    const result = await runTurn(deps, {
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
    return result.text.trim();
  };
}
