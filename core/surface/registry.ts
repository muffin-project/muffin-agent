import { redactText } from '../tracing/redact.js';
import { notDelivered, type DeliveryOutcome, type FileSpec, type Surface } from './types.js';

/**
 * The one place that knows which surfaces exist, and the only caller of
 * `Surface.handles`.
 *
 * ADR-0021: *"Tutte le surface abilitate sono connesse contemporaneamente.
 * Nessuna è «il» canale"*. This is that registry, and it is what lets the
 * scheduler, the REPL and `muffin observe` stop each carrying their own opinion
 * about which channels are real — three opinions that had already disagreed.
 *
 * It is deliberately not a map keyed by surface id. A channel is allowed to
 * carry an address (`telegram:-1001234`, ADR-0021) and only the surface knows
 * how to read its own; asking each in turn keeps that knowledge inside the
 * implementation instead of putting a parser here that would have to learn every
 * surface's addressing scheme — which is precisely the boundary the previous
 * system lost when its gateway started building Telegram-shaped footers.
 */
export class SurfaceRegistry {
  constructor(private readonly surfaces: readonly Surface[]) {}

  /** Registration order, which is also the order `deliver` asks in. */
  all(): readonly Surface[] {
    return this.surfaces;
  }

  /** The surface that owns this channel and can reach it now, or null. */
  find(channel: string): Surface | null {
    return this.surfaces.find((s) => s.handles(channel)) ?? null;
  }

  /**
   * Deliver, and say how it went.
   *
   * The two failure modes are kept apart because they call for different
   * repairs: *nobody serves this channel* is configuration (enable the surface,
   * pair it), while *the surface tried and failed* is the network or the token.
   * Collapsing them into one message is how "consegna fallita" becomes a line
   * the owner cannot act on.
   *
   * A surface that throws instead of returning is caught here rather than
   * allowed to escape. The contract says implementations return their failures;
   * an implementation that breaks the contract must still not be able to turn a
   * failed delivery into an exception in the scheduler's floating promise, which
   * is the exact shape that took the gateway down once already
   * (`core/scheduler/scheduler.ts`, the `markRan` catch).
   */
  deliver = async (channel: string, text: string): Promise<DeliveryOutcome> => {
    const surface = this.find(channel);
    if (surface === null) return this.noSurface(channel);
    // Il sink della risposta è `s6` del corpus avversariale: la scena in cui
    // l'effetto dell'attaccante esce **osservabile fuori dal testo del modello**
    // — e la scena che, misurata, non incontrava nessuna guardia, perché la riga
    // `reply` è `allow/allow/allow` per decisione (rispondere sul canale
    // d'origine è il modo in cui l'agente funziona).
    //
    // Questo non gli mette un gate davanti: aggiungere una domanda dove
    // l'owner ne concede 32 su 35 peggiorerebbe le cose. Mette il floor
    // deterministico che il codice può decidere da solo — **una credenziale che
    // esce è una proprietà dei byte, non dell'intenzione** — sull'unica porta
    // per cui passa tutto ciò che Muffin dice a chiunque.
    //
    // Vale anche per il caso più banale e più probabile: l'owner incolla una
    // chiave in chat, la chiede a Muffin, e Muffin gliela ripete in un gruppo.
    return this.caught(surface.id, () => surface.deliver(channel, redactText(text)));
  };

  /**
   * The B14 half of the same guarantee: a file that cannot be sent is a value,
   * never an exception, exactly as `deliver` established for text.
   */
  deliverFile = async (channel: string, file: FileSpec): Promise<DeliveryOutcome> => {
    const surface = this.find(channel);
    if (surface === null) return this.noSurface(channel);
    return this.caught(surface.id, () => surface.deliverFile(channel, file));
  };

  private noSurface(channel: string): DeliveryOutcome {
    const known = this.surfaces.map((s) => s.id).join(', ');
    return notDelivered(
      `nessuna superficie serve "${channel}"` + (known === '' ? ' — nessuna superficie è connessa' : ` — connesse: ${known}`),
    );
  }

  /**
   * A surface that throws instead of returning is caught here rather than
   * allowed to escape. The contract says implementations return their failures;
   * an implementation that breaks the contract must still not be able to turn a
   * failed delivery into an exception in the scheduler's floating promise, which
   * is the exact shape that took the gateway down once already
   * (`core/scheduler/scheduler.ts`, the `markRan` catch).
   */
  private async caught(surfaceId: string, attempt: () => Promise<DeliveryOutcome>): Promise<DeliveryOutcome> {
    try {
      return await attempt();
    } catch (error) {
      return notDelivered(`${surfaceId} ha lanciato invece di riportare l'esito: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
