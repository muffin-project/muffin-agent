import type { Message, Update, User } from '@grammyjs/types';

/**
 * The Bot API, over `fetch`, with no library between.
 *
 * `@grammyjs/types` is a type-only import — zero runtime bytes, zero
 * dependencies of its own, generated from the official schema and published
 * within days of each Bot API release. What it does *not* give is runtime
 * safety: a field the type calls required can still arrive missing, so
 * everything that matters is read defensively at the edge (see `connector.ts`),
 * not trusted because a `.d.ts` said so.
 *
 * Rate limits, from Telegram's own FAQ: about one message per second to a single
 * chat, about twenty per minute to a group, about thirty per second overall. A
 * single owner and a few group chats do not approach any of them, so there is no
 * queue here — one retry after the `retry_after` the server names, and nothing
 * more. The previous system built a queue and a cooldown map, then removed both
 * because they caused more failures than the rate limit did.
 */

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
    /** Seconds Telegram asked us to wait. Present on 429, sometimes on 5xx. */
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${status}: ${description}`);
    this.name = 'TelegramError';
  }
}

/** Long polling holds the connection open; the timeout has to outlast it. */
const POLL_SECONDS = 50;
const REQUEST_TIMEOUT_MS = (POLL_SECONDS + 15) * 1000;

export type SendOptions = {
  replyTo?: number;
  /** Off by default: an agent quoting a link should not turn it into a card. */
  preview?: boolean;
};

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://api.telegram.org',
  ) {}

  /**
   * One call, one retry on a 429 or a 5xx.
   *
   * The retry honours `retry_after` when Telegram sends it, because guessing a
   * backoff against a server that just told you the number is how a soft limit
   * becomes a hard one.
   */
  async call<T>(method: string, payload: Record<string, unknown> = {}, attempt = 0): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A network failure is retryable once; a second one is the network's
      // answer and pretending otherwise just delays it.
      if (attempt === 0) {
        await sleep(1000);
        return this.call<T>(method, payload, 1);
      }
      throw new TelegramError(0, error instanceof Error ? error.message : String(error));
    }

    const body = (await response.json()) as
      | { ok: true; result: T }
      | { ok: false; description: string; parameters?: { retry_after?: number } };

    if (body.ok) return body.result;

    const retryAfter = body.parameters?.retry_after;
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      // Plus a second: `retry_after` is when the window opens, not when it is
      // safe to be inside it.
      await sleep((retryAfter ?? 1) * 1000 + 1000);
      return this.call<T>(method, payload, 1);
    }
    throw new TelegramError(response.status, body.description, retryAfter);
  }

  /**
   * A multipart call, for the methods that carry bytes.
   *
   * Separate from `call` rather than a branch inside it: the body is a
   * `FormData`, the content-type is set by the runtime and must *not* be
   * supplied by hand (the boundary parameter goes with it), and there is no JSON
   * to serialise. Two small functions beat one with a mode flag.
   *
   * No retry. A failed upload should be retried by whoever knows what the file
   * was, and re-sending several megabytes on a guess is not a decision this
   * layer gets to make.
   */
  async upload<T>(method: string, body: FormData): Promise<T> {
    const response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(120_000),
    });
    const payload = (await response.json()) as { ok: true; result: T } | { ok: false; description: string };
    if (!payload.ok) throw new TelegramError(response.status, payload.description);
    return payload.result;
  }

  /** Who we are. Called once at startup, so a bad token fails at boot and not mid-conversation. */
  getMe(): Promise<User> {
    return this.call<User>('getMe');
  }

  /**
   * Long polling. Returns when there is something, or when the poll expires.
   *
   * `allowed_updates` is explicit: asking only for what is handled means an
   * update type added by a future Bot API version does not silently arrive and
   * fall through the connector's `else`.
   */
  getUpdates(offset: number, allowed: string[] = ['message', 'edited_message']): Promise<Update[]> {
    return this.call<Update[]>('getUpdates', {
      offset,
      timeout: POLL_SECONDS,
      allowed_updates: allowed,
    });
  }

  sendMessage(chatId: number, html: string, options: SendOptions = {}): Promise<Message> {
    return this.call<Message>('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: options.preview !== true },
      ...(options.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
    });
  }

  editMessageText(chatId: number, messageId: number, html: string): Promise<Message | boolean> {
    return this.call<Message | boolean>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  /**
   * The "typing…" indicator. Self-cancels after about five seconds, so it is
   * repeated rather than set once — this is a heartbeat, not a state.
   */
  sendChatAction(chatId: number, action = 'typing'): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  /**
   * The ephemeral draft bubble. Private chats only — groups answer
   * `TEXTDRAFT_PEER_INVALID` — and its TTL is about thirty seconds, fixed,
   * extended by nothing. See `presence.ts` for why that matters.
   */
  sendMessageDraft(chatId: number, text: string): Promise<boolean> {
    return this.call<boolean>('sendMessageDraft', { chat_id: chatId, text, parse_mode: 'HTML' });
  }

  /**
   * Resolves a file id to a download URL.
   *
   * The path is valid for about an hour, so it is never stored: callers ask
   * again. Anything beyond 20 MB cannot be downloaded through the public Bot
   * API at all, whatever the path says.
   */
  async fileUrl(fileId: string): Promise<string> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new TelegramError(0, `no file_path for ${fileId}`);
    return `${this.baseUrl}/file/bot${this.token}/${file.file_path}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
