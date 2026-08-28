import { appendFileSync, readFileSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { premi, statoIniziale, testo, type Key, type Stato } from './editor.js';
import { disponi, type Cornice } from './riquadro.js';

/**
 * Il terminale attorno al buffer: modo raw, disegno, storia su disco.
 *
 * `cli/editor.ts` sa cosa fa ogni tasto e non sa niente di terminali. Questo
 * file è l'inverso: non decide niente su cosa significhi un tasto, e si occupa
 * solo delle tre cose che un buffer puro non può fare — leggere, disegnare,
 * ricordare fra un avvio e l'altro.
 *
 * ## Perché non readline
 *
 * `rl.question` legge **una riga**: Invio spedisce sempre, e non esiste un
 * modo di scrivere un messaggio di due paragrafi né di tornare a sistemare la
 * riga di sopra. Era la lamentela dell'owner («non ho tipo una textzone»).
 * readline non ha un modo di estendersi a questo: la sua unità è la riga.
 *
 * Quello che readline dà e che qui si tiene comunque è la **decodifica**:
 * `emitKeypressEvents` funziona anche in raw mode e sa già leggere le sequenze
 * di escape di ogni terminale. Riscrivere quel decodificatore a mano è il
 * genere di lavoro che sembra finito e non lo è mai.
 *
 * ## Niente schermo alternato
 *
 * `cli/STYLES.md` lo esclude, e continua a valere: si disegna **in fondo allo
 * scrollback**, cancellando e ridisegnando solo le righe del prompt. Quello che
 * è già scorso sopra resta selezionabile e copiabile, che è la ragione per cui
 * quella regola esiste.
 */

/** Attiva il bracketed paste: il terminale recinta ciò che viene incollato. */
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';

export type Esito =
  | { tipo: 'testo'; testo: string }
  /** Ctrl+C. Il chiamante decide se annullare un turno o uscire. */
  | { tipo: 'interrotto' }
  /** Ctrl+D su buffer vuoto, o stdin chiuso. */
  | { tipo: 'fine' };

export type TextzoneDeps = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  /** Dove ricordare la storia fra un avvio e l'altro. Assente = non si ricorda. */
  historyFile?: string | undefined;
  /** I comandi che il Tab completa. */
  comandi?: readonly string[];
};

/**
 * Le colonne che un testo occupa davvero, senza contare le sequenze di escape.
 *
 * Il prompt colorato è `\x1b[36m›\x1b[0m ` — **dodici** caratteri, **due**
 * colonne. Contare la stringa mette il cursore dieci colonne più a destra di
 * dove sta il testo, e il difetto si vede solo col colore acceso: su una pipe,
 * dove il colore si spegne da sé, tutto sembra a posto.
 *
 * Misurato pilotando il REPL vero dentro un pty il 28/08/2026.
 */
export function larghezzaVisibile(testoRiga: string): number {
  // eslint-disable-next-line no-control-regex
  return testoRiga.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
}

/**
 * Quante righe di terminale occupa una riga logica.
 *
 * Una riga più larga dello schermo ne occupa più di una, e ridisegnare senza
 * saperlo lascia dietro pezzi della riga precedente — il difetto che si vede
 * solo quando qualcuno scrive una frase lunga.
 */
export function righeDisegnate(testoRiga: string, larghezza: number): number {
  const w = larghezza > 0 ? larghezza : 80;
  return Math.max(1, Math.ceil(larghezzaVisibile(testoRiga) / w) || 1);
}

/**
 * Dove va messo il cursore dopo aver disegnato: quante righe risalire e su
 * quale colonna atterrare.
 *
 * Estratto e puro perché è la parte che si sbaglia. Una larghezza a **zero** —
 * quello che risponde un terminale sotto `script`, misurato il 28/08/2026 —
 * faceva `% 0`, cioè `NaN`, cioè la sequenza `ESC[NaNG` stampata a schermo.
 */
export function posizioneCursore(
  righe: string[],
  riga: number,
  colonna: number,
  prompt: string,
  continuazione: string,
  larghezza: number,
): { su: number; colonnaSchermo: number } {
  const w = larghezza > 0 ? larghezza : 80;
  const sotto = righe.slice(riga + 1).reduce((n, r) => n + righeDisegnate(continuazione + r, w), 0);
  const prefisso = riga === 0 ? prompt : continuazione;
  const assoluta = larghezzaVisibile(prefisso) + colonna;
  const rigaDentro = Math.floor(assoluta / w);
  const restanti = righeDisegnate(prefisso + (righe[riga] ?? ''), w) - 1 - rigaDentro;
  return { su: sotto + Math.max(0, restanti), colonnaSchermo: (assoluta % w) + 1 };
}

