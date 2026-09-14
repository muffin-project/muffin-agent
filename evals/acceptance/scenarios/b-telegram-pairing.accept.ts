import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { install, until } from '../harness.js';
import { privateMessage, startFakeTelegram } from '../telegram.js';

/**
 * Il valore di una chiave in `muffin config --json`, che è un array di
 * `{key, value, source, sealed}`.
 *
 * Interrogare la chiave invece di cercare una sottostringa nel blob non è
 * pedanteria: la prima stesura asseriva `toContain('999')` sull'output intero,
 * e in quell'output c'è anche l'URL del Bot API finto, che porta una porta
 * casuale. Un test che passa perché `999` era il numero di porta non prova
 * niente, e fallisce un giorno a caso.
 */
const chiave = (out: string, key: string): unknown => {
  const righe = JSON.parse(out) as Array<{ key: string; value: unknown }>;
  return righe.find((r) => r.key === key)?.value;
};

/** Legge la config dal file: il poll non deve pagare uno spawn per giro. */
const ownerDalFile = (home: string): number | undefined => {
  try {
    const c = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      surfaces?: { telegram?: { ownerUserId?: number } };
    };
    return c.surfaces?.telegram?.ownerUserId;
  } catch {
    return undefined;
  }
};

/**
 * Il pairing, sul binario vero.
 *
 * Questa casella era dichiarata vuota nel repo stesso: `report.ts` la registra
 * sotto `NOT_PROVABLE_HERE.B16` — *"nessun binario spawnabile contro un Bot API
 * finto: TelegramApi non ha override di baseUrl in produzione"*. Il connettore
 * aveva (e ha) i suoi test in-process, che provano la logica del pairing
 * guidando `drain()` con un oggetto scritto a mano; quello che nessuno poteva
 * mostrare è che `cli/surface.ts` colleghi quella logica a qualcosa. È
 * esattamente la famiglia di difetti contro cui `harness.ts` è stato costruito:
 * *"a mechanism with green tests that no real path reaches"*.
 *
 * La cucitura ora esiste e non è un trucco da test: Telegram pubblica il Bot
 * API come software che si può ospitare — *"You can run it locally and send the
 * requests to your own server"* (core.telegram.org/bots/api) — quindi
 * `--api-base` è una manopola di deployment documentata, che per costruzione
 * rende la superficie anche provabile.
 *
 * ## La proprietà sotto esame
 *
 * Non "Telegram funziona", ma: **finché nessuno ha dimostrato di essere
 * l'owner, chi scrive è uno sconosciuto**. È il confine di autorità più
 * esposto del sistema — l'unico punto in cui una persona qualsiasi su internet
 * può scrivere a Muffin — e la sua garanzia è che il codice di pairing lega
 * "chi tiene questa macchina" a "chi tiene quell'account". Prima di quel
 * legame, nessun messaggio può conferire autorità.
 */

describe('acceptance · telegram · nessuno è owner finché non lo dimostra', () => {
  it(
    'uno sconosciuto che scrive non diventa owner; il codice di pairing lo fa',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [{ text: 'Ciao, sono Muffin.' }, { text: 'Eccomi.' }],
        env: { MUFFIN_GATEWAY_TICK_MS: '300' },
      });
      try {
        // Il token è finto e non lascia mai questa macchina: il base URL è il
        // server qui sopra.
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-bot-token');
        if (tok.code !== 0) throw new Error(`secret set: exit ${tok.code}\n${tok.err}`);

        // --- (a) abilitazione: il binario vero parla col Bot API e stampa il
        //     codice. Il file ne tiene solo il digest.
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0) throw new Error(`surface enable: exit ${enable.code}\n${enable.err}`);
        expect(enable.err).toContain('muffin_test_bot'); // ha davvero chiamato getMe
        const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
        if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);

        // Il codice in chiaro non è finito nella configurazione.
        const salvato = await inst.muffin(['config', '--json']);
        expect(salvato.out).not.toContain(code);

        // --- (b) uno sconosciuto scrive per primo: non deve ricevere una
        //     risposta né diventare owner, anche durante il pairing.
        const gateway = await inst.gateway();
        await gateway.waitFor(/muffin gateway/, 20_000);
        tg.deliver(privateMessage({ id: 777, name: 'Sconosciuto' }, 'ciao, chi sei?'));

        const updateEsaurito = (id: number): boolean =>
          inst.db((db) => {
            const row = db
              .prepare(`SELECT payload, processed_at FROM telegram_updates WHERE update_id = ?`)
              .get(id) as { payload: string; processed_at: string | null } | undefined;
            return row?.processed_at !== null && row?.processed_at !== undefined;
          });
        await until(() => updateEsaurito(1), 30_000);
        expect(tg.messages()).toEqual([]);
        expect(
          inst.db((db) =>
            (db.prepare(`SELECT payload FROM telegram_updates WHERE update_id = 1`).get() as
              | { payload: string }
              | undefined)?.payload,
          ),
        ).toBe('{}');

        // La riga che conta: dopo il messaggio dello sconosciuto, la
        // configurazione non ha un owner. Nessun messaggio conferisce autorità.
        expect(ownerDalFile(inst.home)).toBeUndefined();

        // --- (b2) un codice SBAGLIATO. Non deve rispondere né associare
        //     l'account: il pairing non è una conversazione aperta.
        tg.deliver(privateMessage({ id: 888, name: 'Impostore' }, 'AAAA-BBBB'));
        await until(() => updateEsaurito(2), 30_000);
        expect(tg.messages()).toEqual([]);
        expect(
          inst.db((db) =>
            (db.prepare(`SELECT payload FROM telegram_updates WHERE update_id = 2`).get() as
              | { payload: string }
              | undefined)?.payload,
          ),
        ).toBe('{}');
        expect(ownerDalFile(inst.home)).toBeUndefined();

        // --- (c) ora il codice giusto, dall'account che diventerà owner.
        tg.deliver(privateMessage({ id: 999, name: 'Giusto' }, code));

        // Il poll legge il file, non rilancia il binario: `muffin config` ogni
        // 250ms costava uno spawn di Node per giro e portava lo scenario da 4
        // a 34 secondi. La fonte è la stessa.
        await until(() => ownerDalFile(inst.home) !== undefined, 30_000);

        // --- (d) owner è l'account che ha mandato il codice giusto: non lo
        //     sconosciuto che ha scritto per primo, non l'impostore che ha
        //     tentato. Interrogata come chiave, non cercata come sottostringa.
        const finale = await inst.muffin(['config', '--json']);
        // Reso come stringa: `muffin config` è una vista, non il file.
        expect(String(chiave(finale.out, 'surfaces.telegram.ownerUserId'))).toBe('999');
        // E il pairing è bruciato: un codice, un uso.
        expect(chiave(finale.out, 'surfaces.telegram.pairing')).toBeUndefined();

        await gateway.stop();
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    90_000,
  );
});
