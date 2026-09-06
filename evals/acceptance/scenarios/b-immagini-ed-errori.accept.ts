import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { install, until, type Install } from '../harness.js';
import { photoMessage, privateMessage, startFakeTelegram, type FakeTelegram } from '../telegram.js';
import { scenario } from '../scenario.js';
import type { RecordedRequest } from '../provider.js';

/**
 * B10 · Telegram — immagini ed errori, sul binario vero.
 *
 * The row was BLOCKER for one reason only (issue #361): the fake Bot API this
 * suite drives `muffin gateway` against never implemented `getFile`, so no
 * scenario could put real bytes behind a `file_id` — the mechanism already in
 * HEAD (`ImageBlock` via `ingest()` in `connectors/telegram/connector.ts`,
 * since b815751) had never been exercised end to end. `telegram.ts` now
 * serves `getFile` and the `/file/bot<token>/<file_path>` download route
 * (`FakeTelegram.plantFile`) — the two-step dance the real Bot API actually
 * does, not a shortcut straight to a URL.
 *
 * The row's second half — "errori gestiti a pezzi, non come proprietà unica"
 * — is `FakeTelegram.guasta()`: a real Telegram rejection (`{ok:false,
 * description}`), not a dropped connection (`rompi()` already covers that
 * class, B7/reconnect territory). What it exercises is
 * `connectors/telegram/delivery.ts`'s own point: a rejected send must be
 * recorded as `rejected`/`failed:<why>`, never silently treated as `sent`,
 * and the *next* delivery attempt — triggered here by a second inbound
 * message, exactly the path `resolveBound`'s own comment describes ("stays
 * pending; the next drain retries the send, not the model") — must complete
 * it rather than lose it.
 *
 * ## Why only the image half is registered in `manifest.ts`
 *
 * `report.ts`'s manifest is 1:1 per row (`manifest.ts`'s own comment on E3:
 * "One scenario, not two"), and `verdictFor` reports a row on
 * `scenariosForRow[0]` only. A second `scenario('B10', …)` call here would
 * register a **second** `it()` whose title is `entry('B10').title`
 * verbatim — the *same* string as the first — and `chiaviEsito` would find
 * two vitest outcomes ending in it, which `verdictFor` calls
 * `rosso-inatteso` ("titolo ambiguo… un verdetto scelto fra questi sarebbe
 * un lancio di moneta"). `b-telegram-journey.accept.ts` hit exactly this
 * shape for B1 and solved it the same way: the second scenario below is a
 * plain, unmanifested `it()` — it runs, it must stay green (a failure here
 * still fails the report, as `orfaniRossi`), it is just not claimed against
 * the row a second time.
 */

const OWNER_ID = 999;

function ownerDalFile(home: string): number | undefined {
  try {
    const c = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      surfaces?: { telegram?: { ownerUserId?: number } };
    };
    return c.surfaces?.telegram?.ownerUserId;
  } catch {
    return undefined;
  }
}

type Gw = Awaited<ReturnType<Install['gateway']>>;

async function pairOwner(inst: Install, tg: FakeTelegram, ownerId: number): Promise<Gw> {
  const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-b10-token');
  if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
  const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
  if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
  const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
  if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);
  const gw = await inst.gateway();
  await gw.waitFor(/muffin gateway/, 20_000);
  tg.deliver(privateMessage({ id: ownerId, name: 'Owner' }, code));
  await until(() => ownerDalFile(inst.home) === ownerId, 20_000);
  if (ownerDalFile(inst.home) !== ownerId) {
    throw new Error(`owner atteso ${ownerId}, trovato ${String(ownerDalFile(inst.home))}`);
  }
  return gw;
}

/**
 * A minimal but real JPEG on the wire: `agent/images.ts#sniff` reads the
 * first three bytes (SOI marker `FF D8 FF`) and nothing else, so this is
 * enough to be recognised as `image/jpeg` without needing a decodable
 * picture — the claim under test is that the *bytes* survive the round trip
 * (fake Bot API → download → vault → provider), not that they render.
 */
