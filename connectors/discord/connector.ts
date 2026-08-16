import { runTurn, type LoopDeps } from '../../agent/loop.js';
import { checkPairing, type PendingPairing } from '../../core/config/pairing.js';
import type { SessionStore } from '../../core/session/store.js';
import type { TrustTier } from '../../core/policy/types.js';
import { identify, tierOf, type SurfaceIdentity } from '../../core/surface/types.js';
import { DiscordApi, DiscordError } from './api.js';
import { DiscordGateway } from './gateway.js';
import { DiscordInbox } from './inbox.js';
import { downloadToVault } from './media.js';
import { startPresence } from './presence.js';
import { renderForDiscord } from './render.js';
import type { DiscordAttachment, DiscordMessage } from './api.js';

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
  config: DiscordConfig;
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

export class DiscordConnector {
  private gateway: DiscordGateway | null = null;
  /** D2 guard — see `drain()`. */
  private draining = false;
  private redrainRequested = false;

  constructor(private readonly deps: ConnectorDeps) {}

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
    const me = await this.deps.api.me();
    log(`discord: connesso come @${me.username} (${me.id})`);

    // Anything left pending from a previous life comes first, before new work.
    await this.drain();

    this.gateway = new DiscordGateway({
      token: this.deps.config.token,
      intents: 1 << 12, // DIRECT_MESSAGES only
      gatewayUrl: async () => {
        const { url } = await this.deps.api.gatewayUrl();
        return url;
      },
      onDispatch: (event, data) => {
        if (event !== 'MESSAGE_CREATE') return;
        const raw = data as DiscordMessage;
        const stored = this.deps.inbox.accept(raw.id, raw, this.now());
        // A duplicate (RESUMED replay, or a rare Discord-side redelivery) is
        // silently absorbed by the inbox's primary key; only a genuinely new
        // arrival triggers a drain, so a busy resume does not re-walk the
        // whole pending set once per event.
        if (stored) void this.drain();
      },
      onLog: (line) => log(line),
    });

    await this.gateway.run(signal);
  }

  stop(): void {
    this.gateway?.stop();
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
  private async drain(): Promise<void> {
    if (this.draining) {
      this.redrainRequested = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.redrainRequested = false;
        await this.drainOnce();
      } while (this.redrainRequested);
    } finally {
      this.draining = false;
    }
  }

  /** One pass over whatever `inbox.pending()` returns right now. */
  private async drainOnce(): Promise<void> {
    for (const stored of this.deps.inbox.pending()) {
      const raw = JSON.parse(stored.payload) as DiscordMessage;
      const incoming = parseMessage(raw);

      if (!incoming) {
        this.deps.inbox.markProcessed(stored.messageId, this.now());
        continue;
      }

      try {
        await this.handle(incoming);
        this.deps.inbox.markProcessed(stored.messageId, this.now());
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.inbox.markFailed(stored.messageId, reason);
        (this.deps.log ?? (() => {}))(`discord: messaggio ${stored.messageId} fallito — ${reason}`);
      }
    }
  }

  /**
   * The pairing gate — identical shape to `TelegramConnector.tryPair`, over a
   * snowflake string instead of a numeric user id.
   */
  private async tryPair(incoming: Incoming): Promise<boolean> {
    const { ownerUserId, pairing } = this.deps.config;
    if (ownerUserId !== undefined || !pairing || !this.deps.savePairing) return false;
    if (incoming.fromId === '') return false;

    const { outcome, next } = checkPairing(pairing, incoming.text, new Date(this.now()));
    const say = (text: string) => this.deps.api.sendMessage(incoming.channelId, text);

    if (outcome.status === 'matched') {
      this.deps.savePairing({ ownerUserId: incoming.fromId, pairing: null });
      this.deps.config.ownerUserId = incoming.fromId;
      this.deps.config.pairing = undefined;
      await say('Sei tu. Da adesso questa è la nostra chat.');
      return true;
    }

    if (!/^[\s0-9A-Za-z-]{8,12}$/.test(incoming.text.trim())) return false;

    this.deps.savePairing({ pairing: next });
    this.deps.config.pairing = next ?? undefined;
    if (outcome.status === 'wrong') await say(`Non è quello. Tentativi rimasti: ${outcome.remaining}.`);
    else await say('Quel codice non vale più. Rigenerane uno dalla CLI.');
    return true;
  }

  private async handle(incoming: Incoming): Promise<void> {
    if (await this.tryPair(incoming)) return;
    const { principal, tenant } = principalFor(incoming, this.deps.config.ownerUserId);
    const presence = startPresence(this.deps.api, incoming.channelId);

    try {
      const arrival = incoming.attachment ? await this.ingest(incoming, incoming.attachment, tenant, tierOf(principal)) : null;

      const result = await runTurn(this.deps.loop, {
        principal,
        tenant,
        surface: 'discord',
        session: this.deps.sessions.open(`discord:${incoming.channelId}`),
        text: arrival ? `${arrival}\n\n${incoming.text}`.trim() : incoming.text,
        replyTo: { channelId: incoming.channelId, messageId: incoming.messageId },
        replyChannel: `discord:${incoming.channelId}`,
      });

      try {
        const parts = renderForDiscord(result.text);
        for (const part of parts) {
          await this.deps.api.sendMessage(incoming.channelId, part);
        }
        this.recordDelivery(result.turnId, 'sent');
      } catch (error) {
        this.recordDelivery(result.turnId, `failed:${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    } finally {
      await presence.stop();
    }
  }

  private recordDelivery(turnId: string, delivery: 'sent' | `failed:${string}`): void {
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
  private async ingest(incoming: Incoming, attachment: DiscordAttachment, tenantId: string, tier: TrustTier): Promise<string> {
    if (!this.deps.vault) return `[allegato ricevuto ma il vault non è configurato: ${attachment.filename}]`;
    try {
      const saved = await downloadToVault(this.deps.api, this.deps.vault.root, attachment, incoming.messageId, this.now());
      const report = await this.deps.vault.reindexPath(tenantId, saved.vaultPath, tier);
      const skipped = report.skipped.find((s) => s.path === saved.vaultPath);
      if (skipped) {
        return `[ricevuto \`${saved.vaultPath}\` (${Math.round(saved.bytes / 1024)}KB) ma non indicizzato: ${skipped.why}]`;
      }
      const document = report.documents.find((d) => d.path === saved.vaultPath);
      if (document) return `[documento acquisito]\n${document.outline}`;
      return `[ricevuto e indicizzato: \`${saved.vaultPath}\`, ${Math.round(saved.bytes / 1024)}KB]`;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      (this.deps.log ?? (() => {}))(`discord: allegato non scaricato — ${why}`);
      return `[allegato NON ricevuto: ${why}. Dillo, non fingere di averlo.]`;
    }
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

export { DiscordError };
