import type { ConnectorId, Principal, TenantId } from '../policy/types.js';

/**
 * What a surface is, extracted from the one that exists rather than imagined.
 *
 * ADR-0021 already wrote the shape — a registry, every enabled surface connected
 * at once, none privileged — and named the failure it exists to prevent:
 * *"un'astrazione che privilegia un canale produce codice che assume quel canale
 * ovunque"*. The previous system paid for that with a 2,900-line Telegram file.
 *
 * This repo was paying for it again in a smaller way. `Deliver` was
 * `(channel, text) => Promise<void>` and every implementation branched on
 * `'cli'` and treated the rest as unwired: `cli/gateway.ts` wrote to stderr and
 * **returned normally**, `cli/repl.ts` and `cli/observe.ts` threw. Three
 * implementations, three chances to forget, and one that had.
 *
 * ## The two properties that are in the types, not in the prose
 *
 * **1. A delivery that did not happen is a value, not an omission.**
 * `docs/ORCHESTRATION.md` §14 names this exactly: *"Una firma che ritorna `void`
 * non può dire «non ho consegnato»"*. TypeScript has no checked exceptions, so
 * no function type can require an implementation to throw — the remedy has to be
 * the shape of the returned value (`docs/evidence/tipi-contro-successo-falso.md`
 * §Forma A, which measured the cost of this change at 9 files before it was
 * made). `DeliveryOutcome` is that shape, and it follows the house idiom for
 * "what happened" that `LockOutcome`, `VerifyOutcome` and `PairingOutcome`
 * already use: a discriminated union returned, not an exception raised.
 *
 * **2. "Is this channel real?" is asked by the one place that needs the answer.**
 * `handles` moves that question out of three imperative duties and into a
 * required predicate the *registry* consults before it ever calls `deliver`.
 * An unwired channel is now a `{ delivered: false }` by construction — there is
 * nothing left for a fourth implementation to forget.
 */

/**
 * How a delivery went. The only two answers, and both are values.
 *
 * Boolean-discriminated on purpose, like `VerifyOutcome`
 * (`core/rot/verify.ts`, `core/mcp/registry.ts`): a `boolean` cannot silently
 * grow a third member the way a string union can, so an `if (outcome.delivered)`
 * is exhaustive by construction and needs no `assertNever` to stay that way.
 *
 * `why` is required on the failure arm. A caller that has to report the failure
 * — the scheduler does, into the turn record — must never have to write
 * "consegna fallita" with no reason because the type let the producer omit one.
 */
export type DeliveryOutcome = { delivered: true } | { delivered: false; why: string };

/** The successful answer, named so call sites read as sentences. */
export const DELIVERED: DeliveryOutcome = { delivered: true };

/** The other one. A function so the reason is impossible to leave out. */
export function notDelivered(why: string): DeliveryOutcome {
  return { delivered: false, why };
}

/**
 * What a surface can carry, declared rather than discovered at the 400.
 *
 * `maxMessageChars` is the number that cost the previous system real messages:
 * the limit is on the *rendered* text, and splitting before rendering produced
 * messages over the limit that Telegram rejected whole
 * (`connectors/telegram/render.ts`). Every surface states its own — Telegram
 * 4096, Discord 2000, a terminal none — so nothing above has to know which
 * surface it is talking to in order to fit inside it.
 */
type SurfaceLimits = {
  /** Longest single message, in characters of the final rendered text. */
  readonly maxMessageChars: number;
  /** Largest attachment this surface will accept from us, in bytes. */
  readonly maxUploadBytes: number;
  /** Largest attachment we can pull *from* it, in bytes. */
  readonly maxDownloadBytes: number;
};

/**
 * How a surface can show an answer arriving — DAY-1 requirement B11, and Hermes's own
 * finding stated as a conclusion (`docs/evidence/hermes-documentazione.md` §3.8):
 * *"streaming is a capability of the surface, not a global flag"*. A boolean
 * on a config object would have to mean the same thing on a terminal and on
 * Telegram, and it does not — a terminal writes to its own stdout, Telegram
 * has nothing to progressively rewrite except a message it already sent.
 *
 * - `'stdout'` — the surface can print growing text to a stream it owns
 *   (the REPL, when stdout is a TTY).
 * - `'edit'` — the surface can progressively rewrite a message already sent
 *   (Telegram, on both transports it ends up choosing between — a business
 *   draft or a plain edit — see `connectors/telegram/presence.ts`).
 * - `'off'` — no live rewrite; a caller still gets the full answer, just not
 *   before the turn ends. The honest default for anything not listed above,
 *   and what a capable surface degrades to on its own (non-TTY stdout,
 *   `--no-stream`, the first failed edit of a session — Hermes's rule).
 */
