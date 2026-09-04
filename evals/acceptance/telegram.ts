import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A Telegram Bot API that costs nothing and answers from a script.
 *
 * The counterpart of `provider.ts`, and it exists for the same reason: the
 * real binary talks to Telegram over HTTP, so handing `TelegramConnector` a
 * hand-written `api` object would mean *not running the real binary* — which
 * is the whole point of this suite. `connectors/telegram/pairing-flow.test.ts`
 * does exactly that and proves the connector's logic; what it cannot show is
 * that `cli/surface.ts` wires that logic to anything. Until this file existed,
 * `report.ts` recorded the gap honestly under `NOT_PROVABLE_HERE.B16`:
 * *"nessun binario spawnabile contro un Bot API finto"*.
 *
 * The seam is the one Telegram itself documents. The Bot API server is
 * software you can run yourself — *"You can run it locally and send the
 * requests to your own server instead of `https://api.telegram.org`"*
 * (core.telegram.org/bots/api) — and the request shape does not change:
 * `<base>/bot<token>/METHOD`. So a scenario points a real installation at
 * this server with `muffin surface enable telegram --api-base <url>`, and
 * nothing in `connectors/` or `cli/` learns that it is being tested.
 *
 * What this buys, beyond determinism:
 *
 *  - **the request is evidence.** What Muffin *sent* to a chat — the HTML, the
 *    chat id, whether a draft or a final message — is a recorded object, not
 *    an interpretation of a log line.
 *  - **inbound is scriptable.** `deliver()` queues an update, and the next
 *    `getUpdates` long-poll returns it: a scenario can make a stranger write
 *    first, then the owner, and assert what each one got back.
 *
 * No scenario may ever reach `api.telegram.org`: the token here is fake and
 * the base URL is this server.
 */

export type FakeUpdate = Record<string, unknown>;

/** One outbound call the binary made, in order. */
type SentCall = {
  method: string;
  payload: Record<string, unknown>;
  /**
   * Only set for a `multipart/form-data` call (`sendDocument`, B14): the file
   * parts, keyed by their form field name (`document`). `size` is the real
   * byte length of the part body, not a string length — see `parseMultipart`.
   */
  files?: Record<string, { filename: string; size: number }>;
  /**
   * Only set for `sendMessage`/`sendMessageDraft` (D12, B13): the fresh id
   * this server invented for the message it just created. `editMessageText`/
   * `deleteMessage` need none — they already name the id they mean as
   * `payload['message_id']`, the same field a real Bot API call carries.
   */
  messageId?: number;
};

export type FakeTelegram = {
  /** `https://127.0.0.1:<port>` — what `--api-base` is given. */
  url: string;
  /** Queue an inbound update; the next `getUpdates` returns it. */
  deliver(update: FakeUpdate): void;
  /**
   * Fa cadere il long poll come cade davvero: la connessione accettata e poi
   * distrutta: la classe di guasto che il gateway dell'owner ha incontrato 3187
   * volte fra il 29 e il 30/08. Non un 500 — un 500 e' una risposta, e la classe
   * da riprodurre e' quella in cui risposta non ce n'e'.
   */
  rompi(): void;
  /** E torna a rispondere. */
  ripara(): void;
  /**
   * Fa tardare la stretta di mano.
   *
   * Serve a coprire la finestra fra «il connettore e' partito» e «Telegram ha
   * risposto», che sulla rete vera arriva a due minuti (65s di timeout piu' un
   * ritentativo) ed e' larga esattamente quando la rete e' lenta — cioe' quando
   * l'owner corre `doctor`. Senza una manopola, un test puo' solo sperare di
   * infilarsi in una finestra di millisecondi.
   */
  ritardaGetMe(ms: number): void;
  /** Every outbound call, in order. */
  sent(): SentCall[];
  /** Only `sendMessage`, the ones a person would actually read. */
  messages(): Array<{ chatId: number; text: string }>;
  /** Only `sendDocument` (B14) — the file, its byte length, and where it went. */
  documents(): Array<{ chatId: number; filename: string; bytes: number; caption?: string }>;
  /**
   * Scripts `getChatMember`'s answer for one (chatId, userId) pair — F4's own
   * use (`connectors/telegram/invito.ts`): the owner marked `'left'` in the
   * group Muffin was just added to. Unset pairs answer `'member'`, the
   * harmless default that keeps every scenario that never calls this from
   * accidentally tripping the exit flow.
   */
  setChatMember(chatId: number, userId: number, status: string): void;
  /**
   * The `allowed_updates` array the most recent `getUpdates` call actually
   * carried on the wire — F4's own use: proving `my_chat_member` is really
   * requested, not merely declared as a client-side default that a future
   * edit could drop without any test noticing (`connectors/telegram/
   * dove-e-il-mio-umano.test.ts`'s own "il pezzo senza cui tutto il resto e'
   * codice morto").
   */
  lastAllowedUpdates(): string[] | undefined;
  close(): Promise<void>;
};

