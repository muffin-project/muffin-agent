/**
 * Il buffer di testo del prompt: righe, cursore, e cosa fa ogni tasto.
 *
 * Nasce da una riga dell'owner: *«la CLI ancora non è fatta bene, non ho tipo
 * una textzone»*. Fino a qui l'input era `rl.question` — **una riga**. Invio
 * spediva sempre, quindi non esisteva un modo di scrivere un messaggio di due
 * paragrafi, e non esisteva un modo di tornare indietro a sistemare la riga di
 * sopra: non c'era una riga di sopra. Incollare un blocco multilinea non
 * incollava, spediva N turni mezzi scritti.
 *
 * ## Perché un modulo puro
 *
 * Qui dentro non si scrive su nessuno stream e non si legge da nessuno. Una
 * funzione prende `(stato, tasto)` e restituisce `(stato, azione)`. È l'unico
 * modo per cui i tasti si possano provare senza un terminale finto — e le
 * combinazioni sono tante: il difetto in un editor di riga non è mai «non
 * funziona», è «Ctrl+W mangia una lettera di troppo quando il cursore è a fine
 * parola».
 *
 * La decodifica dei tasti **non** è qui: la fa `readline.emitKeypressEvents`,
 * che è stdlib e sa già leggere le sequenze di escape di ogni terminale. Questo
 * modulo riceve il risultato di quella decodifica. Riscrivere un decodificatore
 * di escape a mano è il genere di lavoro che sembra finito e non lo è mai.
 */

/** Un tasto già decodificato — la forma che `readline.emitKeypressEvents` emette. */
export type Key = {
  name?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
  shift?: boolean | undefined;
  sequence?: string | undefined;
};

/**
 * Il testo che si sta scrivendo, e dove sta il cursore.
 *
 * Righe separate invece di una stringa con `\n`: ogni movimento del cursore è
 * un'operazione su `(riga, colonna)`, e farlo su un indice piatto vuol dire
 * ricontare i newline a ogni tasto premuto.
 *
 * `storiaIndice` è `null` quando si sta scrivendo qualcosa di nuovo, e un
 * indice quando si sta navigando la storia — la distinzione serve perché
 * tornare in fondo alla storia deve restituire la bozza che si stava
 * scrivendo, non una riga vuota.
 */
export type Stato = {
  righe: string[];
  riga: number;
  colonna: number;
  storia: string[];
  storiaIndice: number | null;
  /** La bozza messa da parte quando si è cominciato a navigare la storia. */
  bozza: string[] | null;
  /** Vero fra `ESC[200~` e `ESC[201~`: dentro un incollaggio, Invio non spedisce. */
  incollando: boolean;
};

export type Azione =
  | { tipo: 'niente' }
  | { tipo: 'spedisci'; testo: string }
  /** Ctrl+C: il chiamante decide se annullare un turno o uscire. */
  | { tipo: 'interrompi' }
  /** Ctrl+D su un buffer vuoto. Su un buffer pieno cancella un carattere, come in bash. */
  | { tipo: 'fine' };

export function statoIniziale(storia: string[] = []): Stato {
  return { righe: [''], riga: 0, colonna: 0, storia, storiaIndice: null, bozza: null, incollando: false };
}

export function testo(s: Stato): string {
  return s.righe.join('\n');
}

/** I marcatori del bracketed paste, così come arrivano dopo la decodifica. */
const PASTE_INIZIO = '[200~';
const PASTE_FINE = '[201~';

function conRighe(s: Stato, righe: string[], riga: number, colonna: number): Stato {
  return { ...s, righe, riga, colonna };
}

/** Il testo corrente diventa la bozza da cui la storia è partita, una volta sola. */
function iniziaStoria(s: Stato): Stato {
  return s.storiaIndice === null ? { ...s, bozza: s.righe } : s;
}

function daStoria(s: Stato, indice: number | null): Stato {
  const righe = indice === null ? (s.bozza ?? ['']) : (s.storia[indice] ?? '').split('\n');
  return {
    ...s,
    storiaIndice: indice,
    righe,
    riga: righe.length - 1,
    colonna: (righe[righe.length - 1] ?? '').length,
  };
}

/**
 * Un tasto, applicato.
 *
 * L'ordine dei rami non è casuale: i marcatori di incollaggio vengono per
 * primi, perché dentro un incollaggio **Invio non spedisce** — è l'intera
 * ragione per cui il bracketed paste esiste, e metterlo dopo il ramo di Invio
 * lo renderebbe inutile.
 */
