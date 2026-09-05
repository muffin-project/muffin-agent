import { sembraComando, type Controlli, type EsitoComando } from '../../../agent/comandi.js';
import type { Principal } from '../../../core/policy/types.js';

/**
 * Slice 13 of the ingress decomposition
 * (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` §1.2 rows 6 and 7,
 * §3 row 13): the ownership of *live turn* state leaves the Telegram
 * connector.
 *
 * Three things move, and one deliberately does not.
 *
 *  - **The live-lane registry** (`LaneRegistry`). ADR-0054's "una chat, un
 *    turno alla volta" lever: an `AbortController` for `/stop` and a queue of
 *    corrections for `/steer`. It had *two* writers in the pre-slice
 *    connector, not one — the fresh turn (`runFresh`, which registers a lane
 *    before `runTurn` and removes it in its `finally`) and the resume branch
 *    (`resumeStream`, which reuses the lane already there and removes it only
 *    when it was the one that registered it) — and two readers: the "in coda"
 *    notice and the control commands. All four are here now.
 *  - **The queue notice** (`QueueNotices`). "In coda" / "in pausa", said once
 *    **per event**, never once per drain: two messages arriving while the
 *    same turn runs are two people-facing facts, and the pre-slice `avvisati`
 *    set keyed on the update id for exactly that reason.
 *  - **The command stitching** (`controlliPerCorsia`, `tryControlCommand`).
 *    `agent/comandi.ts` was already surface-agnostic and already served both
 *    `cli/repl.ts` and the Telegram connector; what was duplicated per port
 *    was the four lines around it — the owner check, building `Controlli` out
 *    of this conversation's lane, and handing the outcome back to whoever
 *    asked. Per §2.5 this extends the seam that already works rather than
 *    inventing a chat-only command module the terminal would never call.
 *
 * What stays in the port, by §2.5: `controlla` — the poller-level pre-emption,
 * `gestiti`, and `markProcessed`. A stage walked once per already-durable
 * event cannot reproduce a batch pre-emption, so moving it here would change
 * what `/stop` can interrupt.
 *
 * ## Why the key carries the port id (§4 invariant 5)
 *
 * Today's lanes are per connector: each connector owns its own map, so a
 * Telegram turn and a Discord turn are never the same lane. A shared registry
 * keyed on `identify()`'s `sessionKey` alone would silently end that, because
 * `OWNER_SESSION_KEY` is the literal `'owner'` on *every* port
 * (`core/surface/types.ts`): the owner's Telegram turn and the owner's
 * Discord turn would collapse into one live lane, `/stop` sent on one port
 * would abort a turn running on the other, and the second port's message
 * would answer "📥 in coda" to a turn it cannot see. That is a behaviour
 * change, and slice 13 is explicitly *not* "nessun comportamento nuovo": the
 * decision is to keep today's behaviour, and `laneKey` exists so that keeping
 * it is a call, not an accident.
 *
 * The second half of the key is the port's own conversation id, not
 * `sessionKey`, and that is the same decision made twice. `identify()`
 * suffixes `sessionKey` with `#<threadId>` for a forum topic, while the
 * pre-slice map was keyed on the chat id: two topics of one Telegram group
 * share one lane today. Keying on `sessionKey` here would split them into two
 * concurrent lanes — a real change to how many turns a group can run at once,
 * arriving as a side effect of a refactor. The port passes the id whose lane
 * shape it already has; only the prefix is added.
 */

/** The live turn of one lane: the lever for `/stop`, and the queue `/steer` writes into. */
export type LiveTurn = {
  readonly controller: AbortController;
  /** Drained by the turn itself (`splice(0)`), appended to by `/steer`. Mutable by contract. */
  readonly correzioni: string[];
};

/**
 * The registry key for one conversation on one port.
 *
 * `portId` is data, never a branch: nothing in this module compares it to a
 * literal, so no platform name enters a shared module (§4 invariant 11).
 */
export function laneKey(portId: string, conversationId: string | number): string {
  return `${portId}:${conversationId}`;
}

/**
 * Who is running right now, per lane.
 *
 * Deliberately not one `set`/`delete` pair for both writers: the fresh turn
 * and the resume branch have different removal rules, and collapsing them was
 * how the pre-slice connector first got `resumeStream` wrong (a resume's
 * `stop()` deleting the lane of a *fresh* turn that was still using it).
 */
export class LaneRegistry {
  private readonly lanes = new Map<string, LiveTurn>();

  /**
   * A fresh turn takes the lane: registers a new live turn, replacing
   * whatever was there. Mirrors the pre-slice `vivi.set(chatId, vivo)`
   * immediately before `runTurn`.
   */
  open(key: string): LiveTurn {
    const lane: LiveTurn = { controller: new AbortController(), correzioni: [] };
    this.lanes.set(key, lane);
    return lane;
  }

  /**
   * The fresh turn's `finally`: give the lane back if it is still there.
   * Idempotent, like the `if (…?.controller !== undefined) delete` it replaces.
   */
  close(key: string): void {
    this.lanes.delete(key);
  }

  /**
   * A resume attaches to the lane: reuses the live turn already registered
   * for this conversation, or registers one when there is none.
   *
   * `release` removes the lane **only when this call registered it**. A
   * resume that found a fresh turn already running must not take that turn's
   * lever away when its own stream stops — the turn is still running, and
   * `/stop` has to keep finding it.
   */
  attach(key: string): { readonly lane: LiveTurn; readonly release: () => void } {
    const existing = this.lanes.get(key);
    if (existing !== undefined) return { lane: existing, release: () => {} };
    const lane = this.open(key);
    return { lane, release: () => this.lanes.delete(key) };
  }

