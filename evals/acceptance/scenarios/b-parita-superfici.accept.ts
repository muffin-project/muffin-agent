import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { install, until, type Install } from '../harness.js';
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
 * ## L'esito, aggiornato da ADR-0053
 *
 * La misura del 02/09 diceva: nessuna divergenza, e a taint 2 la scrittura è un
 * `deny/taint_exceeded` ovunque. La ricostruzione che ne è seguita ha trovato
 * che quel `deny` non era una decisione ma una trascrizione mancata — la riga
 * *Shell / filesystem host / processi* della matrice normativa dice `ASK` a
 * taint 2, e solo `sys.shell` l'aveva ricevuta. Da ADR-0053 il soffitto viene
 * dalla riga di effetto, quindi la cella condivisa è una **domanda**.
 *
 * La parità è la claim che non cambia, ed è la ragione per cui questo file
 * resta: le tre superfici devono continuare a rispondere identico, qualunque
 * sia la cella. Il segnale confrontato non è più il codice di rifiuto ma la
 * riga di `approvals`, che è la stessa su tutte e tre.
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
        const uno = await cli.muffin(['run', '--session', 'parita', '--timeout', '20', LEGGI]);
        if (uno.code !== 0) throw new Error(`CLI turno 1: exit ${uno.code}\n${uno.err}`);
        const due = await cli.muffin(['run', '--session', 'parita', '--timeout', '20', SCRIVI]);
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
          await until(() => tg.messages().some((m) => m.text.includes('somma è 6')), 30_000);
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, SCRIVI));
          // Non più la risposta del modello: il turno si ferma a chiedere. La
          // riga di `approvals` è il segnale che le tre superfici condividono.
          await until(() => approvazioneScrittura(tel) !== null, 30_000);
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
        const uno = await fresca.muffin(['run', '--session', 'parita-a', '--timeout', '20', LEGGI]);
        if (uno.code !== 0) throw new Error(`CLI sessione fresca turno 1: exit ${uno.code}\n${uno.err}`);
        const due = await fresca.muffin(['run', '--session', 'parita-b', '--timeout', '20', SCRIVI]);
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
            `codice=${m.codice ?? '-'} chiesto=${m.chiesto ?? '-'} scritto=${m.scritto ? 'sì' : 'no'}\n`,
        );
      }

      const [cliM, replM, telM, frescaM] = misure as [Esito, Esito, Esito, Esito];
      const tainted = [cliM, replM, telM];

      // (1) La divergenza superficie/kernel: se esiste, è qui che si vede.
      const chiavi = new Set(
        tainted.map((m) => `${m.taint}/${m.codice ?? '-'}/${m.chiesto ?? '-'}/${m.scritto ? 'scritto' : 'no'}`),
      );
      if (chiavi.size !== 1) {
        throw new Error(
          `divergenza superficie/kernel: a parità di history la stessa richiesta decide diverso — ` +
            `${JSON.stringify(misure, null, 2)}`,
        );
      }

      // E l'esito condiviso è la cella che la matrice normativa stampa per la
      // riga `host` a taint 2: **ASK**, non deny. `fs.write` scrive sul disco
      // dell'host come la shell, e da ADR-0053 le due porte hanno la stessa
      // regola. Il file non c'è perché nessuno ha approvato, non perché la
      // capability sia irraggiungibile: è la differenza che questa slice ripara.
      for (const m of tainted) {
        if (m.taint !== 2) throw new Error(`${m.superficie}: atteso taint 2 dopo la lettura, trovato ${m.taint}`);
        if (m.codice !== null) {
          throw new Error(`${m.superficie}: il kernel ha rifiutato (${m.codice}) invece di chiedere`);
        }
        if (m.chiesto !== 2) {
          throw new Error(
            `${m.superficie}: attesa una domanda di approvazione per fs.write a taint 2, trovata ${String(m.chiesto)}`,
          );
        }
        if (m.scritto) throw new Error(`${m.superficie}: esito.txt è stato scritto senza approvazione`);
      }

      // (2) La vita della sessione, isolata: cambia solo quella, e l'esito
      // cambia con lei.
      if (frescaM.taint !== 0 || frescaM.codice !== null || frescaM.chiesto !== null || !frescaM.scritto) {
        throw new Error(
          `il controllo a sessione nuova non si comporta come atteso (taint 0, nessun rifiuto, file scritto): ` +
            `${JSON.stringify(frescaM)}`,
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
   * Falsificatore: porta `fs.write` sulla riga `context` in `agent/tools/fs.ts`
   * e questo scenario diventa rosso perché il file compare senza che nessuno
   * abbia approvato.
   */
  it(
    'leggi → scrivi nello stesso turno chiede, e non scrive finché nessuno risponde',
    async () => {
      const inst = await install({ main: SCRIPT_UN_TURNO });
      try {
        semina(inst);
        const r = await inst.muffin(['run', '--timeout', '20', 'leggi dati.txt e scrivi il totale in esito.txt']);
        if (![0, 1, 3].includes(r.code)) throw new Error(`exit inatteso: ${r.code}\n${r.err}`);
        const m = esito(inst, 'cli un turno');
        process.stderr.write(
          `  parità · ${m.superficie.padEnd(20)} sessione=${m.sessione.padEnd(24)} taint=${m.taint} ` +
            `codice=${m.codice ?? '-'} chiesto=${m.chiesto ?? '-'} scritto=${m.scritto ? 'sì' : 'no'}\n`,
        );
        if (m.taint !== 2 || m.codice !== null || m.chiesto !== 2 || m.scritto) {
          throw new Error(
            `il giro read → write in un turno solo non si comporta come misurato il 02/09: ${JSON.stringify(m)}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    120_000,
  );
});