export function premi(s: Stato, k: Key): { stato: Stato; azione: Azione } {
  const niente = (stato: Stato): { stato: Stato; azione: Azione } => ({ stato, azione: { tipo: 'niente' } });

  if (k.sequence === PASTE_INIZIO) return niente({ ...s, incollando: true });
  if (k.sequence === PASTE_FINE) return niente({ ...s, incollando: false });

  const rigaCorrente = s.righe[s.riga] ?? '';

  if (k.ctrl && k.name === 'c') return { stato: s, azione: { tipo: 'interrompi' } };
  if (k.ctrl && k.name === 'd') {
    // Come in bash: su un buffer vuoto è «esci», su un buffer pieno cancella in
    // avanti. Le due cose condividono il tasto e non si somigliano per niente,
    // e confonderle vuol dire uscire dal REPL mentre si stava cancellando.
    if (s.righe.length === 1 && rigaCorrente === '') return { stato: s, azione: { tipo: 'fine' } };
    if (s.colonna < rigaCorrente.length) {
      const righe = [...s.righe];
      righe[s.riga] = rigaCorrente.slice(0, s.colonna) + rigaCorrente.slice(s.colonna + 1);
      return niente(conRighe(s, righe, s.riga, s.colonna));
    }
    return niente(s);
  }

  /**
   * **Le due Invio, e sono due tasti diversi sul filo.**
   *
   * Misurato il 28/08/2026 con `emitKeypressEvents`, dopo aver visto il difetto
   * su uno schermo vero dentro tmux:
   *
   *   `\r`      -> `{name:'return'}`            Invio
   *   `\n`      -> `{name:'enter'}`             Ctrl+J
   *   `ESC \r`  -> `{name:'return', meta:true}` Alt+Invio
   *
   * `enter` **non** arriva con `ctrl: true`. Il ramo che avevo scritto —
   * `k.ctrl && k.name === 'j'` — era quindi codice morto, e `enter` cadeva nel
   * ramo di sopra insieme a `return`: Ctrl+J spediva invece di andare a capo,
   * cioè la via che doveva funzionare su ogni terminale era l'unica rotta.
   *
   * Il mio test non l'aveva visto perché costruiva `{name:'j', ctrl:true}` —
   * una forma che Node non produce mai. Provava la mia assunzione, non il
   * terminale.
   *
   * Quindi: `return` nudo spedisce; `enter` (Ctrl+J) va a capo sempre; un
   * `return` con un modificatore va a capo — `meta` è Alt+Invio, `shift` è
   * Shift+Invio dove il terminale lo manda distinto (iTerm2 e Ghostty sì,
   * Terminal.app no, ed è per questo che Ctrl+J deve funzionare).
   */
  if (k.name === 'enter') return niente(aCapo(s));
  if (k.name === 'return') {
    if (s.incollando || k.meta === true || k.shift === true) return niente(aCapo(s));
    return { stato: s, azione: { tipo: 'spedisci', testo: testo(s) } };
  }

  if (k.name === 'backspace') {
    if (s.colonna > 0) {
      const righe = [...s.righe];
      righe[s.riga] = rigaCorrente.slice(0, s.colonna - 1) + rigaCorrente.slice(s.colonna);
      return niente(conRighe(s, righe, s.riga, s.colonna - 1));
    }
    // A inizio riga: si fondono le due righe, e il cursore resta dov'era la
    // giunzione. È la parte che si sbaglia mettendo il cursore a 0.
    if (s.riga > 0) {
      const sopra = s.righe[s.riga - 1] ?? '';
      const righe = [...s.righe];
      righe.splice(s.riga - 1, 2, sopra + rigaCorrente);
      return niente(conRighe(s, righe, s.riga - 1, sopra.length));
    }
    return niente(s);
  }

  if (k.ctrl && k.name === 'a') return niente({ ...s, colonna: 0 });
  if (k.ctrl && k.name === 'e') return niente({ ...s, colonna: rigaCorrente.length });
  if (k.ctrl && k.name === 'u') {
    const righe = [...s.righe];
    righe[s.riga] = rigaCorrente.slice(s.colonna);
    return niente(conRighe(s, righe, s.riga, 0));
  }
  if (k.ctrl && k.name === 'k') {
    const righe = [...s.righe];
    righe[s.riga] = rigaCorrente.slice(0, s.colonna);
    return niente(conRighe(s, righe, s.riga, s.colonna));
  }
  if (k.ctrl && k.name === 'w') {
    // Si saltano prima gli spazi a sinistra, poi la parola. Senza il primo
    // passo, Ctrl+W a fine parola seguita da spazio cancella solo lo spazio —
    // il difetto che si nota al terzo uso e non al primo.
    let i = s.colonna;
    while (i > 0 && /\s/.test(rigaCorrente[i - 1] ?? '')) i -= 1;
    while (i > 0 && !/\s/.test(rigaCorrente[i - 1] ?? '')) i -= 1;
    const righe = [...s.righe];
    righe[s.riga] = rigaCorrente.slice(0, i) + rigaCorrente.slice(s.colonna);
    return niente(conRighe(s, righe, s.riga, i));
  }

  if (k.name === 'left') {
    if (s.colonna > 0) return niente({ ...s, colonna: s.colonna - 1 });
    if (s.riga > 0) return niente({ ...s, riga: s.riga - 1, colonna: (s.righe[s.riga - 1] ?? '').length });
    return niente(s);
  }
  if (k.name === 'right') {
    if (s.colonna < rigaCorrente.length) return niente({ ...s, colonna: s.colonna + 1 });
    if (s.riga < s.righe.length - 1) return niente({ ...s, riga: s.riga + 1, colonna: 0 });
    return niente(s);
  }
  if (k.name === 'home') return niente({ ...s, colonna: 0 });
  if (k.name === 'end') return niente({ ...s, colonna: rigaCorrente.length });

  if (k.name === 'up') {
    // Dentro un buffer di più righe la freccia muove **nel buffer**; solo dalla
    // prima riga entra nella storia. È la regola che rende un editor
    // multilinea usabile senza togliere la storia a chi scrive una riga sola.
    if (s.riga > 0) {
      const sopra = s.righe[s.riga - 1] ?? '';
      return niente({ ...s, riga: s.riga - 1, colonna: Math.min(s.colonna, sopra.length) });
    }
    if (s.storia.length === 0) return niente(s);
    const base = iniziaStoria(s);
    const prossimo = base.storiaIndice === null ? base.storia.length - 1 : Math.max(0, base.storiaIndice - 1);
    return niente(daStoria(base, prossimo));
  }
  if (k.name === 'down') {
    if (s.riga < s.righe.length - 1) {
      const sotto = s.righe[s.riga + 1] ?? '';
      return niente({ ...s, riga: s.riga + 1, colonna: Math.min(s.colonna, sotto.length) });
    }
    if (s.storiaIndice === null) return niente(s);
    const prossimo = s.storiaIndice + 1;
    return niente(daStoria(s, prossimo >= s.storia.length ? null : prossimo));
  }

  // Testo. Si escludono le sequenze di controllo che non hanno prodotto un
  // ramo qui sopra: senza questo filtro un tasto funzione ignoto finirebbe nel
  // buffer come `[15~`.
  const ch = k.sequence ?? '';
  if (ch.length === 0 || k.ctrl === true || k.meta === true) return niente(s);
  if (ch.startsWith('')) return niente(s);
  // Un incollaggio arriva come un pezzo unico che può contenere a capo: si
  // inserisce come testo, non come una raffica di Invio.
  if (ch.includes('\n') || ch.includes('\r')) {
    let stato = s;
    const pezzi = ch.split(/\r\n|\r|\n/);
    for (let i = 0; i < pezzi.length; i += 1) {
      if (i > 0) stato = aCapo(stato);
      stato = inserisci(stato, pezzi[i] ?? '');
    }
    return niente(stato);
  }
  // I caratteri di controllo restanti non sono testo.
  if (ch.length === 1 && ch.charCodeAt(0) < 0x20) return niente(s);
  return niente(inserisci(s, ch));
}

function inserisci(s: Stato, testoDaInserire: string): Stato {
  if (testoDaInserire === '') return s;
  const riga = s.righe[s.riga] ?? '';
  const righe = [...s.righe];
  righe[s.riga] = riga.slice(0, s.colonna) + testoDaInserire + riga.slice(s.colonna);
  return conRighe(s, righe, s.riga, s.colonna + testoDaInserire.length);
}

function aCapo(s: Stato): Stato {
  const riga = s.righe[s.riga] ?? '';
  const righe = [...s.righe];
  righe.splice(s.riga, 1, riga.slice(0, s.colonna), riga.slice(s.colonna));
  return conRighe(s, righe, s.riga + 1, 0);
}