type StreamingTransport = 'stdout' | 'edit' | 'off';

export type StreamingCapability = {
  readonly transport: StreamingTransport;
};

/**
 * A place Muffin can be reached and can answer.
 *
 * Deliberately small. Everything a surface does that is *specific* — Telegram's
 * update offsets, Discord's gateway heartbeat, the terminal's readline — stays
 * inside the implementation. What is general is here, and it is exactly the set
 * that a caller outside `connectors/` has ever needed: who owns this channel,
 * how much fits in one message, and did the message arrive.
 */
export interface Surface {
  readonly id: ConnectorId;
  readonly limits: SurfaceLimits;
  /**
   * Declared, not discovered — same reasoning as `limits`. Read by the
   * surface's own turn-running code (the REPL, `TelegramConnector.handle`)
   * to decide whether to attach `TurnInput.onDelta` at all; `Surface.deliver`
   * itself never streams; it is always the whole, finished text, which is
   * why an out-of-band job delivery is unaffected by whatever this says.
   */
  readonly streaming: StreamingCapability;

  /**
   * Does this surface own this channel, **and can it reach it right now**?
   *
   * Both halves. A Telegram surface with no owner chat id configured `handles`
   * nothing: answering `true` and failing inside `deliver` would put the
   * "not wired" case back inside the implementation, which is the arrangement
   * this interface exists to end.
   */
  handles(channel: string): boolean;

  /**
   * Send text to a channel this surface `handles`.
   *
   * Splits to `limits.maxMessageChars` itself — the caller has prose, not a
   * transport budget. Returns how it went and does not throw for a foreseeable
   * failure; a throw from here is a bug in the implementation, and the registry
   * catches it into a `{ delivered: false }` rather than letting it escape into
   * a caller that was promised a value.
   */
  deliver(channel: string, text: string): Promise<DeliveryOutcome>;

  /**
   * Send a file to a channel this surface `handles` — DAY-1 requirement B14, "un file
   * prodotto arriva come allegato, o come percorso da copiare a mano?".
   *
   * **Required, not optional, on the same principle `Deliver` was rewritten
   * for.** An optional method invites the fourth implementation to omit it
   * silently — exactly the shape `docs/ORCHESTRATION.md` §14 already spent one
   * slice closing for text. A surface that has no real way to move bytes still
   * answers honestly: `cliSurface` names the path instead of a transport it
   * does not have, which is a `{ delivered: true }` that is true, not a
   * `{ delivered: false }` standing in for "not implemented".
   *
   * Same non-throwing contract as `deliver`: a foreseeable failure (file too
   * large, upload rejected, channel unreachable) is a `{ delivered: false }`
   * value, and `SurfaceRegistry.deliverFile` catches an implementation that
   * throws anyway for the same reason `deliver`'s does.
   */
  deliverFile(channel: string, file: FileSpec): Promise<DeliveryOutcome>;
}

/**
 * What `deliverFile` is handed. `absolutePath` is a real path on this
 * process's filesystem — the caller (`agent/tools/deliver.ts`) is responsible
 * for having already resolved and contained it; a `Surface` implementation
 * reads from it but does not re-validate where it came from, the same
 * division of labour `fs.ts`'s tools and their `FsScope` already keep.
 */
export type FileSpec = {
  absolutePath: string;
  /** What the recipient sees as the filename — never trusted back into a path. */
  filename: string;
  /** Shown alongside the file where the surface supports one. Truncated by the implementation to its own caption limit. */
  caption?: string;
};

