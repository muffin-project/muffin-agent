import DatabaseCtor from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install, until, type Install } from '../harness.js';
import { callbackQuery, privateMessage, startFakeTelegram, type FakeTelegram } from '../telegram.js';
import { MemoryStore } from '../../../core/memory/store.js';
import { itConSandbox } from '../sandbox-host.js';

/**
 * #783 · La domanda autonoma fra un riavvio: dal click al verdetto senza memoria calda.
 *
 * D12 prova la domanda **ospitata** dalla trascrizione del turno: ask e click
 * avvengono dentro la stessa vita del gateway, con `approvalSulTurno` e
 * `transcriptInSospeso` (`connectors/telegram/connector.ts`) ancora calde a
 * guidare il click verso `resolveAsk`. La domanda **autonoma** — il ripiego di
 * `connectors/telegram/approval.ts#approvatoreTelegram`, o qualunque domanda
 * il cui gateway si riavvia fra ask e click — non ha niente di tutto questo:
 * le tre mappe sono in memoria e il riavvio le azzera. Resta solo ciò che è su
 * disco (la riga `approvals`, il turno `waiting` con barriera `approval:<id>`)
 * e il ramo autonomo di `handleCallback`: decisione nel registro, verdetto
 * scritto sul messaggio con `keyboard: []` nella stessa chiamata, sveglia del
 * turno.
 *
 * Lo scenario fa esattamente questo, due volte: ask → `stop()` + nuovo
 * `gateway()` → click → verdetto sul messaggio + tastiera tolta. La prima
 * metà clicca con la forma testo (`message.text`, come un client che
 * riecheggia una domanda legacy); la seconda con la forma ricca
 * (`message.rich_message` **senza** `text`, la forma delle domande che Muffin
 * manda davvero dal ripiego — il ramo che #759 ha riparato). Ogni asserzione
 * dice quale metà ha fallito: un rosso qui deve nominare «testo» o «ricca»,
 * mai entrambe in silenzio.
 *
 * Falsificatori: svuotare il registro fra ask e click (o renderlo non
 * durevole) fa fallire l'asserzione «la riga ha attraversato il riavvio»;
 * togliere `normalizeInboundRich` dal verdetto fa scadere l'attesa della
 * metà ricca; togliere `keyboard: []` fa fallire l'asserzione «tastiera
 * tolta» in entrambe le metà. Se l'harness non sapesse riavviare il gateway,
 * non c'è un finto equivalente: `install().gateway()` + `stop()` sono il
 * riavvio vero, già usato da `a-lifecycle` e `gateway-execution-owner`.
 *
 * Non registrato nel manifest: D12 è già `verde` e `scenario('D12', …)` una
 * seconda volta registrerebbe un secondo `it()` con lo stesso titolo (stessa
 * ragione di B1/`#746` in `b-telegram-journey.accept.ts`). Come `#746`, resta
 * un `it` fuori inventario che deve stare verde.
 */

const OWNER_ID = 999;

type Gw = Awaited<ReturnType<Install['gateway']>>;
type Chiamata = ReturnType<FakeTelegram['sent']>[number];

/** Da `b-telegram-journey.accept.ts`: l'id owner che `config.json` registra una volta atterrato il pairing. */
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

/**
 * Da `b-telegram-journey.accept.ts`: il pairing di cui nessuna riga qui è
 * *about* (lo prova già `b-telegram-pairing.accept.ts`). Il codice giusto va
 * dritto — la risposta non tocca il modello e non consuma lo script `main`.
 */
async function pairOwner(inst: Install, tg: FakeTelegram, ownerId: number): Promise<Gw> {
  const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-standalone-token');
  if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
  const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
  if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
  const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
  if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);

  // Il gateway legge la config una volta sola, all'avvio: deve partire dopo
  // che `secret set`/`surface enable` sono su disco, o non connette mai il
  // connettore.
  const gw = await inst.gateway();
  await gw.waitFor(/muffin gateway/, 20_000);
  tg.deliver(privateMessage({ id: ownerId, name: 'Owner' }, code));
  await until(() => ownerDalFile(inst.home) === ownerId, 20_000);
  if (ownerDalFile(inst.home) !== ownerId) {
    throw new Error(`owner atteso ${ownerId}, trovato ${String(ownerDalFile(inst.home))}`);
  }
  return gw;
}

