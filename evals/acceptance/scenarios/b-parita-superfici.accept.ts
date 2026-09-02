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
 *  2. la **vita della sessione** — la CLI apre una sessione nuova a ogni
 *     invocazione (`cli/run.ts`), il REPL una per lancio (`cli/repl.ts`),
 *     Telegram **una per chat, per sempre** (`connector.ts`:
 *     `sessions.open('telegram:' + chatId)`). Stessa regola, contesti diversi,
 *     quindi taint ambiente diverso.
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
  codice: string | null;
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

function esito(inst: Install, superficie: string): Esito {
  const row = turnoDellaScrittura(inst);
  const codice = /"?(taint_exceeded|resource_denied|no_capability|safe_mode|rot_violation)"?/.exec(row.messages)?.[1] ?? null;
  return {
    superficie,
    sessione: row.session_id,
    taint: row.taint,
    codice,
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
        if (due.code !== 0 && due.code !== 1) throw new Error(`CLI turno 2: exit ${due.code}\n${due.err}`);
        misure.push(esito(cli, 'cli --session'));
      } finally {
        await cli.cleanup();
      }

      // 2 · REPL, un processo, una sessione per lancio (`sessions.open()`).
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
          await until(() => tg.messages().some((m) => m.text.includes('provato a scrivere')), 30_000);
        } finally {
          await gw.stop();
        }
        misure.push(esito(tel, 'telegram'));
      } finally {
        await tel.cleanup();
        await tg.close();
      }

      // 4 · Il controllo: stessa CLI, stesso script, **sessioni diverse** —
      // l'unica variabile che questo file sostiene essere la causa.
      const fresca = await install({ main: SCRIPT });
      try {
        semina(fresca);
        const uno = await fresca.muffin(['run', '--timeout', '20', LEGGI]);
        if (uno.code !== 0) throw new Error(`CLI sessione fresca turno 1: exit ${uno.code}\n${uno.err}`);
        const due = await fresca.muffin(['run', '--timeout', '20', SCRIVI]);
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
            `codice=${m.codice ?? '-'} scritto=${m.scritto ? 'sì' : 'no'}\n`,
        );
      }

      const [cliM, replM, telM, frescaM] = misure as [Esito, Esito, Esito, Esito];
      const tainted = [cliM, replM, telM];

      // (1) La divergenza superficie/kernel: se esiste, è qui che si vede.
      const chiavi = new Set(tainted.map((m) => `${m.taint}/${m.codice ?? '-'}/${m.scritto ? 'scritto' : 'no'}`));
      if (chiavi.size !== 1) {
        throw new Error(
          `divergenza superficie/kernel: a parità di history la stessa richiesta decide diverso — ` +
            `${JSON.stringify(misure, null, 2)}`,
        );
      }

      // E l'esito condiviso è quello che il kernel dichiara: `fs.write` è
      // `medium` senza `maxTaint` proprio, quindi il soffitto di classe è 1 e
      // un turno che ha letto dal disco (`DISK_TIER` = 2) lo supera.
      for (const m of tainted) {
        if (m.taint !== 2) throw new Error(`${m.superficie}: atteso taint 2 dopo la lettura, trovato ${m.taint}`);
        if (m.codice !== 'taint_exceeded') {
          throw new Error(`${m.superficie}: atteso taint_exceeded dal kernel, trovato ${String(m.codice)}`);
        }
        if (m.scritto) throw new Error(`${m.superficie}: esito.txt è stato scritto a taint 2`);
      }

      // (2) La vita della sessione, isolata: cambia solo quella, e l'esito
      // cambia con lei.
      if (frescaM.taint !== 0 || frescaM.codice !== null || !frescaM.scritto) {
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
   * Falsificatore: alza `maxTaint` di `fs.write` a 2 in `agent/tools/fs.ts` e
   * questo scenario diventa rosso perché il file compare — che è esattamente
   * ciò che l'opzione A/B del bivio owner cambierebbe.
   */
  it(
    'leggi → scrivi nello stesso turno è taint_exceeded anche senza nessuna history',
    async () => {
      const inst = await install({ main: SCRIPT_UN_TURNO });
      try {
        semina(inst);
        const r = await inst.muffin(['run', '--timeout', '20', 'leggi dati.txt e scrivi il totale in esito.txt']);
        if (r.code !== 0 && r.code !== 1) throw new Error(`exit inatteso: ${r.code}\n${r.err}`);
        const m = esito(inst, 'cli un turno');
        process.stderr.write(
          `  parità · ${m.superficie.padEnd(20)} sessione=${m.sessione.padEnd(24)} taint=${m.taint} ` +
            `codice=${m.codice ?? '-'} scritto=${m.scritto ? 'sì' : 'no'}\n`,
        );
        if (m.taint !== 2 || m.codice !== 'taint_exceeded' || m.scritto) {
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
