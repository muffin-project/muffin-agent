/**
 * La riga che dice «sto ancora facendo qualcosa», e sparisce quando non è più
 * vera.
 *
 * In un file suo e non dentro `cli/repl.ts` per due ragioni, e la seconda è
 * quella che conta.
 *
 * La prima: la userà anche `muffin update`, che ha una fase (`npm ci` dentro la
 * release nuova) durante la quale oggi non stampa niente per decine di secondi.
 * Un secondo spinner scritto lì sarebbe la stessa cosa scritta due volte.
 *
 * La seconda: **`line()` esiste, e chi scrive sul terminale deve passare da
 * lì.** Il difetto che ha prodotto questo file è stato misurato sulla macchina
 * dell'owner poche ore dopo aver introdotto lo spinner:
 *
 *     ⠋ penso…consolidamento: indice vettoriale: embedder non disponibile
 *
 * Il consolidamento scrive su stderr da `agent/runtime.ts`, che non sa che
 * esiste una riga di stato accesa, e si è incollato dentro lo spinner invece di
 * sostituirlo. La riga di stato non può difendersi da sola: qualunque `write`
 * fuori banda — il log del consolidatore, una consegna che arriva, un job che
 * fallisce, il prompt di un'approvazione — la sporca allo stesso modo. Quindi
 * la porta è una: `line()` cancella e poi scrive, e nel REPL non resta nessun
 * `process.stderr.write` fuori banda che non passi da qui.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export type StatusLine = {
  /** Mostra (o sostituisce) l'attesa in corso. */
  show(text: string): void;
  /**
   * Scrive una riga sul terminale — cancellando prima l'attesa in corso.
   *
   * **La sola porta** per qualunque scrittura fuori banda mentre un turno gira.
   * Vedi l'intestazione del file: uno spinner riscrive in place, e chiunque
   * scriva senza cancellare gli si incolla dentro.
   */
  line(text: string): void;
  /** Toglie la riga dal terminale: si chiama prima di stampare qualunque altra cosa. */
  clear(): void;
  /** Ferma il timer senza toccare il terminale — per l'uscita e per Ctrl+C. */
  stop(): void;
};

/**
 * La riga che dice «sto ancora facendo qualcosa», e sparisce quando non è più
 * vera.
 *
 * **Senza TTY diventa una riga normale, stampata una volta.** Non è una
 * degradazione, è la condizione per cui `muffin | tee log` e i test vedono
 * byte deterministici invece di dieci frame di spinner e una sequenza di
 * cancellazione: `\r\x1b[2K` su un file è spazzatura, e uno spinner su un
 * pipe è spazzatura che si ripete. Stessa scelta, e stessa ragione, di
 * `streamEnabled`/`progressEnabled` qui sopra.
 *
 * `unref()` sul timer perché un intervallo attivo tiene vivo l'event loop: un
 * turno che finisce mentre lo spinner gira non deve poter lasciare il processo
 * appeso a un `setInterval` che nessuno ferma.
 */
export function makeStatusLine(write: (s: string) => void, tty: boolean): StatusLine {
  if (!tty) {
    let last = '';
    return {
      show(text) {
        // Ripetere lo stesso stato non aggiunge informazione: senza riscrittura
        // in place, «penso…» a ogni giro sarebbe rumore su ogni riga.
        if (text === last) return;
        last = text;
        write(`· ${text}\n`);
      },
      line(text) {
        last = '';
        write(`${text}\n`);
      },
      clear() {
        last = '';
      },
      stop() {},
    };
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let current = '';
  /**
   * Se c'è qualcosa da cancellare.
   *
   * `clear()` si chiama prima di **ogni** riga che va nello scrollback, perché
   * chi stampa non può sapere se un'attesa è in corso — ed è giusto così. Ma
   * una cancellazione a schermo pulito non è innocua: scrive `\r\x1b[2K`
   * davanti alla riga, e da lì in poi quella riga non comincia più con quello
   * con cui dice di cominciare. In `--debug`, dove la riga di stato non viene
   * mai mostrata, sarebbe una sequenza di escape davanti a ogni singola riga.
   */
  let acceso = false;
  const paint = (): void => {
    acceso = true;
    write(`\r\x1b[2K${FRAMES[frame % FRAMES.length]} ${current}`);
  };
  const halt = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    show(text) {
      current = text;
      if (timer === null) {
        timer = setInterval(() => {
          frame += 1;
          paint();
        }, 90);
        timer.unref?.();
      }
      paint();
    },
    line(text) {
      this.clear();
      write(`${text}\n`);
    },
    clear() {
      halt();
      if (!acceso) return;
      acceso = false;
      write('\r\x1b[2K');
    },
    stop: halt,
  };
}

