import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { install, until, type Install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS } from '../turn-budget.js';
import type { ScriptedReply } from '../provider.js';
import { privateMessage, startFakeTelegram, type FakeTelegram } from '../telegram.js';

/**
 * B · Misura di parità fra superfici, prima di toccare il soffitto di `fs.write`.
 *
 * La domanda che questo file esiste per rispondere è **quale delle due cause**
 * produce il fallimento osservato il 02/09 («su Telegram scrivere un file dopo
 * averne letto uno è un DENY, dalla CLI no»):
 *
 *  1. una divergenza superficie/kernel — la stessa richiesta, lo stesso
 *     principal e la stessa history decidono diverso a seconda di *dove*
 *     entrano. Sarebbe un difetto del kernel, e verrebbe prima di qualunque
 *     manopola sul soffitto;
 *  2. la **vita della sessione** — porte diverse aprivano conversazioni
 *     diverse. Stessa regola, contesti diversi, quindi taint ambiente diverso.
 *
 *     **Aggiornato da ADR-0056 (03/09).** Quella frase descriveva tre id
 *     scritti a mano: la CLI headless una sessione nuova a ogni invocazione, il
 *     REPL una per lancio, Telegram `telegram:<chatId>` per sempre. Oggi la
 *     chiave la decide `identify` (`core/surface/types.ts`) e per l'owner è
 *     `owner` su ogni porta, quindi il REPL e Telegram condividono la
 *     conversazione — è il fix del failure «non sembra lo stesso muffin», ed è
 *     esattamente ciò che rende questa misura più forte, non più debole: le tre
 *     righe qui sotto continuano a dover coincidere. Resta per-invocazione solo
 *     `cli/run.ts`, di proposito («a script run in a loop should not silently
 *     accumulate a conversation»), ed è la porta su cui il controllo del punto 4
 *     isola la variabile — ora con due `--session` **espliciti**, perché una
 *     misura che si appoggia a un default è una misura che una scelta di default
 *     può azzerare in silenzio.
 *
 * Le due ipotesi si separano con una sola misura: **a parità di history** —
 * ogni superficie legge lo stesso file nel turno 1 e chiede la stessa
 * scrittura nel turno 2 — l'esito del kernel deve essere identico. Se non lo
 * è, il difetto è (1) e il soffitto non c'entra. Se lo è, la sola variabile
 * rimasta è la sessione, e il controllo qui sotto la isola: la stessa CLI,
 * lo stesso script del provider, due sessioni **diverse** invece di una.
 *
 * Falsificatore: dai a Telegram (o al REPL) un `initialTaint`/una finestra di
 * history propria — per esempio togli `historyTaint(...)` dal ramo del lane in
 * `agent/loop.ts#drive`, o cambia `MAX_HISTORY_TURNS` per una sola superficie
 * — e le tre righe smettono di coincidere: è esattamente la divergenza che
 * questo scenario deve saper vedere.
 *
 * ## L'esito, in tre passaggi
 *
 * **02/09.** Nessuna divergenza, e a taint 2 la scrittura è un
 * `deny/taint_exceeded` ovunque.
 *
 * **ADR-0053.** Quel `deny` non era una decisione ma una trascrizione mancata:
 * la riga *Shell / filesystem host / processi* della matrice dice `ASK` a
 * taint 2, e solo `sys.shell` l'aveva ricevuta. Il soffitto passa alla riga di
 * effetto, e la cella condivisa diventa una **domanda**.
 *
 * **ADR-0074, 06/09.** La domanda sparisce, e sparisce per la ragione che
 * l'ADR misura: quel cancello scattava su una scrittura che ha una copia e un
 * `muffin undo` dietro, cioè su una delle poche cose in questo sistema che si
 * possono davvero rimettere a posto. Il taint continua a **negare** sopra il
 * soffitto della riga (a taint 3 `fs.write` resta `deny`, invariato da
 * ADR-0044) e non trasforma più un `draft` in un `ask`. La cella condivisa è
 * quindi: **il file viene scritto, dopo che una copia è finita nel giornale.**
 *
 * La parità è la claim che non cambia, ed è la ragione per cui questo file
 * resta: le tre superfici devono continuare a rispondere identico, qualunque
 * sia la cella. Il segnale confrontato è cambiato con la cella — non più il
 * codice di rifiuto, non più la riga di `approvals`, ma la coppia «file
 * scritto + copia nel giornale», che è la stessa su tutte e tre. Le altre due
 * colonne restano stampate e asserite a **zero**: un rifiuto o una domanda che
 * ricomparissero su una sola superficie sarebbero esattamente la divergenza
 * che questo scenario esiste per vedere.
 */

