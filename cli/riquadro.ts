import { larghezzaVisibile } from './textzone.js';

/**
 * La cornice attorno a ciò che stai scrivendo, e l'intestazione che dice con
 * chi stai parlando.
 *
 * Owner, 28/08: *«guarda tipo claude code, che ha i bordi, text area,
 * personaggio in alto, nomi testi e cose così»*. Fino a qui il prompt era un
 * `›` e basta: dove finisce quello che scrivi tu e comincia quello che ha
 * scritto lui era una cosa da dedurre, e su uno scrollback lungo era da
 * cercare.
 *
 * ## Perché è un modulo puro
 *
 * Qui si decide **cosa disegnare**, non si disegna. Una funzione prende lo
 * stato e la larghezza e restituisce righe più la posizione del cursore. È
 * l'unico modo per provare l'andata a capo dentro il riquadro senza un
 * terminale: la parte che si rompe è sempre quella — una riga più larga della
 * cornice che sfonda il bordo destro, o un cursore che finisce su una riga
 * visiva che non è la sua.
 *
 * ## E resta nello scrollback
 *
 * `cli/STYLES.md` esclude lo schermo alternato, e la regola vale ancora: il
 * riquadro si disegna **in fondo**, e si ridisegna cancellando solo le proprie
 * righe. Quello che è già scorso sopra resta selezionabile e copiabile.
 */

/** Il massimo a cui il riquadro si allarga, per non attraversare uno schermo largo. */
const LARGHEZZA_MASSIMA = 100;

export type Cornice = {
  /** Il segno davanti alla prima riga. */
  prompt: string;
  /** La riga di suggerimenti sotto il riquadro. Vuota = non si stampa. */
  suggerimenti: string;
  /** Cosa scrivere sul bordo superiore — il modello, la sessione. Vuoto = bordo nudo. */
  etichetta: string;
  /** Applicato a ogni pezzo di cornice; l'identità quando il colore è spento. */
  smorza: (s: string) => string;
};

export type Disposizione = {
  /** Le righe da scrivere, in ordine, senza a capo finale. */
  righe: string[];
  /** Dove va il cursore: indice di riga dentro `righe`, e colonna 1-based sullo schermo. */
  cursore: { riga: number; colonna: number };
};

/**
 * Spezza una riga logica in righe visive larghe al massimo `w`.
 *
 * Si taglia a `w` e basta, senza cercare gli spazi: mandare a capo sulle parole
 * sposterebbe il cursore rispetto al testo, e in un editor la posizione del
 * cursore deve corrispondere al carattere, sempre. Una riga vuota resta una
 * riga visiva, altrimenti sparirebbe.
 */
export function spezza(riga: string, w: number): string[] {
  if (w <= 0) return [riga];
  if (riga.length === 0) return [''];
  const fuori: string[] = [];
  for (let i = 0; i < riga.length; i += w) fuori.push(riga.slice(i, i + w));
  return fuori;
}

function riempi(s: string, w: number): string {
  const manca = w - larghezzaVisibile(s);
  return manca > 0 ? s + ' '.repeat(manca) : s;
}

/**
 * L'intestazione di apertura — il «personaggio in alto».
 *
 * Una volta sola, all'avvio, e non si ridisegna: è scrollback come tutto il
 * resto. Dice le tre cose che servono a sapere con chi stai parlando e dove, e
 * che altrimenti si scoprono solo interrogando la CLI.
 */
export function intestazione(righeDentro: readonly string[], smorza: (s: string) => string, larghezza: number): string[] {
  const w = Math.min(larghezza > 0 ? larghezza : 80, LARGHEZZA_MASSIMA) - 4;
  const dentro = righeDentro.flatMap((r) => spezza(r, w));
  return [
    smorza(`╭${'─'.repeat(w + 2)}╮`),
    ...dentro.map((r) => `${smorza('│')} ${riempi(r, w)} ${smorza('│')}`),
    smorza(`╰${'─'.repeat(w + 2)}╯`),
  ];
}

/**
 * Il riquadro dell'input, dato il testo e dove sta il cursore.
 *
 * `riga`/`colonna` sono coordinate **logiche** (quelle del buffer); la
 * traduzione in coordinate visive è il lavoro di questa funzione, ed è il pezzo
 * che si sbaglia: una riga logica lunga occupa più righe visive, e il cursore
 * deve finire su quella giusta.
 */
export function disponi(
  righe: readonly string[],
  riga: number,
  colonna: number,
  cornice: Cornice,
  larghezza: number,
): Disposizione {
  const esterna = Math.min(larghezza > 0 ? larghezza : 80, LARGHEZZA_MASSIMA);
  const marcatore = larghezzaVisibile(cornice.prompt);
  // 4 = i due `│` più i due spazi che li staccano dal testo.
  const w = Math.max(1, esterna - 4 - marcatore);
  const { smorza } = cornice;

  const bordoAlto =
    cornice.etichetta === ''
      ? smorza(`╭${'─'.repeat(esterna - 2)}╮`)
      : // `esterna - 5`: `╭`, `─`, lo spazio prima e quello dopo l'etichetta, `╮`.
        // Era `- 6`, e il bordo etichettato usciva **un carattere più corto**
        // degli altri — il genere di sbaglio che a occhio non si vede e che il
        // test sulle larghezze qui accanto trova subito.
        smorza(`╭─ ${cornice.etichetta} ${'─'.repeat(Math.max(0, esterna - 5 - larghezzaVisibile(cornice.etichetta)))}╮`);

  const fuori: string[] = [bordoAlto];
  let cursoreRiga = 0;
  let cursoreColonna = 1;

  righe.forEach((testoRiga, i) => {
    const visive = spezza(testoRiga, w);
    visive.forEach((pezzo, j) => {
      // Il marcatore solo sulla prima riga visiva della prima riga logica: sulle
      // altre uno spazio della stessa larghezza, così il testo resta allineato.
      const segno = i === 0 && j === 0 ? cornice.prompt : ' '.repeat(marcatore);
      fuori.push(`${smorza('│')} ${segno}${riempi(pezzo, w)} ${smorza('│')}`);
    });
    if (i === riga) {
      const dentro = Math.min(Math.floor(colonna / w), visive.length - 1);
      cursoreRiga = fuori.length - visive.length + dentro;
      // 1-based, e conta: `│`, lo spazio, il marcatore, poi la colonna.
      cursoreColonna = 2 + marcatore + (colonna - dentro * w) + 1;
    }
  });

  fuori.push(smorza(`╰${'─'.repeat(esterna - 2)}╯`));
  if (cornice.suggerimenti !== '') fuori.push(smorza(`  ${cornice.suggerimenti}`));

  return { righe: fuori, cursore: { riga: cursoreRiga, colonna: cursoreColonna } };
}
