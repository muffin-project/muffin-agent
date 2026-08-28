import { describe, expect, it } from 'vitest';
import { premi, statoIniziale, testo, type Azione, type Key, type Stato } from './editor.js';

/**
 * Il buffer del prompt, tasto per tasto.
 *
 * Un editor di riga non si rompe mai in modo vistoso: si rompe con «Ctrl+W
 * mangia una lettera di troppo quando il cursore è a fine parola», o con
 * «backspace a inizio riga mette il cursore a zero invece che alla giunzione».
 * Sono difetti che si notano al terzo uso, non al primo, e che una prova a mano
 * in un terminale non trova mai due volte di fila. Per quello il buffer è un
 * modulo puro e per quello questi test esistono.
 */

const t = (name: string, extra: Partial<Key> = {}): Key => ({ name, sequence: name, ...extra });
const chr = (sequence: string): Key => ({ sequence });

/** Scrive una stringa carattere per carattere, come farebbe una tastiera. */
function scrivi(s: Stato, testoDaScrivere: string): Stato {
  let stato = s;
  for (const c of testoDaScrivere) stato = premi(stato, chr(c)).stato;
  return stato;
}

function agisci(s: Stato, k: Key): { stato: Stato; azione: Azione } {
  return premi(s, k);
}

describe('scrivere e muoversi', () => {
  it('scrive testo e lo tiene in una riga sola', () => {
    const s = scrivi(statoIniziale(), 'ciao');
    expect(testo(s)).toBe('ciao');
    expect(s.colonna).toBe(4);
  });

  it('le frecce si muovono dentro la riga senza cambiarla', () => {
    let s = scrivi(statoIniziale(), 'ciao');
    s = premi(s, t('left')).stato;
    s = premi(s, t('left')).stato;
    expect(s.colonna).toBe(2);
    s = scrivi(s, 'XX');
    expect(testo(s)).toBe('ciXXao');
  });

  it('backspace a inizio riga fonde le due righe e lascia il cursore alla giunzione', () => {
    let s = scrivi(statoIniziale(), 'primo');
    s = premi(s, { name: 'return', shift: true }).stato;
    s = scrivi(s, 'secondo');
    expect(testo(s)).toBe('primo\nsecondo');

    // A inizio della seconda riga.
    s = { ...s, colonna: 0 };
    s = premi(s, t('backspace')).stato;
    expect(testo(s)).toBe('primosecondo');
    // Alla giunzione, non a zero: è il punto in cui si era, e mettere il
    // cursore a 0 fa saltare il cursore a inizio riga a ogni fusione.
    expect(s.colonna).toBe(5);
  });
});

describe('le due Invio', () => {
  /** Senza questa distinzione un messaggio di due paragrafi non è scrivibile. */
  it('Invio da solo spedisce', () => {
    const s = scrivi(statoIniziale(), 'ciao');
    const r = agisci(s, t('return'));
    expect(r.azione).toEqual({ tipo: 'spedisci', testo: 'ciao' });
  });

  it('Shift+Invio e Alt+Invio vanno a capo, e non spediscono', () => {
    for (const mod of [{ shift: true }, { meta: true }]) {
      let s = scrivi(statoIniziale(), 'primo');
      const r = agisci(s, { name: 'return', ...mod });
      expect(r.azione.tipo).toBe('niente');
      s = scrivi(r.stato, 'secondo');
      expect(testo(s)).toBe('primo\nsecondo');
    }
  });

  /**
   * Ctrl+J è la via che funziona ovunque: è un carattere vero (0x0A), non una
   * sequenza che il terminale deve decidere di inventare. Terminal.app non
   * distingue Shift+Invio, quindi senza questo su quel terminale la textzone
   * non esisterebbe.
   *
   * **Il tasto è quello che Node produce davvero**, non quello che sembrava
   * ovvio. Misurato con `emitKeypressEvents`: `\n` arriva come
   * `{name:'enter'}` — senza `ctrl`. La versione precedente di questo test
   * costruiva `{name:'j', ctrl:true}`, una forma che Node non emette mai:
   * passava verde mentre su un terminale vero Ctrl+J spediva il messaggio.
   * Provava la mia assunzione, non il terminale.
   */
  it('e Ctrl+J pure — che Node consegna come `enter`, non come ctrl+j', () => {
    const s = scrivi(statoIniziale(), 'primo');
    const r = agisci(s, { name: 'enter', sequence: '\n' });
    expect(r.azione.tipo).toBe('niente');
    expect(testo(scrivi(r.stato, 'secondo'))).toBe('primo\nsecondo');
  });

  /** E `return` nudo resta l'unico che spedisce. */
  it('mentre `return` nudo è il solo che spedisce', () => {
    const s = scrivi(statoIniziale(), 'ciao');
    expect(agisci(s, { name: 'return', sequence: '\r' }).azione.tipo).toBe('spedisci');
  });
});

describe('incollare un blocco multilinea', () => {
  /**
   * Il difetto vero: senza bracketed paste, incollare tre righe spediva **tre
   * turni** mezzi scritti, perché ogni a capo del testo incollato arrivava
   * come un Invio.
   */
  it('fra i marcatori di incollaggio, Invio va a capo invece di spedire', () => {
    let s = statoIniziale();
    s = premi(s, chr('\x1b[200~')).stato;
    expect(s.incollando).toBe(true);

    s = scrivi(s, 'prima');
    const r = agisci(s, t('return'));
    expect(r.azione.tipo).toBe('niente');
    s = scrivi(r.stato, 'seconda');

    s = premi(s, chr('\x1b[201~')).stato;
    expect(s.incollando).toBe(false);
    expect(testo(s)).toBe('prima\nseconda');

    // E finito l'incollaggio, Invio torna a spedire.
    expect(agisci(s, t('return')).azione.tipo).toBe('spedisci');
  });

  it('un pezzo incollato che contiene a capo entra come testo, non come raffica di Invio', () => {
    const s = premi(statoIniziale(), chr('una\ndue\ntre')).stato;
    expect(testo(s)).toBe('una\ndue\ntre');
    expect(s.righe).toHaveLength(3);
  });
});

