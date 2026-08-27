import { createInterface } from 'node:readline';

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
 * value — so we only suppress the per-character echo it would otherwise print.
 *
 * input/output are injectable so the read path is testable without a real TTY.
 */
export function promptSecret(
  question: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<string | undefined> {
  if (!input.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    const internal = rl as unknown as { _writeToOutput?: (s: string) => void };
    const echo = internal._writeToOutput?.bind(rl);
    let visible = true;
    internal._writeToOutput = (s: string) => {
      if (visible) echo?.(s);
    };
    output.write(question);
    visible = false; // everything the user types from here is not echoed
    // Prima di `question`, non dopo: un input già chiuso emette `close` subito,
    // e un ascoltatore registrato dopo non lo sentirebbe mai.
    rl.on('close', () => {
      // `question` risolve e poi chiude, quindi questo scatta anche sul
      // percorso normale — dove non fa niente, perché la promise è già decisa.
      output.write('\n');
      resolve(undefined);
    });
    rl.question('', (answer) => {
      // Risolvere PRIMA di chiudere: `rl.close()` emette `close` da lì, e
      // l'ascoltatore qui sopra risolverebbe `undefined` per primo — cioè ogni
      // risposta diventerebbe "non ha risposto". Costa una riga di ordine e
      // vale una chiave incollata e buttata via in silenzio.
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
  if (!input.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.on('close', () => resolve(undefined));
    rl.question(question, (answer) => {
      // Stesso ordine, stessa ragione di `promptSecret`.
      resolve(answer.trim());
      rl.close();
    });
  });
}