const OWNER_ID = 4242;

/** Turno 1: leggi (il disco vale `DISK_TIER` = 2). Turno 2: scrivi. Identico su tutte le superfici. */
const SCRIPT: ScriptedReply[] = [
  { tool: { name: 'fs_read', args: { path: 'dati.txt' } } },
  { text: 'letto: la somma è 6' },
  { tool: { name: 'fs_write', args: { path: 'esito.txt', content: 'totale 6' } } },
  { text: 'ho provato a scrivere esito.txt' },
];

const LEGGI = 'leggi dati.txt e dimmi la somma';
const SCRIVI = 'scrivi il totale in esito.txt';

type Esito = {
  superficie: string;
  sessione: string;
  taint: number;
  /** Il codice di rifiuto del kernel, se ha rifiutato. */
  codice: string | null;
  /** Il taint della richiesta di approvazione registrata, se ha chiesto. */
  chiesto: number | null;
  scritto: boolean;
  /**
   * Una copia del file è finita nel giornale prima della scrittura?
   *
   * Il segnale che ADR-0074 rende centrale: da qui in poi la scrittura non
   * chiede più, quindi ciò che deve essere identico sulle tre superfici è che
   * **il `draft` abbia preso il suo checkpoint**. Senza questa colonna la
   * misura direbbe soltanto «il file c'è», che è vero anche di una scrittura
   * senza rete di sicurezza.
   */
  giornale: boolean;
};

