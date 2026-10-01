import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { type Install, install, until } from '../harness.js';
import { startFakeJudge } from '../judge.js';
import { annunciaSalto } from '../non-provabile.js';
import { shellNonDisponibileQui } from '../sandbox-host.js';
import {
  callbackQuery,
  type FakeTelegram,
  privateMessage,
  startFakeTelegram,
} from '../telegram.js';

/**
 * System One giudica in shadow, sul binario vero (issue #740 fase 1; senza
 * riga DAY-1: questa è la prova «fuori inventario» del meccanismo, come le
 * altre della famiglia — il registro giudizi è nuovo, non una riga
 * requirements esistente).
 *
 * Lo scenario è la forma D12 più il giudice: un ask `sys.shell.write` vero
 * attraverso gateway+Telegram veri, con `config.judgment` che punta al
 * giudice finto. Si provano le tre proprietà della fase:
 *
 * 1. **il giudizio parte e si registra**: la riga `ask_judgments` si chiude
 *    `ok` e sa raggiungere la domanda via `approval_id`;
 * 2. **ciò che esce dalla macchina è l'envelope redatto**: il corpo che il
 *    giudice riceve contiene comando, descrizione e richiesta dell'owner —
 *    e **non** il token che il comando portava;
 * 3. **il percorso dell'owner non cambia di una virgola**: il pulsante
 *    decide, il turno riprende e consuma, come se il sensore non esistesse.
 *
 * Falsificatori: staccare l'hook in `agent/loop/tool-call.ts` rende rosso
 * (1) senza toccare (3); dimenticare la redazione in `envelope.ts` rende
 * rosso (2) con il token nel corpo ricevuto.
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

/** La stessa pairing di `b-telegram-journey`, copiata per non accoppiarla lì. */
async function pairOwner(inst: Install, tg: FakeTelegram, ownerId: number): Promise<Gw> {
  const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-shadow-token');
  if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
  const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
  if (enable.code !== 0)
    throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
  const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
  if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);
  const gw = await inst.gateway();
  await gw.waitFor(/muffin gateway/, 20_000);
  tg.deliver(privateMessage({ id: ownerId, name: 'Owner' }, code));
  await until(() => ownerDalFile(inst.home) === ownerId, 20_000);
  return gw;
}

