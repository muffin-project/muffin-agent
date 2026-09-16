import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { LoopDeps } from '../../agent/loop.js';
import type { PendingPairing } from '../../core/config/pairing.js';
import type { ModelLane } from '../../core/turns/model-lane.js';
import type { SessionStore } from '../../core/session/store.js';
import type { TrustTier } from '../../core/policy/types.js';
import { identify, tierOf, type SurfaceIdentity } from '../../core/surface/types.js';
import { DiscordApi, DiscordMessageSchema } from './api.js';
import { DiscordGateway, type DiscordGatewayDeps } from './gateway.js';
import { DiscordInbox, type StoredMessage } from './inbox.js';
import { downloadToVault } from './media.js';
import { startPresence } from './presence.js';
import { renderForDiscord } from './render.js';
import { discordPort } from './surface.js';
import type { DiscordAttachment, DiscordMessage } from './api.js';
import { awaitWithBudget } from '../shared/stop-budget.js';
import { tryPair as sharedTryPair } from '../shared/ingress/pair.js';
import { LaneRegistry, QueueNotices, laneKey, type LaneState, type PausaLever } from '../shared/ingress/lane.js';
import { receive, type Claim, type IngressHooks, type LiveWork } from '../shared/ingress/router.js';
import type { InboundEvent, IngressPart, IngressPort } from '../shared/ingress/types.js';
import { atLeastAttachmentTier, type Arrival } from '../shared/ingress/ingest.js';
import { DRAIN_BUDGET_MS } from '../../core/gateway/service.js';

/**
 * Same fallback `connector.ts` (Telegram) documents next to its own copy of
 * this constant: only reached by a bare `connector.stop()` (a test, or the
 * REPL/gateway mouth handoff, which never awaits it) — the real shutdown path
 * always passes the gateway's own `drainBudgetMs`.
 */
const DEFAULT_STOP_BUDGET_MS = DRAIN_BUDGET_MS;

/**
 * Discord as an adapter over the one loop — the second proof of
 * `connectors/telegram/connector.ts`'s claim to be a pattern rather than a
 * one-off.
 *
 * **Scope, decided and reversible.** DM-only, not guild. The owner directive
 * that started this slice was "aggiungiamo anche discord cosi da averne un
 * altro effettivo" — a second real surface, not a second chat platform's full
 * feature set. DM-only buys three things at once: it needs exactly one intent
 * (`DIRECT_MESSAGES`, 4096 — see `run()`), it needs no `MESSAGE_CONTENT`
 * privileged intent at all (Discord's own docs exempt DM content — cited in
 * `run()`), and it needs no tenant model for "who in this room is the owner"
 * beyond the one Telegram already has (a private chat is `host`, everything
 * else is a `member` tenant of its own). Extending to guilds later is
 * additive to the surface contract (`core/surface/types.ts`); it is not a
 * rewrite of this file's identity rule.
 *
 * Same three responsibilities as the Telegram connector, in the same order of
 * cost when wrong:
 *
 *  1. **No message is lost.** Every dispatch is written to `DiscordInbox`
 *     before it is interpreted — Discord's Gateway is *worse* than Telegram's
 *     `getUpdates` here (no offset, no backlog, no confirmed-redelivery
 *     contract at all), so the durable-write-before-processing discipline
 *     matters at least as much, argued in `inbox.ts`.
 *  2. **Who is speaking decides the tenant**, through the exact function
 *     Telegram calls (`identify`, `core/surface/types.ts`) — never a second,
 *     drifting copy of the same rule.
 *  3. **Nothing is answered twice**, including across a restart.
 *
 * **What this file still does not have, named rather than left to be found by
 * grep.** `agent/comandi.ts` — the `/model`, `/think`, `/config`, `/stop`
 * family — is wired into `connectors/telegram/connector.ts` (`tryCommand`)
 * and into the REPL, but not here: there is no `sembraComando`/`eseguiComando`
 * call anywhere in this file. Wiring it would mean building the whole
 * owner-only interception Telegram has (`tryCommand`'s `principal.kind !==
 * 'owner'` gate, the never-creates-a-turn short-circuit in `resolve()`) from
 * nothing, for a connector whose own scope note above already says "a second
 * real surface, not a second chat platform's full feature set". Left
 * unbuilt on purpose (docs/decisions/0062-*.md) rather than reaching `/config`
 * here through some smaller, divergent path.
 */