/** Da `b-telegram-journey.accept.ts`: un episodio di tier 2 — quanto basta perché l'ask mostri il taint senza scattare in deny. */
function plantTier2Episode(home: string, threadKey: string): void {
  const db = new DatabaseCtor(join(home, 'muffin.db'));
  try {
    new MemoryStore(db).addEpisode({
      tenantId: 'host',
      connector: 'cli',
      threadKey,
      role: 'user',
      kind: 'message',
      content: 'nota interna: promemoria di gruppo su una faccenda qualsiasi',
      trustTier: 2,
      createdAt: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

/** Da `b-telegram-journey.accept.ts`: il testo visibile di una chiamata — legacy `text` o payload ricco. */
const testoDi = (c: Chiamata): string =>
  c.payload['rich_message'] !== undefined
    ? JSON.stringify(c.payload['rich_message'])
    : String(c.payload['text'] ?? '');

type Tastiera = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

/** Una domanda è una chiamata con una tastiera ancora viva — non un verdetto, che la porta esplicitamente vuota. */
const tastieraViva = (c: Chiamata): boolean => {
  const kb = (c.payload['reply_markup'] as Tastiera | undefined)?.inline_keyboard;
  return Array.isArray(kb) && kb.length > 0;
};

function riassuntoChiamate(tg: FakeTelegram): string {
  return JSON.stringify(
    tg.sent().map((c) => ({
      method: c.method,
      messageId: c.messageId,
      payloadMessageId: c.payload['message_id'],
      tastiera: tastieraViva(c),
      text: testoDi(c).slice(0, 120),
    })),
    null,
    2,
  );
}

describe('acceptance · #783 · domanda autonoma: riavvio fra ask e click', () => {
  itConSandbox(
    '#783 approvazione standalone: ask → riavvio del gateway → click → verdetto sul messaggio + tastiera tolta, metà testo e metà ricca',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        // Due turni, ognuno con la forma di D12: il tool, il suo ritentativo
        // dopo la ripresa (un turno ripreso ridomanda al modello), la risposta
        // finale. Lo script attraversa i riavvii: il provider finto è in
        // questo processo, la cursore non si azzera quando il gateway muore.
        main: [
          { tool: { name: 'shell_run_write', args: { command: 'echo primo', cwd: '.', description: 'primo comando' } } },
          { tool: { name: 'shell_run_write', args: { command: 'echo primo', cwd: '.', description: 'primo comando' } } },
          { text: 'fatto, il primo comando ha risposto primo-fatto' },
          { tool: { name: 'shell_run_write', args: { command: 'echo secondo', cwd: '.', description: 'secondo comando' } } },
          { tool: { name: 'shell_run_write', args: { command: 'echo secondo', cwd: '.', description: 'secondo comando' } } },
          { text: 'fatto, il secondo comando ha risposto secondo-fatto' },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        plantTier2Episode(inst.home, 'fixture-783');

        let gw: Gw | undefined = await pairOwner(inst, tg, OWNER_ID);
        /** Il riavvio vero: SIGTERM + un processo nuovo sulla stessa home. Niente mappe in memoria sopravvive. */
        const riavvia = async (): Promise<void> => {
          await gw!.stop();
          gw = undefined;
          const fresco = await inst.gateway();
          gw = fresco;
          await fresco.waitFor(/muffin gateway/, 20_000);
        };
        try {
          // ================= metà testo =================
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'esegui il primo comando'));
          let ask1: Chiamata;
          try {
            await until(() => tg.sent().some((c) => tastieraViva(c) && testoDi(c).includes('echo primo')), 20_000);
            ask1 = tg.sent().filter((c) => tastieraViva(c) && testoDi(c).includes('echo primo')).at(-1)!;
          } catch {
            throw new Error(
              `[standalone/restart · metà testo] la domanda con tastiera per «echo primo» non è mai partita:\n${riassuntoChiamate(tg)}`,
            );
          }
          const ask1MessageId = ask1.messageId;
          if (ask1MessageId === undefined) {
            throw new Error('[standalone/restart · metà testo] il messaggio ASK non ha un id registrato');
          }
          const ok1 = (ask1.payload['reply_markup'] as Tastiera).inline_keyboard
            .flat()
            .find((b) => b.callback_data.startsWith('ok:'));
          if (!ok1) {
            throw new Error(
              `[standalone/restart · metà testo] nessun pulsante "ok:" nella tastiera:\n${JSON.stringify(ask1.payload['reply_markup'])}`,
            );
          }
          const approval1 = ok1.callback_data.slice('ok:'.length);

          await riavvia();

          // Precondizione di durabilità: se la riga non ha attraversato il
          // riavvio, il click non può decidere niente — ed è questo l'anello
          // che nomina, non il click.
          const prima1 = inst.db(
            (db) =>
              db.prepare(`SELECT decision FROM approvals WHERE id = ?`).get(approval1) as
                | { decision: string | null }
                | undefined,
          );
          if (!prima1) {
            throw new Error(
              `[standalone/restart · metà testo] la riga approvals ${approval1} non ha attraversato il riavvio — il registro non è durevole`,
            );
          }
          if (prima1.decision !== null) {
            throw new Error(
              `[standalone/restart · metà testo] la riga approvals ${approval1} è già decisa prima del click: ${JSON.stringify(prima1)}`,
            );
          }

          const dalClick1 = tg.sent().length;
          tg.deliver(
            callbackQuery({ id: OWNER_ID, name: 'Owner' }, `ok:${approval1}`, {
              messageId: ask1MessageId,
              chatId: OWNER_ID,
              text: testoDi(ask1),
            }),
          );

          let verdetto1: Chiamata | undefined;
          try {
            await until(
              () =>
                tg
                  .sent()
                  .some(
                    (c) =>
                      (c.method === 'editMessageText' || c.method === 'editMessageRichText') &&
                      Number(c.payload['message_id']) === ask1MessageId &&
                      testoDi(c).includes('consentito'),
                  ),
              30_000,
            );
            verdetto1 = tg
              .sent()
              .find(
                (c) =>
                  (c.method === 'editMessageText' || c.method === 'editMessageRichText') &&
                  Number(c.payload['message_id']) === ask1MessageId &&
                  testoDi(c).includes('consentito'),
              );
          } catch {
            throw new Error(
              `[standalone/restart · metà testo] il verdetto non è mai stato scritto sul messaggio ${ask1MessageId} dopo il click:\n${riassuntoChiamate(tg)}`,
            );
          }
          if (!testoDi(verdetto1!).includes('echo primo')) {
            throw new Error(
              `[standalone/restart · metà testo] il verdetto non riporta la domanda (base illeggibile?):\n${testoDi(verdetto1!).slice(0, 500)}`,
            );
          }
          const tastiera1 = verdetto1!.payload['reply_markup'] as Tastiera | undefined;
          if (!Array.isArray(tastiera1?.inline_keyboard) || tastiera1.inline_keyboard.length !== 0) {
            throw new Error(
              `[standalone/restart · metà testo] la tastiera non è stata tolta con keyboard: [] nella stessa chiamata del verdetto: ${JSON.stringify(verdetto1!.payload)}`,
            );
          }
          if (!tg.sent().slice(dalClick1).some((c) => c.method === 'answerCallbackQuery')) {
            throw new Error('[standalone/restart · metà testo] nessun answerCallbackQuery dopo il click — il pulsante resta a girare');
          }
          const dopo1 = inst.db(
            (db) =>
              db.prepare(`SELECT decision FROM approvals WHERE id = ?`).get(approval1) as
                | { decision: string | null }
                | undefined,
          );
          if (dopo1?.decision !== 'allow') {
            throw new Error(
              `[standalone/restart · metà testo] decision attesa "allow", trovata ${JSON.stringify(dopo1?.decision)}`,
            );
          }
          try {
            await until(
              () =>
                tg
                  .sent()
                  .some(
                    (c) =>
                      (c.method === 'sendMessage' || c.method === 'editMessageText' || c.method === 'editMessageRichText') &&
                      testoDi(c).includes('primo-fatto'),
                  ),
              30_000,
            );
          } catch {
            const righe = inst.db((db) => db.prepare('SELECT id, capability, decision, consumed_at FROM approvals ORDER BY asked_at').all());
            throw new Error(
              `[standalone/restart · metà testo] il turno non ha ripreso dopo il click (verdetto scritto, ma niente risposta):\n` +
                `approvals: ${JSON.stringify(righe)}\n${riassuntoChiamate(tg)}`,
            );
          }

          // ================= metà ricca =================
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'esegui il secondo comando'));
          let ask2: Chiamata;
          try {
            await until(() => tg.sent().some((c) => tastieraViva(c) && testoDi(c).includes('echo secondo')), 20_000);
            ask2 = tg.sent().filter((c) => tastieraViva(c) && testoDi(c).includes('echo secondo')).at(-1)!;
          } catch {
            throw new Error(
              `[standalone/restart · metà ricca] la domanda con tastiera per «echo secondo» non è mai partita:\n${riassuntoChiamate(tg)}`,
            );
          }
          const ask2MessageId = ask2.messageId;
          if (ask2MessageId === undefined) {
            throw new Error('[standalone/restart · metà ricca] il messaggio ASK non ha un id registrato');
          }
          const ok2 = (ask2.payload['reply_markup'] as Tastiera).inline_keyboard
            .flat()
            .find((b) => b.callback_data.startsWith('ok:'));
          if (!ok2) {
            throw new Error(
              `[standalone/restart · metà ricca] nessun pulsante "ok:" nella tastiera:\n${JSON.stringify(ask2.payload['reply_markup'])}`,
            );
          }
          const approval2 = ok2.callback_data.slice('ok:'.length);
          const ask2Text = testoDi(ask2);

          await riavvia();

          const prima2 = inst.db(
            (db) =>
              db.prepare(`SELECT decision FROM approvals WHERE id = ?`).get(approval2) as
                | { decision: string | null }
                | undefined,
          );
          if (!prima2) {
            throw new Error(
              `[standalone/restart · metà ricca] la riga approvals ${approval2} non ha attraversato il riavvio — il registro non è durevole`,
            );
          }
          if (prima2.decision !== null) {
            throw new Error(
              `[standalone/restart · metà ricca] la riga approvals ${approval2} è già decisa prima del click: ${JSON.stringify(prima2)}`,
            );
          }

          const dalClick2 = tg.sent().length;
          // La forma delle domande che Muffin manda davvero: il messaggio del
          // callback non ha `text`, solo `rich_message` (#759). Niente chiave
          // `text` — nemmeno vuota.
          tg.deliver(
            callbackQuery({ id: OWNER_ID, name: 'Owner' }, `ok:${approval2}`, {
              messageId: ask2MessageId,
              chatId: OWNER_ID,
              richBlocks: [{ type: 'paragraph', text: ask2Text }],
            }),
          );

          let verdetto2: Chiamata | undefined;
          try {
            await until(
              () =>
                tg
                  .sent()
                  .some(
                    (c) =>
                      (c.method === 'editMessageText' || c.method === 'editMessageRichText') &&
                      Number(c.payload['message_id']) === ask2MessageId &&
                      testoDi(c).includes('consentito'),
                  ),
              30_000,
            );
            verdetto2 = tg
              .sent()
              .find(
                (c) =>
                  (c.method === 'editMessageText' || c.method === 'editMessageRichText') &&
                  Number(c.payload['message_id']) === ask2MessageId &&
                  testoDi(c).includes('consentito'),
              );
          } catch {
            throw new Error(
              `[standalone/restart · metà ricca] il verdetto non è mai stato scritto sul messaggio ${ask2MessageId} dopo il click ` +
                `(forma rich_message senza text non letta?):\n${riassuntoChiamate(tg)}`,
            );
          }
          if (!testoDi(verdetto2!).includes('echo secondo')) {
            throw new Error(
              `[standalone/restart · metà ricca] il verdetto non riporta la domanda letta dai blocchi:\n${testoDi(verdetto2!).slice(0, 500)}`,
            );
          }
          const tastiera2 = verdetto2!.payload['reply_markup'] as Tastiera | undefined;
          if (!Array.isArray(tastiera2?.inline_keyboard) || tastiera2.inline_keyboard.length !== 0) {
            throw new Error(
              `[standalone/restart · metà ricca] la tastiera non è stata tolta con keyboard: [] nella stessa chiamata del verdetto: ${JSON.stringify(verdetto2!.payload)}`,
            );
          }
          if (!tg.sent().slice(dalClick2).some((c) => c.method === 'answerCallbackQuery')) {
            throw new Error('[standalone/restart · metà ricca] nessun answerCallbackQuery dopo il click — il pulsante resta a girare');
          }
          const dopo2 = inst.db(
            (db) =>
              db.prepare(`SELECT decision FROM approvals WHERE id = ?`).get(approval2) as
                | { decision: string | null }
                | undefined,
          );
          if (dopo2?.decision !== 'allow') {
            throw new Error(
              `[standalone/restart · metà ricca] decision attesa "allow", trovata ${JSON.stringify(dopo2?.decision)}`,
            );
          }
          try {
            await until(
              () =>
                tg
                  .sent()
                  .some(
                    (c) =>
                      (c.method === 'sendMessage' || c.method === 'editMessageText' || c.method === 'editMessageRichText') &&
                      testoDi(c).includes('secondo-fatto'),
                  ),
              30_000,
            );
          } catch {
            const righe = inst.db((db) => db.prepare('SELECT id, capability, decision, consumed_at FROM approvals ORDER BY asked_at').all());
            throw new Error(
              `[standalone/restart · metà ricca] il turno non ha ripreso dopo il click (verdetto scritto, ma niente risposta):\n` +
                `approvals: ${JSON.stringify(righe)}\n${riassuntoChiamate(tg)}`,
            );
          }
        } finally {
          await gw?.stop();
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});
