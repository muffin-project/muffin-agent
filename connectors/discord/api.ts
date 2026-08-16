import { z } from 'zod';

/**
 * The Discord HTTP API, over `fetch`, with no library between.
 *
 * The same choice as `connectors/telegram/api.ts`, made again with the numbers
 * in front of it rather than by analogy (research 2026-08-15, recorded in
 * ADR-0043). The short version: `discord.js@14.27.0` is Apache-2.0 and well
 * maintained, but it is **CJS** (`"type": null`, `main: ./src/index.js`) in a
 * repo that is `"type": "module"`, it brings **24 packages**, and its value is a
 * client object graph and an entity cache this connector does not want — the
 * loop is the engine, and a second one is what ADR-0025 refused for Telegram.
 * `@discordjs/core` + `@discordjs/ws` + `@discordjs/rest` is genuinely dual-ESM
 * and would be the right answer if the gateway were the hard part. It is not:
 * the subset needed for messages is Hello, heartbeat, Identify, Resume and a
 * close-code table.
 *
 * What makes "no library" cheap here is the runtime. `package.json` requires
 * Node ≥22, and Node 22 has both `fetch` and — since **v22.4.0, no longer
 * experimental** — a global WHATWG `WebSocket`. So the whole transport is
 * built-ins.
 *
 * ## Two things Discord requires that Telegram does not
 *
 * **The token goes in a header, not the path.** Telegram's URL contains the bot
 * token, which is why `media.ts` is careful never to log a URL. Here the secret
 * is in `Authorization`, so a leaked URL is not a leaked token — but the header
 * must never be logged either, and errors below quote the status and Discord's
 * own message, never the request.
 *
 * **`User-Agent` is mandatory.** Discord's reference says a request without a
 * valid one "may be blocked and return a Cloudflare error" — a failure that
 * looks like a network problem and is not.
 */

/** Pinned. An unversioned request defaults to v6, which is deprecated. */
const API = 'https://discord.com/api/v10';

/** Required by Discord's reference, in this exact shape. */
const USER_AGENT = 'DiscordBot (https://github.com/GiustoPiedimonte/muffin-agent, 0.0.0)';

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
    /** Seconds Discord asked us to wait. Present on 429. */
    readonly retryAfter?: number,
  ) {
    super(`Discord ${status}: ${description}`);
    this.name = 'DiscordError';
  }
}

/**
 * What we read off an attachment, and what we read off a message — parsed at
 * the boundary rather than asserted. U1 (judge, PR #42): `connector.ts` used
 * to write `data as DiscordMessage` and `JSON.parse(...) as DiscordMessage`,
 * so a corrupted payload — a numeric `id`, already rounded by `JSON.parse`
 * before any type ever looked at it, since a real snowflake exceeds
 * `Number.MAX_SAFE_INTEGER` — passed through typed as a `string` that at
 * runtime never was one. `z.infer` is the type now, not a hand-copy of it:
 * the same discipline `core/config/config.ts`'s `ConfigSchema` uses at its
 * own boundary, and the same shape `connectors/telegram/connector.ts`'s
 * `parseUpdate` already holds by hand (defensive field-by-field checks,
 * nothing trusted from an `as`) — here the check is a schema a payload can
 * actually fail, rather than a cast a compiler takes on faith.
 *
 * The full object Discord sends is much larger; this is the part that is
 * ours, with the same optionality the hand-written type used to declare.
 */
export const DiscordAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  /**
   * Signed and time-limited (`?ex=&is=&hm=`). Valid when the payload arrives and
   * **never stored**: the connector downloads on receipt or not at all.
   */
  url: z.string(),
  content_type: z.string().optional(),
});
export type DiscordAttachment = z.infer<typeof DiscordAttachmentSchema>;

export const DiscordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  /** Absent in a DM — there is no guild. See `connector.ts` for why both signals are read. */
  guild_id: z.string().optional(),
  /** 1 = DM, 3 = GROUP_DM. Optional on MESSAGE_CREATE, so it is a hint, not the check. */
  channel_type: z.number().optional(),
  author: z
    .object({
      id: z.string(),
      username: z.string().optional(),
      bot: z.boolean().optional(),
      system: z.boolean().optional(),
      global_name: z.string().nullable().optional(),
    })
    .optional(),
  content: z.string().optional(),
  attachments: z.array(DiscordAttachmentSchema).optional(),
  /** Who the message names. Used to tell "addressed to Muffin" from "said nearby". */
  mentions: z.array(z.object({ id: z.string() })).optional(),
});
export type DiscordMessage = z.infer<typeof DiscordMessageSchema>;