export type DiscordConfig = {
  token: string;
  /**
   * The owner's Discord user id — a snowflake, always a string. **Absent
   * means nobody is the owner**, the same fail-closed posture
   * `TelegramConfig.ownerUserId` documents, for the same reason: a bot that
   * defaults to "whoever DMs first" is a race, not an election.
   */
  ownerUserId?: string | undefined;
  /** The outstanding pairing code, hashed. Absent once it has matched. */
  pairing?: PendingPairing | undefined;
};

export type ConnectorDeps = {
  loop: LoopDeps;
  /**
   * La ModelLane dell'execution owner di questo processo (#533) — vedi
   * `connectors/telegram/connector.ts` per il perché è obbligatoria.
   */
  lane: ModelLane;
  /** Persists a pairing outcome. Absent disables pairing — the surface never becomes owned, the safe direction. */
  savePairing?: ((next: { ownerUserId?: string; pairing: PendingPairing | null }) => void) | undefined;
  sessions: SessionStore;
  inbox: DiscordInbox;
  api: DiscordApi;
  /** Where attachments land. Absent means the connector still answers, and says plainly that it cannot keep files. */
  vault?: {
    root: string;
    reindexPath: (
      tenantId: string,
      vaultPath: string,
      defaultTier: TrustTier,
    ) => Promise<{
      skipped: { path: string; why: string }[];
      documents: { path: string; outline: string }[];
    }>;
  };
  /** Come per Telegram: dove si registra se questa superficie sta rispondendo. */
  salute?: { connessa: (id: string, ora: Date) => void; caduta: (id: string, causa: string, ora: Date) => void };
  /**
   * La stessa cucitura che `DiscordGateway` espone gia' ai suoi test, passata
   * di qui perche' il ponte fra il socket e `salute` sta in questo file: senza,
   * quelle quattro righe sarebbero l'unico anello della catena provato solo
   * leggendolo. Assente in produzione, dove si costruisce un WebSocket vero.
   */
  wsFactory?: DiscordGatewayDeps['wsFactory'];
  config: DiscordConfig;
  /**
   * La pausa durevole (ADR-0054 §4, `core/runtime/pausa.ts`), come la riceve
   * gia' Telegram. Assente = mai in pausa.
   *
   * Slice 15, e **l'unico cambiamento di comportamento** della fetta: prima
   * di diventare una porta questo connettore non guardava la pausa affatto,
   * quindi `/pause` dal terminale o dal telefono fermava i job e Telegram e
   * lasciava Discord a rispondere. Lo stadio `busy` del router e' lo stesso
   * su ogni porta, e dichiararlo non applicabile qui vorrebbe dire scrivere
   * in `DIVERGENZE_AMMESSE` una divergenza che nessun ADR giustifica: la
   * pausa e' un fatto del runtime, non un dialetto di piattaforma.
   *
   * Cio' che Discord ancora non ha e' il `/resume` da questa porta (niente
   * comandi, fetta 17): il messaggio resta pending nell'inbox e lo raccoglie
   * il primo drain successivo alla ripresa — niente va perso, ma la ripresa
   * la deve chiedere un'altra bocca.
   */
  pausa?: PausaLever | undefined;
  now?: () => Date;
  log?: (line: string) => void;
};

/** What one dispatch turns into, or null when it is not ours to handle. */
export type Incoming = {
  messageId: string;
  channelId: string;
  text: string;
  /** Who sent it. `''` when Discord did not say (never a real snowflake). */
  fromId: string;
  /**
   * Is this a real one-to-one DM — derived from `channel_type`, never
   * assumed. Threaded through rather than re-derived by `principalFor`, so
   * the check and the value that authority relies on cannot drift apart.
   */
  direct: boolean;
  attachment?: DiscordAttachment;
};

/**
 * Reads a `MESSAGE_CREATE` payload defensively, and decides "is this ours to
 * answer" — the DM filter lives here, once, rather than at every call site.
 *
 * **`channel_type === 1` is the DM check, fail-closed.** A DM (`1`) and a
 * GROUP_DM (`3`) both omit `guild_id` — a group has no guild either — so
 * `guild_id === undefined` alone cannot tell the two apart, and a GROUP_DM
 * used to reach `identify()` as `direct: true` by construction, which made
 * every member of that group a candidate to be recognised as the owner.
 * Discord's own docs mark `channel_type` optional on `MESSAGE_CREATE`; the
 * absent case is refused here rather than assumed to mean DM, on purpose —
 * requiring the positive signal (`1`) is what "fail-closed" means for a check
 * that authority depends on, even though it costs an occasional false refusal
 * on a field Discord's docs do not always guarantee.
 *
 * `guild_id` is checked too, even though no legitimate `channel_type: 1`
 * payload should ever carry one — belt and suspenders costs one comparison
 * and refuses a payload that claims both signals at once instead of trusting
 * either alone.
 *
 * A message from a bot account — including this bot's own messages, which the
 * gateway echoes back — is never processed: nothing here calls itself, and no
 * bot's words are the owner's.
 */
