import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install, until, type Install } from '../harness.js';
import { privateMessage, startFakeTelegram, type FakeTelegram } from '../telegram.js';
import { scenario } from '../scenario.js';

/**
 * B2 · un messaggio mentre un turno è vivo (ADR-0054), sul binario vero.
 *
 * Il finto provider tiene la risposta sul filo (`ScriptedReply.delayMs`), il
 * gateway vero la aspetta, e nel frattempo il finto Bot API consegna un
 * secondo messaggio. Fino al 03/09 il poller non lo avrebbe nemmeno letto:
 * `drain()` attendeva il turno e `getUpdates` non girava. Quello che si
 * misura qui è l'ordine dei `sendMessage` sul finto server — la conferma
 * «in coda» **prima** della prima risposta — e, nel secondo scenario, che un
 * `/stop` arrivato a metà turno produca «Interrotto.» e mai la risposta
 * trattenuta.
 *
 * Falsifier: rimettere `await this.drain()` al posto di `controlla` +
 * `scheduleDrain` in `connector.ts#run` e la conferma arriva solo dopo la
 * prima risposta (primo scenario rosso); togliere `signal: vivo.controller.signal`
 * da `runFresh` e `/stop` risponde «fermato» ma la risposta trattenuta arriva
 * lo stesso (secondo scenario rosso).
 */

const OWNER_ID = 999;

function ownerDalFile(home: string): number | undefined {
  try {
    const c = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { surfaces?: { telegram?: { ownerUserId?: number } } };
    return c.surfaces?.telegram?.ownerUserId;
  } catch {
    return undefined;
  }
}

type Gw = Awaited<ReturnType<Install['gateway']>>;

async function pairOwner(inst: Install, tg: FakeTelegram, ownerId: number): Promise<Gw> {
  const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-busy-token');
  if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
  const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
  if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
  const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
  if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);
  const gw = await inst.gateway();
  await gw.waitFor(/muffin gateway/, 20_000);
  tg.deliver(privateMessage({ id: ownerId, name: 'Owner' }, code));
  await until(() => ownerDalFile(inst.home) === ownerId, 20_000);
  return gw;
}

const testi = (tg: FakeTelegram): string[] =>
  tg
    .sent()
    .filter((c) => c.method === 'sendMessage')
    .map((c) => String(c.payload['text'] ?? ''));

describe('acceptance · B2 · un messaggio mentre un turno è vivo', () => {
  scenario(
    'B2',
    async () => {
      // --- la coda: confermata subito, risposta dopo ----------------------
      {
        const tg = await startFakeTelegram();
        const inst = await install({
          main: [{ text: 'prima risposta, quella lenta', delayMs: 4_000 }, { text: 'seconda risposta' }],
          env: { MUFFIN_GATEWAY_TICK_MS: '200' },
        });
        try {
          const gw = await pairOwner(inst, tg, OWNER_ID);
          try {
            tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'una cosa lunga'));
            // Il modello finto ha ricevuto la prima richiesta e la tiene sul filo.
            await until(() => inst.provider.main().length >= 1, 15_000);
            tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'e poi questa'));
            await until(() => testi(tg).some((t) => t.includes('in coda')), 10_000);
            if (testi(tg).some((t) => t.includes('prima risposta'))) {
              throw new Error(`la conferma «in coda» è arrivata dopo la prima risposta — il poller ha aspettato il turno:\n${testi(tg).join('\n')}`);
            }
            await until(() => testi(tg).some((t) => t.includes('seconda risposta')), 20_000);
            const t = testi(tg);
            if (t.indexOf(t.find((x) => x.includes('prima risposta'))!) > t.indexOf('seconda risposta')) {
              throw new Error(`le risposte non sono nell'ordine dei messaggi:\n${t.join('\n')}`);
            }
          } finally {
            await gw.stop();
          }
        } finally {
          await inst.cleanup();
          await tg.close();
        }
      }

      // --- /stop: il turno vivo si interrompe ----------------------------
      {
        const tg = await startFakeTelegram();
        const inst = await install({
          main: [{ text: 'non dovrei arrivare', delayMs: 8_000 }],
          env: { MUFFIN_GATEWAY_TICK_MS: '200' },
        });
        try {
          const gw = await pairOwner(inst, tg, OWNER_ID);
          try {
            tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'una cosa lunga'));
            await until(() => inst.provider.main().length >= 1, 15_000);
            tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, '/stop'));
            await until(() => testi(tg).some((t) => t.includes('fermato')), 10_000);
            await until(() => testi(tg).some((t) => t === 'Interrotto.'), 15_000);
            if (testi(tg).some((t) => t.includes('non dovrei arrivare'))) {
              throw new Error(`la risposta trattenuta è arrivata nonostante /stop:\n${testi(tg).join('\n')}`);
            }
          } finally {
            await gw.stop();
          }
        } finally {
          await inst.cleanup();
          await tg.close();
        }
      }
    },
    120_000,
  );
});