/**
 * The one place a `multipart/form-data` body (`sendDocument`, B14) gets read.
 *
 * Minimal on purpose — this is a test double for one real caller
 * (`connectors/telegram/media.ts#sendDocument`, built with the platform's own
 * `FormData`/`Blob`), not a general-purpose multipart library: it knows the
 * shape that caller produces (plain string fields, at most one file field per
 * call) and nothing else. `raw` must be the exact bytes the request carried —
 * concatenated `Buffer`s, never `toString()`'d first, or a binary file part
 * would already be corrupted before this ever runs.
 */
function parseMultipart(
  raw: Buffer,
  contentType: string,
): { fields: Record<string, string>; files: Record<string, { filename: string; size: number }> } {
  const fields: Record<string, string> = {};
  const files: Record<string, { filename: string; size: number }> = {};
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return { fields, files };
  const delimiter = Buffer.from(`--${boundary}`);

  let start = raw.indexOf(delimiter);
  while (start !== -1) {
    const next = raw.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break; // the closing `--boundary--` ends the walk, not a part of its own
    let partStart = start + delimiter.length;
    if (raw[partStart] === 0x0d && raw[partStart + 1] === 0x0a) partStart += 2; // the CRLF right after the marker
    let partEnd = next;
    if (raw[partEnd - 2] === 0x0d && raw[partEnd - 1] === 0x0a) partEnd -= 2; // the CRLF right before the next marker
    if (partEnd > partStart) {
      const part = raw.subarray(partStart, partEnd);
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headerText = part.subarray(0, headerEnd).toString('utf8');
        const body = part.subarray(headerEnd + 4);
        const name = /name="([^"]*)"/.exec(headerText)?.[1];
        const filename = /filename="([^"]*)"/.exec(headerText)?.[1];
        if (name !== undefined) {
          if (filename !== undefined) files[name] = { filename, size: body.length };
          else fields[name] = body.toString('utf8');
        }
      }
    }
    start = next;
  }
  return { fields, files };
}

/**
 * `getUpdates` is a **long poll**: the real server holds the connection open
 * for `timeout` seconds when it has nothing. Answering instantly with `[]`
 * would turn the connector's poll loop into a busy loop and burn a CI runner,
 * so this holds too — but only briefly, and it returns the moment something is
 * queued. Short enough that a scenario never waits on it, long enough that
 * nothing spins.
 */
