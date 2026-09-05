import { checkPairing, type PendingPairing } from '../../../core/config/pairing.js';

/**
 * Slice 12 of the ingress decomposition
 * (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` §1.2 row 3, §3 row
 * 12): the pairing gate, written identically twice —
 * `connectors/telegram/connector.ts`'s pre-slice `tryPair` and
 * `connectors/discord/connector.ts`'s `tryPair`, "stesso algoritmo" per the
 * design doc. `checkPairing` itself (`core/config/pairing.ts`) was already
 * shared; what was duplicated is the *orchestration* around it — the same
 * guard clauses, the same three-way branch on a `PairingOutcome`, and the
 * same three owner-facing sentences — copied into two connectors that differ
 * only in the type of an id (a numeric Telegram user id vs. a Discord
 * snowflake string) and in one extra field Telegram alone persists on a
 * match (`ownerChatId`).
 *
 * Generic over `TId` so neither this module nor its callers cast: whichever
 * id type a port uses flows through unchanged, and this module never
 * compares it to anything or parses it — deleting either connector's own
 * copy and pointing it at this one is the cheapest proof the shared path is
 * real (§3 row 12: "cancellare una delle due copie è la prova più economica
 * che il cammino è reale").
 */

/** What the caller already knows about one inbound message, before pairing decides anything about it. */
export type PairingCandidate<TId> = {
  readonly fromId: TId;
  readonly text: string;
  /**
   * Whether this message is even eligible to be a pairing attempt, decided
   * by the caller because the rule is platform-shaped: Telegram requires a
   * private chat and a real sender (`isPrivate && fromId !== 0`); Discord
   * requires only a real sender, since every message this connector accepts
   * is already a DM by construction (`parseMessage`). Folding either rule in
   * here would put a platform's own shape back inside a module the "no
   * platform name" invariant (§4.11) forbids naming one in.
   */
  readonly eligible: boolean;
};

/** What pairing already knows before looking at one candidate — read here, never written. */
export type PairingState<TId> = {
  readonly ownerUserId: TId | undefined;
  readonly pairing: PendingPairing | undefined;
  /** `false` when the connector was not given a way to persist a pairing outcome — pairing is disabled, the safe direction. */
  readonly canPersist: boolean;
};

/**
 * The two writes and the one reply a caller performs on the gate's decision —
 * supplied by the caller because every one of them differs per platform: the
 * persisted shape (Telegram also stores `ownerChatId`), the config fields
 * that get updated, and the channel a reply goes to.
 */
export type PairingActions<TId> = {
  /** Persist the match and update in-memory config; called before the reply is sent (see `tryPair`'s own comment on why). */
  readonly onMatched: (fromId: TId) => void;
  /** Persist an attempt's outcome — `next` is `checkPairing`'s own next state, `null` once burned. */
  readonly onAttempt: (next: PendingPairing | null) => void;
  readonly say: (text: string) => Promise<unknown> | void;
};

/** Only a candidate matching this shape burns an attempt — a stranger saying "ciao" must not spend the owner's tries. */
const LOOKS_LIKE_A_CODE = /^[\s0-9A-Za-z-]{8,12}$/;

/**
 * Runs the pairing gate for one inbound message.
 *
 * Returns `true` when the message was consumed by pairing — matched or
 * not — so the caller's drain loop stops rather than handing a code to the
 * model; `false` means this message was never a pairing attempt and the
 * caller should treat it as ordinary conversation.
 *
 * The three owner-facing sentences are copied verbatim from the two
 * pre-slice `tryPair` methods: §4 invariant 9 (byte-identical text visible to
 * the owner) applies to a shared implementation exactly as it did to two
 * separate ones.
 */
export async function tryPair<TId>(
  state: PairingState<TId>,
  candidate: PairingCandidate<TId>,
  actions: PairingActions<TId>,
  now: Date,
): Promise<boolean> {
  if (state.ownerUserId !== undefined || !state.pairing || !state.canPersist) return false;
  if (!candidate.eligible) return false;

  const { outcome, next } = checkPairing(state.pairing, candidate.text, now);

  if (outcome.status === 'matched') {
    // Persisted before the reply: if the send fails, the pairing still
    // happened, and the alternative — confirming something that was never
    // stored — is the worse of the two.
    actions.onMatched(candidate.fromId);
    await actions.say('Sei tu. Da adesso questa è la nostra chat.');
    return true;
  }

  if (!LOOKS_LIKE_A_CODE.test(candidate.text.trim())) return false;

  actions.onAttempt(next);
  if (outcome.status === 'wrong') await actions.say(`Non è quello. Tentativi rimasti: ${outcome.remaining}.`);
  else await actions.say('Quel codice non vale più. Rigenerane uno dalla CLI.');
  return true;
}
