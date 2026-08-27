import { describe, expect, it } from 'vitest';
import { makeStatusLine } from './status-line.js';

const sink = (): { out: string[]; write: (t: string) => void } => {
  const out: string[] = [];
  return { out, write: (t: string) => void out.push(t) };
};

describe('makeStatusLine', () => {
  it('su un TTY riscrive in place e sparisce quando le si dice di sparire', () => {
    const { out, write } = sink();
    const s = makeStatusLine(write, true);
    s.show('penso…');
    s.clear();
    s.stop();
    expect(out[0]).toContain('penso…');
    expect(out[0]!.startsWith('\r\u001b[2K')).toBe(true);
    expect(out.at(-1)).toBe('\r\u001b[2K');
  });

  /**
   * `clear()` si chiama prima di ogni riga che va nello scrollback, e chi
   * stampa non sa se un'attesa è in corso. A schermo pulito deve quindi non
   * scrivere niente: altrimenti in `--debug` — dove la riga di stato non
   * compare mai — ogni riga si porterebbe davanti una sequenza di escape, e
   * smetterebbe di cominciare con quello con cui dice di cominciare.
   */
  it('a schermo pulito non scrive niente: cancellare il nulla non è una cancellazione', () => {
    const { out, write } = sink();
    const s = makeStatusLine(write, true);
    s.clear();
    s.clear();
    expect(out).toEqual([]);
  });

  /**
   * Senza TTY niente spinner e niente sequenze di cancellazione: `\r\x1b[2K`
   * dentro un file è spazzatura, e uno spinner dentro una pipe è spazzatura
   * che si ripete. È la stessa scelta che `streamEnabled` fa per il testo.
   */
  it('senza TTY diventa una riga normale, e non si ripete uguale', () => {
    const { out, write } = sink();
    const s = makeStatusLine(write, false);
    s.show('penso…');
    s.show('penso…');
    s.clear();
    s.show('penso…');
    expect(out).toEqual(['· penso…\n', '· penso…\n']);
    expect(out.join('')).not.toContain('\u001b');
  });
});


/**
 * Il difetto che ha prodotto questo file, misurato sulla macchina dell'owner —
 * la riga di stato accesa e il consolidamento che ci si scrive dentro, senza
 * cancellarla, sulla stessa riga.
 *
 * Il consolidatore scrive su stderr da `agent/runtime.ts`, che della riga di
 * stato non sa niente. `line()` è la porta unica che lo impedisce, e il test
 * guarda i byte perché è ai byte che si vedeva.
 */
describe('line() — la porta unica per chi scrive fuori banda', () => {
  it("cancella l'attesa prima di scrivere, invece di incollarcisi dentro", () => {
    const { out, write } = sink();
    const s = makeStatusLine(write, true);
    s.show('penso…');
    s.line('consolidamento: embedder non disponibile');
    s.stop();
    const scritto = out.join('');
    expect(scritto).not.toContain('penso…consolidamento');
    // La cancellazione sta *prima* della riga, non dopo.
    expect(scritto.indexOf('[2K')).toBeLessThan(scritto.indexOf('consolidamento'));
    expect(scritto.endsWith('consolidamento: embedder non disponibile\n')).toBe(true);
  });

  it('senza attesa accesa scrive la riga e basta, senza sequenze di escape', () => {
    const { out, write } = sink();
    const s = makeStatusLine(write, true);
    s.line('job 1a2b3c: consegna fallita');
    expect(out).toEqual(['job 1a2b3c: consegna fallita\n']);
  });

  it("senza TTY è una riga e basta, e reimposta l'ultimo stato mostrato", () => {
    const { out, write } = sink();
    const s = makeStatusLine(write, false);
    s.show('penso…');
    s.line('consolidamento: fatto');
    s.show('penso…');
    expect(out).toEqual(['· penso…\n', 'consolidamento: fatto\n', '· penso…\n']);
  });
});