export class DiscordApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = API,
  ) {}

  /**
   * One call, one retry on a 429 or a 5xx — the same policy as Telegram's, and
   * for the same reason: guessing a backoff against a server that just told you
   * the number is how a soft limit becomes a hard one.
   */
  async call<T>(
    method: 'GET' | 'POST',
    path: string,
    payload?: Record<string, unknown>,
    attempt = 0,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          'user-agent': USER_AGENT,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === 0) {
        await sleep(1000);
        return this.call<T>(method, path, payload, 1);
      }
      // The message, never the request: the request carries the bot token.
      throw new DiscordError(0, error instanceof Error ? error.message : String(error));
    }

    if (response.status === 204) return undefined as T;

    if (response.ok) return (await response.json()) as T;

    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      retry_after?: number;
    };
    const retryAfter = body.retry_after;
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      await sleep((retryAfter ?? 1) * 1000 + 1000);
      return this.call<T>(method, path, payload, 1);
    }
    throw new DiscordError(response.status, body.message ?? response.statusText, retryAfter);
  }

  /** Who we are. Called once at startup, so a bad token fails at boot. */
  me(): Promise<{ id: string; username: string }> {
    return this.call('GET', '/users/@me');
  }

  /**
   * The gateway URL to connect to, from Discord rather than hard-coded.
   *
   * Also the first proof the token works: this endpoint is bot-authenticated,
   * so an invalid token fails here with a 401 instead of as gateway close code
   * 4004 thirty seconds later, where it reads like a network fault.
   */
  gatewayUrl(): Promise<{ url: string; session_start_limit?: { remaining: number } }> {
    return this.call('GET', '/gateway/bot');
  }

  sendMessage(channelId: string, content: string): Promise<DiscordMessage> {
    return this.call('POST', `/channels/${channelId}/messages`, { content });
  }

  /**
   * Sends a file, as multipart — the M5-BIS B14 half of this API.
   *
   * `payload_json` is Discord's documented way to carry the JSON body
   * alongside binary parts in the same request; `call` cannot be reused as-is
   * because it always serialises `payload` as the *whole* body. Not `call`
   * with a flag: a multipart body is a `FormData`, whose `content-type` (with
   * its boundary) the runtime sets and must not be supplied by hand — the
   * exact reason `TelegramApi.upload` is a separate method from `call` too.
   *
   * No retry. A failed upload should be retried by whoever knows what the
   * file was and whether it is still worth the bytes, not guessed at here —
   * same reasoning as `TelegramApi.upload`.
   */
  async sendFile(
    channelId: string,
    bytes: Buffer,
    filename: string,
    options: { content?: string } = {},
  ): Promise<DiscordMessage> {
    const body = new FormData();
    body.append(
      'payload_json',
      JSON.stringify({ ...(options.content ? { content: options.content } : {}), attachments: [{ id: 0, filename }] }),
    );
    body.append('files[0]', new Blob([bytes]), filename);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bot ${this.token}`, 'user-agent': USER_AGENT },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new DiscordError(0, error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      const errBody = (await response.json().catch(() => ({}))) as { message?: string; retry_after?: number };
      throw new DiscordError(response.status, errBody.message ?? response.statusText, errBody.retry_after);
    }
    return (await response.json()) as DiscordMessage;
  }

  /**
   * The DM channel with a user, opened or reused.
   *
   * Idempotent by Discord's own contract — "if one already exists, it will be
   * returned instead" — which is why the connector can call it whenever it needs
   * the owner's channel instead of caching one that may have been closed.
   */
  openDm(userId: string): Promise<{ id: string }> {
    return this.call('POST', '/users/@me/channels', { recipient_id: userId });
  }

  /**
   * "typing…", which Discord expires after **ten seconds** — twice Telegram's
   * five, and still far shorter than a turn with tool calls. So it is repeated
   * on a timer, exactly as `connectors/telegram/presence.ts` learned to.
   */
  typing(channelId: string): Promise<void> {
    return this.call('POST', `/channels/${channelId}/typing`);
  }

  /**
   * Downloads an attachment.
   *
   * Not `call`: this goes to the CDN, not the API, and must **not** carry the
   * `Authorization` header — the URL is already signed, and sending a bot token
   * to a host that did not ask for it is how a credential ends up somewhere it
   * was never needed.
   */
  async download(url: string, maxBytes: number): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new Error(`download fallito: ${error instanceof Error ? error.name : 'errore'}`);
    }
    if (!response.ok) throw new Error(`download fallito: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    // Checked against what actually arrived, not only against what the payload
    // declared: the declared size is a number in a message a stranger sent.
    if (buffer.byteLength > maxBytes) {
      throw new Error(`${(buffer.byteLength / 1e6).toFixed(1)}MB, oltre il limite di ${maxBytes / 1e6}MB`);
    }
    return buffer;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