export function parseMessage(raw: DiscordMessage): Incoming | null {
  const direct = raw.channel_type === 1; // DM only — see docstring above for why not `guild_id === undefined`
  if (!direct || raw.guild_id !== undefined) return null;
  if (raw.author === undefined || raw.author.bot === true || raw.author.system === true) return null;

  const text = raw.content ?? '';
  const attachment = raw.attachments?.[0];
  if (text.trim() === '' && attachment === undefined) return null;

  return {
    messageId: raw.id,
    channelId: raw.channel_id,
    text,
    fromId: raw.author.id,
    direct,
    ...(attachment ? { attachment } : {}),
  };
}

/**
 * The tenant and the principal, from who is speaking — via the rule every
 * surface shares (`identify`, `core/surface/types.ts`).
 *
 * `direct` is read off `incoming`, never asserted `true` here: `parseMessage`
 * is the one place that derives it from `channel_type`, and a second, hand-
 * written `true` at this call site is exactly the shape that let a GROUP_DM's
 * absent `guild_id` read as a private chat — the check and the value it fed
 * `identify()` had drifted apart without either line looking wrong on its own.
 */
export function principalFor(incoming: Incoming, ownerUserId: string | undefined): SurfaceIdentity {
  return identify(
    { connector: 'discord', authorId: incoming.fromId, conversationId: incoming.channelId, direct: incoming.direct },
    ownerUserId,
  );
}

/**
 * Le parti di contenuto di questo messaggio (fetta 15).
 *
 * Una sola, oggi: le parole di chi scrive, mai recintate perche' sono le sue.
 * Discord non porta ancora ne' provenienza di inoltro/citazione ne' il nome
 * del file come parte tipizzata — sono la fetta 21, e aggiungerle qui
 * cambierebbe i byte del prompt che questa fetta si e' impegnata a lasciare
 * dov'erano. `contentTierOf` su questa lista vale quindi 0, che e' esattamente
 * il `contentTaint` che Discord non passava affatto prima.
 */
function partiDi(incoming: Incoming): IngressPart[] {
  if (incoming.text === '') return [];
  return [{ source: 'author', tier: 0, text: incoming.text }];
}

