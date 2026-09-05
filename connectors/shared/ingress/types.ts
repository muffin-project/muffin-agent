import type { TrustTier } from '../../../core/policy/types.js';
import type { IncomingIdentity, Surface } from '../../../core/surface/types.js';

/**
 * Slice 10 of the ingress decomposition (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md`
 * §2.1-§2.3, §3 row 10). Additive only: nothing under `connectors/telegram/` or
 * `connectors/discord/` constructs one of these yet. That arrives with §3 rows
 * 11-15, one stage at a time.
 *
 * ## Why this lives here and not in `core/ingress/`
 *
 * `docs/VISION.md` §"Core narrow" names "new messaging platforms" as exactly
 * what does not belong in the core, and `docs/EXTENSIONS.md`:73 classes a
 * *connector* as an extension contract. A shared module deduplicating two
 * connectors is prior art already, not a new decision:
 * `connectors/shared/stop-budget.ts` is the same move for one mechanism
 * instead of ten. `core/surface/types.ts` is imported from here — identity and
 * capability are already core subjects — but nothing here is imported back
 * into `core/` (§4 invariant 11, asserted mechanically in this module's own
 * `types.test.ts`, describe block "direction and vocabulary").
 *
 * ## Why `IngressPort` has no capability record of its own
 *
 * The design's first draft gave `IngressPort` its own `limits`/`streaming`,
 * mirroring `Surface`. `connectors/discord/surface.ts`:54-56 already names the
 * defect that shape produces for `DISCORD_MAX` — "two literals that agreed
 * today and had no reason to keep agreeing tomorrow" — and a second capability
 * record would be exactly that, doubled across every port instead of once.
 * `IngressPort` therefore *contains* its `Surface` and reads `limits` and
 * `streaming` from it; `ingress` below only declares what `Surface` has no
 * opinion about, because streaming a delivery and progressively rewriting one
 * are surface concerns, while accepting a slash-command or a button press on
 * the way in is not.
 */

/**
 * Where one part of an inbound message's content actually came from — the
 * generalisation of `connectors/telegram/connector.ts`'s `contentTaintOf`
 * (:597), which only had one axis (forwarded or not) because Telegram was the
 * only port. Per-*part*, not per-event, for the same reason `composeTurnText`
 * (telegram :623) fences a caption separately from a forwarded block: a
 * message can carry the sender's own words *and* someone else's in the same
 * event, and folding them into one taint would either recolour the sender's
 * own line or launder the other person's.
 *
 * - `'author'` — typed here, by the person this event's `identity` names.
 * - `'forwarded'` — relayed from elsewhere; the sender chose to bring it into
 *   this chat but did not write it (telegram `forwarded`, ADR-0046 §2).
 * - `'quoted'` — a reply/quote of an earlier message by *someone else*.
 *   `chi-scrive`'s own earlier words and Muffin's own earlier words are not
 *   this — they are already covered by `'author'`/`'derived'` respectively.
 * - `'caption'` — text attached to an attachment, kept apart from the
 *   sender's main line the same way telegram's `caption` field is.
 * - `'catalog'` — text chosen by whoever populated a lookup the sender only
 *   *picked from* — a location's venue name and address (telegram
 *   `posizione.luogo`), never typed by the sender themselves.
 * - `'filename'` — the name attached to a file, chosen by whoever created or
 *   sent it, never by the recipient.
 * - `'derived'` — computed from the sender's own input rather than quoting
 *   anyone — a voice note's transcription. Not `'author'`: the words on the
 *   wire were never typed, they were produced by a model reading audio, and a
 *   transcription error is not something the sender said.
 */
export type IngressPartSource =
  | 'author'
  | 'forwarded'
  | 'quoted'
  | 'caption'
  | 'catalog'
  | 'filename'
  | 'derived';

/**
 * A file attached to an inbound message, named generically enough that
 * neither field needs a platform's own vocabulary.
 *
 * `kind` reuses the alphabet `connectors/telegram/media.ts`'s `MediaSpec`
 * already settled on (photo/document/audio/voice/video) plus `'other'` for a
 * port that cannot classify further — it was already platform-neutral there,
 * so widening it instead of inventing a second one keeps one vocabulary
 * instead of two that could drift.
 */
