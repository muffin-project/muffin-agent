import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';
import { paths } from '../../../core/config/config.js';
import { seal } from '../../../core/rot/verify.js';
import { buildRuntime } from '../../../agent/runtime.js';
import { readDocument } from '../../../agent/tools/document.js';
import { vaultPathPer } from '../../../agent/tools/vault-save.js';
import { install, until } from '../harness.js';
import { scenario } from '../scenario.js';
import { startFakeTelegram } from '../telegram.js';

/**
 * F · Gruppi — cinque righe DAY-1, tutte READY sulla forza di test unitari e
 * di cablaggio, nessuna con uno scenario che le porti sul binario vero.
 *
 * Ognuna qui sotto è la stessa classe di guasto che `AGENTS.md` nomina per
 * prima: un meccanismo con test verdi che la produzione non attraversa mai.
 * `F2` non è qui — vive già in `b-una-conversazione.accept.ts`, e questo file
 * non la duplica (vedi il commento su quella riga in `manifest.ts`).
 */

const RISPOSTA_MENZIONE = 'eccomi, ho sentito la menzione';

describe('acceptance · F1 · gate di gruppo: nessuna menzione, nessun turno', () => {
  /**
   * ADR-0063, `apreUnTurno` (`connectors/telegram/connector.ts`). Il gate è
   * l'unica cosa fra un gruppo attivo e un turno per riga da quando la privacy
   * mode di Telegram è stata spenta — un messaggio di conversazione fra
   * persone non deve mai raggiungere il modello, e uno che nomina Muffin deve
   * raggiungerlo esattamente una volta.
   *
   * `muffin_test_bot` è lo username che il finto Bot API restituisce a
   * `getMe` (`evals/acceptance/telegram.ts`) — la stessa stringa che
   * `b-una-conversazione.accept.ts`'s F2 usa per la stessa ragione.
   */
  scenario(
    'F1',
    async () => {
      const tg = await startFakeTelegram();
      const GROUP = -100_701;
      const SOMEONE = 7001;
      const inst = await install({ main: [{ text: RISPOSTA_MENZIONE }], env: { MUFFIN_GATEWAY_TICK_MS: '200' } });
      try {
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-f1-gate');
        if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);

        const gw = await inst.gateway();
        await gw.waitFor(/muffin gateway/, 20_000);
        try {
          tg.deliver({
            message: {
              message_id: 6001,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'gruppo f1' },
              from: { id: SOMEONE, is_bot: false, first_name: 'Un tizio' },
              text: 'che tempo fa oggi in centro?',
            },
          });

          // Negativo, e a budget per costruzione: se il gate fosse rotto (cioè
          // aprisse un turno per ogni riga) il tick da 200ms basterebbe a
          // farlo vedere ben prima di questo tetto. Un'attesa senza scadenza
          // non proverebbe niente; una che scade sempre nemmeno — qui la
          // scadenza È l'esito atteso, e `until` che la rispetta è il segnale.
          let apertoSenzaMenzione = false;
          try {
            await until(() => inst.provider.main().length > 0, 4_000, 100);
            apertoSenzaMenzione = true;
          } catch {
            // atteso: nessuna chiamata al provider entro il tetto.
          }
          if (apertoSenzaMenzione) {
            throw new Error('un messaggio senza menzione ha aperto un turno: il provider è stato chiamato');
          }
          if (tg.messages().length > 0) {
            throw new Error(`un messaggio senza menzione ha prodotto una risposta: ${JSON.stringify(tg.messages())}`);
          }

          tg.deliver({
            message: {
              message_id: 6002,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'gruppo f1' },
              from: { id: SOMEONE, is_bot: false, first_name: 'Un tizio' },
              text: '@muffin_test_bot che tempo fa oggi in centro?',
            },
          });
          await until(() => tg.messages().some((m) => m.text.includes(RISPOSTA_MENZIONE)), 30_000);
        } finally {
          await gw.stop();
        }

        if (inst.provider.main().length !== 1) {
          throw new Error(`atteso esattamente una chiamata al provider, viste ${inst.provider.main().length}`);
        }
        if (tg.messages().length !== 1) {
          throw new Error(`atteso esattamente un messaggio inviato nel gruppo, visti ${tg.messages().length}`);
        }
        const turni = inst.db((db) => db.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number });
        if (turni.n !== 1) {
          throw new Error(`atteso esattamente un turno nel database, visti ${turni.n}`);
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});