describe('cancellare per parola', () => {
  /**
   * Il difetto che si nota al terzo uso: senza saltare prima gli spazi, Ctrl+W
   * a fine parola-seguita-da-spazio cancella solo lo spazio.
   */
  it('Ctrl+W dopo uno spazio cancella la parola, non solo lo spazio', () => {
    const s = premi(scrivi(statoIniziale(), 'ciao mondo '), { name: 'w', ctrl: true }).stato;
    expect(testo(s)).toBe('ciao ');
  });

  it('e a metà parola cancella solo fin dove sta il cursore', () => {
    let s = scrivi(statoIniziale(), 'ciao mondo');
    s = premi(s, t('left')).stato;
    s = premi(s, t('left')).stato; // fra "mon" e "do"
    s = premi(s, { name: 'w', ctrl: true }).stato;
    expect(testo(s)).toBe('ciao do');
  });

  it('Ctrl+U toglie a sinistra, Ctrl+K a destra', () => {
    let s = scrivi(statoIniziale(), 'ciao mondo');
    s = { ...s, colonna: 5 };
    expect(testo(premi(s, { name: 'u', ctrl: true }).stato)).toBe('mondo');
    expect(testo(premi(s, { name: 'k', ctrl: true }).stato)).toBe('ciao ');
  });
});

describe('la storia', () => {
  /**
   * La regola che rende un editor multilinea usabile senza togliere la storia
   * a chi scrive una riga sola: dentro un buffer di più righe la freccia muove
   * nel buffer, e solo dalla prima riga entra nella storia.
   */
  it('freccia su dentro un buffer multilinea muove nel buffer, non nella storia', () => {
    let s = statoIniziale(['vecchia']);
    s = scrivi(s, 'primo');
    s = premi(s, { name: 'return', shift: true }).stato;
    s = scrivi(s, 'secondo');

    s = premi(s, t('up')).stato;
    expect(testo(s)).toBe('primo\nsecondo');
    expect(s.riga).toBe(0);
    expect(s.storiaIndice).toBeNull();
  });

  it('e dalla prima riga entra nella storia', () => {
    let s = statoIniziale(['prima cosa', 'seconda cosa']);
    s = premi(s, t('up')).stato;
    expect(testo(s)).toBe('seconda cosa');
    s = premi(s, t('up')).stato;
    expect(testo(s)).toBe('prima cosa');
  });

  /**
   * Tornare in fondo alla storia deve restituire **la bozza** che si stava
   * scrivendo, non una riga vuota: perdere quello che si era già scritto per
   * aver premuto una freccia è il modo più veloce per non usare più le frecce.
   */
  it('e tornando giù restituisce la bozza che si stava scrivendo', () => {
    let s = statoIniziale(['vecchia']);
    s = scrivi(s, 'bozza a metà');
    s = premi(s, t('up')).stato;
    expect(testo(s)).toBe('vecchia');
    s = premi(s, t('down')).stato;
    expect(testo(s)).toBe('bozza a metà');
    expect(s.storiaIndice).toBeNull();
  });

  it('senza storia la freccia su non fa niente', () => {
    const s = scrivi(statoIniziale(), 'ciao');
    expect(testo(premi(s, t('up')).stato)).toBe('ciao');
  });
});

describe('Ctrl+C e Ctrl+D', () => {
  it('Ctrl+C è sempre un interrompi, e il chiamante decide cosa vuol dire', () => {
    expect(agisci(scrivi(statoIniziale(), 'ciao'), { name: 'c', ctrl: true }).azione).toEqual({ tipo: 'interrompi' });
  });

  /**
   * Come in bash, e la distinzione conta: le due cose condividono il tasto e
   * non si somigliano per niente. Confonderle vuol dire uscire dal REPL mentre
   * si stava cancellando un carattere.
   */
  it('Ctrl+D su buffer vuoto esce, su buffer pieno cancella in avanti', () => {
    expect(agisci(statoIniziale(), { name: 'd', ctrl: true }).azione).toEqual({ tipo: 'fine' });

    let s = scrivi(statoIniziale(), 'ciao');
    s = { ...s, colonna: 0 };
    const r = agisci(s, { name: 'd', ctrl: true });
    expect(r.azione.tipo).toBe('niente');
    expect(testo(r.stato)).toBe('iao');
  });
});

describe('cosa non deve finire nel buffer', () => {
  /**
   * Senza questo filtro un tasto funzione ignoto finisce nel testo come
   * `[15~`, e l'owner si ritrova caratteri che non ha scritto in un messaggio
   * che sta per spedire.
   */
  it('una sequenza di escape sconosciuta non diventa testo', () => {
    const s = premi(scrivi(statoIniziale(), 'ciao'), chr('\x1b[15~')).stato;
    expect(testo(s)).toBe('ciao');
  });

  it('né un carattere di controllo isolato', () => {
    const s = premi(scrivi(statoIniziale(), 'ciao'), chr('\x07')).stato;
    expect(testo(s)).toBe('ciao');
  });
});
