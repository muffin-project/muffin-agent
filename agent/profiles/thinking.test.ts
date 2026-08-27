import { describe, expect, it } from 'vitest';
import { CONSERVATIVE, withThinking } from './profile.js';

/**
 * La manopola del ragionamento ha due sorgenti e una sola risposta.
 *
 * Il profilo sa cosa il **modello** accetta (Fable 5 va in 400 se glielo
 * spegni); `config.json` sa cosa l'**owner** vuole. `withThinking` è il punto
 * in cui le due si compongono, e l'ordine non è negoziabile: l'owner vince,
 * perché il profilo è un default spedito e la config è una scelta presa.
 */
describe('withThinking', () => {
  it("senza override tiene il valore del profilo", () => {
    expect(withThinking(CONSERVATIVE, undefined).thinking).toBe(CONSERVATIVE.thinking);
  });

  it("con override vince l'owner, e nient'altro del profilo si muove", () => {
    const out = withThinking(CONSERVATIVE, 'adaptive');
    expect(out.thinking).toBe('adaptive');
    expect({ ...out, thinking: CONSERVATIVE.thinking }).toEqual(CONSERVATIVE);
  });

  /**
   * Il difetto vero, e l'unica ragione per cui il ramo «niente da fare» copia
   * lo stesso: su questa installazione `main` e `light` sono due modelli della
   * **stessa famiglia** (`qwen3.8-27b` e `qwen3.7-flash`, entrambi `*qwen3*`),
   * quindi `selectProfile` restituisce due volte lo **stesso oggetto**.
   * Restituire l'originale quando l'override è assente darebbe alla corsia di
   * conversazione un profilo condiviso, e la mutazione di `/think` andrebbe a
   * spegnere il ragionamento anche alla corsia della memoria — per riferimento,
   * in silenzio, e solo quando i due modelli si somigliano.
   */
  it('copia sempre, anche senza override: due corsie sullo stesso profilo non condividono l oggetto', () => {
    const a = withThinking(CONSERVATIVE, undefined);
    const b = withThinking(CONSERVATIVE, undefined);
    expect(a).not.toBe(CONSERVATIVE);
    expect(a).not.toBe(b);
    a.thinking = 'adaptive';
    expect(CONSERVATIVE.thinking).toBe('off');
    expect(b.thinking).toBe('off');
  });
});
