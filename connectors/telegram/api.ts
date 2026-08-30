import type { Message, Update, User } from '@grammyjs/types';
import { causaDiRete } from '../../core/net/causa.js';

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

/**
 * Un pulsante sotto un messaggio.
 *
 * `callback_data` sta in **64 byte** (docs lette il 28/08/2026) e torna
 * verbatim dentro il `callback_query`: è l'unico posto dove far viaggiare
 * l'identità della domanda, perché il messaggio a cui il pulsante è attaccato
 * può essere modificato, e il testo non è un identificatore.
 *
 * `style` è opzionale e vale quello che sembra: `danger` rosso, `success`
 * verde, `primary`. Un "rifiuta" e un "consenti" che si somigliano sono un
 * pulsante premuto per sbaglio.
 */
export type InlineButton = { text: string; callback_data: string; style?: 'danger' | 'success' | 'primary' };

export type SendOptions = {
  replyTo?: number;
  /** Off by default: an agent quoting a link should not turn it into a card. */
  preview?: boolean;
  /**
   * Una tastiera sotto il messaggio: righe di pulsanti.
   *
   * Esiste per una cosa sola, ed è la ragione per cui non è generica: una
   * domanda di approvazione a cui l'owner risponde da dove sta leggendo. Senza,
   * su Telegram il kernel poteva solo dire «qui non posso chiedertelo» — cioè
   * niente di ciò che chiede conferma era usabile dal telefono.
   */
  keyboard?: InlineButton[][];
};

/**
 * The subset of `TelegramApi` every caller actually uses — extracted so a
 * test can hand `presence.ts`/`connector.ts` a fake that records calls and
 * timing (M5-BIS B11) without instantiating the real class, which `private
 * readonly token` would otherwise make impossible: TypeScript's structural
 * typing treats private members as nominal, so a plain object literal can
 * never satisfy `TelegramApi` itself, only an interface like this one.
 */
export interface TelegramApiLike {
  call<T>(method: string, payload?: Record<string, unknown>, attempt?: number): Promise<T>;
  upload<T>(method: string, body: FormData): Promise<T>;
  getMe(): Promise<User>;
  getUpdates(offset: number, allowed?: string[]): Promise<Update[]>;
  sendMessage(chatId: number, html: string, options?: SendOptions): Promise<Message>;
  editMessageText(chatId: number, messageId: number, html: string): Promise<Message | boolean>;
  deleteMessage(chatId: number, messageId: number): Promise<boolean>;
  sendChatAction(chatId: number, action?: string): Promise<boolean>;
  sendMessageDraft(chatId: number, draftId: number, text: string): Promise<boolean>;
  fileUrl(fileId: string): Promise<string>;
  setMyCommands(commands: { command: string; description: string }[]): Promise<boolean>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
}

