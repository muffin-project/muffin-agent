/**
 * The Discord Gateway — the WebSocket half, over the runtime's built-in
 * `WebSocket`, with no library between.
 *
 * Same decision as `connectors/telegram/api.ts` (ADR-0025) and
 * `connectors/discord/api.ts`, made again for the harder half: `discord.js`
 * owns a client object graph, an entity cache and its own event loop — a
 * second engine, which is exactly what this project keeps one of on purpose.
 * `@discordjs/{ws,core}` is genuinely ESM and would be the right answer if the
 * gateway handshake were large; it is not. The subset a DM-only bot needs is
 * six opcodes (Hello, Identify, Resume, Reconnect, Invalid Session, Heartbeat
 * ACK) and a close-code table — see the docstring on `nextAction` below,
 * transcribed from `docs.discord.com/developers/topics/opcodes-and-status-codes`
 * (fetched 2026-08-16, not from memory).
 *
 * Node has shipped a global, spec-compliant `WebSocket` (wrapping undici)
 * since v22.4.0, no longer experimental — `package.json` already requires
 * Node ≥22, so this costs nothing to depend on.
 *
 * ## Why this file does not open a socket itself
 *
 * `wsFactory` is injected, defaulting to `(url) => new WebSocket(url)`. Not for
 * abstraction's own sake: Node has no built-in WebSocket *server*, so a test
 * cannot stand up a fake gateway the way `cli/gateway.test.ts` stands up a fake
 * HTTP provider. Injecting the client lets a test drive this class with a
 * scripted fake that never touches a socket — proving *this file's* state
 * machine (when to Identify vs Resume, when to reconnect, when to give up)
 * rather than re-proving that Node's WebSocket implements RFC 6455, which is
 * not this file's job to verify.
 */

/** The whole envelope shape every Discord Gateway payload shares. */
export type GatewayEnvelope = {
  op: number;
  d?: unknown;
  /** Sequence number, present only on Dispatch (op 0). Cached for Heartbeat and Resume. */
  s?: number | null;
  /** Event name, present only on Dispatch. */
  t?: string | null;
};

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * The minimum a WHATWG `WebSocket` gives us, and the whole surface this file
 * touches — small on purpose, so a test fake has little to get wrong.
 */
export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /**
   * One signature, not one overload per event — a real `WebSocket`'s
   * `addEventListener` is happy to be called this way (the event objects it
   * hands back are a superset of what each branch below reads), and a single
   * signature is what a plain object literal fake can implement without
   * fighting structural typing over which overload it satisfies.
   */
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev?: WsEvent) => void): void;
};

/** The union of fields this file ever reads off an event object, across all four event types. */
export type WsEvent = { data?: unknown; code?: number; reason?: string };

