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
export type SentCall = { method: string; payload: Record<string, unknown> };

export type FakeTelegram = {
  /** `https://127.0.0.1:<port>` — what `--api-base` is given. */
  url: string;
  /** Queue an inbound update; the next `getUpdates` returns it. */
  deliver(update: FakeUpdate): void;
  /** Every outbound call, in order. */
  sent(): SentCall[];
  /** Only `sendMessage`, the ones a person would actually read. */
  messages(): Array<{ chatId: number; text: string }>;
  close(): Promise<void>;
};

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
  let nextUpdateId = 1;
  let nextMessageId = 1000;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      // `<base>/bot<token>/METHOD` — the shape is Telegram's, unchanged.
      const method = (req.url ?? '').split('/').pop() ?? '';
      let payload: Record<string, unknown> = {};
      try {
        payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }

      const ok = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      };

      if (method === 'getMe') {
        ok({ id: 42, is_bot: true, first_name: 'Muffin', username: 'muffin_test_bot' });
        return;
      }

      if (method === 'getUpdates') {
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

      // Everything else is an outbound effect, and it is recorded before it is
      // answered: a scenario asserting "Muffin never sent this" needs the
      // record to exist even when the reply is uninteresting.
      calls.push({ method, payload });

      if (method === 'sendMessage' || method === 'editMessageText' || method === 'sendMessageDraft') {
        ok({
          message_id: nextMessageId++,
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
    sent: () => calls.slice(),
    messages: () =>
      calls
        .filter((c) => c.method === 'sendMessage')
        .map((c) => ({ chatId: Number(c.payload['chat_id'] ?? 0), text: String(c.payload['text'] ?? '') })),
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
