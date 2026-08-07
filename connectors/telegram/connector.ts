import type { Message, Update } from '@grammyjs/types';
import { runTurn, type LoopDeps } from '../../agent/loop.js';
import type { Principal } from '../../core/policy/types.js';
import type { SessionStore } from '../../core/session/store.js';
import { TelegramApi, TelegramError } from './api.js';
import { startPresence } from './presence.js';
import { renderForTelegram } from './render.js';
import { UpdateInbox } from './updates.js';

/**
 * Telegram as an adapter over the one loop, not a second engine.
 *
 * The boundary is the point. The previous system's 2,900-line Telegram file was
 * not caused by its library: the diagnosis names the *absence of a typed
 * boundary* — a gateway that knew Telegram's message length limit and built
 * Telegram-shaped footers. So nothing above this file knows what Telegram is,
 * and nothing in this file knows what the agent decided. It receives text,
 * calls `runTurn`, and renders what comes back.
 *
 * Three properties it is responsible for, in order of how much they cost when
 * wrong:
 *
 *  1. **No message is lost.** Every batch is written to the inbox before the
 *     offset advances, because Telegram never redelivers a confirmed update.
 *  2. **Who is speaking decides the tenant**, and the kernel decides the rest.
 *     A private chat with the owner is `host`; a group is its own tenant; anyone
 *     who is not the owner is a `member` with the taint that comes with it.
 *  3. **Nothing is answered twice**, including across a restart.
 */

export type TelegramConfig = {
  token: string;
  /** The only chat that speaks as the owner. Everything else is a stranger. */
  ownerChatId: number;
};

export type ConnectorDeps = {
  loop: LoopDeps;
  sessions: SessionStore;
  inbox: UpdateInbox;
  api: TelegramApi;
  config: TelegramConfig;
  now?: () => Date;
  log?: (line: string) => void;
};

/** What one update turns into, or null when it is not ours to handle. */
type Incoming = {
  updateId: number;
  chatId: number;
  text: string;
  isPrivate: boolean;
  fromOwner: boolean;
  messageId: number;
};

/**
 * Reads an update defensively.
 *
 * The types say `message.chat.id` is always there. The types are generated from
 * a schema, not from what a live server does under an edge case, and this is the
 * one place where being wrong means a crash in a long-running process. So every
 * field is checked, and anything unrecognised is skipped rather than guessed at.
 */
export function parseUpdate(update: Update, ownerChatId: number): Incoming | null {
  const message: Message | undefined = update.message ?? update.edited_message;
  if (!message || typeof message.chat?.id !== 'number') return null;

  const text = message.text ?? message.caption;
  if (typeof text !== 'string' || text.trim() === '') return null;

  return {
    updateId: update.update_id,
    chatId: message.chat.id,
    text,
    isPrivate: message.chat.type === 'private',
    // Identity is the chat id, not the display name: a name is chosen by whoever
    // holds the account.
    fromOwner: message.chat.id === ownerChatId,
    messageId: message.message_id,
  };
}

/**
 * The tenant and the principal, from who is speaking.
 *
 * A group is a tenant of its own, so its memory is separate by construction
 * rather than by a filter someone has to remember. The owner in a private chat
 * is the host tenant. Someone else in a private chat is *not* the owner even
 * though the chat is private — that is the case a naive `isPrivate` check gets
 * wrong, and it is the one that matters.
 */
export function principalFor(incoming: Incoming): { principal: Principal; tenant: string } {
  if (incoming.fromOwner) {
    return { principal: { kind: 'owner', connector: 'telegram' }, tenant: 'host' };
  }
  const tenant = `group:telegram:${incoming.chatId}`;
  return {
    principal: {
      kind: 'member',
      connector: 'telegram',
      tenantId: tenant,
      externalId: String(incoming.chatId),
    },
    tenant,
  };
}

export class TelegramConnector {
  private running = false;

  constructor(private readonly deps: ConnectorDeps) {}

  /**
   * Polls until stopped.
   *
   * The order inside the loop is the load-bearing part: fetch, **store**,
   * confirm, then process. Processing after confirmation is safe because the
   * evidence is already on disk; processing before storing would lose it.
   */
  async run(signal?: AbortSignal): Promise<void> {
    const log = this.deps.log ?? (() => {});
    const me = await this.deps.api.getMe();
    log(`telegram: connesso come @${me.username ?? me.id}`);
    this.running = true;

    // Anything left pending from a previous life comes first, before new work.
    await this.drain();

    while (this.running && signal?.aborted !== true) {
      let updates: Update[];
      try {
        updates = await this.deps.api.getUpdates(this.deps.inbox.nextOffset());
      } catch (error) {
        if (error instanceof TelegramError && error.status === 409) {
          // Another poller holds the token — usually the previous process not
          // yet gone. Waiting is the correct move; racing it is not.
          log('telegram: 409, un altro getUpdates è attivo — attendo');
          await sleep(5000, signal);
          continue;
        }
        log(`telegram: polling fallito (${error instanceof Error ? error.message : String(error)})`);
        await sleep(5000, signal);
        continue;
      }

      if (updates.length > 0) {
        const { stored, duplicates } = this.deps.inbox.accept(updates, this.now());
        if (duplicates > 0) log(`telegram: ${duplicates} update già visti, ignorati`);
        if (stored > 0) await this.drain();
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Everything not yet answered, oldest first. Also the crash-recovery path. */
  private async drain(): Promise<void> {
    for (const stored of this.deps.inbox.pending()) {
      const update = JSON.parse(stored.payload) as Update;
      const incoming = parseUpdate(update, this.deps.config.ownerChatId);

      if (!incoming) {
        // Nothing to do with it, and saying so is better than leaving it pending
        // for ever: a queue that never empties hides the ones that matter.
        this.deps.inbox.markProcessed(stored.updateId, this.now());
        continue;
      }

      try {
        await this.handle(incoming);
        this.deps.inbox.markProcessed(stored.updateId, this.now());
      } catch (error) {
        // Stays pending: it may well work after a restart, and dropping it is
        // the data loss the inbox exists to prevent, arriving by another road.
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.inbox.markFailed(stored.updateId, reason);
        (this.deps.log ?? (() => {}))(`telegram: update ${stored.updateId} fallito — ${reason}`);
      }
    }
  }

  private async handle(incoming: Incoming): Promise<void> {
    const { principal, tenant } = principalFor(incoming);
    const presence = await startPresence(this.deps.api, incoming.chatId, {
      isPrivate: incoming.isPrivate,
      placeholder: 'sto guardando…',
    });

    try {
      const result = await runTurn(this.deps.loop, {
        principal,
        tenant,
        surface: 'telegram',
        // One session per chat, so a conversation continues where it left off
        // and two chats never share one.
        session: this.deps.sessions.open(`telegram:${incoming.chatId}`),
        text: incoming.text,
      });

      const parts = renderForTelegram(result.text);
      for (const [i, part] of parts.entries()) {
        // The placeholder becomes the first part rather than sitting above it.
        if (i === 0 && presence.editMessageId !== undefined) {
          await this.deps.api.editMessageText(incoming.chatId, presence.editMessageId, part);
        } else {
          await this.deps.api.sendMessage(incoming.chatId, part, {
            ...(i === 0 ? { replyTo: incoming.messageId } : {}),
          });
        }
      }
    } finally {
      await presence.stop();
    }
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
