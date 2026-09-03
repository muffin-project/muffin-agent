/**
 * Un terminale finto, giusto quanto basta per **vedere** cosa resta a schermo.
 *
 * Nasce da una lezione presa il 28/08/2026. Il riquadro dell'input si
 * ridisegna a ogni tasto, e per capire se il ridisegno funzionasse ho pilotato
 * il REPL vero dentro un pty e ho guardato l'output. Sbagliato: `script`
 * registra i **byte**, non lo schermo, e i byte di dieci ridisegni sono dieci
 * riquadri uno sotto l'altro anche quando a schermo ce n'è sempre stato uno
 * solo — le sequenze che li sovrascrivono sono lì in mezzo e non si vedono
 * leggendo.
 *
 * Quindi la domanda «quanti riquadri vede l'owner» non si risponde guardando
 * l'output. Si risponde applicandolo. Questo modulo applica: prende i byte che
 * la textzone scrive e restituisce la griglia di caratteri che ne risulta.
 *
 * Capisce **solo** le sequenze che questo repo emette davvero — su, giù,
 * colonna assoluta, posizione assoluta, cancella-in-giù, cancella-riga,
 * margini di scorrimento, salva/ripristina cursore, ritorno a capo, a capo —
 * e ignora il resto (i colori non spostano niente). Un emulatore completo
 * sarebbe una dipendenza e un secondo progetto; questo è un misuratore.
 *
 * ## Due modi, dal 03/09/2026
 *
 * Senza `righe` lo schermo è **senza fondo**: non scorre mai, e misura ciò che
 * il riquadro faceva quando viveva in fondo allo scrollback. Con `righe` è uno
 * schermo vero, alto quanto dichiarato: un a capo sull'ultima riga del margine
 * fa scorrere, e ciò che esce dal margine superiore finisce in `scrollback` —
 * ma **solo se il margine superiore è la prima riga**, che è il comportamento
 * che questa cornice dà per scontato dei terminali veri (Codex,
 * `codex-rs/tui/src/insert_history.rs`, usa esattamente
 * `SetScrollRegion(1..top)` per lo stesso motivo). Una regione che comincia
 * più in basso scorre e perde: è il misuratore che lo dice, prima che lo dica
 * lo schermo di qualcuno.
 */

export type Schermo = {
  righe: string[];
  /** Ciò che è uscito dall'alto: quello che l'owner ritrova scorrendo su. Vuoto senza `righe`. */
  scrollback: string[];
  riga: number;
  colonna: number;
};

export type OpzioniSchermo = {
  /** L'altezza. Assente = senza fondo, mai uno scorrimento. */
  righe?: number;
};

function poni(righe: string[], r: number, c: number, testo: string): void {
  while (righe.length <= r) righe.push('');
  const riga = righe[r] ?? '';
  const imbottita = riga.length < c ? riga + ' '.repeat(c - riga.length) : riga;
  righe[r] = imbottita.slice(0, c) + testo + imbottita.slice(c + testo.length);
}

/**
 * Applica una sequenza di scritture e restituisce lo schermo che ne risulta.
 */
export function applica(scritture: readonly string[], opzioni: OpzioniSchermo = {}): Schermo {
  const alto = opzioni.righe;
  const righe: string[] = [''];
  const scrollback: string[] = [];
  let r = 0;
  let c = 0;
  // Margini di scorrimento, 0-based e inclusivi. Senza fondo non contano.
  let sopra = 0;
  let sotto = alto === undefined ? Number.POSITIVE_INFINITY : alto - 1;
  let salvato: { r: number; c: number } | null = null;

  if (alto !== undefined) while (righe.length < alto) righe.push('');

  /** Un a capo dove sta il cursore: scorre se è sull'ultimo margine. */
  const aCapo = (): void => {
    if (alto !== undefined && r === sotto) {
      const uscita = righe.splice(sopra, 1)[0] ?? '';
      if (sopra === 0) scrollback.push(uscita);
      righe.splice(sotto, 0, '');
      return;
    }
    r += 1;
    while (righe.length <= r) righe.push('');
  };

  const dati = scritture.join('');
  let i = 0;
  while (i < dati.length) {
    const ch = dati[i]!;

    if (ch === '\x1b') {
      if (dati[i + 1] === '7') {
        salvato = { r, c };
        i += 2;
        continue;
      }
      if (dati[i + 1] === '8') {
        if (salvato) ({ r, c } = salvato);
        i += 2;
        continue;
      }
      if (dati[i + 1] === '[') {
        // Il `?` è il prefisso dei modi privati (`ESC[?2004h`, il bracketed
        // paste): non spostano niente, ma senza riconoscerli i loro
        // caratteri finirebbero stampati — otto colonne di cursore in più,
        // trovate misurando `finisci` il 03/09/2026.
        const m = /^\x1b\[(\??)([0-9;]*)([a-zA-Z])/.exec(dati.slice(i));
        if (m) {
          const privato = m[1] === '?';
          const parametri = m[2] === '' ? [] : m[2]!.split(';').map((p) => (p === '' ? 1 : Number(p)));
          const n = parametri[0] ?? 1;
          switch (privato ? '' : m[3]) {
            case 'A':
              r = Math.max(0, r - n);
              break;
            case 'B':
              r += n;
              while (righe.length <= r) righe.push('');
              break;
            case 'G':
              c = Math.max(0, n - 1);
              break;
            case 'H':
            case 'f':
              // Posizione assoluta, 1-based: `ESC[r;cH`. `ESC[H` è casa.
              r = Math.max(0, (parametri[0] ?? 1) - 1);
              c = Math.max(0, (parametri[1] ?? 1) - 1);
              while (righe.length <= r) righe.push('');
              break;
            case 'J':
              // `0J` (e `J` nudo): dalla posizione in giù. È quella che il
              // ridisegno usa per togliere il riquadro di prima.
              if (m[2] === '' || m[2] === '0') {
                righe[r] = (righe[r] ?? '').slice(0, c);
                if (alto === undefined) righe.length = r + 1;
                else for (let k = r + 1; k < righe.length; k++) righe[k] = '';
              }
              break;
            case 'K':
              // `2K`: tutta la riga; `0K`/nudo: dal cursore a destra.
              if (m[2] === '2') righe[r] = '';
              else if (m[2] === '' || m[2] === '0') righe[r] = (righe[r] ?? '').slice(0, c);
              break;
            case 'r':
              // DECSTBM: `ESC[a;br` imposta i margini, `ESC[r` li toglie. In
              // entrambi i casi il cursore va a casa — è il dettaglio che chi
              // scrive la regione deve ricordarsi, e che qui si misura.
              if (alto !== undefined) {
                sopra = m[2] === '' ? 0 : Math.max(0, (parametri[0] ?? 1) - 1);
                sotto = m[2] === '' ? alto - 1 : Math.min(alto - 1, (parametri[1] ?? alto) - 1);
                r = 0;
                c = 0;
              }
              break;
            default:
              // Colori e tutto il resto: non spostano niente e non si stampano.
              break;
          }
          i += m[0].length;
          continue;
        }
      }
    }

    if (ch === '\r') {
      c = 0;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      aCapo();
      c = 0;
      i += 1;
      continue;
    }

    poni(righe, r, c, ch);
    c += 1;
    i += 1;
  }

  return { righe, scrollback, riga: r, colonna: c };
}