/** Il turno **della scrittura**, scelto per contenuto e non per posizione: `LIMIT 1` sull'ultima riga prenderebbe qualunque turno di coda (un job, una consolidazione) come se fosse questo. */
function turnoDellaScrittura(inst: Install): { taint: number; messages: string; session_id: string; surface: string } {
  const row = inst.db(
    (db) =>
      db
        .prepare(
          `SELECT taint, messages, session_id, surface FROM turns
             WHERE messages LIKE '%esito.txt%'
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get() as { taint: number; messages: string; session_id: string; surface: string } | undefined,
  );
  if (!row) throw new Error('nessun turno ha mai nominato esito.txt: lo script del provider non è stato consumato');
  return row;
}

/**
 * La domanda registrata per `fs.write`, se c'è.
 *
 * È il segnale uniforme fra le tre superfici, e va letto dal database e non
 * dalla risposta: la CLI stampa un exit code, il REPL una riga, Telegram una
 * tastiera, e confrontare *quelli* misurerebbe tre rendering invece di una
 * decisione. `core/approvals/store.ts` registra capability, risorsa e il taint
 * al momento della domanda: quella riga è la stessa ovunque.
 */
function approvazioneScrittura(inst: Install): number | null {
  const row = inst.db(
    (db) =>
      db
        .prepare(
          `SELECT taint FROM approvals WHERE capability = 'fs.write'
             ORDER BY asked_at DESC, rowid DESC LIMIT 1`,
        )
        .get() as { taint: number } | undefined,
  );
  return row?.taint ?? null;
}

/**
 * Il giornale di undo ha una copia di qualcosa, per questa installazione.
 *
 * Letto dal disco (`~/.muffin/undo/<turno>/manifest.json`) e non dal
 * database, perché è lì che il `draft` mette la sua rete di sicurezza
 * (`core/undo/journal.ts`) ed è quello che `muffin undo` rimetterebbe.
 */
function giornaleHaUnaCopia(inst: Install): boolean {
  const root = join(inst.home, 'undo');
  if (!existsSync(root)) return false;
  return readdirSync(root).some((turno) => existsSync(join(root, turno, 'manifest.json')));
}

function esito(inst: Install, superficie: string): Esito {
  const row = turnoDellaScrittura(inst);
  const codice = /"?(taint_exceeded|resource_denied|no_capability|safe_mode|rot_violation)"?/.exec(row.messages)?.[1] ?? null;
  return {
    superficie,
    sessione: row.session_id,
    taint: row.taint,
    codice,
    chiesto: approvazioneScrittura(inst),
    scritto: existsSync(join(inst.workspace, 'esito.txt')),
    giornale: giornaleHaUnaCopia(inst),
  };
}

function semina(inst: Install): void {
  writeFileSync(join(inst.workspace, 'dati.txt'), '1 2 3\n', 'utf8');
}

/** Il pairing, che non consuma nessuna risposta scriptata: un codice giusto lo risolve il connettore. */
async function pairOwner(inst: Install, tg: FakeTelegram): Promise<Awaited<ReturnType<Install['gateway']>>> {
  const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-parita-token');
  if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
  const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
  if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
  const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
  if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);
  const gw = await inst.gateway();
  await gw.waitFor(/muffin gateway/, 20_000);
  tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, code));
  await until(() => {
    try {
      const c = JSON.parse(readFileSync(join(inst.home, 'config.json'), 'utf8')) as {
        surfaces?: { telegram?: { ownerUserId?: number } };
      };
      return c.surfaces?.telegram?.ownerUserId === OWNER_ID;
    } catch {
      return false;
    }
  }, 20_000);
  return gw;
}

describe('acceptance · parità di superficie · stesso principal, stessa history, stessa richiesta', () => {
  it(
    'read → write decide identico su CLI, REPL e Telegram; cambia solo se cambia la sessione',
    async () => {
      const misure: Esito[] = [];

      // 1 · CLI, due processi, **una** sessione: la vita della sessione è
      // quella di Telegram, la superficie no.
      const cli = await install({ main: SCRIPT });
      try {
        semina(cli);
        const uno = await cli.muffin(['run', '--session', 'parita', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), LEGGI]);
        if (uno.code !== 0) throw new Error(`CLI turno 1: exit ${uno.code}\n${uno.err}`);
        const due = await cli.muffin(['run', '--session', 'parita', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), SCRIVI]);
        // 3 = «serve un'approvazione» (`cli/run.ts`): dopo ADR-0053 questa è la
        // risposta attesa, non un errore.
        if (![0, 1, 3].includes(due.code)) throw new Error(`CLI turno 2: exit ${due.code}\n${due.err}`);
        misure.push(esito(cli, 'cli --session'));
      } finally {
        await cli.cleanup();
      }

      // 2 · REPL, un processo. Da ADR-0056 la sua sessione è `owner`, la
      // stessa che apre la DM Telegram dell'owner qui sotto: la parità non
      // cambia, e ora si vede anche nella colonna `sessione=` che questo
      // scenario stampa.
      const repl = await install({ main: SCRIPT });
      try {
        semina(repl);
        const r = await repl.muffin(['repl'], `${LEGGI}\n${SCRIVI}\n/exit\n`);
        if (r.code !== 0) throw new Error(`REPL: exit ${r.code}\n${r.err}`);
        misure.push(esito(repl, 'repl'));
      } finally {
        await repl.cleanup();
      }

      // 3 · Telegram, gateway vero, due messaggi nella stessa chat.
      const tg = await startFakeTelegram();
      const tel = await install({ main: SCRIPT, env: { MUFFIN_GATEWAY_TICK_MS: '200' } });
      try {
        semina(tel);
        const gw = await pairOwner(tel, tg);
        try {
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, LEGGI));
          // The answer follows a tool call (`fs_read`), so it joins that
          // tool's own transcript message as an edit rather than arriving as
          // a fresh `sendMessage` (`connector.ts#deliverTo`'s merge) — wait
          // on `tg.sent()` directly, not `tg.messages()`.
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('somma è 6'),
                ),
            30_000,
          );
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, SCRIVI));
          // Da ADR-0074 il turno non si ferma più a chiedere: la scrittura ha
          // un undo, quindi va avanti come `draft`. Il segnale condiviso
          // dalle tre superfici è il file, dopo che una copia è finita nel
          // giornale — si aspetta quello, non una riga di `approvals` che non
          // arriverà mai (e aspettarla sarebbe un timeout travestito da rosso).
          await until(() => existsSync(join(tel.workspace, 'esito.txt')) && giornaleHaUnaCopia(tel), 30_000);
        } finally {
          await gw.stop();
        }
        misure.push(esito(tel, 'telegram'));
      } finally {
        await tel.cleanup();
        await tg.close();
      }

      // 4 · Il controllo: stessa CLI, stesso script, **sessioni diverse** —
      // l'unica variabile che questo file sostiene essere la causa. I due id
      // sono scritti a mano e non lasciati al default: dopo ADR-0056 «nessun
      // `--session`» non significa più «una sessione diversa» su tutte le
      // porte, e un controllo che si fida di quel default smetterebbe di
      // isolare qualcosa senza che una riga diventi rossa.
      const fresca = await install({ main: SCRIPT });
      try {
        semina(fresca);
        const uno = await fresca.muffin(['run', '--session', 'parita-a', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), LEGGI]);
        if (uno.code !== 0) throw new Error(`CLI sessione fresca turno 1: exit ${uno.code}\n${uno.err}`);
        const due = await fresca.muffin(['run', '--session', 'parita-b', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), SCRIVI]);
        if (due.code !== 0) throw new Error(`CLI sessione fresca turno 2: exit ${due.code}\n${due.err}`);
        misure.push(esito(fresca, 'cli sessione nuova'));
      } finally {
        await fresca.cleanup();
      }

      // La misura si stampa: uno scenario che decide da solo e non lascia
      // niente da leggere è la stessa cosa che una prosa senza numeri.
      for (const m of misure) {
        process.stderr.write(
          `  parità · ${m.superficie.padEnd(20)} sessione=${m.sessione.padEnd(24)} taint=${m.taint} ` +
            `codice=${m.codice ?? '-'} chiesto=${m.chiesto ?? '-'} scritto=${m.scritto ? 'sì' : 'no'} ` +
            `giornale=${m.giornale ? 'sì' : 'no'}\n`,
        );
      }

      const [cliM, replM, telM, frescaM] = misure as [Esito, Esito, Esito, Esito];
      const tainted = [cliM, replM, telM];

      // (1) La divergenza superficie/kernel: se esiste, è qui che si vede.
      const chiavi = new Set(
        tainted.map(
          (m) =>
            `${m.taint}/${m.codice ?? '-'}/${m.chiesto ?? '-'}/${m.scritto ? 'scritto' : 'no'}/${m.giornale ? 'giornale' : 'no'}`,
        ),
      );
      if (chiavi.size !== 1) {
        throw new Error(
          `divergenza superficie/kernel: a parità di history la stessa richiesta decide diverso — ` +
            `${JSON.stringify(misure, null, 2)}`,
        );
      }

      // E l'esito condiviso è quello che ADR-0074 mette al posto della
      // domanda: `fs.write` è `undoable`, quindi a taint 2 resta un `draft` —
      // la copia prima, l'effetto dopo — e non un cancello che l'owner
      // concede nove volte su dieci. Le due colonne che devono restare a zero
      // sono la prova che non è ricomparso niente per un'altra strada.
      for (const m of tainted) {
        if (m.taint !== 2) throw new Error(`${m.superficie}: atteso taint 2 dopo la lettura, trovato ${m.taint}`);
        if (m.codice !== null) {
          throw new Error(`${m.superficie}: il kernel ha rifiutato (${m.codice}) invece di scrivere con undo`);
        }
        if (m.chiesto !== null) {
          throw new Error(
            `${m.superficie}: nessuno doveva essere interrogato per una scrittura con undo (ADR-0074), ` +
              `trovata una domanda a taint ${String(m.chiesto)}`,
          );
        }
        if (!m.scritto) throw new Error(`${m.superficie}: esito.txt non è stato scritto`);
        if (!m.giornale) {
          throw new Error(
            `${m.superficie}: il file è stato scritto senza che il giornale prendesse una copia — ` +
              `il "draft" senza checkpoint è la cosa che ADR-0022 rifiuta`,
          );
        }
      }

      // (2) La sessione, isolata — e da ADR-0074 quello che isola è cambiato
      // di segno, il che la rende una prova migliore e non peggiore.
      //
      // Prima: cambiare sessione cambiava il taint, e il taint cambiava
      // l'esito (a taint 0 scriveva, a taint 2 chiedeva). Adesso il taint
      // resta diverso — la colonna `taint=` lo stampa, 0 contro 2 — e l'esito
      // **non** cambia più con lui. È esattamente l'affermazione dell'ADR
      // («il taint non chiede mai») misurata sul binario vero e su tre
      // superfici, e un `askAbove` rimesso su una riga qualunque la fa cadere
      // qui, non solo negli unit test.
      if (frescaM.taint !== 0) {
        throw new Error(`il controllo a sessione nuova doveva partire da taint 0, trovato ${frescaM.taint}`);
      }
      if (frescaM.codice !== null || frescaM.chiesto !== null || !frescaM.scritto || !frescaM.giornale) {
        throw new Error(
          `il controllo a sessione nuova non si comporta come atteso (nessun rifiuto, nessuna domanda, ` +
            `file scritto con copia nel giornale): ${JSON.stringify(frescaM)}`,
        );
      }
      const chiaveSenzaTaint = (m: Esito) =>
        `${m.codice ?? '-'}/${m.chiesto ?? '-'}/${m.scritto ? 'scritto' : 'no'}/${m.giornale ? 'giornale' : 'no'}`;
      if (chiaveSenzaTaint(frescaM) !== chiaveSenzaTaint(cliM)) {
        throw new Error(
          `il taint ha ancora cambiato l'esito di una scrittura con undo (ADR-0074): ` +
            `taint 0 -> ${chiaveSenzaTaint(frescaM)}, taint 2 -> ${chiaveSenzaTaint(cliM)}`,
        );
      }
      if (frescaM.sessione === cliM.sessione) {
        throw new Error('il controllo ha riusato la stessa sessione: non isola niente');
      }
    },
    240_000,
  );
});