/** Names the field, same idiom as `core/config/config.ts`'s own boundary parse. */
function describeZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export class DiscordConnector {
  private gateway: DiscordGateway | null = null;
  /** D2 guard — see `drain()`. */
  private draining = false;
  private redrainRequested = false;
  /**
   * The drain currently in flight, if any — same shape as
   * `TelegramConnector`'s own `draining` field, and for the same reason:
   * `stop()` needs something to await, not just the `draining` boolean `drain`
   * already guards re-entrancy with. Read live (not snapshotted) in `stop()`'s
   * wait loop, because `drain()`'s own `redrainRequested` chain can replace it
   * with a fresh promise while the wait is still going.
   */
  private drainInFlight: Promise<void> | null = null;
  /** Same meaning as `TelegramConnector.stopping` — see there. */
  private stopping = false;
  /** Same meaning as `TelegramConnector.runDone` — resolves once `run()` itself has returned. */
  private runDone: Promise<void> = Promise.resolve();

  /**
   * Questo connettore come **porta d'ingresso** (fetta 15).
   *
   * Costruita qui e non iniettata, per la stessa ragione che
   * `TelegramConnector` scrive accanto alla sua: `cli/surface.ts` registra
   * `doors`/`streams`/`approvers` sotto `connector.ingressPort.surface.id`, e
   * lo stadio `work` scrive quello stesso valore in `turns.surface`. Due
   * costruzioni separate sarebbero due letterali che concordano oggi senza
   * ragione di concordare domani (§4 invariante 1).
   *
   * `ownerUserId` qui dentro decide solo `Surface.handles`, che il lato
   * d'ingresso non legge mai: il pairing che lo cambia piu' tardi lascia
   * `port.surface.id` dov'era.
   */
  private readonly port: IngressPort;

  /**
   * La corsia viva di questa conversazione (ADR-0054): il segnale di abort e
   * la coda delle correzioni che il turno consuma.
   *
   * La chiave porta il prefisso della porta — `laneKey('discord', channelId)`
   * — perche' `identify()` risponde `'owner'` come `sessionKey` su **ogni**
   * porta: un registro senza prefisso fonderebbe il turno Telegram e quello
   * Discord dell'owner in una corsia sola (§4 invariante 5).
   *
   * Oggi nessun comando Discord la legge (`ingress.commands: false`, fetta
   * 17); esiste perche' lo stadio `work` chiede un `AbortSignal` alla porta e
   * un segnale finto sarebbe una leva che non ferma niente.
   */
  private readonly corsie = new LaneRegistry();

  /** I messaggi a cui e' gia' stato detto «in pausa»: una volta sola, **per messaggio**, non per drain. */
  private readonly avvisi = new QueueNotices();

  constructor(private readonly deps: ConnectorDeps) {
    this.port = discordPort(deps.api, deps.config.ownerUserId);
  }

  /**
   * Questa porta, per chi la assembla — stesso getter, stessa ragione di
   * `TelegramConnector.ingressPort`: l'oggetto da cui `work` prende
   * `turns.surface` e' lo stesso da cui `cli/surface.ts` prende le chiavi
   * delle tre mappe.
   */
  get ingressPort(): IngressPort {
    return this.port;
  }

  /**
   * Connects and processes until stopped.
   *
   * **The one intent this bot requests, and why not more.** `DIRECT_MESSAGES`
   * (`1 << 12` = 4096) is the only bit set. Not `MESSAGE_CONTENT` (`1 << 15`,
   * privileged, gates on Discord's own app review past 100 servers): its
   * documented exemptions include *"Content in DMs with the app"*
   * (docs.discord.com/developers/topics/gateway, "Privileged Intents" —
   * fetched live 2026-08-16, not assumed from memory of an older policy). Not
   * `GUILDS` or `GUILD_MESSAGES`: this connector never reads a guild channel,
   * per the DM-only scope decided above, and requesting an intent a bot does
   * not use is a security posture, not a configuration nicety — the brief's
   * own words for exactly this choice.
   */
  async run(signal?: AbortSignal): Promise<void> {
    const log = this.deps.log ?? (() => {});
    this.stopping = false;
    let resolveRunDone!: () => void;
    this.runDone = new Promise<void>((resolve) => {
      resolveRunDone = resolve;
    });
    try {
      const me = await this.deps.api.me();
      // Nessuna registrazione di salute qui, e la mancanza e' la riparazione:
      // `me()` che risponde prova che il token vale e che la rete c'e', **non**
      // che arrivino i messaggi — quelli dipendono dal socket. Dirlo qui e'
      // costato un ✓ verde su un Discord provatamente morto, perche' `run()` si
      // risolve anche quando rinuncia (4004/4013/4014) e nessuno lo contraddiceva
      // piu'. A dire «connessa» e' READY, sotto; `connectSurfaces` ha gia'
      // dichiarato l'attesa prima di arrivare qui.
      log(`discord: connesso come @${me.username} (${me.id})`);
      // `stop()` may have been called while `me()` was still in flight — the
      // same window `TelegramConnector.run` guards after its own `getMe()`.
      // Without this a stop requested during boot is silently ignored and the
      // socket connects anyway, moments after the process was told to leave.
      if (this.stopping) return;

      // Anything left pending from a previous life comes first, before new work.
      await this.drain();
      if (this.stopping) return;

      this.gateway = new DiscordGateway({
        token: this.deps.config.token,
        intents: 1 << 12, // DIRECT_MESSAGES only
        gatewayUrl: async () => {
          const { url } = await this.deps.api.gatewayUrl();
          return url;
        },
        onDispatch: (event, data) => {
          if (event !== 'MESSAGE_CREATE') return;
          // U1 — `data` is `unknown` here (the gateway's own `onDispatch`
          // signature says so); the id used as the inbox's primary key comes
          // from the same schema `drainOnce()` validates against below, not
          // from an `as DiscordMessage` cast. A payload that fails to parse has
          // no id this file can trust to store it under, so it is refused at
          // the door — logged, never promoted — rather than accepted under a
          // borrowed or synthetic key.
          const parsed = DiscordMessageSchema.safeParse(data);
          if (!parsed.success) {
            log(`discord: MESSAGE_CREATE scartato all'ingresso, payload non valido — ${describeZodIssues(parsed.error)}`);
            return;
          }
          const stored = this.deps.inbox.accept(parsed.data.id, parsed.data, this.now());
          // A duplicate (RESUMED replay, or a rare Discord-side redelivery) is
          // silently absorbed by the inbox's primary key; only a genuinely new
          // arrival triggers a drain, so a busy resume does not re-walk the
          // whole pending set once per event.
          if (stored) void this.drain();
        },
        ...(this.deps.wsFactory === undefined ? {} : { wsFactory: this.deps.wsFactory }),
        onLog: (line) => log(line),
        // Il battito vero di questa superficie. La `connessa` qui sopra dice
        // soltanto che `me()` ha risposto una volta; da qui in avanti a parlare
        // e' il socket, che e' l'unica cosa che porta i messaggi.
        onStato: (viva, causa) => {
          if (viva) this.deps.salute?.connessa('discord', new Date(this.now()));
          else this.deps.salute?.caduta('discord', causa ?? 'gateway giu', new Date(this.now()));
        },
      });

      await this.gateway.run(signal);
    } finally {
      resolveRunDone();
    }
  }

  /**
   * Same contract as `TelegramConnector.stop`, over the websocket instead of a
   * long poll: signal the gateway to close, then wait for `run()` to actually
   * return — which for Discord means the socket's own `close` event fired,
   * `gateway.ts`'s `connectOnce` — and for any drain already under way (a
   * queued message, possibly a whole turn) to finish or be abandoned, bounded
   * by `budgetMs` (`connectors/shared/stop-budget.ts`). `cli/surface.ts` calls
   * this with the gateway's own drain budget, same as Telegram's — one number,
   * not two.
   */
  async stop(budgetMs = DEFAULT_STOP_BUDGET_MS): Promise<boolean> {
    const log = this.deps.log ?? (() => {});
    this.stopping = true;
    this.gateway?.stop();
    const deadline = Date.now() + budgetMs;
    let finished = await awaitWithBudget(this.runDone, Math.max(0, deadline - Date.now()));
    while (finished && this.drainInFlight !== null) {
      finished = await awaitWithBudget(this.drainInFlight, Math.max(0, deadline - Date.now()));
    }
    if (!finished) {
      log(
        `discord: fermata non confermata entro ${Math.round(budgetMs / 1000)}s — un messaggio potrebbe essere rimasto a metà, riprende al prossimo avvio`,
      );
    }
    return finished;
  }

  /**
   * Everything not yet answered, oldest first. Also the crash-recovery path.
   *
   * **Guarded against overlap — D2.** `onDispatch` calls `void this.drain()`
   * on every new arrival, with nothing awaiting it. Two DMs a few
   * milliseconds apart used to start two concurrent walks of
   * `inbox.pending()`: the first message was still mid-turn — not yet
   * `markProcessed` — when the second walk read the table, so it saw the
   * same row as still pending and processed it a second time, in parallel
   * with the first. One message paid for and answered twice, on top of
   * whatever else had genuinely arrived.
   *
   * The shape is `Scheduler.tick`'s `running` guard
   * (`core/scheduler/scheduler.ts:146-160`): a call that arrives while one is
   * already in flight does not start a second walk. Unlike the scheduler —
   * which simply waits for the next timer tick to pick up what a deferred run
   * left due — nothing here re-invokes `drain()` on its own, so a request
   * that arrived mid-drain has to be remembered and honoured once the current
   * pass finishes, or a message that arrived after `pending()` had already
   * been read would sit answered by nobody until some unrelated later
   * dispatch happened to trigger a fresh drain.
   */
  private drain(): Promise<void> {
    if (this.draining) {
      this.redrainRequested = true;
      // Not a fresh promise: the caller (`stop()` included) that wants "done"
      // means "whatever is currently the tail of this chain", and the in-flight
      // walk already guarded by `this.draining` is exactly that.
      return this.drainInFlight ?? Promise.resolve();
    }
    this.draining = true;
    const run = (async () => {
      try {
        do {
          this.redrainRequested = false;
          await this.drainOnce();
        } while (this.redrainRequested);
      } finally {
        this.draining = false;
        this.drainInFlight = null;
      }
    })();
    this.drainInFlight = run;
    return run;
  }

  /** One pass over whatever `inbox.pending()` returns right now. */
  private async drainOnce(): Promise<void> {
    const log = this.deps.log ?? (() => {});
    for (const stored of this.deps.inbox.pending()) {
      // U1 — validated against the same schema `onDispatch` uses, not
      // `JSON.parse(...) as DiscordMessage`. A row can only get here via
      // `inbox.accept`, which by construction (see `onDispatch`) only ever
      // stores an already-validated payload — so this is defence in depth
      // for a row written by an older or future code path, the same reason
      // `core/turns/store.ts` parses a row `better-sqlite3` cannot type
      // rather than trusting the column.
      const parsed = DiscordMessageSchema.safeParse(JSON.parse(stored.payload));
      if (!parsed.success) {
        // Marked processed, not retried: the same bytes would fail the same
        // way forever, so leaving it pending would only make `doctor` see a
        // queue that never empties. Never promoted to `parseMessage`/`handle`.
        this.markProcessedQuietly(stored.messageId, log);
        log(`discord: messaggio ${stored.messageId} scartato, payload non valido — ${describeZodIssues(parsed.error)}`);
        continue;
      }
      const incoming = parseMessage(parsed.data);

      if (!incoming) {
        this.markProcessedQuietly(stored.messageId, log);
        continue;
      }

      try {
        await this.resolve(stored, incoming);
      } catch (error) {
        // `this.stopping` checked before touching `error.message` for the same
        // reason `TelegramConnector.drain` does: past `stop()`'s budget the
        // database is closed underneath this turn, and the raw message is the
        // driver's own `The database connection is not open` — not a sentence
        // for the owner.
        const reason = this.stopping
          ? 'interrotto dallo spegnimento — resta da elaborare al prossimo avvio'
          : error instanceof Error
            ? error.message
            : String(error);
        try {
          this.deps.inbox.markFailed(stored.messageId, reason);
        } catch {
          // Nothing left to record it in; the log line below is what survives.
        }
        log(`discord: messaggio ${stored.messageId} fallito — ${reason}`);
      }
    }
  }

  /** `markProcessed`, tolerant of a database that closed out from under a drain running past `stop()`'s budget. */
  private markProcessedQuietly(messageId: string, log: (line: string) => void): void {
    try {
      this.deps.inbox.markProcessed(messageId, this.now());
    } catch (error) {
      if (!this.stopping) throw error;
      log(`discord: messaggio ${messageId} interrotto dallo spegnimento — resta da elaborare al prossimo avvio`);
    }
  }

  /**
   * The pairing gate. Slice 12: the algorithm itself now lives once in
   * `connectors/shared/ingress/pair.ts` — this is Telegram's `tryPair`
   * over a snowflake string instead of a numeric user id, and without the
   * `ownerChatId` field only Telegram persists.
   */
  private async tryPair(incoming: Incoming): Promise<boolean> {
    return sharedTryPair(
      {
        ownerUserId: this.deps.config.ownerUserId,
        pairing: this.deps.config.pairing,
        canPersist: this.deps.savePairing !== undefined,
      },
      {
        fromId: incoming.fromId,
        text: incoming.text,
        eligible: incoming.fromId !== '',
      },
      {
        onMatched: (fromId) => {
          this.deps.savePairing!({ ownerUserId: fromId, pairing: null });
          this.deps.config.ownerUserId = fromId;
          this.deps.config.pairing = undefined;
        },
        onAttempt: (next) => {
          this.deps.savePairing!({ pairing: next });
          this.deps.config.pairing = next ?? undefined;
        },
        say: (text) => this.deps.api.sendMessage(incoming.channelId, text),
      },
      new Date(this.now()),
    );
  }

  /**
   * L'unico punto in cui questo connettore entra nel cammino d'ingresso
   * condiviso (fetta 15, `docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md`
   * §3 riga 15).
   *
   * Cio' che prima era `handle()` — pairing, presenza, ingest, `runTurn`,
   * consegna, `markProcessed` — e' adesso
   * `connectors/shared/ingress/router.ts`, percorso stadio per stadio da
   * `INGRESS_STAGES`. Qui restano soltanto i fatti di Discord: quali campi
   * fanno un candidato al pairing, come si spezza un messaggio sotto i 2000
   * caratteri, quale riga dell'inbox si marca elaborata.
   *
   * **Solo `receive`, non `recover`.** Il gemello esiste per un evento gia'
   * legato a un `workId` durevole, e `discord_messages` (`inbox.ts`:29-38) non
   * ha ne' la colonna del legame ne' quella del settle: un messaggio Discord e'
   * o pending o elaborato. `claim` conia quindi sempre un id nuovo e vince
   * sempre, non esiste una gara di bind da perdere, e `recover` non ha da qui
   * un chiamante raggiungibile. La conseguenza e' quella di oggi, invariata:
   * un crash fra il turno e `markProcessed` fa ripartire il messaggio al drain
   * successivo. Darle un bind — e con esso l'esattamente-una-volta che
   * Telegram ha — e' una migrazione additiva dello schema durevole, che il
   * disegno mette nella fetta 20 accanto alle parti di consegna.
   */
  private async resolve(stored: StoredMessage, incoming: Incoming): Promise<void> {
    const log = this.deps.log ?? (() => {});
    const esito = await receive(this.port, this.eventoDi(stored, incoming), this.ganci(stored, incoming));

    // Un pairing non crea mai un turno: non chiama il modello e legarlo a uno
    // vorrebbe dire fargli attraversare tutta la macchina di consegna
    // costruita per una risposta che non arrivera'.
    if (esito.kind === 'paired' || esito.kind === 'commanded' || esito.kind === 'ignored') {
      this.markProcessedQuietly(stored.messageId, log);
      return;
    }
    // `queued` (in pausa) non scrive niente e non marca niente: e' esattamente
    // cio' che lo lascia nell'inbox per il drain successivo alla ripresa. Ogni
    // altro esito ha gia' scritto quello che doveva, dentro il router.
  }

  /**
   * Questo messaggio come `InboundEvent` — la forma che ogni stadio legge.
   *
   * `parts` e' dove la conoscenza del filo di Discord si ferma. Oggi ce n'e'
   * una sola, le parole di chi scrive: la riga d'arrivo dell'allegato la
   * produce lo stadio `ingest` e la mette in testa lui, e il **nome** del file
   * non entra ancora come parte `filename` recintata come fa Telegram —
   * aggiungerla cambierebbe i byte del prompt di Discord, che e' la fetta 21
   * («una parte per allegato invece di `attachments[0]`»), non questa.
   *
   * `addressing.direct` e' `true` per costruzione e non per scelta:
   * `parseMessage` (:155-156) rifiuta tutto cio' che non e' un DM uno-a-uno,
   * quindi `mentionsBot`/`repliesToBot` non hanno un ramo che possa
   * raggiungerli — la ragione per cui `gate` e `remember` sono in
   * `DIVERGENZE_AMMESSE` dal giorno uno.
   */
  private eventoDi(stored: StoredMessage, incoming: Incoming): InboundEvent {
    const channel = `discord:${incoming.channelId}`;
    return {
      port: this.port,
      // Discord non compone mai piu' dispatch in un Work solo, quindi i due id
      // sono la stessa stringa — la risposta onesta per una porta che non
      // compone, come dice il docstring di `InboundEvent`.
      eventId: stored.messageId,
      compositionId: stored.messageId,
      identity: {
        connector: 'discord',
        authorId: incoming.fromId,
        conversationId: incoming.channelId,
        // Letto da `parseMessage`, mai riasserito qui: e' la stessa riga che
        // `principalFor` documenta, e un secondo `true` scritto a mano e'
        // esattamente la forma che fece leggere un GROUP_DM come chat privata.
        direct: incoming.direct,
      },
      address: {
        channel,
        replyTo: incoming.messageId,
        // Il record durevole, invariato: e' cio' che `turns.replyTo` contiene
        // gia' su questa installazione, e questa fetta non tocca lo schema
        // (§4 invariante 2).
        record: { channelId: incoming.channelId, messageId: incoming.messageId, channel },
      },
      addressing: { direct: incoming.direct, mentionsBot: false, repliesToBot: false },
      parts: partiDi(incoming),
      receivedAt: new Date(stored.receivedAt),
    };
  }

  /**
   * Tutto cio' che il router chiede a questa porta, per un messaggio.
   *
   * Gli stadi che questa porta non ha sono `undefined`, non finti: il router
   * salta uno stadio il cui gancio manca, e un gancio che risponde sempre «no»
   * direbbe la stessa cosa nascondendola. `command` manca perche'
   * `ingress.commands` e' `false` (fetta 17); `remember` manca perche'
   * `opensATurn` non ha un ramo che possa rifiutare.
   */
  private ganci(stored: StoredMessage, incoming: Incoming): IngressHooks {
    const log = this.deps.log ?? (() => {});
    const spec = incoming.attachment;
    return {
      ownerId: this.deps.config.ownerUserId,
      pair: () => this.tryPair(incoming),
      // §2.5: la regola del gate resta nella porta. Qui e' una costante, e la
      // costante e' il fatto: `parseMessage` ha gia' rifiutato ogni messaggio
      // che non sia un DM uno-a-uno, quindi ogni evento che arriva fin qui
      // apre un turno. Non c'e' un ramo di gruppo da provare, ed e' per questo
      // che `gate` e `remember` sono divergenze ammesse e non buchi.
      opensATurn: () => true,
      laneState: (): LaneState => ({
        inPausa: this.deps.pausa?.attiva() === true,
        vivo: this.corsie.isLive(this.corsia(incoming.channelId)),
      }),
      notices: this.avvisi,
      say: (_ctx, testo) => this.dilloA(incoming, testo),
      ...(spec === undefined
        ? {}
        : {
            ingest: (ctx) => this.ingest(incoming, spec, ctx.identity.tenant, tierOf(ctx.identity.principal)),
          }),
      claim: async (): Promise<Claim> => ({ kind: 'mine', workId: randomBytes(16).toString('hex') }),
      work: { loop: this.deps.loop, sessions: this.deps.sessions, lane: this.deps.lane },
      openLive: async () => this.apriIlVivo(incoming),
      deliver: async (_ctx, _workId, text) => {
        for (const part of renderForDiscord(text)) {
          await this.deps.api.sendMessage(incoming.channelId, part);
        }
        return 'sent';
      },
      recordDelivery: (turnId, delivery) => this.recordDelivery(turnId, delivery),
      finish: () => this.markProcessedQuietly(stored.messageId, log),
      // Discord non ha un fuoco da spegnere: `discord_messages` non ha una
      // colonna `settled_at`, perche' senza bind non c'e' la finestra fra il
      // legame e la consegna che quella colonna esiste per testimoniare.
      settle: () => {},
      markProcessed: () => this.markProcessedQuietly(stored.messageId, log),
      log: (riga) => log(`discord: ${riga}`),
    };
  }

  /** La chiave della corsia viva di questa conversazione (§4 invariante 5). */
  private corsia(channelId: string): string {
    return laneKey(this.port.surface.id, channelId);
  }

  /** Una frase sola, non richiesta, nel canale da cui e' arrivato questo messaggio. */
  private async dilloA(incoming: Incoming, testo: string): Promise<void> {
    try {
      await this.deps.api.sendMessage(incoming.channelId, testo);
    } catch (error) {
      (this.deps.log ?? (() => {}))(
        `discord: conferma di coda non inviata — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * I sink vivi di un turno, come li chiede il router.
   *
   * La presenza parte all'apertura — e' cosi' che l'owner vede che qualcosa
   * sta succedendo, anche durante uno scaricamento lento — mentre la corsia la
   * apre `arm()`, che il router chiama subito prima del modello: una corsia
   * registrata durante lo scaricamento farebbe dire a `/stop` di aver
   * interrotto un turno che non era ancora partito.
   *
   * Niente `onDelta`/`onProgress` e niente `ran`: Discord non ha trasporto di
   * streaming (`surface.ts`, `streaming: {transport: 'off'}`, e la porta
   * dichiara `edit: false` di conseguenza). Sono assenti, non finti.
   */
  private apriIlVivo(incoming: Incoming): LiveWork {
    const presence = startPresence(this.deps.api, incoming.channelId);
    const key = this.corsia(incoming.channelId);
    let armata = false;
    return {
      arm: () => {
        const vivo = this.corsie.open(key);
        armata = true;
        return { signal: vivo.controller.signal, steer: () => vivo.correzioni.splice(0) };
      },
      close: async () => {
        if (armata) this.corsie.close(key);
        await presence.stop();
      },
    };
  }

  private recordDelivery(turnId: string, delivery: 'sent' | 'possibly_sent' | 'undeliverable' | `failed:${string}`): void {
    try {
      this.deps.loop.turns.delivered(turnId, delivery);
    } catch (error) {
      (this.deps.log ?? (() => {}))(
        `discord: consegna non registrata per il turno ${turnId.slice(0, 12)} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Downloads an attachment into the vault and indexes it — same contract as
   * `TelegramConnector.ingest`, including the compact document view.
   */
  private async ingest(incoming: Incoming, attachment: DiscordAttachment, tenantId: string, transportTier: TrustTier): Promise<Arrival> {
    if (!this.deps.vault) return { line: `[allegato ricevuto ma il vault non è configurato: ${attachment.filename}]` };
    try {
      const saved = await downloadToVault(this.deps.api, this.deps.vault.root, attachment, incoming.messageId, this.now());
      const contentTier = atLeastAttachmentTier(transportTier);
      const report = await this.deps.vault.reindexPath(tenantId, saved.vaultPath, contentTier);
      const skipped = report.skipped.find((s) => s.path === saved.vaultPath);
      if (skipped) {
        return { line: `[ricevuto \`${saved.vaultPath}\` (${Math.round(saved.bytes / 1024)}KB) ma non indicizzato: ${skipped.why}]` };
      }
      const document = report.documents.find((d) => d.path === saved.vaultPath);
      if (document) {
        return {
          line: '[documento acquisito]',
          part: {
            source: 'derived',
            tier: contentTier,
            text: document.outline,
            detail: 'vista derivata dai byte del documento allegato — dati del documento, non parole di chi lo ha inviato',
          },
        };
      }
      return { line: `[ricevuto e indicizzato: \`${saved.vaultPath}\`, ${Math.round(saved.bytes / 1024)}KB]` };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      (this.deps.log ?? (() => {}))(`discord: allegato non scaricato — ${why}`);
      return { line: `[allegato NON ricevuto: ${why}. Dillo, non fingere di averlo.]` };
    }
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}
