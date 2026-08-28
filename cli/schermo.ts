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
 * colonna assoluta, cancella-in-giù, ritorno a capo, a capo — e ignora il
 * resto (i colori non spostano niente). Un emulatore completo sarebbe una
 * dipendenza e un secondo progetto; questo è un misuratore.
 */

export type Schermo = { righe: string[]; riga: number; colonna: number };

function poni(righe: string[], r: number, c: number, testo: string): void {
  while (righe.length <= r) righe.push('');
  const riga = righe[r] ?? '';
  const imbottita = riga.length < c ? riga + ' '.repeat(c - riga.length) : riga;
  righe[r] = imbottita.slice(0, c) + testo + imbottita.slice(c + testo.length);
}

/**
 * Applica una sequenza di scritture e restituisce lo schermo che ne risulta.
 *
 * Le righe non hanno un limite in basso: non si simula lo scorrimento, perché
 * ciò che interessa misurare — «il riquadro si sostituisce o si accumula?» —
 * sta tutto sotto l'ultima riga di scrollback e non tocca mai il bordo.
 */
export function applica(scritture: readonly string[]): Schermo {
  const righe: string[] = [''];
  let r = 0;
  let c = 0;

  const dati = scritture.join('');
  let i = 0;
  while (i < dati.length) {
    const ch = dati[i]!;

    if (ch === '\x1b' && dati[i + 1] === '[') {
      const m = /^\x1b\[([0-9;]*)([a-zA-Z])/.exec(dati.slice(i));
      if (m) {
        const n = m[1] === '' ? 1 : Number(m[1]?.split(';')[0] ?? 1);
        switch (m[2]) {
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
          case 'J':
            // `0J` (e `J` nudo): dalla posizione in giù. È quella che il
            // ridisegno usa per togliere il riquadro di prima.
            if (m[1] === '' || m[1] === '0') {
              righe[r] = (righe[r] ?? '').slice(0, c);
              righe.length = r + 1;
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

    if (ch === '\r') {
      c = 0;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      r += 1;
      c = 0;
      while (righe.length <= r) righe.push('');
      i += 1;
      continue;
    }

    poni(righe, r, c, ch);
    c += 1;
    i += 1;
  }

  return { righe, riga: r, colonna: c };
}