export function makeTextzone(deps: TextzoneDeps) {
  const { input, output } = deps;
  let storia = leggiStoria(deps.historyFile);
  /**
   * Come ridisegnare cio' che si sta scrivendo, quando qualcosa scrive fuori
   * banda in mezzo.
   *
   * `undefined` quando non stiamo leggendo, ed e' la meta' che conta: un
   * messaggio consegnato da una superficie mentre il modello risponde non deve
   * far comparire un prompt che nessuno sta usando.
   */
  let disegnaCorrente: (() => void) | undefined;
  /** E come **toglierlo**, che è la metà senza la quale il ridisegno non serve. */
  let cancellaCorrente: (() => void) | undefined;

  /**
   * Legge un messaggio.
   *
   * `prompt` è il prefisso della prima riga; le righe successive prendono una
   * guida della stessa larghezza, così il testo resta allineato e si vede a
   * colpo d'occhio che sono lo stesso messaggio.
   */
  async function read(cornice: Cornice): Promise<Esito> {
    if (input.isTTY !== true) return leggiSenzaTty(input);

    let stato = statoIniziale(storia);
    let righeDisegnateOra = 0;
    /**
     * Su **quale** riga del riquadro è rimasto il cursore dopo l'ultimo disegno.
     *
     * È la cosa da ricordare, e ricordare il numero di righe invece era il
     * difetto: alla fine di ogni disegno il cursore non sta in fondo al
     * riquadro, sta dove sta il testo. Risalire di `righe - 1` da lì portava
     * troppo in su o troppo in giù, la cancellazione partiva dal punto
     * sbagliato, e ogni tasto premuto stampava un riquadro **nuovo** sotto il
     * precedente invece di sostituirlo. Visto pilotando il REPL dentro un pty
     * il 28/08/2026: una colonna di riquadri, uno per lettera digitata.
     */
    let cursoreRigaOra = 0;
    /**
     * I comandi che l'ultimo Tab non ha saputo scegliere.
     *
     * Prendono il posto della riga di suggerimenti finché non si preme
     * qualcos'altro: così l'elenco vive dentro il riquadro, e il ridisegno che
     * già cancella le proprie righe lo toglie senza sapere che esiste.
     */
    let candidati: readonly string[] = [];

    /**
     * `finale` disegna il riquadro **come resterà nello scrollback**: senza la
     * riga dei suggerimenti.
     *
     * I suggerimenti dicono cosa puoi premere *adesso*; sotto un messaggio già
     * spedito non dicono niente, e si accumulano — una copia per turno, per
     * tutta la sessione. Il riquadro invece resta: è quello che fa vedere dove
     * finisce ciò che hai scritto tu.
     */
    const disegna = (finale = false): void => {
      const w = output.columns ?? 80;
      // Si risale da dove sta il cursore adesso fino alla prima riga del
      // riquadro, poi si cancella tutto ciò che sta sotto.
      if (cursoreRigaOra > 0) output.write(`\x1b[${String(cursoreRigaOra)}A`);
      output.write('\r\x1b[0J');

      const conElenco = finale
        ? { ...cornice, suggerimenti: '' }
        : candidati.length === 0
          ? cornice
          : { ...cornice, suggerimenti: candidati.join('  ') };
      const d = disponi(stato.righe, stato.riga, stato.colonna, conElenco, w);
      output.write(d.righe.join('\n'));
      righeDisegnateOra = d.righe.length;

      // Il cursore, dalla fine di ciò che si è appena scritto fino alla sua riga.
      const su = d.righe.length - 1 - d.cursore.riga;
      if (su > 0) output.write(`\x1b[${String(su)}A`);
      output.write(`\r\x1b[${String(d.cursore.colonna)}G`);
      cursoreRigaOra = d.cursore.riga;
    };

    return new Promise<Esito>((resolve) => {
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      output.write(PASTE_ON);

      /**
       * Toglie il riquadro da schermo, per far scrivere qualcosa al suo posto.
       *
       * È la metà che mancava, e senza di lei `redraw` da solo non basta: chi
       * consegna un messaggio fuori banda lo scriveva dove stava il cursore,
       * cioè **dentro** il riquadro, e poi ne faceva comparire un secondo
       * sotto. Visto su uno schermo vero il 28/08/2026 — un avviso del
       * consolidatore finito dentro la riga di input come se l'avesse battuto
       * qualcuno.
       */
      const cancella = (): void => {
        if (cursoreRigaOra > 0) output.write(`\x1b[${String(cursoreRigaOra)}A`);
        output.write('\r\x1b[0J');
        // Il riquadro non è più a schermo: il prossimo disegno non deve
        // risalire di nuovo, o mangerebbe la riga appena scritta sopra.
        cursoreRigaOra = 0;
        righeDisegnateOra = 0;
      };

      const finisci = (esito: Esito): void => {
        disegna(true);
        disegnaCorrente = undefined;
        cancellaCorrente = undefined;
        input.off('keypress', onKey);
        output.write(PASTE_OFF);
        input.setRawMode(false);
        input.pause();
        // Sotto tutto il riquadro, non sotto la riga del cursore: uscire da
        // metà riquadro farebbe cominciare la risposta dentro la cornice.
        const giu = righeDisegnateOra - 1 - cursoreRigaOra;
        if (giu > 0) output.write(`\x1b[${String(giu)}B`);
        output.write('\r\n');
        resolve(esito);
      };

      const onKey = (_ch: string | undefined, key: Key | undefined): void => {
        if (!key) return;

        // Il Tab completa un comando, e non è un tasto del buffer: sta qui e
        // non in `editor.ts` perché l'elenco dei comandi è una cosa della CLI,
        // non del testo.
        if (key.name === 'tab' && stato.righe.length === 1) {
          const c = completa(stato.righe[0] ?? '', deps.comandi ?? []);
          candidati = c.candidati;
          stato = { ...stato, righe: [c.testo], colonna: c.testo.length };
          disegna();
          return;
        }
        // Qualunque altro tasto rimette i suggerimenti al posto dell'elenco:
        // i candidati valgono per la riga che li ha chiesti, non per la dopo.
        candidati = [];

        const r = premi(stato, key);
        stato = r.stato;
        switch (r.azione.tipo) {
          case 'spedisci': {
            const t = r.azione.testo;
            if (t.trim() !== '') {
              storia = [...storia, t];
              aggiungiAStoria(deps.historyFile, t);
            }
            finisci({ tipo: 'testo', testo: t });
            return;
          }
          case 'interrompi':
            finisci({ tipo: 'interrotto' });
            return;
          case 'fine':
            finisci({ tipo: 'fine' });
            return;
          case 'niente':
            disegna();
            return;
        }
      };

      input.on('keypress', onKey);
      // Se stdin muore mentre stiamo leggendo, è una fine come Ctrl+D: senza
      // questo il REPL resterebbe in attesa di un tasto che non arriverà.
      input.once('end', () => finisci({ tipo: 'fine' }));
      disegnaCorrente = disegna;
      cancellaCorrente = cancella;
      disegna();
    });
  }

  /**
   * Una domanda a cui si risponde con una riga — l'approvazione di una
   * capability, `[s/N]`.
   *
   * Esiste qui e non in readline per due ragioni. La prima: due lettori sullo
   * stesso stdin non convivono, e readline ne consuma i byte prima che la
   * textzone possa vederli. La seconda è un difetto vero, misurato leggendo il
   * codice il 28/08/2026 — la vecchia `rl.question` dell'approvazione non
   * ascoltava Ctrl+C: il gestore SIGINT annullava il turno, la domanda restava
   * appesa, e il terminale continuava a chiedere «approvi…» di una cosa che era
   * già stata annullata. Il messaggio d'avvio prometteva «Ctrl+C annulla il
   * turno» e per quella domanda non era vero.
   *
   * Qui Ctrl+C torna `interrotto`, e chi chiama lo tratta come un no.
   */
  async function readLine(prompt: string): Promise<Esito> {
    if (input.isTTY !== true) return leggiSenzaTty(input);
    return new Promise<Esito>((resolve) => {
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      let riga = '';
      output.write(prompt);

      const finisci = (esito: Esito): void => {
        input.off('keypress', onKey);
        input.setRawMode(false);
        input.pause();
        output.write('\n');
        resolve(esito);
      };
      const onKey = (_ch: string | undefined, key: Key | undefined): void => {
        if (!key) return;
        if (key.ctrl === true && key.name === 'c') return finisci({ tipo: 'interrotto' });
        if (key.ctrl === true && key.name === 'd') return finisci({ tipo: 'fine' });
        if (key.name === 'return' || key.name === 'enter') return finisci({ tipo: 'testo', testo: riga });
        if (key.name === 'backspace') {
          if (riga.length > 0) {
            riga = riga.slice(0, -1);
            output.write('\b \b');
          }
          return;
        }
        const ch = key.sequence ?? '';
        if (ch.length !== 1 || ch.charCodeAt(0) < 0x20 || key.ctrl === true || key.meta === true) return;
        riga += ch;
        output.write(ch);
      };
      input.on('keypress', onKey);
      input.once('end', () => finisci({ tipo: 'fine' }));
    });
  }

  return {
    read,
    readLine,
    redraw: () => disegnaCorrente?.(),
    /**
     * Toglie il riquadro, se ce n'è uno. `redraw` lo rimette.
     *
     * Due mosse e non una sola «scrivi sopra», perché fra le due ci sta la
     * scrittura di chi consegna, e chi consegna deve poter fallire senza
     * lasciare lo schermo senza prompt — la garanzia che `makeReplCliWrite`
     * tiene nel suo `finally`.
     */
    cancella: () => cancellaCorrente?.(),
  };
}

