import { describe, expect, it } from 'vitest';
import { AZIONE_DELLA_SCENA, confrontaAB, eseguiCorpus, tabella, tabellaAB } from './corpus.js';

/**
 * Il corpus avversariale come test, e perché è **opt-in**.
 *
 * Ogni scena avvia una o due installazioni vere — `muffin init`, un database,
 * processi figli — e la corsa completa sta nei minuti, non nei secondi. Il
 * budget dell'accettazione è ~5 minuti con un tetto di 10, e questo corpus si
 * aggiunge a quello: una eval che nessuno può permettersi di far girare è una
 * eval che nessuno fa girare, quindi non entra in `npx vitest run` per
 * default.
 *
 *     MUFFIN_EVAL_ATTACKS=1 npx vitest run evals/security/attacks
 *
 * Cosa fa cadere la corsa, e cosa no. **Un attacco riuscito non la fa
 * cadere**: è una misura, e trasformarla in un'asserzione renderebbe la eval
 * un test di regressione della politica di oggi invece di un esperimento. Fa
 * cadere la corsa un **controllo morto**: una scena in cui l'attacco non
 * riesce nemmeno quando la guardia è fuori gioco non misura niente, e un
 * corpus di scene così darebbe zero attacchi riusciti per costruzione.
 */
const ACCESO = process.env['MUFFIN_EVAL_ATTACKS'] === '1';

describe.skipIf(!ACCESO)('corpus avversariale · binario vero', () => {
  it(
    'misura se gli attacchi riescono, e stampa la tabella',
    async () => {
      const misure = await eseguiCorpus();
      const confronti = confrontaAB(misure);
      process.stderr.write(`\n${tabella(misure)}\n\n${tabellaAB(confronti)}\n`);

      // Ogni scena ha un'azione normalizzata, o il confronto A/B è incompleto.
      for (const m of misure) {
        expect(AZIONE_DELLA_SCENA[m.id], `la scena '${m.id}' non ha un'azione normalizzata`).toBeDefined();
      }

      // I controlli: se uno è morto, la scena non poteva andare storta e la
      // sua riga della tabella non è evidenza di niente.
      const morti = misure.filter((m) => !m.controllo.riuscito);
      expect(
        morti.map((m) => `${m.id}: ${m.controllo.nota}`),
        'controlli morti — queste scene non possono osservare un attacco riuscito',
      ).toEqual([]);
    },
    // Il tetto, non la durata attesa: la misura vera la stampa la tabella.
    900_000,
  );
});

describe('il corpus è dichiarato anche quando non gira', () => {
  it('ogni scena dichiarata ha la sua azione normalizzata', () => {
    // Vale senza avviare niente: è la coerenza fra le due metà della eval, e
    // deve restare verde nella suite normale perché è lì che si rompe.
    expect(Object.keys(AZIONE_DELLA_SCENA).length).toBeGreaterThanOrEqual(7);
  });
});
