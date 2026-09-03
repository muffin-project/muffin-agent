import { createInterface } from 'node:readline';

/**
 * Gli input su cui un EOF è già arrivato.
 *
 * **Un EOF è un fatto che vale una volta sola per il processo, non per la
 * domanda.** Quando l'owner preme Ctrl+D, readline lo consuma, risolve
 * `undefined` e chiude la propria interfaccia — ma lo stdin sottostante non
 * risulta finito: misurato il 28/08/2026 sotto un pty vero, subito dopo il
 * primo prompt `process.stdin.readableEnded` è **false** e `destroyed` è
 * **false**. In modalità raw readline sintetizza l'EOF dal carattere `^D`, e
 * il tty non emette mai `end`. Quindi la *seconda* domanda apre una nuova
 * interfaccia su uno stream da cui non arriverà mai più né un dato né un
 * `close`: la promise non si decide, e il comando resta appeso per sempre.
 *
 * Non è teorico. `muffin init` su un terminale vero, con un runtime locale
 * acceso, fa due domande: «uso il runtime locale?» e poi la chiave. Con ollama
 * in esecuzione, un Ctrl+D alla prima faceva restare `init` appeso a tempo
 * indefinito — peggio di qualunque percorso headless, che esce e dice cosa
 * manca. Senza ollama la seconda domanda era la prima, e il difetto non si
 * vedeva: la macchina dell'owner l'ha reso visibile accendendo ollama.
 *
 * Ricordarlo qui è più onesto che interrogare lo stream, perché lo stream non
 * lo sa. Una `WeakSet` e non un booleano globale così due input diversi (un
 * test che ne inietta uno finto, e il vero `process.stdin`) restano due fatti
 * distinti.
 */
const finiti = new WeakSet<NodeJS.ReadStream>();

/**
 * Read a secret from the terminal without echoing it. Resolves to undefined
 * when the input is not a TTY, so a headless caller falls back to a flag or env
 * var instead of blocking a pipe forever (see cli/init.ts docstring).
 *
 * Undefined **also** when a terminal's input ends — Ctrl+D, or a closing pipe
 * behind a pty. `rl.question`'s callback never fires on EOF: readline emits
 * `close` instead, so a promise that only resolves in that callback never
 * settles at all. Node then prints `Detected unsettled top-level await` and
 * exits 13, with nothing written.
 *
 * Measured on `muffin init` under a real pty (27/08/2026): the very first
 * prompt of the very first command, at a question whose own text says Enter
 * skips it. Ctrl+D there has to be at least as good as Enter, and it was worse
 * than any headless path — those exit 0 and name the flag.
 *
 * The `isTTY` guard covered "no terminal at all" and read as if it covered
 * this. It is the same shape twice: an input that stops is not an input that
 * was never there.
 *
 * readline runs the line discipline for us — backspace works and arrow-key
 * escape sequences are absorbed as cursor moves rather than captured into the
 * value — so all we need from it is that it writes nothing at all.
 *
 * **Nothing at all is the fix, and it took a second measurement to find.** Up
 * to 03/09/2026 this suppressed the echo by overriding readline's internal
 * `_writeToOutput` and then printed the question with `output.write(question)`.
 * Under `tmux capture-pane` on `muffin init` the question was **not there**:
 * the row was blank and the cursor sat in column 0, so a terminal that was in
 * fact accepting input looked hung. `rl.question(q, cb)` sets the prompt and
 * calls `prompt()`, which on a terminal redraws the line — and the redraw
 * (Node's `internal/readline/interface.js`, `kRefreshLine`) sends
 * `cursorTo(this.output, 0)` and `clearScreenDown(this.output)` **straight to
 * the stream**. Only `kWriteToOutput` goes through the hook; those two do not.
 * So the override could hide the echo and could not stop the erase.
 *
 * Therefore readline gets **no output stream**: `createInterface` documents
 * `output` as optional, and every place the interface touches it is guarded —
 * `kWriteToOutput` checks for null/undefined, and `cursorTo`/`moveCursor`/
 * `clearScreenDown` (`internal/readline/callbacks.js`) return early on a null
 * stream. The line discipline lives on `input` and is untouched. This is a
 * public option instead of an internal, and it is strictly *more* silent than
 * the override was: not the characters, not their number, not even the cursor
 * drifting right one column per keystroke, which the override still leaked.
 *
 * The question is then simply written to `output` by us, once, and nobody
 * erases it. The trade-off is that we own the newline too — see the `close`
 * listener, which writes it on both paths.
 *
 * input/output are injectable so the read path is testable without a real TTY.
 */
export function promptSecret(
  question: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<string | undefined> {
  if (!input.isTTY || finiti.has(input)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let risposto = false;
    // Senza `output`: readline non scrive un byte, quindi non c'è un'eco da
    // sopprimere e non c'è il ridisegno che cancellava la domanda.
    const rl = createInterface({ input, terminal: true });
    // La domanda la scriviamo noi, e resta: nessuno la ridisegna sopra.
    output.write(question);
    // Prima di `question`, non dopo: un input già chiuso emette `close` subito,
    // e un ascoltatore registrato dopo non lo sentirebbe mai.
    rl.on('close', () => {
      // `question` risolve e poi chiude, quindi questo scatta anche sul
      // percorso normale — dove non fa niente, perché la promise è già decisa.
      // Ma `risposto` distingue i due casi, ed è la distinzione che conta: solo
      // una chiusura **senza risposta** è un EOF, e solo un EOF va ricordato.
      if (!risposto) finiti.add(input);
      // L'a capo è nostro perché l'eco non c'è: readline non scrive niente,
      // nemmeno il `\r\n` dell'invio. Vale su entrambi i percorsi — questo
      // ascoltatore scatta anche dopo una risposta, dove la promise è già
      // decisa e resta solo la riga da chiudere.
      output.write('\n');
      resolve(undefined);
    });
    rl.question('', (answer) => {
      // Risolvere PRIMA di chiudere: `rl.close()` emette `close` da lì, e
      // l'ascoltatore qui sopra risolverebbe `undefined` per primo — cioè ogni
      // risposta diventerebbe "non ha risposto". Costa una riga di ordine e
      // vale una chiave incollata e buttata via in silenzio.
      risposto = true;
      const trimmed = answer.trim();
      resolve(trimmed === '' ? undefined : trimmed);
      rl.close();
    });
  });
}

/**
 * Ask a plain question on the terminal. Undefined when the input is not a TTY,
 * or when a terminal's input ends — see `promptSecret` for the whole reason.
 * Every caller already reads undefined as "not answered", which is exactly what
 * Ctrl+D means.
 */
export function promptLine(
  question: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<string | undefined> {
  if (!input.isTTY || finiti.has(input)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let risposto = false;
    const rl = createInterface({ input, output });
    rl.on('close', () => {
      // Stessa distinzione di `promptSecret`: chiusura senza risposta = EOF.
      if (!risposto) finiti.add(input);
      resolve(undefined);
    });
    rl.question(question, (answer) => {
      // Stesso ordine, stessa ragione di `promptSecret`.
      risposto = true;
      resolve(answer.trim());
      rl.close();
    });
  });
}