/** Il prefisso più lungo che tutte le stringhe date hanno in comune. */
function prefissoComune(parole: readonly string[]): string {
  const prima = parole[0] ?? '';
  let n = prima.length;
  for (const p of parole) {
    let i = 0;
    while (i < n && i < p.length && p[i] === prima[i]) i += 1;
    n = i;
  }
  return prima.slice(0, n);
}

/**
 * Il completamento di un comando: cosa diventa la riga, e cosa mostrare.
 *
 * Un candidato solo completa. **Più di uno completa fino al prefisso comune e
 * si fa nominare**: è il comportamento di ogni shell, e la versione di prima —
 * «zero o più di uno non fanno niente» — rendeva il Tab un tasto morto proprio
 * nel momento in cui serve. Misurato dentro tmux il 28/08/2026: `/` più Tab
 * non muoveva niente e non diceva niente, che si legge come un tasto rotto.
 *
 * Il motivo che avevo scritto per non stampare l'elenco — «romperebbe il
 * disegno del prompt» — non vale: l'elenco non si *stampa*, prende il posto
 * della riga di suggerimenti, che è già una riga del riquadro e che il
 * ridisegno già cancella da sé.
 */
export function completa(riga: string, comandi: readonly string[]): { testo: string; candidati: readonly string[] } {
  if (!riga.startsWith('/')) return { testo: riga, candidati: [] };
  const candidati = comandi.filter((c) => c.startsWith(riga));
  if (candidati.length === 0) return { testo: riga, candidati: [] };
  if (candidati.length === 1) return { testo: candidati[0] ?? riga, candidati: [] };
  // Più di uno: si allunga quanto si può senza scegliere al posto dell'owner.
  return { testo: prefissoComune(candidati), candidati };
}