export type DiscordGatewayDeps = {
  token: string;
  /** `DIRECT_MESSAGES` only for this slice — see `connectors/discord/connector.ts`. */
  intents: number;
  /**
   * Resolves the URL to open, fresh every call. `GET /gateway/bot` is also the
   * first thing that fails on a revoked token (401), which is why the caller
   * gets one live token check before the socket even opens.
   */
  gatewayUrl: () => Promise<string>;
  onDispatch: (event: string, data: unknown, sequence: number) => void;
  onLog?: (line: string) => void;
  /**
   * Se il socket sta portando eventi, adesso.
   *
   * Separato da `onLog` perche' una riga di diario e una risposta a «questa
   * superficie e' viva?» sono due cose diverse, e per Discord la differenza
   * costava caro: `run()` **si risolve** sia quando si e' chiesto `stop()` sia
   * quando rinuncia su un 4004 (token revocato) o 4013/4014 (intent tolti), per
   * scelta dichiarata qui sopra. Chi guarda dall'esterno vede una promise che
   * si chiude bene, quindi il `.catch` di `connectSurfaces` non scatta mai: la
   * superficie restava registrata connessa dalla stretta di mano d'avvio, e
   * `muffin doctor` stampava «connesse» per tutta la vita del processo mentre
   * il connettore aveva gia' scritto nel diario di aver rinunciato. Stessa
   * forma di verde-perche'-non-arriva-niente che questa slice esiste per
   * togliere, sulla seconda superficie.
   *
   * Chiamata su READY/RESUMED e su ogni chiusura o fallimento — anche quelli da
   * cui si riprova, perche' e' la **durata** a distinguere un blip da un
   * guasto, e quella la misura chi legge.
   */
  onStato?: (connessa: boolean, causa?: string) => void;
  now?: () => Date;
  wsFactory?: (url: string) => WebSocketLike;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * `library` in the Identify payload is a courtesy string Discord shows on
 * its own dashboard ("connected via …"); it has no protocol effect.
 */
const IDENTIFY_PROPERTIES = { os: process.platform, browser: 'muffin', device: 'muffin' };

/**
 * What to do with a close code, transcribed verbatim from
 * `docs.discord.com/developers/topics/opcodes-and-status-codes` (fetched
 * 2026-08-16) rather than inferred from a library's defaults.
 *
 * `reconnect: false` — 4004 (bad token), 4010/4011/4012 (sharding/version,
 * irrelevant to a one-shard DM bot but Discord's own table lists them),
 * 4013/4014 (intents wrong or disallowed) — are **configuration**, not
 * transient network faults. Retrying them hammers Discord with the same
 * rejected handshake forever, which is worse than stopping and saying so.
 *
 * `resume: false` on `reconnect: true` — 4007 (our cached `seq` is stale) and
 * 4009 (the session itself timed out) — means the *session* is the thing that
 * is invalid, not just the socket: Resume would ask Discord to continue a
 * session it has already discarded, and Discord's answer to that is Invalid
 * Session, one round trip later for nothing. A fresh Identify is the correct
 * first move, not a fallback.
 */
export function nextAction(code: number): { reconnect: boolean; resume: boolean; why: string } {
  switch (code) {
    case 4004:
      return { reconnect: false, resume: false, why: 'token non valido o revocato (Authentication failed)' };
    case 4010:
      return { reconnect: false, resume: false, why: 'shard non valido (Invalid shard)' };
    case 4011:
      return { reconnect: false, resume: false, why: 'serve lo sharding (Sharding required) — non atteso per un bot DM-only' };
    case 4012:
      return { reconnect: false, resume: false, why: 'versione API del gateway non valida (Invalid API version)' };
    case 4013:
      return { reconnect: false, resume: false, why: 'intent richiesti non validi (Invalid intent(s))' };
    case 4014:
      return { reconnect: false, resume: false, why: 'intent non autorizzati per questa app (Disallowed intent(s)) — vanno abilitati nel developer portal' };
    case 4007:
      return { reconnect: true, resume: false, why: 'sequence non valida (Invalid seq) — la sessione non è più valida, serve un nuovo Identify' };
    case 4009:
      return { reconnect: true, resume: false, why: 'sessione scaduta (Session timed out)' };
    // 4000 Unknown error, 4001 Unknown opcode, 4002 Decode error, 4003 Not
    // authenticated, 4005 Already authenticated, 4008 Rate limited, and any
    // ordinary WebSocket close (1000, 1006, …) all mean "the socket is gone,
    // the session might still be good" — Resume first, and let a subsequent
    // Invalid Session(d:false) demote it to a fresh Identify.
    default:
      return { reconnect: true, resume: true, why: `codice di chiusura ${code}` };
  }
}

/** Backoff for reconnect attempts. Capped, with jitter so a mass-reconnect (Discord-side incident) does not retry in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return base + Math.floor(Math.random() * 1000);
}

export class DiscordGateway {
  private ws: WebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private awaitingAck = false;
  private running = false;
  private stopRequested = false;
  private readonly log: (line: string) => void;
  private readonly stato: (connessa: boolean, causa?: string) => void;
  private readonly now: () => Date;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: DiscordGatewayDeps) {
    this.log = deps.onLog ?? (() => {});
    this.stato = deps.onStato ?? (() => {});
    this.now = deps.now ?? (() => new Date());
    this.wsFactory = deps.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Connects, and keeps reconnecting, until `stop()` or a non-recoverable
   * close code. Resolves normally in both cases — a Gateway that stopped on
   * purpose and one that gave up on a bad token look the same to the type
   * system; `onLog` carries which one happened, same as
   * `TelegramConnector.run`.
   */
  async run(signal?: AbortSignal): Promise<void> {
    this.running = true;
    this.stopRequested = false;
    let attempt = 0;

    while (this.running && signal?.aborted !== true) {
      const resuming = this.sessionId !== null && this.resumeUrl !== null;
      const url = resuming ? `${this.resumeUrl}/?v=10&encoding=json` : await this.deps.gatewayUrl();

      try {
        const { code: closeCode, sawReadyOrResumed } = await this.connectOnce(url, resuming);
        if (this.stopRequested) return;

        // D4 — a session that reached READY or RESUMED proved the connection
        // healthy end to end, so the *next* failure is a fresh problem, not a
        // continuation of whatever caused an earlier one. Without this, five
        // ordinary reconnects (each individually harmless — a laptop sleeping,
        // a Discord-side blip) left `attempt` at 5 forever after, and every
        // later reconnect waited the capped 30s+jitter regardless of how long
        // the intervening session had run cleanly.
        if (sawReadyOrResumed) attempt = 0;

        const action = nextAction(closeCode);
        this.log(`discord: gateway chiuso (${closeCode}) — ${action.why}`);
        this.stato(false, `gateway chiuso (${closeCode}) — ${action.why}`);
        if (!action.reconnect) {
          this.log('discord: non riprovo — serve intervento (token, intent o config)');
          // Il ramo che rende la promise indistinguibile da uno stop voluto.
          // Chi legge deve poter distinguerli, e questa e' l'unica riga che
          // glielo dice.
          this.stato(false, `non riprovo — ${action.why} (serve intervento: token, intent o config)`);
          return;
        }
        if (!action.resume) {
          this.sessionId = null;
          this.resumeUrl = null;
        }
      } catch (error) {
        if (this.stopRequested) return;
        const causa = error instanceof Error ? error.message : String(error);
        this.log(`discord: connessione fallita — ${causa}`);
        this.stato(false, `connessione fallita — ${causa}`);
      }

      attempt += 1;
      await this.sleep(backoffMs(attempt));
    }
  }

  stop(): void {
    this.stopRequested = true;
    this.running = false;
    this.clearHeartbeat();
    this.ws?.close(1000, 'stop');
  }

  /**
   * One socket's whole life. Resolves with the close code that ended it, and
   * whether this socket ever reached READY or RESUMED — `run()`'s D4 backoff
   * reset reads that half; nothing else needs it, but a private field the
   * caller could not see was exactly what let the reset go unbuilt the first
   * time, so it is returned instead.
   */
  private connectOnce(url: string, resuming: boolean): Promise<{ code: number; sawReadyOrResumed: boolean }> {
    return new Promise((resolve, reject) => {
      let helloReceived = false;
      let sawReadyOrResumed = false;
      const ws = this.wsFactory(url);
      this.ws = ws;

      ws.addEventListener('error', () => {
        // The WHATWG `Event` a real WebSocket hands an error listener carries
        // no message worth extracting (`ErrorEvent` is not guaranteed here);
        // the close event that follows it names the code, which is the part
        // that decides what happens next.
        if (!helloReceived) reject(new Error('connessione al gateway fallita'));
      });

      ws.addEventListener('close', (ev) => {
        this.clearHeartbeat();
        this.ws = null;
        const code = ev?.code ?? 1006;
        if (!sawReadyOrResumed && !helloReceived) {
          // Never got as far as Hello: a connect-level failure (DNS, refused,
          // TLS), not a protocol close. Same effect either way — the caller
          // retries — but the message should not claim a handshake that never
          // started.
          reject(new Error(`connessione chiusa prima di Hello (${code})`));
          return;
        }
        resolve({ code, sawReadyOrResumed });
      });

      ws.addEventListener('message', (ev) => {
        let envelope: GatewayEnvelope;
        try {
          envelope = JSON.parse(String(ev?.data)) as GatewayEnvelope;
        } catch {
          this.log('discord: payload non JSON, scartato');
          return;
        }
        if (typeof envelope.s === 'number') this.sequence = envelope.s;

        switch (envelope.op) {
          case OP.HELLO: {
            helloReceived = true;
            const interval = (envelope.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval;
            if (typeof interval !== 'number') {
              ws.close(1002, 'Hello senza heartbeat_interval');
              return;
            }
            this.startHeartbeat(ws, interval);
            if (resuming && this.sessionId !== null) {
              this.send(ws, {
                op: OP.RESUME,
                d: { token: this.deps.token, session_id: this.sessionId, seq: this.sequence },
              });
            } else {
              this.send(ws, {
                op: OP.IDENTIFY,
                d: { token: this.deps.token, intents: this.deps.intents, properties: IDENTIFY_PROPERTIES },
              });
            }
            return;
          }
          case OP.HEARTBEAT_ACK:
            this.awaitingAck = false;
            return;
          case OP.HEARTBEAT:
            // Discord may request an out-of-cycle heartbeat; answering
            // immediately is cheap and keeps the connection off the zombie
            // path for a beat it did not actually miss.
            this.send(ws, { op: OP.HEARTBEAT, d: this.sequence });
            return;
          case OP.RECONNECT:
            // "You should reconnect and resume" — closing here (rather than
            // waiting for the server to) is the documented behaviour, and
            // `connectOnce`'s own close handler does the rest.
            ws.close(1000, 'server requested reconnect');
            return;
          case OP.INVALID_SESSION: {
            const resumable = envelope.d === true;
            if (!resumable) {
              this.sessionId = null;
              this.resumeUrl = null;
            }
            ws.close(1000, `invalid session (resumable=${resumable})`);
            return;
          }
          case OP.DISPATCH: {
            if (envelope.t === 'READY' || envelope.t === 'RESUMED') this.stato(true);
            if (envelope.t === 'READY') {
              const ready = envelope.d as { session_id?: string; resume_gateway_url?: string } | undefined;
              this.sessionId = ready?.session_id ?? this.sessionId;
              this.resumeUrl = ready?.resume_gateway_url ?? this.resumeUrl;
              sawReadyOrResumed = true;
              this.log('discord: connesso (identify)');
            } else if (envelope.t === 'RESUMED') {
              sawReadyOrResumed = true;
              this.log('discord: connesso (resume — nessun messaggio perso)');
            } else if (typeof envelope.t === 'string' && this.sequence !== null) {
              this.deps.onDispatch(envelope.t, envelope.d, this.sequence);
            }
            return;
          }
          default:
            // An opcode this file does not handle (voice, presence, …) is not
            // ours to act on; Discord's own docs say unhandled dispatch types
            // are routine as the API grows. Logged, not dropped in silence,
            // so a genuinely new required opcode is at least visible.
            this.log(`discord: opcode ${envelope.op} ignorato`);
            return;
        }
      });
    });
  }

  private send(ws: WebSocketLike, envelope: GatewayEnvelope): void {
    ws.send(JSON.stringify(envelope));
  }

  /**
   * Jittered first beat (Discord's own recommendation: `heartbeat_interval *
   * random(0,1)`), then exact-interval beats after. A missed ACK closes the
   * socket locally rather than waiting for Discord to notice — the documented
   * "zombied connection" case, and the reason this file tracks `awaitingAck`
   * instead of trusting the timer alone.
   *
   * **One `setTimeout` that reschedules itself, not a jittered kickoff racing
   * an independent `setInterval`.** The first version used both, and they
   * raced: the interval's own first tick lands `intervalMs` after the
   * interval was *created*, which is only moments after the jittered beat
   * actually fired — nowhere near a full interval later. `awaitingAck` was
   * still true because the first beat had not had time to be ACK'd, so the
   * interval's tick read that as a zombie and closed a connection that was a
   * few hundred milliseconds old. Caught by `gateway.test.ts`'s heartbeat
   * test, not reasoned out — the failure was `sent` going from one Identify
   * to an empty array, i.e. a silent reconnect nothing in the test had asked
   * for. A self-rescheduling chain has exactly one timer in flight at a time,
   * so "the previous beat" always means one whole `intervalMs` ago.
   */
  private startHeartbeat(ws: WebSocketLike, intervalMs: number): void {
    this.clearHeartbeat();
    const beat = (): void => {
      if (this.awaitingAck) {
        this.log('discord: nessun ACK al battito precedente — connessione considerata zombie, riconnetto');
        ws.close(1000, 'zombied connection');
        return; // no reschedule — the socket is closing, connectOnce's close handler takes over
      }
      this.awaitingAck = true;
      this.send(ws, { op: OP.HEARTBEAT, d: this.sequence });
      this.heartbeatTimer = setTimeout(beat, intervalMs);
    };
    this.heartbeatTimer = setTimeout(beat, Math.floor(intervalMs * Math.random()));
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.awaitingAck = false;
  }
}
