import { describe, expect, it } from 'vitest';
import { annunciaSalto } from './non-provabile.js';

describe('annunciaSalto', () => {
  it('scrive il motivo, non solo un simbolo', () => {
    // Una capability non esercitata che non lascia traccia nell'output è
    // indistinguibile da una provata: la mutazione che questo test uccide è
    // esattamente «il salto smette di stamparsi».
    const scritto: string[] = [];
    annunciaSalto('D9', 'bwrap grezzo non contiene su questo host: ENOENT', (s) => scritto.push(s));
    expect(scritto).toHaveLength(1);
    expect(scritto[0]).toContain('D9');
    expect(scritto[0]).toContain('non provabile su questo host');
    expect(scritto[0]).toContain('ENOENT');
  });

  it('il titolo del test saltato porta lo stesso motivo', () => {
    // Il report dei test (`report.ts`) e l'output del terminale devono poter
    // dire la stessa cosa senza rileggere lo stderr.
    const titolo = annunciaSalto('D9', 'ENOENT', () => {});
    expect(titolo).toContain('D9');
    expect(titolo).toContain('non provabile qui');
    expect(titolo).toContain('ENOENT');
  });
});
