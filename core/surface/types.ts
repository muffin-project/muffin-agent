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
 * the shape of the returned value (`research/tipi-contro-successo-falso.md`
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
export type SurfaceLimits = {
  /** Longest single message, in characters of the final rendered text. */
  readonly maxMessageChars: number;
  /** Largest attachment this surface will accept from us, in bytes. */
  readonly maxUploadBytes: number;
  /** Largest attachment we can pull *from* it, in bytes. */
  readonly maxDownloadBytes: number;
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
   * Send a file to a channel this surface `handles` — M5-BIS B14, "un file
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

/**
 * A surface that also *listens*. Separate from `Surface` because delivery and
 * reception have different lifetimes: the scheduler holds a `Surface` for as
 * long as a job takes, while a connector's `run` owns a socket for the life of
 * the process. A surface that only speaks (an outbound webhook, say) is a
 * legitimate `Surface` and would have nothing to put in `run`.
 */
export interface ListeningSurface extends Surface {
  /** Receives until stopped or aborted. Rejects only on a fault worth reporting. */
  run(signal?: AbortSignal): Promise<void>;
  stop(): void;
}

/** Who is speaking and whose memory this belongs to. */
export type SurfaceIdentity = { principal: Principal; tenant: TenantId };

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