/** Who is speaking, whose memory this belongs to, and which conversation it continues. */
export type SurfaceIdentity = {
  principal: Principal;
  tenant: TenantId;
  /**
   * Quale conversazione questo messaggio continua — l'id di sessione, deciso
   * qui e da nessun'altra parte.
   *
   * Il failure che l'ha portato dentro `identify`, misurato dall'owner il
   * 2026-09-03: «non sembra di star parlando allo stesso muffin». Non era un
   * confine di sicurezza — la DM Telegram dell'owner e il terminale sono già
   * lo stesso tenant `host`, poche righe più sotto — era una stringa scritta a
   * mano in due connector (`telegram:<chatId>`, `discord:<channelId>`) che due
   * porte diverse non possono mai far coincidere.
   *
   * `owner` **senza connector** è il punto: è l'unica stringa che due porte
   * diverse possono produrre, ed è ciò che rende ADR-0045 §1 vero in pratica
   * («CLI, chat, voce e device sono porte; nessuna può possedere una persona,
   * una memoria o una policy separata»).
   *
   * Il ramo `member` produce **la stringa che i connector già usavano**,
   * quindi per i gruppi non cambia niente — nemmeno il nome del file. E la
   * separazione dei gruppi smette di essere una condizione da ricordare una
   * volta per connector: un `member` non produce mai `owner`, e l'owner che
   * parla *dentro* un gruppo è un `member` di quel tenant. È una conseguenza
   * della funzione, ed è la ragione per cui la chiave sta qui e non in un
   * helper esportato accanto, che un connector potrebbe non chiamare.
   *
   * Cosa **non** è: un indirizzo di consegna. `replyTo.channel` e
   * `replyChannel` restano `telegram:<chatId>` pienamente qualificati, ed è la
   * loro separazione da questa chiave che impedisce a una risposta di uscire
   * dalla porta sbagliata.
   *
   * Vedi ADR-0056 e `docs/evidence/continuita-e-provenienza-2026-09-03.md` §8.
   */
  sessionKey: string;
};

/**
 * La chiave di conversazione dell'owner, per i chiamanti che sono owner **per
 * costruzione** e quindi non passano da `identify`: il REPL, che parla su un
 * terminale già autenticato dal fatto di girare sulla macchina dell'owner
 * (`cli/repl.ts` passa già `tenant: 'host'`).
 *
 * Esportata come costante e non come funzione: non c'è niente da decidere, e
 * una funzione inviterebbe un connector a chiamarla invece di `identify`.
 */
export const OWNER_SESSION_KEY = 'owner';

/**
 * What a surface must know about an incoming message to answer "who is this".
 *
 * Every field is something the transport reports about the *account*, never
 * something the sender types. That is the whole contract: `authorId` is a
 * Telegram user id or a Discord snowflake, and there is deliberately no field
 * for a display name, a nickname or a handle — so `identify` cannot be given
 * one by a future caller who thinks it would be convenient.
 */
export type IncomingIdentity = {
  readonly connector: ConnectorId;
  /**
   * The sender's account id, as the platform reports it.
   *
   * Owner recognition compares **only** this. Owner directive, verbatim:
   * *«Le persone dobbiamo riconoscerle SEMPRE per uid o cose così, in modo che
   * non si possano fingere l'owner»*. On Discord a display name, a server
   * nickname and a global name are all chosen by whoever holds the account and
   * changed in seconds; the snowflake is not. On Telegram the same is true of
   * `first_name`.
   *
   * An empty string means the platform did not say — a Telegram channel post,
   * a Discord webhook — and an unknown sender is never the owner.
   */
  readonly authorId: string;
  /** The room. A chat id, a channel id. Never used to decide who is speaking. */
  readonly conversationId: string;
  /**
   * La sotto-conversazione dentro la stanza, quando la piattaforma ne ha una:
   * un topic di un forum Telegram, e domani un thread Discord.
   *
   * **Non è un tenant.** Un topic non ha una lista membri sua, non ha permessi
   * suoi e non ha un amministratore suo: chi entra nel gruppo li vede tutti.
   * Trattarlo come tenant moltiplicherebbe i confini di sicurezza per il
   * numero di topic e darebbe a chiunque apra un topic il potere di creare un
   * inquilino nuovo. Quindi entra **solo** in `sessionKey`, che decide *quale
   * conversazione si continua*, e non tocca `tenant`, che decide *cosa si
   * può fare*.
   *
   * Il difetto che l'ha portato dentro: in un forum due topic diversi
   * producevano la stessa `sessionKey`, cioè una memoria sola. Muffin
   * rispondeva in «Bug» con il contesto di «Spesa».
   *
   * `undefined` quando la piattaforma non ne parla — il caso normale.
   */
  readonly threadId?: string | undefined;
  /**
   * Is this a one-to-one conversation with the bot?
   *
   * Load-bearing for the *tenant*, not only for politeness: the owner speaking
   * in a group is a member of that group's tenant, or group content lands in
   * host memory. `connectors/telegram/impersonation.test.ts` has held that line
   * since the day the check compared the room instead of the person.
   */
  readonly direct: boolean;
};

