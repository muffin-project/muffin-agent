import { describe, expect, it } from 'vitest';
import { affermazioni, caratteriInEco, eco } from './eco.js';

/**
 * La misura dell'eco.
 *
 * Il difetto che questi test tengono chiuso non è «trova troppo poco»: è
 * **trova poco e sembra a posto**. La prima versione leggeva riga per riga su
 * file mandati a capo a 80 colonne, quindi confrontava mezze frasi, e riportava
 * 4 coppie dove ce n'erano cinque volte tante. Un misuratore che dice «quasi
 * niente» non fallisce: viene creduto.
 */

describe('le frasi si ricuciono prima di essere confrontate', () => {
  /**
   * Il difetto vero, misurato: `persona.md` e `voice.md` vanno a capo attorno
   * agli 80 caratteri, quindi ogni affermazione sta su due o tre righe.
   */
  it('una frase spezzata su tre righe torna una frase sola', () => {
    const a = affermazioni('x', 'Non devo fare una battuta\nper dimostrare di avere\npersonalità.');
    expect(a).toHaveLength(1);
    expect(a[0]?.testo).toBe('Non devo fare una battuta per dimostrare di avere personalità.');
  });

  it('e due frasi sulla stessa riga restano due', () => {
    const a = affermazioni('x', 'La memoria cambia il modo in cui capisco quello che succede adesso. Le inferenze importanti restano comunque soltanto inferenze.');
    expect(a).toHaveLength(2);
  });

  /** Una riga vuota separa: non si incolla la fine di un paragrafo all'inizio del dopo. */
  it('un paragrafo non si attacca a quello dopo', () => {
    const a = affermazioni('x', 'La memoria cambia il modo in cui capisco quello che succede adesso\n\nLe inferenze importanti restano comunque soltanto inferenze');
    expect(a).toHaveLength(2);
  });

  /**
   * Dentro un elenco le affermazioni ci sono eccome — è dove `voice.md` tiene
   * le sue — e attaccarle alla riga che le introduce le fonderebbe in una.
   */
  it('ogni voce di elenco è una sua affermazione', () => {
    const a = affermazioni(
      'x',
      'Non uso mai linguaggio corporate per riflesso automatico:\n\n- come posso aiutarti oggi con questo problema tecnico\n- spero davvero che questo messaggio ti sia utile',
    );
    expect(a).toHaveLength(3);
  });

  it("un'intestazione non è un'affermazione", () => {
    expect(affermazioni('x', '## Come lavoro e come parlo')).toHaveLength(0);
  });

  /** Sotto le quattro parole di contenuto ogni frase somiglia a ogni altra. */
  it('e una frase troppo corta non entra nel confronto', () => {
    expect(affermazioni('x', 'Sono Muffin e basta.')).toHaveLength(0);
  });
});

describe("l'eco sta fra blocchi, non dentro", () => {
  const stessa = 'Non descrivo un azione come fatta se non l ho fatta davvero.';
  const riformulata = 'Se descrivo un azione al passato deve esserci evidenza che sia stata fatta davvero.';

  it('due blocchi che dicono la stessa cosa sono una coppia', () => {
    const r = eco([
      { name: 'persona', text: stessa },
      { name: 'voice', text: riformulata },
    ]);
    expect(r).toHaveLength(1);
    expect([r[0]?.a.blocco, r[0]?.b.blocco]).toEqual(['persona', 'voice']);
  });

  /**
   * Un file che si ripete al proprio interno è un difetto di quel file e lo
   * vede chi lo legge. Quattro file che si ripetono a vicenda non li vede
   * nessuno, perché nessuno li legge insieme: è il caso che ha bisogno di uno
   * strumento, ed è l'unico che questo misura.
   */
  it('mentre un blocco che si ripete da solo non lo è', () => {
    expect(eco([{ name: 'persona', text: `${stessa}\n\n${riformulata}` }])).toHaveLength(0);
  });

  it('e due affermazioni che non c entrano niente non lo sono', () => {
    const r = eco([
      { name: 'persona', text: 'Mi interessano anche le assenze di un progetto lasciato lì.' },
      { name: 'voice', text: 'Non uso LaTeX nei messaggi destinati a superfici che non lo renderizzano.' },
    ]);
    expect(r).toHaveLength(0);
  });

  /**
   * Sul più piccolo dei due insiemi, non sull'unione: una frase corta contenuta
   * dentro una lunga **è** un'eco, e l'unione la punirebbe per la lunghezza
   * dell'altra — cioè proprio il caso in cui un file dice in una riga quello
   * che un altro dice in un paragrafo.
   */
  it('una frase corta dentro una lunga conta come eco', () => {
    const r = eco([
      { name: 'work-rules', text: 'Non chiedere il permesso a parole per una cosa che i permessi gestiscono.' },
      {
        name: 'persona',
        text: 'Chiedere continuamente il permesso a parole per una cosa che i permessi gestiscono già non serve a nessuno ed è soltanto attrito inutile fra due passi.',
      },
    ]);
    expect(r).toHaveLength(1);
  });
});

describe('quanto prompt è coinvolto', () => {
  /**
   * Non è «quanto si risparmierebbe»: una delle due copie va tenuta. È la
   * misura da guardare scendere quando si mette mano ai file.
   */
  it('conta ogni affermazione una volta sola, anche se ha più eco', () => {
    const r = eco([
      { name: 'a', text: 'Non descrivo un azione come fatta se non l ho fatta davvero.' },
      { name: 'b', text: 'Non descrivo un azione come fatta se non l ho fatta davvero.' },
      { name: 'c', text: 'Non descrivo un azione come fatta se non l ho fatta davvero.' },
    ]);
    expect(r).toHaveLength(3); // a↔b, a↔c, b↔c
    // Ma i caratteri sono tre affermazioni, non sei.
    expect(caratteriInEco(r)).toBe(60 * 3);
  });

  it('e senza eco è zero', () => {
    expect(caratteriInEco([])).toBe(0);
  });
});