const HOLD_MS = 150;
const HOLD_STEP_MS = 10;

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const queue: FakeUpdate[] = [];
  const calls: SentCall[] = [];
  let guasto = false;
  let ritardoGetMe = 0;
  let nextUpdateId = 1;
  let nextMessageId = 1000;
  const chatMembers = new Map<string, string>();
  let ultimoAllowedUpdates: string[] | undefined;

  const server: Server = createServer((req, res) => {
    // `Buffer`s, not a string: `sendDocument` (B14) carries real file bytes in
    // a `multipart/form-data` body, and `body += chunk` (the old shape here)
    // ran every chunk through the default utf8 `toString()` on the way in —
    // silently corrupting anything that was not text before this function
    // ever saw it.
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      // `<base>/bot<token>/METHOD` — the shape is Telegram's, unchanged.
      const method = (req.url ?? '').split('/').pop() ?? '';
      const raw = Buffer.concat(chunks);
      const contentType = String(req.headers['content-type'] ?? '');
      let payload: Record<string, unknown> = {};
      let files: Record<string, { filename: string; size: number }> | undefined;
      if (contentType.toLowerCase().startsWith('multipart/form-data')) {
        const parsed = parseMultipart(raw, contentType);
        payload = parsed.fields;
        if (Object.keys(parsed.files).length > 0) files = parsed.files;
      } else {
        try {
          payload = raw.length > 0 ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
        } catch {
          payload = {};
        }
      }

      const ok = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      };

      if (method === 'getMe') {
        const rispondi = (): void => ok({ id: 42, is_bot: true, first_name: 'Muffin', username: 'muffin_test_bot' });
        if (ritardoGetMe > 0) setTimeout(rispondi, ritardoGetMe);
        else rispondi();
        return;
      }

      if (method === 'getUpdates') {
        // Registrato **prima** del ramo guasto/lungo-poll: e' il dato che F4
        // guarda per provare che `my_chat_member` e' davvero sul filo, non
        // solo nel default di `api.ts` — un long poll caduto o ancora in
        // attesa non deve nascondere cosa questa chiamata ha chiesto.
        const richiesti = payload['allowed_updates'];
        ultimoAllowedUpdates = Array.isArray(richiesti) ? richiesti.map(String) : undefined;
        if (guasto) {
          req.socket.destroy();
          return;
        }
        const start = Date.now();
        const drain = (): void => {
          if (queue.length > 0) {
            const batch = queue.splice(0, queue.length).map((u) => ({ update_id: nextUpdateId++, ...u }));
            ok(batch);
            return;
          }
          if (Date.now() - start >= HOLD_MS) {
            ok([]);
            return;
          }
          setTimeout(drain, HOLD_STEP_MS);
        };
        drain();
        return;
      }

      // Prima dell'inoltro generico qui sotto: senza un ramo suo, questa
      // chiamata cadeva in quello e rispondeva `ok(true)` — un booleano dove
      // il client vero (`connectors/telegram/api.ts#getChatMember`) legge
      // `{status}`, quindi `stato.status` era sempre `undefined` e
      // `gestisciInvito` decideva sempre "l'owner c'e'" per costruzione. F4
      // esiste per scriptare l'altra risposta.
      if (method === 'getChatMember') {
        const chatId = Number(payload['chat_id'] ?? 0);
        const userId = Number(payload['user_id'] ?? 0);
        const status = chatMembers.get(`${chatId}:${userId}`) ?? 'member';
        calls.push({ method, payload });
        ok({ status });
        return;
      }

      // `sendMessage`/`sendMessageDraft` *create* a message — the id is the
      // server's own invention, and this is the only place it is ever known.
      // `editMessageText`/`deleteMessage` *address* an existing one — the
      // caller already names it as `message_id` in the request payload
      // (`connectors/telegram/api.ts`), so it needs no manufacturing here; a
      // scenario reads it straight off `sent()[i].payload['message_id']`.
      const createdId = method === 'sendMessage' || method === 'sendMessageDraft' ? nextMessageId++ : undefined;

      // Everything else is an outbound effect, and it is recorded before it is
      // answered: a scenario asserting "Muffin never sent this" needs the
      // record to exist even when the reply is uninteresting.
      calls.push({ method, payload, ...(files ? { files } : {}), ...(createdId !== undefined ? { messageId: createdId } : {}) });

      if (method === 'sendMessage' || method === 'editMessageText' || method === 'sendMessageDraft') {
        ok({
          // An edit echoes the id it was given; a create hands out the fresh one.
          message_id: createdId ?? Number(payload['message_id'] ?? 0),
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(payload['chat_id'] ?? 0), type: 'private' },
          text: String(payload['text'] ?? ''),
        });
        return;
      }
      // `sendChatAction` and anything else the connector reaches for.
      ok(true);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    deliver: (update) => {
      queue.push(update);
    },
    rompi: () => {
      guasto = true;
    },
    ripara: () => {
      guasto = false;
    },
    ritardaGetMe: (ms) => {
      ritardoGetMe = ms;
    },
    sent: () => calls.slice(),
    messages: () =>
      calls
        .filter((c) => c.method === 'sendMessage')
        .map((c) => ({ chatId: Number(c.payload['chat_id'] ?? 0), text: String(c.payload['text'] ?? '') })),
    documents: () =>
      calls
        .filter((c) => c.method === 'sendDocument')
        .map((c) => ({
          chatId: Number(c.payload['chat_id'] ?? 0),
          filename: c.files?.['document']?.filename ?? '',
          bytes: c.files?.['document']?.size ?? 0,
          ...(typeof c.payload['caption'] === 'string' ? { caption: c.payload['caption'] as string } : {}),
        })),
    setChatMember: (chatId, userId, status) => {
      chatMembers.set(`${chatId}:${userId}`, status);
    },
    lastAllowedUpdates: () => ultimoAllowedUpdates,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** An inbound private message, the shape Telegram sends. */
export function privateMessage(from: { id: number; name?: string }, text: string): FakeUpdate {
  return {
    message: {
      message_id: Math.floor(Math.random() * 100_000),
      date: Math.floor(Date.now() / 1000),
      from: { id: from.id, is_bot: false, first_name: from.name ?? `u${from.id}` },
      chat: { id: from.id, type: 'private' },
      text,
    },
  };
}

/**
 * An inbound button press, the shape Telegram sends for `callback_query`
 * (D12 — the ASK's Consenti/Rifiuta buttons, `cli/surface.ts`'s
 * `approvatoreTelegram`). `message` must echo the id/chat of the real ASK
 * message this press is answering, the way a real Telegram client would —
 * `connectors/telegram/connector.ts#handleCallback` reads `message.chat.id`
 * and `message.message_id` to strike the confirmation onto that same bubble.
 */
export function callbackQuery(
  from: { id: number; name?: string },
  data: string,
  message: { messageId: number; chatId: number; text: string },
): FakeUpdate {
  return {
    callback_query: {
      id: `cbq${Math.floor(Math.random() * 1_000_000)}`,
      from: { id: from.id, is_bot: false, first_name: from.name ?? `u${from.id}` },
      chat_instance: '1',
      data,
      message: {
        message_id: message.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: message.chatId, type: 'private' },
        text: message.text,
      },
    },
  };
}