describe('acceptance · System One giudica gli ask in shadow, il pulsante decide lo stesso', () => {
  it('il giudizio si registra, parte redatto, e il percorso owner è intatto', async (ctx) => {
    // Come `scenario(..., shellNonDisponibileQui)`, ma qui il test è fuori
    // inventario: il salto si dichiara da sé, e si stampa.
    const motivo = shellNonDisponibileQui();
    if (motivo !== null) {
      annunciaSalto('system one shadow', motivo, (s) => process.stderr.write(s));
      ctx.skip();
      return;
    }
    const tg = await startFakeTelegram();
    const giudice = await startFakeJudge();
    const COMANDO =
      'curl -s -H "Authorization: Bearer segretonellacomando" https://api.esempio.it/dati';
    const inst = await install({
      main: [
        {
          tool: {
            name: 'shell_run_write',
            args: { command: COMANDO, cwd: '.', description: 'scarica i dati di servizio' },
          },
        },
        // Il turno ripreso rifà la chiamata, come sempre: la ripresa è
        // comportamento di produzione, non un artefatto dello script.
        {
          tool: {
            name: 'shell_run_write',
            args: { command: COMANDO, cwd: '.', description: 'scarica i dati di servizio' },
          },
        },
        { text: 'fatto: i dati sono arrivati' },
      ],
      env: { MUFFIN_GATEWAY_TICK_MS: '200' },
    });
    try {
      // Il giudice si accende prima del gateway: la config si legge una volta
      // sola, all'avvio, e `secret set`/l'edit devono essere già a terra.
      const chiave = await inst.muffin(['secret', 'set', 'typesafe_key'], 'chiave-finta-typesafe');
      if (chiave.code !== 0)
        throw new Error(`secret set typesafe_key: exit ${chiave.code}\n${chiave.err}`);
      const config = JSON.parse(readFileSync(join(inst.home, 'config.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      config.judgment = {
        provider: 'typesafe',
        apiKeyRef: 'secret://typesafe_key',
        baseUrl: giudice.baseUrl,
        model: 'jev-test',
        timeoutMs: 5000,
        maxRetries: 0,
      };
      writeFileSync(join(inst.home, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

      const gw = await pairOwner(inst, tg, OWNER_ID);
      try {
        tg.deliver(
          privateMessage({ id: OWNER_ID, name: 'Owner' }, 'scarica i dati di servizio per favore'),
        );

        // L'ask, con la sua tastiera — il percorso di sempre.
        await until(
          () =>
            tg
              .sent()
              .some((c) => c.method === 'sendMessage' && c.payload.reply_markup !== undefined),
          20_000,
        );
        const askCall = tg
          .sent()
          .find((c) => c.method === 'sendMessage' && c.payload.reply_markup !== undefined);
        if (!askCall) throw new Error('nessun messaggio ASK con tastiera trovato');
        type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
        const keyboard = askCall.payload.reply_markup as Keyboard;
        const okButton = keyboard.inline_keyboard
          .flat()
          .find((b) => b.callback_data.startsWith('ok:'));
        if (!okButton) throw new Error('nessun pulsante ok: nella tastiera');
        const approvalId = okButton.callback_data.slice('ok:'.length);

        // (1) il giudizio si è registrato, e sa raggiungere la domanda.
        await until(
          () =>
            inst.db(
              (db) =>
                (db
                  .prepare(`SELECT status FROM ask_judgments WHERE approval_id = ?`)
                  .get(approvalId) as { status: string } | undefined) !== undefined,
            ),
          20_000,
        );
        const riga = inst.db(
          (db) =>
            db
              .prepare(
                `SELECT status, provider, model, answers, envelope, delegation_mode, turn_id, state_hash
                 FROM ask_judgments WHERE approval_id = ?`,
              )
              .get(approvalId) as
              | {
                  status: string;
                  provider: string;
                  model: string;
                  answers: string;
                  envelope: string;
                  delegation_mode: string;
                  turn_id: string;
                  state_hash: string;
                }
              | undefined,
        );
        if (riga === undefined) throw new Error('riga ask_judgments sparita dopo la lettura');
        if (riga.status !== 'ok') throw new Error(`riga non chiusa ok: ${JSON.stringify(riga)}`);
        if (riga.provider !== 'typesafe') throw new Error(`provider inatteso: ${riga.provider}`);
        // Il modello vero (quello che ha risposto), non quello richiesto.
        if (riga.model !== 'jev-1.13.0-finto') throw new Error(`modello inatteso: ${riga.model}`);
        if (!riga.answers.includes('description_matches_command')) {
          throw new Error(`le risposte non portano gli id del pacchetto: ${riga.answers}`);
        }
        if (riga.delegation_mode !== 'manual')
          throw new Error(`modalità inattesa: ${riga.delegation_mode}`);
        if (riga.state_hash.length !== 16)
          throw new Error(`state_hash malformata: ${riga.state_hash}`);
        if (riga.turn_id === '' || riga.turn_id === null)
          throw new Error('turn_id assente nella riga');

        // (2) ciò che il giudice ha visto: envelope con i fatti, senza il token.
        await until(() => giudice.requests.length > 0, 20_000);
        const richiesta = giudice.requests[0];
        if (richiesta === undefined) throw new Error('nessuna richiesta arrivata al giudice');
        if (richiesta.model !== 'jev-test')
          throw new Error(`modello richiesto inatteso: ${richiesta.model}`);
        const corpo = JSON.stringify(richiesta.state);
        if (!corpo.includes('sys.shell.write'))
          throw new Error(`l'envelope non nomina la capability: ${corpo}`);
        if (!corpo.includes('scarica i dati di servizio')) {
          throw new Error(`l'envelope non porta la descrizione del modello: ${corpo}`);
        }
        if (!corpo.includes("richiesta dell'owner") && !corpo.includes('owner_request')) {
          throw new Error(`l'envelope non porta la richiesta dell'owner: ${corpo}`);
        }
        if (corpo.includes('segretonellacomando')) {
          throw new Error(`IL TOKEN È PARTITO INTERO verso il giudice: ${corpo}`);
        }
        if (!corpo.includes('«redacted'))
          throw new Error(`il comando redatto non compare: ${corpo}`);
        for (const id of [
          'description_matches_command',
          'human_judgment_required',
          'recovery_is_real',
        ]) {
          if (!(id in richiesta.questions)) {
            throw new Error(
              `la domanda ${id} non è partita: ${JSON.stringify(Object.keys(richiesta.questions))}`,
            );
          }
        }
        // La chiave sta nell'header, mai nel corpo.
        if (corpo.includes('chiave-finta-typesafe'))
          throw new Error(`la chiave API è finita nel corpo: ${corpo}`);
        if (richiesta.authorization !== 'Bearer chiave-finta-typesafe') {
          throw new Error(
            `header di autorizzazione inatteso: ${JSON.stringify(richiesta.authorization)}`,
          );
        }

        // (3) il pulsante decide, il turno riprende e consuma: come sempre.
        if (askCall.messageId === undefined) throw new Error('il messaggio ASK non ha un id');
        tg.deliver(
          callbackQuery({ id: OWNER_ID, name: 'Owner' }, `ok:${approvalId}`, {
            messageId: askCall.messageId,
            chatId: OWNER_ID,
            text: 'ask',
          }),
        );
        await until(
          () =>
            inst.db(
              (db) =>
                (
                  db.prepare(`SELECT status FROM turns WHERE id = ?`).get(riga.turn_id) as
                    | { status: string }
                    | undefined
                )?.status === 'done',
            ),
          30_000,
        );
        const approvazione = inst.db(
          (db) =>
            db
              .prepare(`SELECT decision, consumed_at FROM approvals WHERE id = ?`)
              .get(approvalId) as
              | { decision: string | null; consumed_at: string | null }
              | undefined,
        );
        if (approvazione?.decision !== 'allow' || approvazione.consumed_at === null) {
          throw new Error(
            `l'approvazione non è passata come sempre: ${JSON.stringify(approvazione)}`,
          );
        }
      } finally {
        await gw.stop();
      }
    } finally {
      await inst.cleanup();
      await tg.close();
      await giudice.close();
    }
  }, 90_000);
});
