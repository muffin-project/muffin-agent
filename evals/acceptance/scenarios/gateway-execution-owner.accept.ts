import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { install, until } from '../harness.js';
import { type FakeTelegram, privateMessage, startFakeTelegram } from '../telegram.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';

/**
 * #533 — quando il gateway è vivo, è l'unico execution owner della Home.
 *
 * Il difetto, misurato il 12/09/2026: il REPL costruiva il suo Runtime ed
 * eseguiva i turni del terminale in locale mentre il gateway girava — due
 * copie vive di provider/modello/profilo/budget sullo stesso DB, e la
 * `ModelLane` esplicitamente in-process non poteva serializzarle. Ora il
 * terminale è cliente del gateway: esegue lui, in streaming, sullo stesso
 * socket di controllo che già diceva se è vivo.
 *
 * Ciò che ogni `it` prova è una proprietà, non un percorso:
 *
 * - il turno del terminale gira sul gateway (una sola chiamata al modello,
 *   riga `cli` chiusa `done`, niente secondo runtime);
 * - l'approvazione fa round-trip nella stessa execution (nessuna seconda
 *   execution per il sì, l'effetto parte davvero);
 * - terminale e Telegram condividono una sola ModelLane (il secondo aspetta
 *   il primo, non gira insieme);
 * - un client ucciso a metà non duplica niente (una chiamata, riga `done`);
 * - un cancel arriva come `aborted`, mai come «non è successo niente» né
 *   come esito inventato;
 * - senza gateway, l'owner locale è esplicito e unico.
 *
 * `scenario()` richiede una riga di manifest DAY-1 e qui non ce n'è una: come
 * `lane-concurrency.accept.ts`, sono `it()` plain sullo stesso harness.
 */

function turniCli(
  home: string,
): Array<{ id: string; status: string; outcome: string | null; surface: string }> {
  const db = new DatabaseCtor(join(home, 'muffin.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, status, turn_outcome AS outcome, surface FROM turns WHERE surface = 'cli' ORDER BY created_at`,
      )
      .all() as Array<{ id: string; status: string; outcome: string | null; surface: string }>;
  } finally {
    db.close();
  }
}

