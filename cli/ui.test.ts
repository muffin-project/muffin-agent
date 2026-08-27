import { describe, expect, it } from 'vitest';
import { PLAIN, styleFor } from './ui.js';
import { formatReport } from './doctor.js';
import type { DoctorReport } from './doctor.js';

const TTY = { isTTY: true };

const report: DoctorReport = {
  exitCode: 1,
  checks: [
    { name: 'build', level: 'ok', detail: 'cc28618 del 2026-08-27' },
    { name: 'vector index', level: 'warn', detail: "l'embedder non risponde", remedy: 'avvia ollama' },
  ],
};

/**
 * Il colore è additivo e sparisce da solo. È la condizione che tiene in piedi
 * ogni `expect(out).toContain('…')` già scritto — la suite passa `NO_COLOR: '1'`
 * a ogni `spawnSync` — e che fa arrivare a `grep` e `tee` lo stesso testo di
 * prima. Stessa regola di `makeStatusLine`, stessa ragione: una sequenza di
 * escape dentro un file è spazzatura.
 */
describe('styleFor — quando il colore esce e quando no', () => {
  it('su un TTY senza NO_COLOR, colora', () => {
    expect(styleFor(TTY, {}).enabled).toBe(true);
  });

  it('mai fuori da un TTY, per quanto pulito sia l ambiente', () => {
    expect(styleFor({ isTTY: false }, {}).enabled).toBe(false);
    expect(styleFor({}, {}).enabled).toBe(false);
  });

  it('mai con NO_COLOR impostata, che è lo standard e quello che passa la suite', () => {
    expect(styleFor(TTY, { NO_COLOR: '1' }).enabled).toBe(false);
    // Anche vuota: lo standard dice «impostata», non «con un valore».
    expect(styleFor(TTY, { NO_COLOR: '' }).enabled).toBe(false);
  });

  it('mai su TERM=dumb', () => {
    expect(styleFor(TTY, { TERM: 'dumb' }).enabled).toBe(false);
  });

  it('spento, ogni funzione restituisce il testo identico', () => {
    const s = styleFor({ isTTY: false }, {});
    for (const f of [s.ok, s.warn, s.fail, s.dim, s.bold, s.accent]) expect(f('ciao')).toBe('ciao');
    expect(s.header('muffin doctor', '/home')).not.toMatch(//);
    expect(s.header('muffin doctor', '/home')).toContain('muffin doctor');
    expect(s.header('muffin doctor', '/home')).toContain('/home');
  });

  it('acceso, il testo resta dentro e la sequenza si chiude', () => {
    const s = styleFor(TTY, {});
    expect(s.ok('✓')).toContain('✓');
    expect(s.ok('✓').endsWith('[0m')).toBe(true);
  });
});

describe('formatReport', () => {
  /**
   * Il default è senza colore, e non è pigrizia: `formatReport` è una funzione
   * che restituisce una stringa, e chi la chiama può volerla scrivere su disco.
   * Colorare per default vorrebbe dire che il caso comodo è quello sbagliato.
   */
  it('senza stile non emette nessuna sequenza di escape', () => {
    const out = formatReport(report);
    expect(out).not.toMatch(//);
    expect(out).toContain('✓ build');
    expect(out).toContain('→ avvia ollama');
  });

  it('e con lo stile spento produce byte identici al default', () => {
    expect(formatReport(report, PLAIN)).toBe(formatReport(report));
  });

  /**
   * Il segno prende il colore, il dettaglio resta nudo: colorare anche il
   * dettaglio farebbe venti righe verdi in cui trovare l'unica gialla è di
   * nuovo un lavoro dell'occhio.
   */
  it('acceso, colora i segni e lascia il dettaglio pulito', () => {
    const out = formatReport(report, styleFor(TTY, {}));
    expect(out).toMatch(/\[32m✓/);
    expect(out).toMatch(/\[33m!/);
    expect(out).toContain("l'embedder non risponde");
    // Il dettaglio non e' avvolto: subito dopo il nome in grassetto chiuso,
    // il testo prosegue nudo fino a fine riga.
    expect(out).toMatch(/l'embedder non risponde$/m);
  });

  it("il rimedio e' smorzato, perche' lo leggi dopo aver deciso che la riga sopra ti riguarda", () => {
    const out = formatReport(report, styleFor(TTY, {}));
    expect(out).toMatch(/\[2m {2}→ avvia ollama/);
  });
});
