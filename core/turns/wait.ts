import { pidAlive } from '../lock/durable.js';

/**
 * The vocabulary of a wait, and the arithmetic of when it ends.
 *
 * Pure, and separate from both the tool that arms a wait and the lane that
 * honours one, for the reason the kernel is pure: the two interesting questions
 * — *is this a wait we are willing to arm* and *has it come due* — are then
 * answerable without a database, a clock or a model.
 *
 * ## What a wait is, and what it is not
 *
 * `WAIT → persist the state → RELEASE execution → scheduler/event → resume`
 * (`docs/status/day1/requirements-status.md` §2). An `await sleep()` inside the cognitive
 * process is **not** this: it is a very long async function that holds the
 * runtime, and the difference is exactly the one between a Muffin that lives
 * and a Muffin launched from a terminal. Nothing in this file sleeps.
 *
 * The bounds below are ADR-0047 §1, which also records why each number is
 * what it is rather than a preference.
 *
 * Two barriers, both persisted, both bounded:
 *
 *  - **a time** — `wake_at`, and it is mandatory. A job with no stop condition
 *    keeps arriving, so the owner notices it; a suspended turn with no deadline
 *    is silent, holds its whole context, and nobody would ever know
 *    (`docs/evidence/turno-sospendibile.md` §Domanda 3). The worse of the two, so
 *    the deadline is not optional even when an event is also armed.
 *  - **an event** — `wait_for`, from a **closed set**. A free string here
 *    rebuilds the firehose ADR-0028 made unbuildable, and — worse for this
 *    slice — it would let the model name a barrier nothing evaluates, which is
 *    a suspension that only its deadline can ever end.
 */

/**
 * The floor on a wait, and it is a property of the wake-up mechanism rather
 * than a preference.
 *
 * The lane ticks on the gateway's heartbeat (`TICK_MS = HEARTBEAT_MS = 30 s`),
 * so a wait is never more precise than that. "Wait five seconds" would become
 * thirty, and the honest answer is not a faster heartbeat: **a wait under a
 * minute is not a wait**, it is a sleep inside a tool, and it is refused at the
 * boundary instead of being silently rounded up to something else.
 */
export const MIN_WAIT_MS = 60_000;

/**
 * The ceiling. Seven days, because a wait of six months is a typo and not an
 * intention — and because the thing on the other side of a long wait is a
 * resume that re-sends the whole prefix, at a price no counter measures yet.
 */
export const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many turns one tenant may hold suspended at once.
 *
 * Eight: enough that a real piece of multi-step work is never blocked by the
 * ceiling, small enough that a model which likes `wait` hits it in one session
 * rather than filling a table nobody reads. Refused at the tool boundary with
 * the count in the message, because a limit that fails without saying which one
 * it was is a limit the owner debugs by reading source.
 */
export const MAX_SUSPENDED_PER_TENANT = 8;

/**
 * The events a turn may wait for.
 *
 * **One member, and that is a deliberate floor rather than a stub.** The rule
 * this set exists to hold is that a barrier must be *evaluated by something* —
 * a closed set whose members nothing can satisfy is the thirteenth instance of
 * this repo's own defect, a mechanism declared and connected to nothing. So the
 * set contains exactly what the lane can decide, on this machine, without a
 * broker: whether a process id is still alive.
 *
 * It is also the shape the prior art converged on: Hermes's `/goal wait <pid>`
 * parks until *"the process with that PID exits"* — a predicate that is
 * concrete and checkable, not "when something happens". Adding a member means
 * adding its evaluator in the same change; `satisfied` below is a `switch` with
 * an exhaustive `default`, so the build says so.
 */
type WaitKind = 'process_exit' | 'approval';