const FAKE_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(512, 0x2a),
  Buffer.from([0xff, 0xd9]),
]);

type TurnRow = { id: string; delivery: string | null; messages: string };

function readTurn(inst: Install, where: string, params: unknown[] = []): TurnRow | undefined {
  return inst.db(
    (db) => db.prepare(`SELECT id, delivery, messages FROM turns ${where}`).get(...params) as TurnRow | undefined,
  );
}

function deliveryPartStatuses(inst: Install, turnId: string): string[] {
  return inst.db(
    (db) =>
      db
        .prepare(`SELECT status FROM telegram_delivery_parts WHERE turn_id = ? ORDER BY part_index`)
        .all(turnId) as { status: string }[],
  ).map((r) => r.status);
}

/** Every `image_url` part across every message this request carried. */
function imageUrlsIn(messages: RecordedRequest['messages']): string[] {
  const urls: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as unknown[]) {
      if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url') {
        const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
        if (typeof url === 'string') urls.push(url);
      }
    }
  }
  return urls;
}

describe('acceptance · B10 · telegram — immagini ed errori', () => {
  /**
   * Falsifier: in `connectors/telegram/connector.ts#ingest`, drop the
   * `...(arrival?.image ? { images: [arrival.image] } : {})` spread from the
   * `runTurn` call (or make `loadImage` always return `{ok:false, …}`) and
   * this scenario goes red — no request to the fake provider would ever
   * carry an `image_url` part, and the base64 comparison below has nothing
   * to compare against `FAKE_JPEG`.
   */
  scenario(
    'B10',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [{ text: 'bella foto, la vedo bene' }],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const gw = await pairOwner(inst, tg, OWNER_ID);
        try {
          // Planted before delivery: a real photo already sits on Telegram's
          // servers before its `file_id` is ever named in an `Update`.
          tg.plantFile('b10-photo-1', 'photos/file_1.jpg', FAKE_JPEG);
          tg.deliver(photoMessage({ id: OWNER_ID, name: 'Owner' }, 'b10-photo-1'));
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('la vedo bene'),
                ),
            20_000,
          );

          // The claim itself: the model was shown an `image_url` part, and
          // its bytes are exactly what the fake Bot API served for this
          // `file_id` — not merely "some image", the same one.
          const main = inst.provider.main();
          const urls = main.flatMap((r) => imageUrlsIn(r.messages));
          if (urls.length === 0) {
            throw new Error(
              `nessuna richiesta al modello porta un image_url — l'immagine non ha attraversato il turno:\n` +
                JSON.stringify(main.map((r) => r.messages), null, 2).slice(0, 2000),
            );
          }
          const prefix = 'data:image/jpeg;base64,';
          const url = urls[0]!;
          if (!url.startsWith(prefix)) {
            throw new Error(`mime inatteso nell'image_url: ${url.slice(0, 60)}`);
          }
          const roundtrip = Buffer.from(url.slice(prefix.length), 'base64');
          if (!roundtrip.equals(FAKE_JPEG)) {
            throw new Error(
              `i byte arrivati al modello non sono quelli scaricati dal Bot API finto ` +
                `(attesi ${FAKE_JPEG.length}, arrivati ${roundtrip.length})`,
            );
          }

          // And the durable record agrees: the arrival is not only visible to
          // the model in this process's memory, it is what the turn itself
          // says happened — `ingest()`'s own line, recorded, not just shown.
          const turn = readTurn(inst, `ORDER BY created_at DESC LIMIT 1`);
          if (!turn || !turn.messages.includes('immagine ricevuta')) {
            throw new Error(`il turno non registra l'arrivo dell'immagine: ${turn?.messages}`);
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    60_000,
  );

  /**
   * Unmanifested — see this file's own docstring for why (the same shape
   * `b-telegram-journey.accept.ts` uses for B1's Telegram half).
   *
   * Falsifier: in `connectors/telegram/delivery.ts#deliverTelegram`, change
   * the `catch` branch to call `store.sent(...)` instead of
   * `store.rejected(...)` when `error instanceof TelegramError` — the
   * "recorded as rejected, not sent" assertion breaks immediately, on a turn
   * whose reply never actually reached the owner's chat. Comment out
   * `throw error` right after `store.rejected(...)` — the "stays pending"
   * half breaks: `resolveBound` would settle the update as delivered on the
   * first, failed attempt, and the retry section below would find nothing
   * left to redeliver.
   */
  it(
    'B10-errori: un rifiuto di Telegram a metà turno resta un fallimento registrato, mai un "consegnato" silenzioso — e il turno successivo lo recupera',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [{ text: 'ecco la risposta numero uno' }, { text: 'tutto ok, eccoti' }],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const gw = await pairOwner(inst, tg, OWNER_ID);
        try {
          // One rejection, for the *delivery*'s own call — not the
          // transcript's preview (`transcript.ts` swallows its own failures
          // on purpose; this rejection is aimed at the call
          // `deliverTelegram`/`TelegramDeliveryStore` actually track).
          // Confirmed against the private-chat shape after the per-room
          // negotiation (#460): the answer forms in a `sendMessageDraft`
          // preview, which is not a message, and the one real message is
          // the delivery's own `sendMessage` — so that is the call this
          // line fails. Before #460 the shape was a transcript `sendMessage`
          // plus a delivery `editMessageText`, and the rejection sat on the
          // edit; a rejection planted on a call the delivery no longer
          // makes is never consumed, and this scenario waited forever.
          tg.guasta('sendMessage', 400, 'Bad Request: fake rejection (B10-errori)');
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'dimmi qualcosa'));

          await until(() => {
            const turn = readTurn(inst, `ORDER BY created_at DESC LIMIT 1`);
            return turn?.delivery?.startsWith('failed:') === true;
          }, 20_000);

          const turn1 = readTurn(inst, `ORDER BY created_at DESC LIMIT 1`);
          if (!turn1) throw new Error('nessun turno dopo il primo messaggio');
          if (turn1.delivery !== 'failed:Telegram 400: Bad Request: fake rejection (B10-errori)') {
            throw new Error(`delivery attesa "failed:…400…", trovata ${JSON.stringify(turn1.delivery)}`);
          }

          // The durable record of *why*, not just *that*: `delivery.ts`'s own
          // point is a `rejected` part, never a silently-promoted `sent` one.
          const statuses = deliveryPartStatuses(inst, turn1.id);
          if (statuses.length !== 1 || statuses[0] !== 'rejected') {
            throw new Error(`atteso esattamente un part 'rejected' per ${turn1.id}, trovato ${JSON.stringify(statuses)}`);
          }

          // === next delivery: a later message is what actually retries it ===
          //
          // `resolveBound`'s own comment: "stays pending; the next drain
          // retries the send, not the model" — nothing here re-asks the
          // provider for turn 1's answer, so the second scripted reply below
          // can only belong to *this* new message.
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'ci sei ancora?'));
          await until(
            () =>
              tg.sent().some((c) => String(c.payload['text'] ?? '').includes('ecco la risposta numero uno')) &&
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('tutto ok, eccoti'),
                ),
            20_000,
          );

          const turn1After = readTurn(inst, `WHERE id = ?`, [turn1.id]);
          if (turn1After?.delivery !== 'sent') {
            throw new Error(`delivery del turno 1 dopo il retry attesa "sent", trovata ${JSON.stringify(turn1After?.delivery)}`);
          }
          const statusesAfter = deliveryPartStatuses(inst, turn1.id);
          if (!statusesAfter.every((s) => s === 'sent')) {
            throw new Error(`part del turno 1 non tutti 'sent' dopo il retry: ${JSON.stringify(statusesAfter)}`);
          }

          // And the model was never asked twice for the same answer: only
          // two calls to the main model in the whole scenario (one per
          // owner message), never a third for a "recomputed" retry.
          const mainCalls = inst.provider.main().length;
          if (mainCalls !== 2) {
            throw new Error(`attese esattamente 2 chiamate al modello principale, viste ${mainCalls} — il retry ha ricalcolato invece di riconsegnare`);
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    60_000,
  );
});
