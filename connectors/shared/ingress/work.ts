import { runTurn, type LoopDeps, type TurnDelta, type TurnEvent, type TurnResult } from '../../../agent/loop.js';
import type { AudioBlock, ImageBlock } from '../../../agent/providers/types.js';
import type { TrustTier } from '../../../core/policy/types.js';
import type { SessionStore } from '../../../core/session/store.js';
import type { SurfaceIdentity } from '../../../core/surface/types.js';
import type { InboundEvent, IngressPort } from './types.js';

/**
 * Slice 14, the `work` stage: creating the turn and its durable record.
 *
 * This is the **only** place an inbound event reaches `runTurn`. Not a
 * stylistic preference — `docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md`
 * §4 invariant 1 makes it load-bearing: the `surface` column this call writes
 * (`core/turns/store.ts`, `surface TEXT NOT NULL`) is a durable routing key,
 * read back after a restart by three independent maps in `cli/surface.ts` and
 * `agent/runtime.ts` (`doors`, `streams`, `approvers`). Before this slice each
 * connector wrote it as its own string literal (`surface: 'telegram'`,
 * `surface: 'discord'`) beside a second literal used to register the door, and
 * nothing made the two agree. Here it is `port.surface.id` — the same value
 * `cli/surface.ts` keys the maps with, because `INGRESS_PORTS` hands both
 * halves the one `IngressPort`.
 *
 * Everything a *platform* knows stays out: the live sinks arrive as plain
 * callbacks, the reply address arrives as the opaque record the port already
 * writes to the durable row, and the identity arrives already resolved by
 * `identify()` (§4 invariant 4 — one place decides a `sessionKey`).
 */

export type WorkDeps = {
  readonly loop: LoopDeps;
  /**
   * The same store `loop.sessions` names. Taken explicitly because the port
   * already had to resolve one for its own command stitching, and because a
   * second store here would open the exact gap `/new` closes: the command
   * archives the conversation the *next* turn reopens, so both must be the
   * same object.
   */
  readonly sessions: SessionStore;
};

export type WorkRequest = {
  /**
   * The identity the port already committed for this event (Telegram's
   * `bind`, `updates.ts`) — threaded in so the row this call writes is the row
   * the event already points at, never a second competing one
   * (`slice/inbound-unit`, ADR-0035 emendamento №6).
   */
  readonly workId: string;
  /** `identify()`'s own answer, resolved once by the router. */
  readonly identity: SurfaceIdentity;
  readonly text: string;
  /**
   * What `text` carries beyond the sender's own tier, `contentTierOf` over the
   * event's parts. One number: `agent/loop.ts` reuses it for the row's
   * starting taint and for the episode/session writes of this same message
   * (DAY-1 requirement B16, ADR-0044 amendment).
   */
  readonly contentTaint: TrustTier;
  /**
   * Where the answer goes, on the record rather than only on this stack — the
   * port's own opaque address, unchanged, because the durable schema is
   * untouched by this slice (§4 invariant 2) and only the port can read it
   * back on the way out.
   */
  readonly replyTo: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly steer: () => string[];
  readonly images?: readonly ImageBlock[] | undefined;
  readonly audios?: readonly AudioBlock[] | undefined;
  readonly onDelta?: ((delta: TurnDelta) => void) | undefined;
  readonly onProgress?: ((event: TurnEvent) => void) | undefined;
};

export async function runWork(
  deps: WorkDeps,
  port: IngressPort,
  event: InboundEvent,
  req: WorkRequest,
): Promise<TurnResult> {
  return runTurn(deps.loop, {
    signal: req.signal,
    steer: req.steer,
    principal: req.identity.principal,
    tenant: req.identity.tenant,
    // §4 invariant 1: the durable routing key, and the one place it is
    // written. `port.surface.id` rather than a literal, so it cannot disagree
    // with the key the door was registered under.
    surface: port.surface.id,
    // La chiave viene da `identify` (`core/surface/types.ts`) e non da un
    // letterale: per l'owner è `owner`, la stessa che apre il terminale, così
    // una conversazione sola attraversa le due porte (ADR-0056, il failure del
    // 03/09 «non sembra lo stesso muffin»); per un gruppo è la stanza — due
    // stanze non condividono mai una sessione, e l'owner che parla *dentro* un
    // gruppo è un `member` di quel tenant.
    session: deps.sessions.open(req.identity.sessionKey),
    text: req.text,
    // I byte dell'immagine viaggiano nello stesso messaggio della domanda. Non
    // serve alzare niente a mano: il turno parte già a `max(tierOf(principal),
    // contentTaint)` per la riga qui sotto, e l'immagine è contenuto dello
    // stesso mittente — un'immagine inoltrata eredita il tier del testo che la
    // accompagna.
    ...(req.images === undefined ? {} : { images: [...req.images] }),
    // Solo quando il modello ascolta davvero: `decidiVoce` ha già fatto quella
    // domanda al provider, e se la risposta era no qui non arriva niente — la
    // nota vocale è già diventata testo dentro la riga d'arrivo, recintata
    // come dati.
    ...(req.audios === undefined ? {} : { audios: [...req.audios] }),
    contentTaint: req.contentTaint,
    id: req.workId,
    replyTo: req.replyTo,
    // The registry address for *this* conversation — always fully qualified,
    // even for the owner's own private chat: a mid-turn tool addressing a
    // follow-up delivery needs the exact room the turn came from, not the
    // surface's default.
    replyChannel: event.address.channel,
    ...(req.onDelta === undefined ? {} : { onDelta: req.onDelta }),
    ...(req.onProgress === undefined ? {} : { onProgress: req.onProgress }),
  });
}