describe('acceptance · F3 · topic di forum: due sotto-conversazioni, non un inquilino nuovo', () => {
  /**
   * PR #415 (`slice/topic-e-sessione`). `identify` (`core/surface/types.ts`)
   * appende `#<threadId>` alla chiave di sessione solo quando la piattaforma
   * dichiara un topic (`is_topic_message`), mai su un `message_thread_id`
   * nudo — che su un supergruppo qualunque marca le catene di risposta, non
   * un topic. `connectors/telegram/topic-di-forum.test.ts` prova la funzione
   * e il cablaggio in-process; qui il gruppo entra dal gateway vero.
   */
  scenario(
    'F3',
    async () => {
      const tg = await startFakeTelegram();
      const GROUP = -100_702;
      const MEMBER = 7002;
      const TOPIC_BUG = 501;
      const TOPIC_SPESA = 777;
      const RISPOSTA_BUG = 'nel topic del bug';
      const RISPOSTA_SPESA = 'nel topic della spesa';
      const inst = await install({
        main: [{ text: RISPOSTA_BUG }, { text: RISPOSTA_SPESA }],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-f3-topic');
        if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);

        const gw = await inst.gateway();
        await gw.waitFor(/muffin gateway/, 20_000);
        try {
          tg.deliver({
            message: {
              message_id: 7101,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'forum f3', is_forum: true },
              from: { id: MEMBER, is_bot: false, first_name: 'Membro' },
              message_thread_id: TOPIC_BUG,
              is_topic_message: true,
              text: '@muffin_test_bot che succede col bug?',
            },
          });
          await until(() => tg.messages().some((m) => m.text.includes(RISPOSTA_BUG)), 30_000);

          tg.deliver({
            message: {
              message_id: 7102,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'forum f3', is_forum: true },
              from: { id: MEMBER, is_bot: false, first_name: 'Membro' },
              message_thread_id: TOPIC_SPESA,
              is_topic_message: true,
              text: '@muffin_test_bot quanto manca per la spesa?',
            },
          });
          await until(() => tg.messages().some((m) => m.text.includes(RISPOSTA_SPESA)), 30_000);
        } finally {
          await gw.stop();
        }

        // Due sessioni distinte, ciascuna col proprio suffisso `#<thread>` —
        // la stringa che `identify` produce, non una scelta di questo test.
        const fileBug = join(inst.home, 'sessions', `telegram:${GROUP}#${TOPIC_BUG}.jsonl`);
        const fileSpesa = join(inst.home, 'sessions', `telegram:${GROUP}#${TOPIC_SPESA}.jsonl`);
        if (!existsSync(fileBug)) throw new Error(`nessuna sessione per il topic bug: ${fileBug}`);
        if (!existsSync(fileSpesa)) throw new Error(`nessuna sessione per il topic spesa: ${fileSpesa}`);
        if (readFileSync(fileBug, 'utf8').includes(RISPOSTA_SPESA)) {
          throw new Error('la risposta del topic spesa è finita nella sessione del topic bug');
        }
        if (readFileSync(fileSpesa, 'utf8').includes(RISPOSTA_BUG)) {
          throw new Error('la risposta del topic bug è finita nella sessione del topic spesa');
        }

        // E la risposta porta il topic sul filo — non solo nella sessione:
        // `reply_parameters` mette nel topic solo il messaggio citato, quindi
        // senza `message_thread_id` esplicito su ogni parte la risposta
        // finisce in *General* (topic-di-forum.test.ts la stessa ragione).
        const sentBug = tg.sent().find((c) => c.method === 'sendMessage' && String(c.payload['text'] ?? '').includes(RISPOSTA_BUG));
        const sentSpesa = tg.sent().find((c) => c.method === 'sendMessage' && String(c.payload['text'] ?? '').includes(RISPOSTA_SPESA));
        if (sentBug?.payload['message_thread_id'] !== TOPIC_BUG) {
          throw new Error(`la risposta del bug non porta message_thread_id=${TOPIC_BUG}: ${JSON.stringify(sentBug)}`);
        }
        if (sentSpesa?.payload['message_thread_id'] !== TOPIC_SPESA) {
          throw new Error(`la risposta della spesa non porta message_thread_id=${TOPIC_SPESA}: ${JSON.stringify(sentSpesa)}`);
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});

describe('acceptance · F4 · uscita dai gruppi dove il proprio umano non c è', () => {
  /**
   * PR #422 (`slice/dove-e-il-mio-umano`), `connectors/telegram/invito.ts`.
   * `connectors/telegram/dove-e-il-mio-umano.test.ts` prova `decidiInvito` e
   * il cablaggio del connettore in-process con un `api` finto scritto a
   * mano; qui l'update entra dal gateway vero contro il Bot API finto, che
   * ha dovuto imparare a rispondere `getChatMember` con una vera `status`
   * (rispondeva `ok(true)` — vedi il commento in `telegram.ts`) e a
   * registrare `leaveChat`.
   */
  scenario(
    'F4',
    async () => {
      const tg = await startFakeTelegram();
      const OWNER_ID = 4400;
      const GROUP = -100_900;
      const STRANGER = 9911;
      const TITOLO = 'gruppo senza owner';
      const inst = await install({
        main: [{ text: 'non dovrebbe mai arrivare qui: un invito non è una conversazione' }],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-f4-uscita');
        if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
        // `--owner` invece della danza di pairing sul filo: questo scenario
        // non prova il pairing (altri lo fanno già), prova solo cosa succede
        // una volta che l'owner esiste.
        const enable = await inst.muffin([
          'surface',
          'enable',
          'telegram',
          '--api-base',
          tg.url,
          '--owner',
          String(OWNER_ID),
        ]);
        if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);

        // Lo scriptaggio della domanda che `gestisciInvito` fa: «il mio
        // umano è in questa stanza?» — no.
        tg.setChatMember(GROUP, OWNER_ID, 'left');

        const gw = await inst.gateway();
        await gw.waitFor(/muffin gateway/, 20_000);
        try {
          tg.deliver({
            my_chat_member: {
              chat: { id: GROUP, type: 'supergroup', title: TITOLO },
              from: { id: STRANGER, is_bot: false, first_name: 'Estraneo', username: 'estraneo' },
              date: Math.floor(Date.now() / 1000),
              old_chat_member: { status: 'left', user: { id: 42, is_bot: true, first_name: 'Muffin' } },
              new_chat_member: { status: 'member', user: { id: 42, is_bot: true, first_name: 'Muffin' } },
            },
          });

          await until(() => tg.sent().some((c) => c.method === 'leaveChat'), 30_000);
        } finally {
          await gw.stop();
        }

        // L'ordine dei tre effetti è deciso (`gestisciInvito`'s own comment):
        // saluto nel gruppo, avviso all'owner, uscita — in questo ordine e
        // non un altro, perché dopo `leaveChat` non si può più scrivere nel
        // gruppo.
        const rilevanti = tg.sent().filter((c) => c.method === 'sendMessage' || c.method === 'leaveChat');
        if (rilevanti.length !== 3) {
          throw new Error(`attesi esattamente 3 effetti (saluto, avviso, uscita), visti ${rilevanti.length}: ${JSON.stringify(rilevanti)}`);
        }
        const [saluto, avviso, uscita] = rilevanti;
        if (saluto?.method !== 'sendMessage' || Number(saluto.payload['chat_id']) !== GROUP) {
          throw new Error(`il primo effetto non è il saluto nel gruppo: ${JSON.stringify(saluto)}`);
        }
        if (!String(saluto.payload['text'] ?? '').includes('Dove è il mio umano')) {
          throw new Error(`il saluto nel gruppo non nomina "Dove è il mio umano": ${JSON.stringify(saluto)}`);
        }
        if (avviso?.method !== 'sendMessage' || Number(avviso.payload['chat_id']) !== OWNER_ID) {
          throw new Error(`il secondo effetto non è l'avviso all'owner: ${JSON.stringify(avviso)}`);
        }
        if (!String(avviso.payload['text'] ?? '').includes(TITOLO)) {
          throw new Error(`l'avviso all'owner non nomina il titolo del gruppo: ${JSON.stringify(avviso)}`);
        }
        if (uscita?.method !== 'leaveChat' || Number(uscita.payload['chat_id']) !== GROUP) {
          throw new Error(`il terzo effetto non è l'uscita dal gruppo giusto: ${JSON.stringify(uscita)}`);
        }

        // Un invito non è una conversazione: il modello non viene mai chiamato.
        if (inst.provider.main().length !== 0) {
          throw new Error(`il modello è stato chiamato per un invito: ${inst.provider.main().length} chiamate`);
        }

        // E senza `my_chat_member` in `allowed_updates` l'invito non arriva
        // affatto — il difetto di partenza di PR #422, riprodotto sul filo
        // vero invece che sul solo `fetch` finto del test unitario.
        const richiesti = tg.lastAllowedUpdates();
        if (!richiesti?.includes('my_chat_member')) {
          throw new Error(`getUpdates non ha chiesto my_chat_member: ${JSON.stringify(richiesti)}`);
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});

describe('acceptance · F5 · un link copiato non è un link composto, anche in gruppo', () => {
  /**
   * ADR-0071, `core/policy/decide.ts#gateParams`, `agent/
   * link-copiato-non-e-composto.test.ts`. Per un principal che non è
   * l'owner — un membro di gruppo — non c'è nessuno a cui chiedere
   * l'approvazione di una query string composta dal modello: il criterio
   * nega, non chiede (misurato in `muffin-nei-gruppi-2026-09-04.md` §6.1,
   * citato nel commento di `gateParams`). La stessa identica query, se è
   * l'utente a incollarla nel messaggio, è **citata** e passa — copiare un
   * link non è comporlo.
   */
  scenario(
    'F5',
    async () => {
      const tg = await startFakeTelegram();
      const GROUP = -100_950;
      const MEMBER = 8001;
      // Byte che il modello si inventa: non compaiono in nessun ingresso del
      // turno — è esattamente ciò che ADR-0071 chiama "composto".
      const INVENTATO = 'https://example.com/?q=inventato-dal-modello';
      // La stessa forma (host reale, query non vuota) ma incollata per intero
      // dal membro nel proprio messaggio — quindi citata. Stesso host che D10
      // già raggiunge per davvero da questa suite.
      const CITATO = 'https://example.com/?x=1';
      const inst = await install({
        main: [
          { tool: { name: 'http_get', args: { url: INVENTATO } } },
          { text: 'non sono riuscito a leggerla' },
          { tool: { name: 'http_get', args: { url: CITATO } } },
          { text: 'fatto, letto' },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-f5-egress');
        if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);

        const gw = await inst.gateway();
        await gw.waitFor(/muffin gateway/, 20_000);
        try {
          // Niente URL nel messaggio: quello che il tool chiederà se lo è
          // inventato il modello, non l'utente.
          tg.deliver({
            message: {
              message_id: 8101,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'gruppo f5' },
              from: { id: MEMBER, is_bot: false, first_name: 'Membro' },
              text: '@muffin_test_bot leggi quella pagina per me',
            },
          });
          // La risposta segue una chiamata di tool, quindi si unisce al
          // messaggio di stato già in volo come un `editMessageText`
          // (`connector.ts#deliverTo`'s merge) invece di arrivare come un
          // `sendMessage` nuovo — stessa forma di `b-una-conversazione.
          // accept.ts`'s own comment, e per la stessa ragione: aspetta su
          // `tg.sent()` direttamente, non su `tg.messages()`.
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('non sono riuscito a leggerla'),
                ),
            30_000,
          );

          const negato = inst.db(
            (db) => db.prepare(`SELECT id, messages FROM turns ORDER BY created_at DESC LIMIT 1`).get() as { id: string; messages: string },
          );
          if (!JSON.stringify(JSON.parse(negato.messages)).includes('resource_denied')) {
            throw new Error(`il turno non registra un resource_denied per la query inventata: ${negato.messages}`);
          }
          // Il kernel nega *prima* di chiamare l'handler (agent/loop.ts,
          // `runTool`'s `case 'deny'` ritorna sopra `recordIntent`) — quindi
          // nessuna riga in `turn_tool_calls`, e nessuna rete (fake o reale)
          // è mai stata raggiunta. Stessa prova di D10 per lo stesso motivo.
          const chiamateNegate = inst.db(
            (db) => db.prepare(`SELECT COUNT(*) AS n FROM turn_tool_calls WHERE tool = 'http_get'`).get() as { n: number },
          );
          if (chiamateNegate.n !== 0) {
            throw new Error(`una http_get negata ha comunque scritto in turn_tool_calls: ${chiamateNegate.n} righe`);
          }

          // Ora lo stesso membro incolla l'URL per intero, nella stessa
          // sessione di gruppo e con lo stesso gateway già in vita: citato,
          // quindi fetchato per davvero.
          tg.deliver({
            message: {
              message_id: 8102,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'gruppo f5' },
              from: { id: MEMBER, is_bot: false, first_name: 'Membro' },
              text: `@muffin_test_bot apri questo: ${CITATO}`,
            },
          });
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('fatto, letto'),
                ),
            30_000,
          );
        } finally {
          await gw.stop();
        }

        const consentito = inst.db(
          (db) => db.prepare(`SELECT id, messages FROM turns ORDER BY created_at DESC LIMIT 1`).get() as { id: string; messages: string },
        );
        if (JSON.stringify(JSON.parse(consentito.messages)).includes('resource_denied')) {
          throw new Error(`l'URL citato per intero è stato negato: ${consentito.messages}`);
        }
        const riga = inst.db(
          (db) =>
            db
              .prepare(`SELECT is_error FROM turn_tool_calls WHERE tool = 'http_get' ORDER BY started_at DESC LIMIT 1`)
              .get() as { is_error: number } | undefined,
        );
        if (!riga || riga.is_error !== 0) {
          throw new Error(`la http_get sull'URL citato non è arrivata all'handler: ${JSON.stringify(riga)}`);
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});

describe('acceptance · F6 · ricordare senza rispondere', () => {
  /**
   * PR #425, `ricordaSenzaRispondere` nel ramo chiuso di `drain()`
   * (`connectors/telegram/connector.ts`). `ricordare-senza-rispondere.test.ts`
   * prova il ramo in-process; qui il messaggio entra dal gateway vero e la
   * prova è la riga in `episodes` del tenant del gruppo — senza turno, senza
   * chiamata al provider, senza risposta.
   */
  scenario(
    'F6',
    async () => {
      const tg = await startFakeTelegram();
      const GROUP = -100_760;
      const SOMEONE = 7601;
      const FRASE = 'il criceto di Sara è scappato di nuovo stasera';
      const inst = await install({ main: [{ text: 'mai chiamato' }], env: { MUFFIN_GATEWAY_TICK_MS: '200' } });
      try {
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-f6-ricordo');
        if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);

        const gw = await inst.gateway();
        await gw.waitFor(/muffin gateway/, 20_000);
        try {
          tg.deliver({
            message: {
              message_id: 7601,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'gruppo f6' },
              from: { id: SOMEONE, is_bot: false, first_name: 'Sara' },
              text: FRASE,
            },
          });
          // La prova positiva: l'episodio compare. Il tetto è generoso perché
          // il polling del finto Bot API è a 200ms e il drain scrive subito.
          await until(
            () =>
              inst.db(
                (db) =>
                  (db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE tenant_id = ? AND content LIKE ?`).get(`group:telegram:${GROUP}`, `%criceto%`) as {
                    n: number;
                  }).n > 0,
              ),
            20_000,
            200,
          );
        } finally {
          await gw.stop();
        }

        const ep = inst.db(
          (db) =>
            db
              .prepare(`SELECT tenant_id, connector, thread_key, role, trust_tier, turn_id FROM episodes WHERE tenant_id = ? AND content LIKE ?`)
              .all(`group:telegram:${GROUP}`, `%criceto%`) as Array<Record<string, unknown>>,
        );
        if (ep.length !== 1) throw new Error(`atteso un episodio del gruppo, visti ${ep.length}: ${JSON.stringify(ep)}`);
        const riga = ep[0]!;
        if (riga['role'] !== 'user' || riga['turn_id'] !== null || riga['thread_key'] !== `telegram:${GROUP}` || riga['connector'] !== 'telegram') {
          throw new Error(`l'episodio non ha la forma attesa (user, senza turno, sessione del gruppo): ${JSON.stringify(riga)}`);
        }
        if (inst.provider.main().length !== 0) {
          throw new Error(`il provider è stato chiamato per un messaggio non indirizzato: ${inst.provider.main().length} volte`);
        }
        if (tg.messages().length !== 0) {
          throw new Error(`un messaggio non indirizzato ha prodotto una risposta: ${JSON.stringify(tg.messages())}`);
        }
        const turni = inst.db((db) => db.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number });
        if (turni.n !== 0) throw new Error(`atteso nessun turno, visti ${turni.n}`);
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});

describe('acceptance · F7 · una stanza ha le sue capacità, e dentro il suo vault non chiede', () => {
  /**
   * ADR-0073 punti 1, 2, 3 e 5, sul binario vero e in un ordine che nessun
   * test unitario può riprodurre: **la stessa stanza, prima e dopo il
   * sigillo**.
   *
   * È la forma che questa fetta richiede perché il grant non è un flag di
   * processo: è un campo di `rot/policy.json`, cioè un file che `muffin rot
   * verify` copre e che `buildRuntime` legge **una volta, all'avvio**. Un
   * test che costruisse la `PolicyMatrix` a mano proverebbe `grantedTo` e non
   * proverebbe la sola cosa che l'owner deve poter fare: scriverlo,
   * risigillare, e vedere la stanza cambiare comportamento al riavvio
   * successivo. Quindi due vite del gateway, la seconda con il file sigillato
   * in mezzo — la stessa manopola, e lo stesso `seal(...)`, che D16 usa per
   * rimettere il soffitto della riga `host`.
   *
   * Le quattro affermazioni, in quest'ordine dentro lo scenario:
   *
   *  (a) senza grant: `vault_save` è respinto al confine dei tenant
   *      (`principal_forbidden`), nessun file compare nel vault, e Muffin lo
   *      dice invece di fingere;
   *  (b) con grant: lo stesso membro salva, **senza nessun `ask`** — la riga
   *      `vault` non chiede — e i byte sono nel vault del tenant
   *      `group:telegram:<id>`;
   *  (c) `documents.read` di quella stanza li ritrova, e il tenant `host` no:
   *      il vault è uno, il confine è nell'indice;
   *  (d) nella stessa stanza e con lo stesso sigillo, `shell_run` resta
   *      `deny`. Un grant aggiunge per nome, e `sys.shell` non è nemmeno
   *      nominabile.
   */
  scenario(
    'F7',
    async () => {
      const tg = await startFakeTelegram();
      const GROUP = -100_970;
      const MEMBER = 9701;
      const TENANT = `group:telegram:${GROUP}`;
      const TITOLO = 'orari della portineria';
      const TESTO = 'aperta dalle 8 alle 12, chiusa il sabato';
      const SENZA = 'in questa stanza non posso salvare niente';
      const CON = 'fatto, l ho salvato qui';
      const NIENTE_SHELL = 'la shell in questa stanza non ce l ho';

      const inst = await install({
        main: [
          // (a) — la stanza non ha ancora nessun grant.
          { tool: { name: 'vault_save', args: { titolo: TITOLO, testo: TESTO } } },
          { text: SENZA },
          // (b) — stessa stanza, sigillo riscritto fra i due gateway.
          { tool: { name: 'vault_save', args: { titolo: TITOLO, testo: TESTO } } },
          { text: CON },
          // (d) — e la shell, nella stanza che adesso salva.
          { tool: { name: 'shell_run', args: { command: 'echo ciao' } } },
          { text: NIENTE_SHELL },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-f7-grant');
        if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);

        const salvato = vaultPathPer(TENANT, TITOLO);
        const sulDisco = join(paths(inst.home).vault, salvato);

        // ─────────── (a) la stanza senza grant ───────────
        const gw1 = await inst.gateway();
        await gw1.waitFor(/muffin gateway/, 20_000);
        try {
          tg.deliver({
            message: {
              message_id: 9701,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'gruppo f7' },
              from: { id: MEMBER, is_bot: false, first_name: 'Membro' },
              text: `@muffin_test_bot salva questi orari: ${TESTO}`,
            },
          });
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes(SENZA),
                ),
            30_000,
          );
        } finally {
          await gw1.stop();
        }

        const negato = inst.db(
          (db) =>
            db.prepare(`SELECT messages FROM turns ORDER BY created_at DESC LIMIT 1`).get() as {
              messages: string;
            },
        );
        if (!JSON.stringify(JSON.parse(negato.messages)).includes('principal_forbidden')) {
          throw new Error(
            `senza grant, vault_save doveva essere respinto al confine dei tenant: ${negato.messages.slice(0, 800)}`,
          );
        }
        if (existsSync(sulDisco)) {
          throw new Error(`una stanza senza grant ha scritto nel vault: ${sulDisco}`);
        }

        // ─────────── il sigillo: la manopola dell'owner ───────────
        // `tenants` nomina **questa** stanza e **queste** capability. Il file
        // sta dentro il manifest della radice di fiducia, quindi va risigillato
        // o la home riparte in safe mode invece di leggerlo (stessa cosa che
        // fa `muffin rot reseal`).
        writeFileSync(
          join(paths(inst.home).rot, 'policy.json'),
          JSON.stringify(
            { schemaVersion: 1, tenants: { [TENANT]: { grants: ['vault.write', 'turn.todo'] } } },
            null,
            2,
          ),
        );
        seal(inst.home, '1', new Date());

        // Il grant è visibile all'owner senza aprire il JSON: è l'unica cosa
        // che questo file allarga, quindi doctor la nomina.
        const doctor = await inst.muffin(['doctor']);
        if (!doctor.out.includes(TENANT) || !doctor.out.includes('vault.write')) {
          throw new Error(`doctor non elenca la stanza con grant:\n${doctor.out}`);
        }

        // ─────────── (b), (c), (d) la stessa stanza, col grant ───────────
        const gw2 = await inst.gateway();
        await gw2.waitFor(/muffin gateway/, 20_000);
        try {
          tg.deliver({
            message: {
              message_id: 9702,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'gruppo f7' },
              from: { id: MEMBER, is_bot: false, first_name: 'Membro' },
              text: `@muffin_test_bot adesso salvali: ${TESTO}`,
            },
          });
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes(CON),
                ),
            30_000,
          );

          tg.deliver({
            message: {
              message_id: 9703,
              date: Math.floor(Date.now() / 1000),
              chat: { id: GROUP, type: 'supergroup', title: 'gruppo f7' },
              from: { id: MEMBER, is_bot: false, first_name: 'Membro' },
              text: '@muffin_test_bot elenca i file di questa macchina',
            },
          });
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes(NIENTE_SHELL),
                ),
            30_000,
          );
        } finally {
          await gw2.stop();
        }

        // (b) i byte esistono, e sono quelli.
        if (!existsSync(sulDisco)) {
          throw new Error(`col grant, il membro non ha salvato niente: manca ${sulDisco}`);
        }
        if (!readFileSync(sulDisco, 'utf8').includes(TESTO)) {
          throw new Error(`il file salvato non contiene il testo del membro: ${sulDisco}`);
        }

        // (b) e **nessun ask**: la riga `vault` non chiede, a nessun taint. In
        // un gruppo un ask non raggiunge nessuno che possa rispondere, quindi
        // una riga qui sarebbe un divieto travestito.
        const ask = inst.db(
          (db) =>
            db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE capability = 'vault.write'`).get() as {
              n: number;
            },
        );
        if (ask.n !== 0) {
          throw new Error(`un membro ha salvato nel proprio vault e gli e' stato chiesto: ${ask.n} approvazioni`);
        }
        // La chiamata è arrivata all'handler (il kernel ha detto `draft`, non
        // `deny`): senza questa riga «nessun ask» sarebbe vero anche per un
        // rifiuto.
        const riga = inst.db(
          (db) =>
            db
              .prepare(
                `SELECT is_error FROM turn_tool_calls WHERE tool = 'vault_save' ORDER BY started_at DESC LIMIT 1`,
              )
              .get() as { is_error: number } | undefined,
        );
        if (!riga || riga.is_error !== 0) {
          throw new Error(`vault_save non e' arrivata all'handler col grant: ${JSON.stringify(riga)}`);
        }

        // (c) il documento è nel tenant della stanza, e `host` non lo vede.
        const perTenant = inst.db(
          (db) =>
            db
              .prepare(
                `SELECT tenant_id AS tenant, COUNT(*) AS n FROM episodes WHERE vault_path = ? AND superseded_at IS NULL GROUP BY tenant_id`,
              )
              .all(salvato) as Array<{ tenant: string; n: number }>,
        );
        const dellaStanza = perTenant.find((r) => r.tenant === TENANT);
        if (!dellaStanza || dellaStanza.n === 0) {
          throw new Error(`il salvataggio non e' in memoria del tenant della stanza: ${JSON.stringify(perTenant)}`);
        }
        if (perTenant.some((r) => r.tenant !== TENANT)) {
          throw new Error(`il salvataggio di una stanza e' finito anche in un altro tenant: ${JSON.stringify(perTenant)}`);
        }

        // La stessa cosa dal lato del tool che il modello userebbe:
        // `document_read` della stanza lo ritrova, quello di `host` no.
        const runtime = buildRuntime(inst.home, inst.workspace);
        try {
          const daStanza = await readDocument(runtime.vault, runtime.memory.store, TENANT, { path: salvato });
          if (daStanza.isError === true || !daStanza.content.includes(TESTO)) {
            throw new Error(`document_read della stanza non ritrova il salvataggio: ${daStanza.content.slice(0, 300)}`);
          }
          const daHost = await readDocument(runtime.vault, runtime.memory.store, 'host', { path: salvato });
          if (daHost.isError !== true || daHost.content.includes(TESTO)) {
            throw new Error(`il tenant host vede il vault di una stanza: ${daHost.content.slice(0, 300)}`);
          }
        } finally {
          runtime.close();
        }

        // (d) e la shell resta fuori, nella stanza che salva.
        const ultimo = inst.db(
          (db) =>
            db.prepare(`SELECT messages FROM turns ORDER BY created_at DESC LIMIT 1`).get() as {
              messages: string;
            },
        );
        if (!JSON.stringify(JSON.parse(ultimo.messages)).includes('principal_forbidden')) {
          throw new Error(`shell_run doveva restare negata nella stanza con grant: ${ultimo.messages.slice(0, 800)}`);
        }
        const shell = inst.db(
          (db) =>
            db.prepare(`SELECT COUNT(*) AS n FROM turn_tool_calls WHERE tool = 'shell_run'`).get() as { n: number },
        );
        if (shell.n !== 0) {
          throw new Error(`una shell_run negata ha comunque raggiunto l'handler: ${shell.n} righe`);
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    300_000,
  );
});