/**
 * The identity rule, written once for every surface there will ever be.
 *
 * This function is the answer to "is the surface abstraction a generalisation or
 * Telegram with the serial numbers filed off". It was extracted from
 * `connectors/telegram/connector.ts`'s `principalFor` and `parseUpdate`, and
 * Telegram now calls it rather than keeping a copy — so a second implementation
 * cannot drift from the first, and a third cannot invent a third answer.
 *
 * Three refusals, each of which was a real bug somewhere:
 *
 *  1. **The room is not the person.** Telegram compared `message.chat.id` — in a
 *     private chat the chat id and the user id coincide, and that accident was
 *     carrying the entire owner check. Anyone speaking in a chat whose id
 *     matched arrived as the owner.
 *  2. **Unpaired means nobody is the owner**, not "the default one". `ownerId`
 *     absent is fail-closed, which is what replaced "whoever messaged first" —
 *     a bot's username is discoverable, so that was a race, not an election.
 *  3. **An anonymous sender is not the owner.** An empty `authorId` never
 *     equals a configured id, and the comparison is `===` on strings, so no
 *     numeric coercion can make `0` and `''` meet in the middle.
 */
export function identify(incoming: IncomingIdentity, ownerId: string | undefined): SurfaceIdentity {
  const isOwner =
    ownerId !== undefined &&
    ownerId !== '' &&
    incoming.direct &&
    incoming.authorId !== '' &&
    incoming.authorId === ownerId;

  if (isOwner) {
    return {
      principal: { kind: 'owner', connector: incoming.connector, externalId: incoming.authorId },
      tenant: 'host',
      // Senza connector, e questa è l'unica riga del file che due porte
      // diverse possono far coincidere. Vedi `SurfaceIdentity.sessionKey`.
      sessionKey: OWNER_SESSION_KEY,
    };
  }

  const tenant = `group:${incoming.connector}:${incoming.conversationId}`;
  return {
    principal: {
      kind: 'member',
      connector: incoming.connector,
      tenantId: tenant,
      externalId: incoming.authorId === '' ? incoming.conversationId : incoming.authorId,
    },
    tenant,
    // Invariata quando non c'è un topic: è la stringa che i connector
    // scrivevano a mano, quindi la fusione non tocca nemmeno il nome del file
    // di un gruppo normale. Il suffisso `#<threadId>` arriva solo dove la
    // piattaforma dichiara una sotto-conversazione, e allora *deve* arrivare:
    // due topic sono due discorsi, e senza suffisso condividevano memoria.
    sessionKey:
      incoming.threadId === undefined || incoming.threadId === ''
        ? `${incoming.connector}:${incoming.conversationId}`
        : `${incoming.connector}:${incoming.conversationId}#${incoming.threadId}`,
  };
}

/**
 * The trust tier of what this principal says, for the vault and the episode log.
 *
 * One function rather than `principal.kind === 'member' ? 2 : 0` written at each
 * ingest site — it was already written twice (`agent/loop.ts`,
 * `connectors/telegram/connector.ts`) before there was a second surface to write
 * it a third time. Tier 2 is "gruppo/sconosciuti" in the threat model §2, and it
 * is where a public Discord channel belongs for the same reason a Telegram group
 * does: the sender is not the owner and the content is not evidence about them.
 */
export function tierOf(principal: Principal): 0 | 2 {
  return principal.kind === 'member' ? 2 : 0;
}
