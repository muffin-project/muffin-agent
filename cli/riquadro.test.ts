import { describe, expect, it } from 'vitest';
import { disponi, intestazione, spezza, type Cornice } from './riquadro.js';
import { larghezzaVisibile } from './textzone.js';

/**
 * La cornice: cosa si disegna, e dove finisce il cursore.
 *
 * Il difetto tipico di un riquadro non è che non si vede — è che **una riga è
 * larga un carattere in meno delle altre**, e il bordo destro fa un gradino
 * che a occhio si nota solo dopo un po'. Per quello quasi ogni test qui misura
 * larghezze invece di cercare sottostringhe.
 */

const id = (s: string): string => s;
const cornice = (extra: Partial<Cornice> = {}): Cornice => ({
  prompt: '› ',
  suggerimenti: 'invio spedisce',
  etichetta: '',
  smorza: id,
  ...extra,
});

/** Le larghezze visibili di ogni riga, senza la riga dei suggerimenti (che sta fuori dal riquadro). */
const larghezze = (righe: string[], conSuggerimenti: boolean): number[] =>
  (conSuggerimenti ? righe.slice(0, -1) : righe).map(larghezzaVisibile);

describe('ogni riga del riquadro è larga uguale', () => {
  it('con un bordo nudo', () => {
    const d = disponi(['ciao'], 0, 4, cornice(), 60);
    expect(new Set(larghezze(d.righe, true))).toEqual(new Set([60]));
  });

  /**
   * Il bordo etichettato era largo **59 su 60**: `╭`, `─`, i due spazi attorno
   * all'etichetta e `╮` fanno cinque, e il conto ne toglieva sei.
   */
  it('e con un etichetta sul bordo alto', () => {
    const d = disponi(['ciao'], 0, 4, cornice({ etichetta: 'qwen3.8-27b · s-a3f' }), 60);
    expect(new Set(larghezze(d.righe, true))).toEqual(new Set([60]));
  });

  it("anche quando l'etichetta è più larga del riquadro", () => {
    const d = disponi(['ciao'], 0, 4, cornice({ etichetta: 'x'.repeat(200) }), 60);
    // Non si può stare dentro, ma le altre righe non devono seguirla fuori.
    expect(new Set(larghezze(d.righe.slice(1, -1), true))).toEqual(new Set([60]));
  });

  it('e con un testo che va a capo dentro la cornice', () => {
    const d = disponi(['x'.repeat(200)], 0, 10, cornice(), 60);
    expect(new Set(larghezze(d.righe, true))).toEqual(new Set([60]));
  });
});

describe('il testo va a capo dentro la cornice, non fuori', () => {
  it('una riga lunga diventa più righe visive', () => {
    const d = disponi(['x'.repeat(200)], 0, 0, cornice(), 60);
    // 60 di terminale, meno cornice e marcatore: più righe di una.
    const dentro = d.righe.filter((r) => r.startsWith('│'));
    expect(dentro.length).toBeGreaterThan(1);
  });

  /**
   * Si taglia alla larghezza e basta, senza cercare gli spazi: mandare a capo
   * sulle parole sposterebbe il cursore rispetto al testo, e in un editor la
   * posizione del cursore deve corrispondere al carattere, sempre.
   */
  it('e si taglia alla larghezza, non sulle parole', () => {
    expect(spezza('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });

  it('una riga vuota resta una riga visiva, invece di sparire', () => {
    expect(spezza('', 10)).toEqual(['']);
    const d = disponi(['', ''], 1, 0, cornice(), 60);
    expect(d.righe.filter((r) => r.startsWith('│'))).toHaveLength(2);
  });
});

describe('dove finisce il cursore', () => {
  it('sulla prima riga, dopo il marcatore', () => {
    const d = disponi(['ciao'], 0, 4, cornice(), 60);
    expect(d.cursore.riga).toBe(1); // 0 è il bordo alto
    // `│` + spazio + `› ` + quattro caratteri, 1-based.
    expect(d.cursore.colonna).toBe(9);
  });

  it('sulla riga logica giusta di un buffer multilinea', () => {
    const d = disponi(['una', 'due', 'tre'], 2, 3, cornice(), 60);
    expect(d.cursore.riga).toBe(3);
  });

  /**
   * Il pezzo che si sbaglia: una riga logica lunga occupa più righe visive, e
   * il cursore deve finire su quella giusta, non sulla prima.
   */
  it('e sulla riga visiva giusta quando la riga logica è andata a capo', () => {
    const w = 60 - 4 - 2; // cornice + marcatore
    const d = disponi(['x'.repeat(w * 2)], 0, w + 3, cornice(), 60);
    // Seconda riga visiva della prima riga logica: bordo alto, poi due.
    expect(d.cursore.riga).toBe(2);
  });

  /**
   * Il marcatore sta solo sulla prima riga; sulle altre uno spazio della stessa
   * larghezza. Se le due cose divergessero, il testo della seconda riga
   * risulterebbe spostato rispetto alla prima.
   */
  it('e le righe dopo la prima sono allineate col testo, non col bordo', () => {
    const d = disponi(['una', 'due'], 0, 0, cornice(), 60);
    const dentro = d.righe.filter((r) => r.startsWith('│'));
    expect(dentro[0]).toContain('│ › una');
    expect(dentro[1]).toContain('│   due');
  });
});

describe("l'intestazione di apertura", () => {
  it('è un riquadro chiuso, con le righe che gli sono state date', () => {
    const righe = intestazione(['✳ muffin', 'qwen3.8-27b'], id, 60);
    expect(righe[0]?.startsWith('╭')).toBe(true);
    expect(righe.at(-1)?.startsWith('╰')).toBe(true);
    expect(righe.join('\n')).toContain('✳ muffin');
    expect(new Set(righe.map(larghezzaVisibile))).toEqual(new Set([60]));
  });
});

describe('il colore non conta come larghezza', () => {
  /**
   * `smorza` avvolge ogni pezzo di cornice in sequenze di escape. Se il
   * riempimento le contasse, ogni riga colorata verrebbe più corta di quella
   * nuda — cioè il riquadro sarebbe storto **solo** col colore acceso, che è
   * il caso che nessun test su una pipe vedrebbe mai.
   */
  it('un riquadro colorato è largo quanto uno nudo', () => {
    const colora = (s: string): string => `\x1b[2m${s}\x1b[0m`;
    const nudo = disponi(['ciao'], 0, 4, cornice(), 60);
    const colorato = disponi(['ciao'], 0, 4, cornice({ smorza: colora }), 60);
    expect(larghezze(colorato.righe, true)).toEqual(larghezze(nudo.righe, true));
    expect(colorato.cursore).toEqual(nudo.cursore);
  });
});
