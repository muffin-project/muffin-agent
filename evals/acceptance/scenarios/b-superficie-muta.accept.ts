import { describe, expect, it } from 'vitest';
import { install } from '../harness.js';
import { startFakeTelegram } from '../telegram.js';

/**
 * Una superficie che smette di rispondere, sul binario vero.
 *
 * ## Il difetto, misurato
 *
 * Il 30/08/2026, sulla macchina dell'owner: Telegram abilitata, 44 turni veri
 * nel database, e dalle 17:08 del giorno prima il polling che falliva senza
 * interruzione — 3187 righe identiche in `gateway.err`, mentre
 * `api.telegram.org` rispondeva in 300ms. `muffin doctor` diceva:
 *
 * ```text
 * ✓ gateway    attivo · pid 73344 · dal 29/08/26, 12:30 · in attesa · socket concorde
 * ✓ consegne   nessuna delivery mancante nelle ultime 24h
 * ```
 *
 * Tutte e due vere, **e verdi perche' non arrivava piu' niente**: una superficie
 * che non riceve non produce turni, quindi non produce consegne, quindi non ne
 * mancano. Ogni indicatore guardava a valle del punto rotto, e piu' il guasto
 * era completo piu' i numeri sembravano tranquilli.
 *
 * ## Perche' qui e non in un unit test
 *
 * La catena che deve reggere attraversa quattro processi e tre confini: il
 * connettore che registra il battito, `connectSurfaces` che gli passa il
 * registro, il gateway che apre il socket **prima** delle superfici e lo serve
 * pigramente, e un `muffin doctor` separato che chiede. Ognuno di quei pezzi ha
 * il suo test in-process, e nessuno di quei test si accorgerebbe se il registro
 * arrivasse al gateway sempre vuoto. E' la stessa famiglia di difetti per cui
 * `harness.ts` esiste: *"a mechanism with green tests that no real path
 * reaches"*.
 *
 * Il guasto e' riprodotto come e' successo — la connessione accettata e poi
 * distrutta, `ECONNRESET` — e non con un 500: un 500 e' una risposta, e la
 * classe di guasto da provare e' quella in cui risposta non ce n'e'.
 */
/**
 * `until` della harness prende un predicato sincrono; qui ogni giro spawna un
 * `muffin doctor` vero, quindi serve la variante che aspetta un risultato — e
 * lo restituisce, cosi' le asserzioni girano sulla stampa che ha soddisfatto la
 * condizione e non su una successiva.
 */
async function finche(
  prova: () => Promise<{ out: string } | null>,
  timeoutMs = 30_000,
  ogniMs = 500,
): Promise<{ out: string }> {
  const inizio = Date.now();
  for (;;) {
    const esito = await prova();
    if (esito !== null) return esito;
    if (Date.now() - inizio > timeoutMs) throw new Error('condizione mai raggiunta');
    await new Promise((r) => setTimeout(r, ogniMs));
  }
}

describe('acceptance · una superficie che smette di rispondere non resta verde', () => {
  it(
    'doctor la nomina, dice da quanto e con che causa, e torna a tacere quando riprende',
    async () => {
      const tg = await startFakeTelegram();
      // La soglia vera e' un minuto (`GUASTO_DOPO_MS`): aspettarla davvero
        // renderebbe questo scenario un minuto piu' lento, e uno scenario lento
        // e' uno scenario che prima o poi qualcuno toglie. La manopola e'
        // dichiarata in `cli/doctor.ts` e non esiste su nessuna installazione.
        const inst = await install({ main: [], env: { MUFFIN_GATEWAY_TICK_MS: '300', MUFFIN_GUASTO_DOPO_MS: '1500' } });
      try {
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-bot-token');
        if (tok.code !== 0) throw new Error(`secret set: exit ${tok.code}\n${tok.err}`);
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0) throw new Error(`surface enable: exit ${enable.code}\n${enable.err}`);

        // --- (0) la stretta di mano tarda, e in quella finestra `doctor` deve
        //     **tacere**. Prima della riparazione diceva «abilitata, ma il
        //     gateway non ne ha notizia: non e' stata nemmeno tentata», usciva
        //     1 e consigliava di riavviare — cioe' di rifare partire proprio
        //     l'handshake che stava aspettando. La finestra e' larga fino a due
        //     minuti sulla rete vera, ed e' larga esattamente quando la rete e'
        //     lenta: cioe' quando l'owner corre `doctor`.
        tg.ritardaGetMe(6_000);
        const gateway = await inst.gateway();
        await gateway.waitFor(/muffin gateway/, 20_000);

        //     Si guarda l'assenza della riga, non il codice d'uscita: su una
        //     installazione appena creata `doctor` esce 1 lo stesso per altri
        //     `!` legittimi (nessun supervisore, consolidamento mai girato), e
        //     asserire lo zero proverebbe una cosa piu' larga della claim.
        const durante = await inst.muffin(['doctor']);
        expect(durante.out).not.toMatch(/superfic/);
        tg.ritardaGetMe(0);

        // --- (a) mentre risponde, `doctor` non allarma e lo dice una volta.
        const sana = await finche(async () => {
          const r = await inst.muffin(['doctor']);
          return /superfici\s+telegram/.test(r.out) ? r : null;
        }, 30_000);
        expect(sana.out).not.toMatch(/superficie telegram/);

        // --- (b) il long poll cade, e continua a cadere. Un lampo non basta:
        //     sotto la soglia `doctor` tace, perche' un `!` su un
        //     `ECONNRESET` fra due long poll insegna a scorrere oltre
        //     `doctor` — che e' questo difetto al contrario.
        tg.rompi();

        const rotta = await finche(async () => {
          const r = await inst.muffin(['doctor']);
          return /superficie telegram/.test(r.out) ? r : null;
        }, 30_000);

        // La riga dice le tre cose che servono per agire: che non risponde, da
        // quanto, e cosa ha risposto la rete. La causa arriva da `causaDiRete`,
        // che il token non lo puo' portare per costruzione.
        expect(rotta.out).toMatch(/superficie telegram/);
        expect(rotta.out).toMatch(/non risponde da/);
        expect(rotta.out).toMatch(/ECONNRESET|TypeError/);
        expect(rotta.out).not.toContain('fake-bot-token');

        // E dice **perche'** gli altri indicatori restano verdi: senza questa
        // meta' frase l'owner legge il `!`, vede `consegne ✓` e conclude che il
        // `!` esagera. Nella stessa stampa, le due righe che mentivano.
        expect(rotta.out).toContain('non arriva niente');
        expect(rotta.out).toMatch(/✓\s+gateway\s+attivo/);
        expect(rotta.out).toMatch(/✓\s+consegne/);

        // --- (c) e quando riprende, la riga sparisce: un allarme che non si
        //     spegne da solo e' un allarme che si impara a ignorare.
        tg.ripara();
        const guarita = await finche(async () => {
          const r = await inst.muffin(['doctor']);
          return /superfici\s+telegram/.test(r.out) && !/superficie telegram/.test(r.out) ? r : null;
        }, 30_000);
        expect(guarita.out).toMatch(/superfici\s+telegram/);

        await gateway.stop();
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    120_000,
  );
});
