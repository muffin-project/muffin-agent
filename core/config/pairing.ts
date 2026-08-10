import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256 } from '../rot/verify.js';

/**
 * Proving you are the owner, once, from the machine you already control.
 *
 * The problem this replaces: the owner was whoever messaged the bot first. Not
 * an exotic attack — you just had to arrive before the owner did, and the bot's
 * username is discoverable.
 *
 * The shape is device pairing, which is what every comparable system uses for
 * exactly this bind: Signal linking a device, `gh auth login`'s one-time code,
 * Matrix verification. The CLI is already the trust root — you need a shell on
 * the machine to run it — so a code generated there and echoed to the bot binds
 * "whoever holds the machine" to "whoever holds that Telegram account". Nothing
 * else in the system can make that link.
 *
 * Four properties, each closing a way this pattern goes wrong when done
 * casually:
 *
 *  - **Single use.** Consumed on the first match. A code that stays valid is a
 *    second owner credential sitting in a terminal scrollback.
 *  - **Short lived.** Ten minutes. Long enough to switch to a phone, short
 *    enough that an abandoned pairing is not a standing invitation.
 *  - **Attempt capped.** Five wrong guesses burn it. The entropy below makes
 *    brute force hopeless anyway, but a cap turns "hopeless" into "visibly
 *    over" rather than an unbounded oracle.
 *  - **Stored hashed.** The plaintext exists only in the terminal that printed
 *    it. This is the one secret in the system deliberately shown to a human, so
 *    the file gets the digest and nothing else.
 *
 * What it does NOT defend against, said plainly: someone reading the code over
 * your shoulder, or off your screen, inside the ten minutes. That is the same
 * exposure every pairing code has, and it is why the window is short.
 *
 * **Caller deferred, and declared rather than forgotten.** Nothing calls this
 * yet. Wiring it is three edits in one slice — `config.ts` makes `ownerChatId`
 * optional and adds `ownerUserId` plus the pending `pairing`; `cli/surface.ts`
 * prints a code instead of electing the first private chat it has seen; the
 * connector, while unpaired, tests each private message against the pending
 * code and on a match binds `from.id` and clears it.
 *
 * It is committed unwired on purpose and with this paragraph attached, because
 * this repository's characteristic defect is a mechanism that is written,
 * tested and reached by nothing — and the only version of that which is
 * acceptable is the one that says so out loud. Until the wiring lands, the hole
 * it closes is still open: `cli/surface.ts` still elects the first private chat
 * it sees, which is exactly the thing this exists to replace.
 */

/** Ten minutes: long enough to reach for a phone, short enough not to linger. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Wrong guesses before the code is burned rather than merely expiring. */
export const PAIRING_MAX_ATTEMPTS = 5;

/**
 * Crockford-ish: no I, L, O, U. A code is read off a screen and typed on a
 * phone, so the characters that get misread are removed rather than explained.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

export type PendingPairing = {
  /** sha256 of the code. The code itself is never written down. */
  hash: string;
  expiresAt: string;
  attempts: number;
};

/** ~40 bits over an unambiguous alphabet, drawn from the CSPRNG. */
export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i]! % ALPHABET.length];
  // Grouped for reading aloud and typing: MUFF-IN42, not MUFFIN42.
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function startPairing(code: string, now: Date): PendingPairing {
  return {
    hash: sha256(normalise(code)),
    expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
    attempts: 0,
  };
}

export type PairingOutcome =
  | { status: 'matched' }
  | { status: 'wrong'; remaining: number }
  | { status: 'expired' }
  | { status: 'burned' };

/**
 * Checks one candidate against the pending pairing.
 *
 * Pure and total: it returns the next state rather than mutating, so the caller
 * decides what to persist and a failed write cannot leave a half-consumed code.
 */
export function checkPairing(
  pending: PendingPairing,
  candidate: string,
  now: Date,
): { outcome: PairingOutcome; next: PendingPairing | null } {
  if (pending.attempts >= PAIRING_MAX_ATTEMPTS) return { outcome: { status: 'burned' }, next: null };
  if (new Date(pending.expiresAt).getTime() <= now.getTime()) {
    return { outcome: { status: 'expired' }, next: null };
  }

  if (constantTimeEquals(sha256(normalise(candidate)), pending.hash)) {
    // Consumed: `next: null` is the whole single-use guarantee, and it is the
    // caller's job to persist that before acting on the match.
    return { outcome: { status: 'matched' }, next: null };
  }

  const attempts = pending.attempts + 1;
  const remaining = PAIRING_MAX_ATTEMPTS - attempts;
  if (remaining <= 0) return { outcome: { status: 'burned' }, next: null };
  return { outcome: { status: 'wrong', remaining }, next: { ...pending, attempts } };
}

/** Case and separators are presentation; a phone keyboard adds spaces. */
function normalise(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Both sides are hex digests of fixed length, so a length mismatch means a
 * malformed store rather than a guess — and comparing anyway would throw.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