describe('acceptance · #533 · il gateway è l unico execution owner', () => {
  it(
    'un `run` con il gateway vivo gira lì: risposta, stream e una sola chiamata',
    async () => {
      const inst = await install({
        main: [{ text: 'risposta dal gateway, non dal secondo runtime' }],
      });
      try {
        const gw = await inst.gateway();
        try {
          await gw.waitFor(/muffin gateway/, 20_000);
          const run = await inst.muffin([
            'run',
            '--timeout',
            String(HEADLESS_TURN_TIMEOUT_SECONDS),
            'dimmi qualcosa',
          ]);
          if (run.code !== 0) throw new Error(`exit ${run.code} invece di 0:\n${run.err}`);
          if (!run.out.includes('risposta dal gateway'))
            throw new Error(`risposta assente:\n${run.out}`);
          if (!run.err.includes('esecuzione sul gateway')) {
            throw new Error(`il turno non dice di aver girato sul gateway:\n${run.err}`);
          }
          // Una sola chiamata: nessun secondo runtime ha eseguito in parallelo.
          if (inst.provider.main().length !== 1) {
            throw new Error(
              `attesa 1 chiamata al modello, arrivate ${inst.provider.main().length}`,
            );
          }
          const righe = turniCli(inst.home);
          if (righe.length !== 1 || righe[0]!.status !== 'done') {
            throw new Error(`riga del turno inattesa: ${JSON.stringify(righe)}`);
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );

  it(
    'approvazione: domanda sul terminale, sì dentro, effetto vero, stessa execution',
    async () => {
      const inst = await install({
        main: [
          {
            tool: {
              name: 'shell_run_write',
              args: { command: 'echo via-gateway > prova-approvata.txt', cwd: '.' },
            },
          },
          { text: 'comando eseguito dopo il tuo sì' },
        ],
      });
      try {
        const gw = await inst.gateway();
        try {
          await gw.waitFor(/muffin gateway/, 20_000);
          // Domanda, poi `s`: la risposta all'approvazione viaggia dentro lo
          // stesso socket dello stesso turno — non nasce una seconda execution.
          const run = await inst.muffin(['repl'], 'fai girare quel comando di prova\ns\n');
          if (run.code !== 0)
            throw new Error(`exit ${run.code} invece di 0:\n${run.out}\n${run.err}`);
          // La domanda è arrivata a *questo* terminale (e il sì è tornato
          // dentro): la riga del prompt `[s/N]` non si stampa su una pipe,
          // ma il kernel chiede per capability e il verdetto resta.
          if (!run.err.includes('sys.shell.write')) {
            throw new Error(`la domanda di approvazione non è arrivata al terminale:\n${run.err}`);
          }
          if (!run.err.includes('consentito')) {
            throw new Error(`il sì non è stato registrato:\n${run.err}`);
          }
          if (!run.out.includes('comando eseguito dopo il tuo sì')) {
            throw new Error(`il turno non ha ripreso dopo il sì:\n${run.out}`);
          }
          // L'effetto è partito davvero: il file scritto dal comando esiste.
          const scritto = readFileSync(join(inst.workspace, 'prova-approvata.txt'), 'utf8');
          if (!scritto.includes('via-gateway')) {
            throw new Error(
              `il comando approvato non ha scritto il file: ${JSON.stringify(scritto)}`,
            );
          }
          // Due chiamate (tool + risposta finale), una sola riga chiusa: il sì
          // ha ripreso la stessa execution invece di aprirne un'altra.
          if (inst.provider.main().length !== 2) {
            throw new Error(
              `attese 2 chiamate al modello, arrivate ${inst.provider.main().length}`,
            );
          }
          const righe = turniCli(inst.home);
          if (righe.length !== 1 || righe[0]!.status !== 'done') {
            throw new Error(
              `l'approvazione ha lasciato più righe o una riga aperta: ${JSON.stringify(righe)}`,
            );
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );

  it(
    'senza gateway: owner locale esplicito, un solo percorso',
    async () => {
      const inst = await install({ main: [{ text: 'risposta locale, dichiarata' }] });
      try {
        const run = await inst.muffin([
          'run',
          '--timeout',
          String(HEADLESS_TURN_TIMEOUT_SECONDS),
          'dimmi qualcosa',
        ]);
        if (run.code !== 0) throw new Error(`exit ${run.code} invece di 0:\n${run.err}`);
        if (!run.out.includes('risposta locale')) throw new Error(`risposta assente:\n${run.out}`);
        if (!run.err.includes('esecuzione locale (nessun gateway attivo)')) {
          throw new Error(`il fallback non si dichiara owner locale:\n${run.err}`);
        }
        if (inst.provider.main().length !== 1) {
          throw new Error(`attesa 1 chiamata al modello, arrivate ${inst.provider.main().length}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );

  it(
    'cancel: `run --timeout` abortisce la stessa execution, senza inventare l esito',
    async () => {
      const inst = await install({
        main: [{ text: 'questa risposta non deve mai arrivare', delayMs: 15_000 }],
      });
      try {
        const gw = await inst.gateway();
        try {
          await gw.waitFor(/muffin gateway/, 20_000);
          const run = await inst.muffin(['run', '--timeout', '2', 'lavoro lungo che interrompo']);
          if (run.code !== 1)
            throw new Error(`atteso exit 1 (annullato), ricevuto ${run.code}\n${run.err}`);
          if (!run.err.includes('annullato')) {
            throw new Error(`il cancel non si dice annullato:\n${run.err}`);
          }
          if (run.out.includes('questa risposta non deve mai arrivare')) {
            throw new Error('il turno cancellato ha comunque consegnato una risposta');
          }
          // Partito una volta sola: il cancel non ha rieseguito niente.
          if (inst.provider.main().length !== 1) {
            throw new Error(
              `attesa 1 chiamata al modello, arrivate ${inst.provider.main().length}`,
            );
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );

  it(
    'client ucciso a metà: nessuna seconda execution, la riga si chiude `done`',
    async () => {
      const inst = await install({
        main: [{ text: 'risposta che il client morto non leggerà', delayMs: 3_000 }],
      });
      try {
        const gw = await inst.gateway();
        try {
          await gw.waitFor(/muffin gateway/, 20_000);
          const figlio = inst.spawnRaw([
            'run',
            '--timeout',
            String(HEADLESS_TURN_TIMEOUT_SECONDS),
            'lavoro lento',
          ]);
          await until(() => inst.provider.main().length >= 1, 20_000);
          figlio.kill();
          await figlio.exited;
          // L'esecuzione continua senza chi la guardava: la riga si chiude da
          // sola, senza che nessuno la riesegua.
          await until(() => turniCli(inst.home).some((r) => r.status === 'done'), 30_000);
          if (inst.provider.main().length !== 1) {
            throw new Error(
              `il disconnect ha duplicato l'esecuzione: ${inst.provider.main().length} chiamate`,
            );
          }
          const righe = turniCli(inst.home);
          if (righe.length !== 1) throw new Error(`righe inattese: ${JSON.stringify(righe)}`);
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );
});

describe('acceptance · #533 · terminale e Telegram condividono una ModelLane', () => {
  it(
    'un turno Telegram in volo fa aspettare il `run`, non girare insieme',
    async () => {
      const inst = await install({
        main: [
          // Il turno Telegram tiene la corsia aperta per quattro secondi veri.
          { text: 'risposta telegram lenta', delayMs: 4_000 },
          { text: 'risposta cli dopo la corsia' },
        ],
      });
      let tg: FakeTelegram | null = null;
      try {
        tg = await startFakeTelegram();
        const tok = await inst.muffin(
          ['secret', 'set', 'telegram_token'],
          '123456:fake-lane-token',
        );
        if (tok.code !== 0) throw new Error(`secret set: exit ${tok.code}\n${tok.err}`);
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0)
          throw new Error(`surface enable: exit ${enable.code}\n${enable.err}`);
        const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
        if (!code) throw new Error(`nessun codice di pairing:\n${enable.err}`);
        const gw = await inst.gateway();
        try {
          await gw.waitFor(/muffin gateway/, 20_000);
          const OWNER_ID = 424242;
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, code));
          const ownerDalFile = (): number | undefined => {
            try {
              const c = JSON.parse(readFileSync(join(inst.home, 'config.json'), 'utf8')) as {
                surfaces?: { telegram?: { ownerUserId?: number } };
              };
              return c.surfaces?.telegram?.ownerUserId;
            } catch {
              return undefined;
            }
          };
          await until(() => ownerDalFile() === OWNER_ID, 20_000);
          // Il turno Telegram parte e tiene la corsia (delayMs sul provider).
          tg.deliver(
            privateMessage({ id: OWNER_ID, name: 'Owner' }, 'raccontami qualcosa di lungo'),
          );
          await until(() => inst.provider.main().length >= 1, 20_000);
          // Il `run` arriva mentre la corsia è presa: se condividono davvero
          // una ModelLane, aspetta — quattro secondi di modello non si
          // attraversano in fretta con un provider che risponde subito.
          const inizio = Date.now();
          const run = await inst.muffin([
            'run',
            '--timeout',
            String(HEADLESS_TURN_TIMEOUT_SECONDS),
            'una domanda veloce',
          ]);
          const durata = Date.now() - inizio;
          if (run.code !== 0) throw new Error(`exit ${run.code} invece di 0:\n${run.err}`);
          if (!run.out.includes('risposta cli dopo la corsia'))
            throw new Error(`risposta CLI assente:\n${run.out}`);
          if (durata < 2_500) {
            throw new Error(
              `il run ha attraversato un turno in volo in ${durata}ms — due corsie, non una`,
            );
          }
          // E alla fine ognuno ha la sua risposta, senza duplicati.
          await until(() => tg!.messages().length >= 1, 20_000);
          if (!tg.messages().some((m) => m.text.includes('risposta telegram lenta'))) {
            throw new Error(
              `Telegram non ha ricevuto la sua risposta: ${JSON.stringify(tg.messages())}`,
            );
          }
          if (inst.provider.main().length !== 2) {
            throw new Error(
              `attese 2 chiamate al modello, arrivate ${inst.provider.main().length}`,
            );
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await tg?.close();
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(2),
  );
});