/** Lo stesso giro, in **un solo turno**: nessuna history, nessuna sessione da ereditare. */
const SCRIPT_UN_TURNO: ScriptedReply[] = [
  { tool: { name: 'fs_read', args: { path: 'dati.txt' } } },
  { tool: { name: 'fs_write', args: { path: 'esito.txt', content: 'totale 6' } } },
  { text: 'ho provato a scrivere esito.txt' },
];

describe('acceptance · il giro DAY-1 dentro un turno solo · sessione nuova, nessuna history', () => {
  /**
   * La seconda metà della domanda, e quella che decide se la vita della
   * sessione **basta** a spiegare il fallimento: `leggi → calcola → scrivi`
   * è un solo turno, su una sessione appena aperta, senza un byte di history
   * da ereditare. Se anche qui il kernel rifiuta, allora nessuna riforma di
   * *quale* conversazione viene reiniettata può aprire questo percorso: il
   * taint sale **dentro** il turno (`DISK_TIER` = 2 alla lettura) e il
   * soffitto della capability che scrive è 1.
   *
   * **Aggiornato dopo ADR-0053.** La misura regge, e l'esito è cambiato di un
   * gradino: non più `deny`, ma una domanda. La conclusione che contava resta
   * la stessa e anzi si vede meglio — il taint sale dentro il turno, quindi
   * nessuna riforma di *quale* conversazione viene reiniettata apre questo
   * percorso da sola.
   *
   * **Aggiornato da ADR-0074 (06/09), ed è il giro che il DAY-1 chiede
   * davvero.** Il taint sale ancora dentro il turno — la colonna `taint=2` lo
   * stampa e questo test la asserisce — ma non chiude più niente che si possa
   * disfare: la scrittura è un `draft`, prende la sua copia, e il turno
   * finisce da solo. Su un processo headless (uno script, un job dello
   * scheduler) la differenza non è di comodità: `exit 3` era un turno fermo
   * su un'approvazione che, lì, nessuno poteva dare.
   *
   * Il soffitto resta, e non lo prova questo scenario ma
   * `core/policy/read-then-write.test.ts`: a taint 3 `fs.write` è ancora
   * `deny/taint_exceeded`.
   *
   * Falsificatori:
   * - rimetti un `askAbove` sulla riga `host` in `core/policy/matrix.ts` e il
   *   file non compare più: rosso su `scritto`;
   * - togli il checkpoint al ramo `draft` e il file compare senza copia:
   *   rosso su `giornale`.
   */
  it(
    'leggi → scrivi nello stesso turno scrive, con la copia nel giornale e senza chiedere niente',
    async () => {
      const inst = await install({ main: SCRIPT_UN_TURNO });
      try {
        semina(inst);
        const r = await inst.muffin(['run', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), 'leggi dati.txt e scrivi il totale in esito.txt']);
        if (![0, 1].includes(r.code)) throw new Error(`exit inatteso: ${r.code}\n${r.err}`);
        const m = esito(inst, 'cli un turno');
        process.stderr.write(
          `  parità · ${m.superficie.padEnd(20)} sessione=${m.sessione.padEnd(24)} taint=${m.taint} ` +
            `codice=${m.codice ?? '-'} chiesto=${m.chiesto ?? '-'} scritto=${m.scritto ? 'sì' : 'no'} ` +
            `giornale=${m.giornale ? 'sì' : 'no'}\n`,
        );
        if (m.taint !== 2 || m.codice !== null || m.chiesto !== null || !m.scritto || !m.giornale) {
          throw new Error(
            `il giro read → write in un turno solo non si comporta come dice ADR-0074 ` +
              `(taint 2, nessun rifiuto, nessuna domanda, file scritto con copia): ${JSON.stringify(m)}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    120_000,
  );
});