  /** Is there a turn to stop or correct in this lane? */
  isLive(key: string): boolean {
    return this.lanes.has(key);
  }

  /** The lane's live turn, or `undefined`. Reading, never registering. */
  get(key: string): LiveTurn | undefined {
    return this.lanes.get(key);
  }

  /** `false` when there was nothing running — the command says so instead of pretending. */
  stop(key: string): boolean {
    const lane = this.lanes.get(key);
    if (lane === undefined) return false;
    lane.controller.abort();
    return true;
  }

  /** `false` when there was nothing running; the caller then keeps the correction for the next turn. */
  steer(key: string, testo: string): boolean {
    const lane = this.lanes.get(key);
    if (lane === undefined) return false;
    lane.correzioni.push(testo);
    return true;
  }
}

/**
 * The two sentences, verbatim (§4 invariant 9: the owner-visible text is
 * byte-identical through the whole decomposition). Constants rather than
 * literals at the call site so that a second port gives the owner the same
 * words instead of a paraphrase of them.
 */
export const AVVISO_IN_CODA = '📥 in coda: rispondo appena finisco con quello di prima.';
export const AVVISO_IN_PAUSA = '⏸ in pausa: lo leggo al /resume.';

/** What the port already knows when an event arrives and something may already be running. */
export type LaneState = {
  /** The durable, cross-process fact (`core/runtime/pausa.ts`) — not this lane's business, but it wins. */
  readonly inPausa: boolean;
  /** Is this lane's turn running? */
  readonly vivo: boolean;
};

/**
 * "In coda" / "in pausa", once per event.
 *
 * **Per event, not per drain.** The ledger is keyed on the event's own
 * durable id, so two messages that arrive while the same turn runs are told
 * twice — one answer each — while the *same* message seen again by a second
 * drain pass (the pre-slice connector re-reads `pending()` every time a drain
 * is rescheduled) is told once. Deduplicating per lane, or resetting the
 * ledger at the start of a drain, would give the owner one notice for two
 * messages and no way to tell which one was heard.
 */
export class QueueNotices {
  private readonly avvisati = new Set<string>();

  /**
   * The text to send for this event, or `undefined` when there is nothing
   * true to say (nothing running, not paused) or it has already been said.
   *
   * Pause wins over busy: a paused runtime will not start the queued turn at
   * all, so "lo leggo al /resume" is the fact, and "rispondo appena finisco"
   * would be a promise about a turn that is not going to run.
   */
  decide(eventId: string | number, state: LaneState): string | undefined {
    const id = String(eventId);
    if (this.avvisati.has(id)) return undefined;
    if (!state.inPausa && !state.vivo) return undefined;
    this.avvisati.add(id);
    return state.inPausa ? AVVISO_IN_PAUSA : AVVISO_IN_CODA;
  }

  /** How many events have been told. Lets a caller prove the ledger is not the leak `gestiti` once was. */
  get size(): number {
    return this.avvisati.size;
  }
}

/** The durable pause, as `agent/comandi.ts` wants it; `undefined` where the port was not given one. */
export type PausaLever = { attiva: () => boolean; metti: () => void; togli: () => void };

const PAUSA_ASSENTE: PausaLever = { attiva: () => false, metti: () => {}, togli: () => {} };

/**
 * The `Controlli` for **one** lane, built from the shared registry.
 *
 * Per-lane and not per-port, deliberately: `/stop` sent from a group must not
 * stop the turn running in the private chat. That was already true of the
 * pre-slice closure over `chatId`; it is the same rule, written once.
 */
export function controlliPerCorsia(lanes: LaneRegistry, key: string, pausa: PausaLever | undefined): Controlli {
  return {
    vivo: () => lanes.isLive(key),
    stop: () => lanes.stop(key),
    steer: (testo) => lanes.steer(key, testo),
    pausa: pausa === undefined ? PAUSA_ASSENTE : { attiva: () => pausa.attiva(), metti: () => pausa.metti(), togli: () => pausa.togli() },
  };
}

/** `agent/comandi.ts`'s `eseguiComando`, as a port injects it — never imported by a connector directly. */
export type EseguiComando = (riga: string, sessionId: string, controlli: Controlli) => Promise<Pick<EsitoComando, 'testo'> | null>;

export type ControlCommandRequest = {
  /** `identify()`'s own answer. Only the owner has these commands. */
  readonly principal: Principal;
  readonly text: string;
  /** The conversation `/new` must archive — the same `sessionKey` the turn would use, resolved by the port. */
  readonly sessionId: string;
  readonly controlli: Controlli;
  /** Absent where the installation wired no commands: the text goes on to the model, unchanged. */
  readonly esegui: EseguiComando | undefined;
  /** How this port says the answer. Rendering, splitting and quoting stay in the port: they are dialect. */
  readonly rispondi: (testo: string) => Promise<void>;
};

/**
 * Runs one control command if this text is one, and says whether it was
 * handled — `true` only when a command ran *and* the answer went out.
 *
 * **Owner only, and silently so.** These commands touch the config and the
 * bill; `/spend` from a stranger in a group is not a question to answer. Nor
 * is "you are not authorised" an answer: it would tell a stranger that the
 * command exists and belongs to someone. A non-owner's text returns `false`
 * and continues towards the model like any other sentence, which is what it
 * is.
 */
export async function tryControlCommand(req: ControlCommandRequest): Promise<boolean> {
  if (req.esegui === undefined || !sembraComando(req.text)) return false;
  if (req.principal.kind !== 'owner') return false;
  const esito = await req.esegui(req.text, req.sessionId, req.controlli);
  if (esito === null) return false;
  await req.rispondi(esito.testo);
  return true;
}