export class TelegramApi implements TelegramApiLike {
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
    return this.request<T>(method, payload, true, true, attempt);
  }

  /**
   * One HTTP attempt for a user-visible effect. The Bot API exposes no client
   * idempotency token, so a transport failure after acceptance is ambiguous and
   * retrying it here can create a second visible message.
   */
  private effect<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    return this.request<T>(method, payload, false, true, 0);
  }

  private async request<T>(
    method: string,
    payload: Record<string, unknown>,
    retryTransport: boolean,
    retryRejected: boolean,
    attempt: number,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Reads retry one network failure. User-visible effects deliberately do
      // not: after an unreadable response the remote side may have accepted
      // the request, and a second send can become a second visible message.
      if (retryTransport && attempt === 0) {
        await sleep(1000);
        return this.request<T>(method, payload, retryTransport, retryRejected, 1);
      }
      // Mai `.message`, e non per prudenza astratta: l'URL su cui questa
      // `fetch` e' appena fallita porta il bot token nel path (Telegram, a
      // differenza di Discord, lo mette li' — vedi l'intestazione di questo
      // file). La prova del 17/08 aveva concluso che `.message` non portava
      // mai l'URL; il 30/08, ripetuta includendo il caso malformato, ha dato
      // l'URL intero dentro `.message` su questo stesso Node.
      //
      // `causaDiRete` dice la classe **e** il codice (`ECONNRESET`,
      // `ENOTFOUND`) accettando solo campi di una forma che un URL non puo'
      // avere. Il solo `.name` costava 3187 righe `Telegram 0: TypeError` in
      // diciannove ore senza mai dire cosa fosse rotto.
      throw new TelegramError(0, causaDiRete(error));
    }

    let body:
      | { ok: true; result: T }
      | { ok: false; description: string; parameters?: { retry_after?: number } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Headers without a readable Bot API result do not prove whether a
      // mutating request landed. Status 0 is the connector's "unknown" class.
      throw new TelegramError(0, 'risposta Telegram non leggibile');
    }

    if (body.ok) return body.result;

    const retryAfter = body.parameters?.retry_after;
    if (retryRejected && attempt === 0 && (response.status === 429 || response.status >= 500)) {
      // Plus a second: `retry_after` is when the window opens, not when it is
      // safe to be inside it.
      await sleep((retryAfter ?? 1) * 1000 + 1000);
      return this.request<T>(method, payload, retryTransport, retryRejected, 1);
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
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      // Same reasoning as `call`'s catch: this URL carries the token too.
      throw new TelegramError(0, causaDiRete(error));
    }
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
  getUpdates(
    offset: number,
    // `callback_query` è nell'elenco perché senza non arriva: `allowed_updates`
    // è esplicito di proposito (vedi sopra), quindi un tipo che non si nomina
    // non viene mai consegnato — e un pulsante che nessuno riceve è un pulsante
    // che gira per sempre.
    allowed: string[] = ['message', 'edited_message', 'callback_query'],
  ): Promise<Update[]> {
    return this.call<Update[]>('getUpdates', {
      offset,
      timeout: POLL_SECONDS,
      allowed_updates: allowed,
    });
  }

  sendMessage(chatId: number, html: string, options: SendOptions = {}): Promise<Message> {
    return this.effect<Message>('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: options.preview !== true },
      ...(options.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
      ...(options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
    });
  }

  /**
   * La risposta obbligatoria a un pulsante premuto.
   *
   * Non è cortesia: finché non arriva, il client mostra il pulsante che gira.
   * Va mandata **sempre**, anche quando la risposta è «questa domanda era già
   * chiusa» — soprattutto allora, perché è il caso in cui l'owner ha premuto
   * due volte e sta guardando per capire se ha funzionato.
   *
   * `text` sta in 200 caratteri (docs lette il 28/08/2026).
   */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text === undefined ? {} : { text: text.slice(0, 200) }),
    });
  }

  editMessageText(chatId: number, messageId: number, html: string): Promise<Message | boolean> {
    return this.effect<Message | boolean>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  /**
   * Removes a message this bot sent — `progress.ts`'s way of making the status
   * line disappear once a turn ends, rather than leaving it orphaned above the
   * real answer. `effect()`, not `call()`: on an ambiguous transport failure a
   * blind retry could hit a message that *did* delete, and the 400 Telegram
   * gives back ("message to delete not found") is indistinguishable from any
   * other rejection here — either way `progress.ts` swallows it, because a
   * leftover status line is cosmetic, never a lost or duplicated answer.
   */
  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.effect<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  /**
   * The "typing…" indicator. Self-cancels after about five seconds, so it is
   * repeated rather than set once — this is a heartbeat, not a state.
   */
  sendChatAction(chatId: number, action = 'typing'): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  /**
   * The ephemeral draft bubble — M5-BIS B11. Bot API 9.3 (2025-12-31,
   * business bots only), opened to every bot in 9.5 (2026-03-01) —
   * verified against the official changelog and reference,
   * platform.claude's Context7 mirror of core.telegram.org/bots/api,
   * 2026-08-16. Private chats only (`chat_id` is documented as "the target
   * **private** chat"; there is no declared group behaviour to name, so
   * none is claimed here). `draft_id` is **required and must be non-zero**
   * — the parameter this method was missing before this slice, silently:
   * every call landed a 400 that `presence.ts`'s `safely()` wrapper
   * swallowed, so the keepalive this method backs had never actually
   * refreshed anything in production. Reuse the same `draftId` across calls
   * that update one ongoing preview; a fresh one per turn is `presence.ts`'s
   * job, not this method's.
   *
   * The doc calls the preview "a temporary 30-second preview" without
   * stating whether a repeat call *resets* that window — but repeat calls
   * are the method's own stated purpose ("stream a partial message... while
   * being generated"), so a preview that could not outlive 30 seconds
   * regardless of how often it is refreshed would make the method useless
   * for exactly the case it says it is for. Not asserted as fact — only
   * `presence.ts`'s own choice to call this at least once a second either
   * way, comfortably inside any reading of "30 seconds," is asserted.
   */
  sendMessageDraft(chatId: number, draftId: number, text: string): Promise<boolean> {
    return this.call<boolean>('sendMessageDraft', { chat_id: chatId, draft_id: draftId, text, parse_mode: 'HTML' });
  }

  /**
   * Resolves a file id to a download URL.
   *
   * The path is valid for about an hour, so it is never stored: callers ask
   * again. Anything beyond 20 MB cannot be downloaded through the public Bot
   * API at all, whatever the path says.
   */
  /**
   * Pubblica i comandi nel menu del bot.
   *
   * Non è un file: è un metodo dell'API (`setMyCommands`, docs lette il
   * 28/08/2026), e vincola i nomi a 1-32 caratteri di sole minuscole inglesi,
   * cifre e underscore — i nostri otto passano. La descrizione arriva a 256.
   *
   * `BotCommandScopeAllPrivateChats` e non il default: questi comandi toccano
   * la config e il conto dell'owner, quindi in un gruppo non devono nemmeno
   * comparire nel menu. Chi li chiama viene comunque ricontrollato — un menu
   * è un suggerimento, non un permesso.
   */
  setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    return this.call<boolean>('setMyCommands', {
      commands,
      scope: { type: 'all_private_chats' },
    });
  }

  async fileUrl(fileId: string): Promise<string> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new TelegramError(0, `no file_path for ${fileId}`);
    return `${this.baseUrl}/file/bot${this.token}/${file.file_path}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