/**
 * `process_exit:<pid>` o `approval:<id>` — la forma persistita: una stringa,
 * così la colonna resta una colonna.
 *
 * **`approval` non è armabile dal modello.** `parseWait` — l'unico parser che
 * legge argomenti di una tool call — produce solo `process_exit`, e non ha
 * nessun ramo che arrivi qui. Una barriera d'approvazione la arma il kernel
 * quando *lui* decide di chiedere, mai il modello dicendo di volerla: potersela
 * armare da sé vorrebbe dire potersi far riprendere da una risposta che nessuno
 * ha dato.
 */
export type WaitFor = { kind: 'process_exit'; pid: number } | { kind: 'approval'; id: string };

export type WaitSpec = {
  /** ISO 8601. The deadline, always present. */
  wakeAt: string;
  /** The event barrier, or `null` when the deadline is the only one. */
  waitFor: WaitFor | null;
};

/** Refused at the boundary, with the reason the model is told verbatim. */
export type WaitRefusal = { ok: false; why: string };
export type WaitParsed = { ok: true; spec: WaitSpec };

export function encodeWaitFor(waitFor: WaitFor): string {
  return waitFor.kind === 'approval' ? `approval:${waitFor.id}` : `process_exit:${waitFor.pid}`;
}

/**
 * Reads back what `encodeWaitFor` wrote, and refuses anything else.
 *
 * `null` for an unparseable value rather than a throw: the value comes off
 * disk, and a row written by a future version — or by a hand-edited database —
 * must not take the lane down. An unrecognised barrier degrades to "this turn
 * has only its deadline", which is the direction that still ends.
 */
export function decodeWaitFor(raw: string | null): WaitFor | null {
  if (raw === null) return null;
  const [kind, rest] = raw.split(':', 2);
  if (rest === undefined || rest === '') return null;
  if (kind === 'approval') {
    // Esadecimale, come lo scrive `ApprovalStore.ask`. Un id di un'altra forma
    // è una riga che non abbiamo scritto noi.
    return /^[0-9a-f]+$/.test(rest) ? { kind: 'approval', id: rest } : null;
  }
  if (kind !== 'process_exit') return null;
  const pid = Number(rest);
  return Number.isInteger(pid) && pid > 0 ? { kind: 'process_exit', pid } : null;
}

/**
 * Turn what the model asked for into a wait we are willing to arm, or say no.
 *
 * The refusal text is what reaches the model, so it says the bound that was
 * broken and the number that broke it — the repo's rule of telling the truth
 * instead of guessing on its behalf.
 */
export function parseWait(
  input: { seconds?: unknown; untilProcessExits?: unknown },
  now: Date,
): WaitParsed | WaitRefusal {
  const seconds = typeof input.seconds === 'number' ? input.seconds : Number.NaN;
  if (!Number.isFinite(seconds)) {
    return { ok: false, why: '`seconds` è obbligatorio: un\'attesa senza scadenza non finisce mai e nessuno la vede.' };
  }
  const ms = Math.round(seconds * 1000);
  if (ms < MIN_WAIT_MS) {
    return {
      ok: false,
      why:
        `un'attesa sotto i ${MIN_WAIT_MS / 1000}s non è un wait: il risveglio passa dal battito del runtime ` +
        `(30s), quindi ${seconds}s diventerebbero comunque di più. Fai il lavoro adesso, o aspetta almeno ${MIN_WAIT_MS / 1000}s.`,
    };
  }
  if (ms > MAX_WAIT_MS) {
    return {
      ok: false,
      why: `${seconds}s supera il tetto di ${MAX_WAIT_MS / 1000}s (7 giorni). Un'attesa più lunga è un job, non un turno: usa uno scheduled job.`,
    };
  }

  let waitFor: WaitFor | null = null;
  if (input.untilProcessExits !== undefined && input.untilProcessExits !== null) {
    const pid = typeof input.untilProcessExits === 'number' ? input.untilProcessExits : Number.NaN;
    if (!Number.isInteger(pid) || pid <= 1) {
      return { ok: false, why: '`untilProcessExits` deve essere un pid > 1.' };
    }
    waitFor = { kind: 'process_exit', pid };
  }

  return { ok: true, spec: { wakeAt: new Date(now.getTime() + ms).toISOString(), waitFor } };
}