export type AttachmentRef = {
  readonly kind: 'photo' | 'document' | 'audio' | 'voice' | 'video' | 'other';
  /** What the sender named it. Recorded as data a fence can carry — never resolved into a path here. */
  readonly filename: string;
  readonly bytes: number;
  /**
   * What the port's own client needs to fetch the bytes: a directly usable
   * URL when the platform hands one (a Discord attachment's signed URL), or
   * an opaque id the port resolves through its own API (a Telegram
   * `file_id`). Whichever it is, nothing outside the port that produced this
   * event ever reads it — the same division `FileSpec.absolutePath`
   * (`core/surface/types.ts`) draws for the outbound side.
   */
  readonly ref: string;
};

/**
 * One fragment of an inbound message's content, carrying its own provenance
 * and its own taint — the two things `composeTurnText` (telegram :623-687)
 * currently fences by hand, part by part, inside one connector.
 *
 * `tier` is not derived from `source` by a lookup table baked into this
 * type — a port decides it (mirroring `contentTaintOf`'s own reasoning: a
 * quote of the sender's *own* earlier words is not a foreign taint the way a
 * quote of someone else's is, even though both are `source: 'quoted'` at the
 * connector boundary before that distinction is applied). Fixing the mapping
 * here would take that judgment away from the one place that has the
 * platform's own detail to make it.
 */
export type IngressPart = {
  readonly source: IngressPartSource;
  readonly tier: TrustTier;
  /** `''` for an attachment-only part (a bare forwarded photo, a location with no venue name). */
  readonly text: string;
  readonly attachment?: AttachmentRef;
};

/**
 * The content taint of a whole event: the generalisation of `contentTaintOf`
 * (`connectors/telegram/connector.ts`:597), `max` over every part instead of
 * a single forwarded/not-forwarded bit. `identity`'s own tier
 * (`tierOf`, `core/surface/types.ts`) is combined with this by the caller
 * (telegram's own `maxTier(tierOf(principal), contentTaintOf(incoming))`,
 * :1613) — this function never sees `identity`, on the same principle
 * `contentTaintOf`'s docstring states: content taint changes what a turn may
 * do, never who the turn is (ADR-0046 §1).
 *
 * `0` for no parts at all, the honest floor — an event with nothing to say
 * about its own content contributes nothing on top of the sender's tier.
 */
export function contentTierOf(parts: readonly IngressPart[]): TrustTier {
  let max: TrustTier = 0;
  for (const part of parts) {
    if (part.tier > max) max = part.tier;
  }
  return max;
}

/**
 * Where a reply goes, and what it answers — kept apart from `Addressing`
 * below, which says whether the bot was *addressed at all*, not where to
 * send the answer.
 */
export type InboundAddress = {
  /** Fully qualified, same shape `Surface.deliver`/`Surface.handles` already take — `telegram:<chatId>`, `discord:<channelId>`. */
  readonly channel: string;
  /** The wire id of the message this one answers, when the port can quote/reply to it. `undefined` when there is nothing to point back at. */
  readonly replyTo?: string;
};

/**
 * Was this message addressed to Muffin at all, and how — the three signals
 * `apreUnTurno` (telegram :329-358) already reads to decide whether a group
 * message opens a turn: a command naming the bot's own username
 * (`/x@nomebot`), a reply to a message the bot itself sent, and an `@mention`
 * naming it another way. `direct` short-circuits all three: a private
 * conversation needs no addressing signal because there is nothing else the
 * message could be for.
 *
 * Computed by the port, not by this module (§2.5: `apreUnTurno` itself is not
 * moving — Discord has no branch to test it against yet, since every message
 * it accepts already arrives `direct: true` by construction, `parseMessage`
 * :155-156). This type only names the shape the port's computation produces,
 * so a router stage can read it without knowing which platform's rule ran.
 */
