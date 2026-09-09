import type { MemoryStore } from '../../../core/memory/store.js';
import { memoryWriteCapability } from '../../../core/policy/doors.js';
import type { Decide, Principal, TenantId, TrustTier } from '../../../core/policy/types.js';

/**
 * Slice 12 of the ingress decomposition
 * (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` §1.2 row 5, §3 row
 * 12): ADR-0063's own named follow-up, "il ricordare senza rispondere che
 * resta il seguito aperto", generalised from
 * `connectors/telegram/connector.ts`'s pre-slice `ricordaSenzaRispondere`
 * (the gated-out branch of `drain()` reached when `apreUnTurno` says a group
 * message does not open a turn). Discord has no caller for this yet — its
 * `parseMessage` accepts only DMs, so there is no gated-out branch to feed it
 * from (§2.5) — but the write itself has nothing Telegram-specific left in
 * it once the content and the trust tier are already computed, so it moves
 * here rather than waiting for a second caller to justify the move.
 *
 * The one thing this module is not allowed to make easier to get wrong: the
 * kernel door. `agent/loop.ts`'s `runTurn` asks `memoryDoorOpen()`
 * (`memoryWriteCapability`) before writing a turn's own episode; this path
 * never runs a turn, so it has to ask the same question itself, in the same
 * place, before the same kind of write — bypassing it for this one road
 * would be exactly "un divieto non regge il cablaggio": two doors for the
 * same effect, one of which ignores the kernel.
 */

/** What the caller already knows about one message before this module decides whether to remember it. */
export type RememberableMessage = {
  /** `identify()`'s own output for this event — never recomputed here. */
  readonly principal: Principal;
  readonly tenant: TenantId;
  /** The session this episode belongs to — `identify()`'s `sessionKey`, not a turn id: this write never has one. */
  readonly threadKey: string;
  /**
   * The message's own text, already resolved by the caller from whichever
   * field carries it on that platform (Telegram: `text`, then `caption`,
   * then a forward's own content) — never an attachment's bytes. A caller
   * reaches this module only for a message `apreUnTurno` (or its
   * platform's equivalent) already excluded from ever carrying one.
   */
  readonly content: string;
  /**
   * `maxTier(tierOf(principal), contentTaintOf(...))` — the same combination
   * a real turn applies (`runFresh`): who wrote it sets the floor, and a
   * forward or a quote from someone else can only raise it, never lower it
   * below what the sender's own tier already requires.
   */
  readonly trustTier: TrustTier;
  readonly createdAt: string;
};

export type RememberDeps = {
  /** Absent means no memory is wired for this installation — the same silent degradation `agent/loop.ts` accepts for `deps.memory` elsewhere. */
  readonly memory: { readonly store: Pick<MemoryStore, 'addEpisode'> } | undefined;
  readonly decide: Decide;
};

export type RememberOutcome =
  /** No memory wired, no content to write, or the kernel refused the door — every one of these is silent by design, matching the pre-slice branch. */
  | { readonly kind: 'skipped' }
  | { readonly kind: 'written' }
  /** The write itself threw — a constraint, a full disk. Caller decides how to log it; this module never lets it escape. */
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Writes one message into memory without ever running a turn for it, asking
 * the kernel's `memory.write` door first and refusing silently if it says no.
 *
 * `connector` is a platform id supplied by the caller as plain data for the
 * episode row (`episodes.connector`) — the same string `EpisodeInput` already
 * takes from every other call site — not an identifier or a branch in this
 * module's own control flow, so it does not trip the "no platform name" rule
 * (§4 invariant 11).
 *
 * Isolated in its own `try`, deliberately: the pre-slice comment on this call
 * (telegram, pre-slice) explains why — this runs inside a connector's drain
 * loop and outside every other `try`, so a SQLite error here (a constraint, a
 * full disk) must never propagate and stop every other message that
 * connector is draining. A side effect that costs nothing when it works must
 * not be allowed to cost the whole surface when it does not.
 */
export function rememberWithoutReplying(
  deps: RememberDeps,
  connector: string,
  message: RememberableMessage,
): RememberOutcome {
  if (!deps.memory) return { kind: 'skipped' };
  if (message.content === '') return { kind: 'skipped' };

  // The kernel before the write, not after — the same question `runTurn`
  // asks (`memoryDoorOpen`), mimicked here because this path never goes
  // through `runTurn`: no turn exists to ask it of.
  const decision = deps.decide({
    principal: message.principal,
    tenant: message.tenant,
    capability: memoryWriteCapability.id,
    resource: { kind: 'tenant', value: message.tenant },
    args: {},
    taint: message.trustTier,
  });
  if (decision.effect !== 'allow') return { kind: 'skipped' };

  try {
    deps.memory.store.addEpisode({
      tenantId: message.tenant,
      connector,
      threadKey: message.threadKey,
      role: 'user',
      kind: 'message',
      content: message.content,
      trustTier: message.trustTier,
      // Not `actorId`: `episodes.actor_id` is a foreign key into
      // `identities.id` — a row of the *graph*, resolved by whoever links a
      // platform id to an identity (extraction/consolidation), never the raw
      // id a platform hands over. No other production write site sets it for
      // the same reason, and it is unreachable here regardless: a group
      // tenant is never extracted (`CONSOLIDATION_TENANT`), so an
      // `identities` row for this sender will never exist. Passing the raw
      // id fails the constraint — measured: `SqliteError: FOREIGN KEY
      // constraint failed`.
      createdAt: message.createdAt,
    });
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'written' };
}