/**
 * Has the barrier been satisfied?
 *
 * `alive` is injected for the same reason `TurnStore` injects it: a test has to
 * be able to exercise a live holder, a dead one and a reused pid, and a
 * liveness rule that two places implement twice disagrees exactly around a
 * crash. This is `core/lock/durable.ts`'s `pidAlive`, reused rather than
 * rewritten.
 */
export type BarrierChecks = {
  alive?: ((pid: number) => boolean) | undefined;
  /**
   * L'owner ha risposto a questa domanda? `ApprovalStore.answered`.
   *
   * Assente vuol dire «questo processo non sa rispondere», e la barriera resta
   * **non** soddisfatta: un turno che aspetta una conferma non si sveglia
   * perché chi guarda non ha il registro sott'occhio. Il turno ha comunque la
   * sua scadenza, che è la ragione per cui `wakeAt` è obbligatorio.
   */
  answered?: ((id: string) => boolean) | undefined;
};

export function satisfied(waitFor: WaitFor, checks: BarrierChecks | ((pid: number) => boolean) = {}): boolean {
  // `satisfied(barrier, alive)` era la firma di prima, e i suoi chiamanti sono
  // in due file. Accettare ancora la funzione nuda costa una riga e toglie una
  // modifica meccanica da un punto — la sweep delle barriere — dove sbagliare
  // vuol dire turni che non si svegliano più.
  const c: BarrierChecks = typeof checks === 'function' ? { alive: checks } : checks;
  switch (waitFor.kind) {
    case 'process_exit':
      return !(c.alive ?? pidAlive)(waitFor.pid);
    case 'approval':
      return c.answered !== undefined && c.answered(waitFor.id);
    default:
      return assertNever(waitFor);
  }
}

/**
 * What the model is told when the turn comes back, and it is a `tool_result`
 * rather than an error.
 *
 * A deadline that killed the turn in silence would rebuild the problem this
 * primitive closes (`docs/evidence/turno-sospendibile.md` §Domanda 3, second stop
 * condition): the model asked to wait, so it is the one that decides what an
 * expired wait means. It is also told **which** barrier ended the wait, because
 * "the process exited" and "you ran out of time" lead to different next moves.
 */
export function wakeReport(waitFor: WaitFor | null, reason: 'timer' | 'event'): string {
  if (waitFor?.kind === 'approval') {
    // Cosa ha risposto l'owner non si dice qui: lo dice il ramo che rifà la
    // chiamata, perché è quello che ha letto il registro. Qui si dice soltanto
    // che l'attesa è finita e come — e le due uscite portano a mosse diverse.
    return reason === 'event'
      ? "L'owner ha risposto alla richiesta di approvazione. Rifai la chiamata che stavi facendo: se ha detto di sì parte, se ha detto di no te lo dico e non insisti."
      : "L'owner non ha risposto alla richiesta di approvazione entro il tempo previsto. Non l'hai fatto. Diglielo, e proponi cosa fare invece — non rifare la chiamata sperando che stavolta passi.";
  }
  if (reason === 'event' && waitFor !== null) {
    return `Attesa finita: il processo ${waitFor.pid} è uscito. Riprendi da dove eri.`;
  }
  if (waitFor !== null) {
    return (
      `Attesa scaduta: il processo ${waitFor.pid} è ancora vivo allo scadere del tempo che avevi chiesto. ` +
      `Decidi tu: aspettare ancora, procedere senza, o dirlo.`
    );
  }
  return 'Attesa finita: è passato il tempo che avevi chiesto. Riprendi da dove eri.';
}

function assertNever(x: never): never {
  throw new Error(`unreachable: wait barrier non gestita ${JSON.stringify(x)}`);
}
