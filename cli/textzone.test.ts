import { describe, expect, it } from 'vitest';
import { completa, larghezzaVisibile, posizioneCursore, righeDisegnate } from './textzone.js';

/**
 * La matematica del disegno — la parte che si sbaglia in silenzio.
 *
 * Entrambi i difetti qui sotto sono stati trovati pilotando il REPL vero dentro
 * un pty il 28/08/2026, non leggendo il codice: sono il genere di cosa che una
 * revisione non vede perché la formula *sembra* giusta.
 */

describe('quanto è largo davvero un testo', () => {
  /**
   * Il prompt colorato è `\x1b[36m›\x1b[0m ` — dodici caratteri, **due**
   * colonne. Contare la stringa mette il cursore dieci colonne più a destra del
   * testo, e il difetto si vede solo col colore acceso: su una pipe il colore
   * si spegne da sé e tutto sembra a posto.
   */
  it('le sequenze di escape non occupano colonne', () => {
    expect(larghezzaVisibile('\x1b[36m›\x1b[0m ')).toBe(2);
    expect(larghezzaVisibile('› ')).toBe(2);
  });

  it('e il testo normale si conta come sempre', () => {
    expect(larghezzaVisibile('ciao mondo')).toBe(10);
  });
});

describe('quante righe di terminale', () => {
  it('una riga corta ne occupa una', () => {
    expect(righeDisegnate('ciao', 80)).toBe(1);
  });

  it('una riga più larga dello schermo ne occupa di più', () => {
    expect(righeDisegnate('x'.repeat(85), 80)).toBe(2);
    expect(righeDisegnate('x'.repeat(161), 80)).toBe(3);
  });

  it('una riga vuota ne occupa comunque una', () => {
    expect(righeDisegnate('', 80)).toBe(1);
  });

  /**
   * Un terminale può rispondere **zero** colonne — è ciò che risponde sotto
   * `script`, misurato. Senza questa difesa la divisione produce `Infinity` e
   * il modulo più sotto produce `NaN`.
   */
  it('e una larghezza a zero non manda tutto a gambe all aria', () => {
    expect(righeDisegnate('ciao', 0)).toBe(1);
    expect(Number.isFinite(righeDisegnate('x'.repeat(200), 0))).toBe(true);
  });
});

describe('dove va il cursore', () => {
  it('su una riga sola resta sulla riga, alla colonna giusta dopo il prompt', () => {
    const p = posizioneCursore(['ciao'], 0, 4, '› ', '┊ ', 80);
    expect(p.su).toBe(0);
    // 1-based: due colonne di prompt più quattro di testo, più uno.
    expect(p.colonnaSchermo).toBe(7);
  });

  /**
   * Il difetto del prompt colorato, misurato: senza contare la larghezza
   * *visibile* il cursore finiva dieci colonne più in là.
   */
  it('e il prompt colorato non lo sposta di dieci colonne', () => {
    const nudo = posizioneCursore(['ciao'], 0, 4, '› ', '┊ ', 80);
    const colorato = posizioneCursore(['ciao'], 0, 4, '\x1b[36m›\x1b[0m ', '┊ ', 80);
    expect(colorato).toEqual(nudo);
  });

  it('su un buffer di tre righe, dalla prima risale di due', () => {
    const p = posizioneCursore(['una', 'due', 'tre'], 0, 1, '› ', '┊ ', 80);
    expect(p.su).toBe(2);
  });

  it('e dall ultima non risale', () => {
    expect(posizioneCursore(['una', 'due', 'tre'], 2, 3, '› ', '┊ ', 80).su).toBe(0);
  });

  /** La sequenza `ESC[NaNG` stampata a schermo era esattamente questo caso. */
  it('con larghezza zero produce comunque numeri veri', () => {
    const p = posizioneCursore(['ciao'], 0, 4, '› ', '┊ ', 0);
    expect(Number.isFinite(p.su)).toBe(true);
    expect(Number.isFinite(p.colonnaSchermo)).toBe(true);
  });
});

describe('il Tab completa un comando', () => {
  const comandi = ['/new', '/session', '/spend', '/think', '/model', '/debug', '/exit'];

  it('completa quando il candidato è uno solo', () => {
    expect(completa('/th', comandi)).toBe('/think');
    expect(completa('/ex', comandi)).toBe('/exit');
  });

  /**
   * Zero o più di uno non fanno niente: stampare un elenco romperebbe il
   * disegno del prompt, e la lista sta già in `/help`.
   */
  it('e non fa niente quando i candidati sono zero o più di uno', () => {
    expect(completa('/s', comandi)).toBeNull(); // /session e /spend
    expect(completa('/zzz', comandi)).toBeNull();
  });

  it('né su un comando già completo, né su testo normale', () => {
    expect(completa('/exit', comandi)).toBeNull();
    expect(completa('ciao', comandi)).toBeNull();
  });
});
