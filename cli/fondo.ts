/**
 * Il fondo dello schermo, tenuto fermo: la casella sta giù, il testo scorre
 * sopra.
 *
 * Owner, 03/09/2026: *«dovrebbe effettivamente tenere la box di testo sotto,
 * le notifiche in alto, il testo scrollabile senza muovere ste due sezioni»*.
 * Fino a qui il riquadro si disegnava in fondo allo **scrollback**, e mentre
 * una risposta scorreva non c'era nessun riquadro: ricompariva a turno finito,
 * sotto l'ultima riga. È il modo in cui lo fanno i peer, ma solo a metà.
 *
 * ## Come lo fanno gli altri, letto il 03/09
 *
 * Codex (`codex-rs/tui/src/insert_history.rs`): la composer vive in un
 * *inline viewport* in fondo, e la cronologia si inserisce **sopra** con una
 * scroll region — «Codex uses the terminal scrollback itself for finalized
 * chat history». Claude Code/Ink: `<Static>` sopra, la zona dinamica
 * ridisegnata sotto — e finché lo schermo non è pieno la zona dinamica
 * **segue** il contenuto, non sta incollata in fondo. pi: rendering
 * differenziale in main screen, il contenuto finito scorre nello scrollback.
 * **Nessuno tiene una zona fissa in cima**, e il motivo è tecnico, non di
 * gusto: un margine superiore fisso fa perdere lo scrollback nella maggior
 * parte dei terminali; un margine inferiore no. Le «notifiche in alto» quindi
 * stanno *subito sopra la casella*, dentro la regione che scorre, come su
 * Codex — e la regola di `cli/STYLES.md` (lo scrollback resta) vale più della
 * cornice.
 *
 * ## Due fasi, e il momento in cui si passa dall'una all'altra
 *
 * Finché il contenuto non arriva in fondo allo schermo, il riquadro si
 * disegna sotto il contenuto come ha sempre fatto (`textzone.ts`, il ramo
 * senza fondo): l'intestazione resta in alto e non c'è nessun vuoto. La prima
 * versione di questo file saltava in fondo all'avvio, e provata in tmux il
 * 03/09 mostrava uno schermo vuoto con l'intestazione già scorsa via —
 * esattamente il «personaggio in alto» che l'owner aveva chiesto, buttato.
 *
 * Il passaggio avviene all'inizio di una lettura, quando il cursore sta così
 * in basso che il riquadro non ci entra più sotto (`aggancia`): si scorre
 * del minimo che serve, si impostano i margini, e da lì la casella è fissa
 * per il resto della sessione. Dove sta il cursore lo dice il terminale
 * stesso (`ESC[6n`, letto da `textzone.ts`): contarlo a mano vorrebbe dire
 * rifare a mano l'andata a capo di ogni byte della risposta.
 *
 * ## Il meccanismo, una volta agganciato
 *
 * DECSTBM: `ESC[1;{righe-k}r` fa scorrere solo le prime `righe-k` righe. Le
 * ultime `k` sono nostre — il riquadro e la sua riga di suggerimenti — e
 * nessun a capo le tocca. Tre regole tengono in piedi il resto:
 *
 * 1. **Il cursore della regione sta sempre sull'ultima riga della regione.**
 *    Ci si arriva all'aggancio e poi ci resta da solo: ogni a capo su quella
 *    riga scorre invece di scendere, e così anche una risposta in streaming,
 *    con i suoi a capo e i suoi ritorni a capo automatici, non sposta mai il
 *    cursore da lì. stdout scrive gli stessi byte di prima (l'invariante di
 *    B11); le sequenze che posizionano stanno su stderr.
 * 2. **Il fondo si disegna in assoluto e restituisce il cursore.** `ESC7`,
 *    poi `ESC[{r};1H` riga per riga, poi `ESC8`. Quando si sta leggendo, il
 *    cursore va invece **dentro** il riquadro — e la regione ha la colonna 1
 *    per costruzione, perché ogni scrittura nella regione finisce con un a
 *    capo quando nessun turno è in corso.
 * 3. **Cambiare i margini manda il cursore a casa.** È scritto nello standard
 *    e non lo si ricorda mai: ogni `ESC[…r` è seguito da un ripristino. Se il
 *    fondo cresce di `d` righe, prima si scorre di `d` dalla regione e poi si
 *    stringono i margini; se si stringe, si puliscono le righe liberate.
 *
 * Non c'è schermo alternato. In uscita `ESC[r` toglie i margini e il cursore
 * scende sotto il riquadro: la shell riprende da lì e ciò che è scorso resta
 * copiabile.
 */

export type Uscita = Pick<NodeJS.WriteStream, 'write'> & {
  rows?: number | undefined;
  columns?: number | undefined;
  isTTY?: boolean | undefined;
};