export type Addressing = {
  readonly direct: boolean;
  readonly mentionsBot: boolean;
  readonly repliesToBot: boolean;
};

/**
 * What an ingress port can do on the way *in*, declared rather than
 * discovered — same reasoning `Surface.limits`/`Surface.streaming` already
 * give for the way out. Read by router stages (§3 row 14) to decide whether a
 * stage applies at all: a port with `commands: false` never reaches the
 * command stage, the same way `parseMessage` today makes a slash command on
 * Discord just more DM text rather than a mis-dispatched interception.
 *
 * `edit` is the one field this module cross-checks against `Surface` itself
 * — see `makeIngressPort` below — because it names the same fact
 * `StreamingCapability.transport` already does (can this port progressively
 * rewrite a message it already sent), and §2.3 is explicit that the two must
 * never be free to disagree.
 */
export type IngressCapabilities = {
  /** The `/model`, `/think`, `/stop`-family slash commands (`agent/comandi.ts`). */
  readonly commands: boolean;
  /** Inline buttons — approvals today, telegram `handleCallback` :2139. */
  readonly buttons: boolean;
  /** Can progressively rewrite a message already sent. Must agree with `surface.streaming.transport !== 'off'` — see `makeIngressPort`. */
  readonly edit: boolean;
  /** Can show a "sta scrivendo…" presence indicator. */
  readonly typing: boolean;
  /** Can receive an attachment from the sender. */
  readonly upload: boolean;
};

/**
 * A place Muffin can be *reached from* — the ingress twin `core/surface/
 * registry.ts`'s `deliver`/`deliverFile` never got (§1 "Il registro ha
 * unificato solo l'uscita").
 *
 * Contains its `Surface` rather than standing beside it, so `port.surface.id`
 * is the one place a caller reads "which platform", `port.surface.limits` is
 * the one place it reads a message-length budget, and there is no second
 * literal anywhere for either. `ingress` adds exactly the handful of
 * inbound-only facts `Surface` has no field for.
 */
export type IngressPort = {
  readonly surface: Surface;
  readonly ingress: IngressCapabilities;
};

/**
 * Constructs an `IngressPort`, refusing one whose declarations contradict
 * each other. `docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` §2.3: "Un test
 * rende rosso il disaccordo fra `port.ingress.edit` e
 * `surface.streaming.transport`" — a ban on writing the disagreement (a grep
 * a future edit could route around) is weaker than refusing to construct the
 * disagreeing value in the first place, so the check lives here rather than
 * only in a test that asserts fixtures were built correctly.
 */
export function makeIngressPort(surface: Surface, ingress: IngressCapabilities): IngressPort {
  const canEdit = surface.streaming.transport !== 'off';
  if (ingress.edit !== canEdit) {
    throw new Error(
      `ingress port "${surface.id}": ingress.edit=${ingress.edit} disagrees with surface.streaming.transport=${surface.streaming.transport}`,
    );
  }
  return { surface, ingress };
}

/**
 * One message, from any port, in the shape every router stage (§2.4
 * `INGRESS_STAGES`) reads. `identity` is exactly `IncomingIdentity`
 * (`core/surface/types.ts`:236), passed through unchanged rather than
 * re-shaped — the same value goes on to `identify()` and `tierOf()`, so a
 * second copy here could never legitimately say something different from the
 * one those functions see.
 *
 * `eventId` is the native-event idempotency key (telegram `update_id`,
 * `updates.ts`:36; discord `message_id`, `inbox.ts`:29) — the row that must
 * exist exactly once regardless of retries. `compositionId` is the
 * higher-level grouping a port may assemble several events into before one
 * Work is created (`telegram_compositions`, `updates.ts`:52) — for a port
 * that never composes, it is the same string as `eventId`.
 */
export type InboundEvent = {
  readonly port: IngressPort;
  readonly eventId: string;
  readonly compositionId: string;
  readonly identity: IncomingIdentity;
  readonly address: InboundAddress;
  readonly addressing: Addressing;
  readonly parts: readonly IngressPart[];
  readonly receivedAt: Date;
};
