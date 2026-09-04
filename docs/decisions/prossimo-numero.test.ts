import { describe, expect, it } from 'vitest';
// @ts-expect-error — modulo .mjs senza dichiarazioni, importato di proposito
// com'è: è uno strumento da riga di comando, non una dipendenza del runtime.
import { numeriPresi, prossimoLibero } from './prossimo-numero.mjs';

describe('il prossimo numero ADR', () => {
  it('non riusa il buco lasciato da un ADR ritirato', () => {
    // 0003 ritirato e il file cancellato: 3 resta bruciato, perché i commit e i
    // commenti che citavano ADR-0003 puntano ancora lì. Il prossimo è 6.
    expect(prossimoLibero([1, 2, 4, 5])).toBe(6);
  });

  it('parte da 1 su una repo senza ADR', () => {
    expect(prossimoLibero([])).toBe(1);
  });

  it('conta un numero preso su un ramo NON integrato', () => {
    // Il caso che ha prodotto le due collisioni del 04/09/2026: `dev` non
    // conosce ancora 0065, ma un ramo aperto sì. Guardare solo `dev` qui
    // risponderebbe 0065 e rifarebbe l'incidente.
    const rami = () => ['dev', 'slice/qualcosa'];
    const file = (ramo: string) =>
      ramo === 'dev'
        ? ['docs/decisions/0064-una.md']
        : ['docs/decisions/0064-una.md', 'docs/decisions/0065-altra.md'];
    expect(prossimoLibero(numeriPresi(rami, file))).toBe(66);
  });

  it('ignora i file di `docs/decisions/` che non sono ADR', () => {
    const rami = () => ['dev'];
    const file = () => ['docs/decisions/0001-una.md', 'docs/decisions/adr.test.ts', 'docs/decisions/prossimo-numero.mjs'];
    expect(prossimoLibero(numeriPresi(rami, file))).toBe(2);
  });
});