/**
 * Il ramo senza terminale: una riga da stdin, come prima.
 *
 * Una pipe non ha tasti, e pretendere il raw mode su un descrittore che non è
 * un tty lancia. `muffin < script.txt` deve continuare a funzionare.
 */
function leggiSenzaTty(input: NodeJS.ReadStream): Promise<Esito> {
  // Uno stream **gia' finito** non emettera' un secondo `end`, e aspettarlo e'
  // un'attesa che non finisce. E' lo stesso difetto di `cli/prompt.ts` — un
  // input che si e' fermato non e' un input che si fermera' di nuovo — con la
  // differenza che qui lo stream lo sa dire, quindi basta chiederglielo.
  if (input.readableEnded === true || input.destroyed === true) return Promise.resolve({ tipo: 'fine' });
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      const i = buffer.indexOf('\n');
      if (i === -1) return;
      const riga = buffer.slice(0, i);
      input.off('data', onData);
      input.pause();
      // Ciò che resta dopo il newline tornerà al prossimo giro: `unshift` lo
      // rimette nello stream invece di buttarlo.
      const resto = buffer.slice(i + 1);
      if (resto.length > 0) input.unshift(Buffer.from(resto));
      resolve({ tipo: 'testo', testo: riga });
    };
    input.on('data', onData);
    input.once('end', () => resolve({ tipo: 'fine' }));
    input.resume();
  });
}

/**
 * La storia, dal disco.
 *
 * Un file di righe, e un messaggio multilinea ci sta con i suoi a capo
 * codificati: senza, una riga del file non corrisponderebbe a un messaggio e
 * la freccia su restituirebbe metà di una domanda.
 */
function leggiStoria(file: string | undefined): string[] {
  if (file === undefined) return [];
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((r) => r.length > 0)
      .map((r) => r.replace(/\\n/g, '\n'));
  } catch {
    // Nessuna storia è la condizione normale del primo avvio, non un guasto.
    return [];
  }
}

function aggiungiAStoria(file: string | undefined, voce: string): void {
  if (file === undefined) return;
  try {
    appendFileSync(file, `${voce.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}\n`, 'utf8');
  } catch {
    // Una storia che non si scrive non è una ragione per non rispondere.
  }
}
