import { describe, expect, it } from 'vitest';
import { install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';

/**
 * #496 — il provider dice 429 con `Retry-After`, il turno aspetta la
 * finestra del server e poi risponde, attraverso il binario reale.
 *
 * Il difetto: i retry owner di entrambe le corsie attendevano il backoff
 * cieco (`retryDelayMs`) ignorando la finestra dichiarata — ritentare dentro
 * la finestra del server brucia tentativi contro un bucket non ricaricato
 * (stessa classe di deadlock che ha colpito Hermes sugli account Anthropic
 * Tier 1). Le unità provano parsing e attesa per adapter e per corsia; qui
 * resta il percorso di produzione: provider finto che risponde 429 +
 * `retry-after: 3` alla prima chiamata e una completion alla seconda,
 * processo `muffin run` vero, una sola risposta all'owner.
 *
 * Ciò che falsifica lo scenario: due chiamate al modello (la 429 conta —
 * è un tentativo via cavo), risposta finale col testo scriptato, e distanza
 * fra i due arrivi oltre i 2,5s — misurata sul diario del provider finto, non
 * sul muro (il boot del binario varia per macchina e inquinerebbe la soglia;
 * il timer invece scatta in ritardo, mai in anticipo). Senza l'onore della
 * finestra il turno risponderebbe comunque — ma subito, e lo scenario
 * andrebbe rosso sulla distanza.
 *
 * Come `lane-concurrency.accept.ts`: nessuna riga DAY-1, `it()` plain sullo
 * stesso harness.
 */
describe('acceptance · #496 · il turno onora il Retry-After del provider', () => {
  it(
    '429 con finestra, poi completion: due chiamate, una risposta, attesa vera',
    async () => {
      const inst = await install({
        main: [{ text: 'risposta dopo la finestra dichiarata' }],
        failMain: [
          {
            status: 429,
            headers: { 'retry-after': '3' },
            body: { error: { message: 'lento, riprova', code: 429 } },
          },
        ],
      });
      try {
        const run = await inst.muffin([
          'run',
          '--timeout',
          String(HEADLESS_TURN_TIMEOUT_SECONDS),
          'dimmi qualcosa',
        ]);
        if (run.code !== 0) throw new Error(`exit ${run.code} invece di 0:\n${run.err}`);
        if (!run.out.includes('risposta dopo la finestra')) {
          throw new Error(`risposta assente:\n${run.out}`);
        }
        // Esattamente due tentativi via cavo: la 429 e la completion.
        // Un retry che ignorasse la finestra lascerebbe lo stesso conteggio
        // ma una distanza sotto i 2,5s — è la distanza, non il conteggio, il
        // falsificatore.
        const chiamate = inst.provider.main();
        if (chiamate.length !== 2) {
          throw new Error(`attese 2 chiamate al modello, arrivate ${chiamate.length}`);
        }
        const [prima, dopo] = chiamate;
        if (prima === undefined || dopo === undefined) {
          throw new Error('il diario del provider non ha le due chiamate attese');
        }
        expect(dopo.at - prima.at).toBeGreaterThanOrEqual(2500);
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );
});