export type Fondo = {
  /** Vero quando lo schermo ha un'altezza: senza, non esiste un fondo da tenere fermo. */
  readonly attivo: boolean;
  /** Vero da quando i margini sono impostati: da lì il riquadro sta nel fondo. */
  readonly aperto: boolean;
  /**
   * Prova ad agganciare il fondo: il cursore sta alla riga `rigaCursore`
   * (1-based) e il riquadro è alto `k`. Se il riquadro non ci entra sotto,
   * scorre del minimo, imposta i margini e torna `true`; altrimenti non tocca
   * niente e torna `false` — il riquadro si disegna come sempre. Una volta
   * aperto resta aperto.
   */
  aggancia(rigaCursore: number, k: number): boolean;
  /** Toglie i margini e lascia il cursore sotto il riquadro. Idempotente. */
  chiudi(): void;
  /**
   * Disegna le righe nel fondo. `caret` = dove lasciare il cursore, riga 0-based
   * dentro il fondo e colonna 1-based; `null` = restituirlo alla regione.
   * Se le righe sono più o meno di prima, i margini si spostano.
   */
  disegna(righe: readonly string[], caret: { riga: number; colonna: number } | null): void;
  /** Porta il cursore sull'ultima riga della regione, colonna 1 — per scrivere sopra il riquadro mentre si legge. */
  nellaRegione(): void;
  /** Riporta il cursore nel riquadro, dove `disegna` l'aveva lasciato l'ultima volta. */
  nelRiquadro(): void;
  /** Dopo un SIGWINCH: rimette i margini sulle righe nuove. Il chiamante ridisegna subito dopo. */
  ridimensiona(): void;
};

export function makeFondo(output: Uscita): Fondo {
  const righe = (): number => (typeof output.rows === 'number' && output.rows > 0 ? output.rows : 0);
  const attivo = output.isTTY === true && righe() > 0;
  let k = 0;
  let aperto = false;
  /** Dove sta il cursore adesso: nel riquadro (con la sua posizione) o nella regione (`null`). */
  let caret: { riga: number; colonna: number } | null = null;

  const ultimaRigaRegione = (): number => Math.max(1, righe() - k);
  /** DECSTBM: manda il cursore a casa (regola 3); chi chiama lo rimette. */
  const margini = (): void => {
    output.write(`\x1b[1;${String(ultimaRigaRegione())}r`);
  };
  const vaiInFondoAllaRegione = (): void => {
    output.write(`\x1b[${String(ultimaRigaRegione())};1H`);
  };

  return {
    attivo,
    get aperto() {
      return aperto;
    },

    aggancia(rigaCursore, n) {
      if (!attivo) return false;
      if (aperto) return true;
      const sotto = righe() - n;
      // Ci entra ancora: si continua come prima, sotto il contenuto.
      if (rigaCursore <= sotto) return false;
      aperto = true;
      k = n;
      // Il minimo che serve: dall'ultima riga dello schermo, tanti a capo
      // quante righe mancano perché il contenuto finisca sull'ultima riga
      // della regione. Il contenuto sale, niente viene coperto, e il cursore
      // resta sull'ultima riga della regione (regola 1).
      const d = rigaCursore - sotto;
      output.write(`\x1b[${String(righe())};1H${'\n'.repeat(d)}`);
      margini();
      vaiInFondoAllaRegione();
      caret = null;
      return true;
    },

    chiudi() {
      if (!attivo || !aperto) return;
      aperto = false;
      output.write(`\x1b[r\x1b[${String(righe())};1H\n`);
      k = 0;
      caret = null;
    },

    disegna(nuove, dove) {
      if (!attivo || !aperto) return;
      const n = nuove.length;
      if (n !== k) {
        // Prima il cursore nella regione, sull'ultima riga. Se era nel
        // riquadro la colonna è 1 per costruzione (regola 2); se era già
        // nella regione — un turno in corso — si salva e si ripristina, così
        // la colonna del testo in streaming non si perde.
        const eraNellaRegione = caret === null;
        if (eraNellaRegione) output.write('\x1b7');
        else vaiInFondoAllaRegione();
        if (n > k) {
          const d = n - k;
          output.write('\n'.repeat(d));
          k = n;
          margini();
          if (eraNellaRegione) output.write(`\x1b8\x1b[${String(d)}A`);
          else vaiInFondoAllaRegione();
        } else {
          // Il fondo è ancorato in basso: le righe che si liberano sono le
          // prime `k - n` dell'area vecchia, non le ultime.
          for (let i = 0; i < k - n; i++) output.write(`\x1b[${String(righe() - k + 1 + i)};1H\x1b[2K`);
          k = n;
          margini();
          if (eraNellaRegione) output.write('\x1b8');
          else vaiInFondoAllaRegione();
        }
        caret = null;
      }
      const eraNellaRegione = caret === null;
      if (eraNellaRegione) output.write('\x1b7');
      const prima = righe() - k + 1;
      nuove.forEach((riga, i) => output.write(`\x1b[${String(prima + i)};1H\x1b[2K${riga}`));
      caret = dove;
      if (dove === null) {
        if (eraNellaRegione) output.write('\x1b8');
        else vaiInFondoAllaRegione();
      } else {
        output.write(`\x1b[${String(prima + dove.riga)};${String(dove.colonna)}H`);
      }
    },

    nellaRegione() {
      if (!attivo || !aperto) return;
      vaiInFondoAllaRegione();
    },

    nelRiquadro() {
      if (!attivo || !aperto || caret === null) return;
      output.write(`\x1b[${String(righe() - k + 1 + caret.riga)};${String(caret.colonna)}H`);
    },

    ridimensiona() {
      if (!attivo || !aperto) return;
      margini();
      vaiInFondoAllaRegione();
      caret = null;
    },
  };
}
