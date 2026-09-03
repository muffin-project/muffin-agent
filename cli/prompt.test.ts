import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { promptLine, promptSecret } from './prompt.js';
import { applica } from './schermo.js';

/** A writable/readable pair that claims to be a TTY, so the prompts engage. */
function fakeTty(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  const input = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 }) as unknown as NodeJS.WriteStream;
  return { input, output };
}

/**
 * Come `fakeTty`, ma l'output ricorda ogni byte: `applica` (cli/schermo.ts) li
 * rende in griglia, ed è l'unica cosa che risponde a «cosa vede l'owner».
 */
function fakeTtyRegistrato(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream; scritture: string[] } {
  const scritture: string[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 80,
    write: (chunk: unknown) => {
      scritture.push(String(chunk));
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  return { input, output, scritture };
}

/** Lascia girare gli eventi degli stream: readline legge l'input in I/O, non in sincrono. */
function respiro(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('terminal prompts fall back when there is no TTY', () => {
  // In the test runner process.stdin is not a TTY; both prompts must resolve to
  // undefined immediately rather than block on a pipe (cli/init.ts docstring).
  it('promptSecret resolves undefined without a TTY', async () => {
    expect(process.stdin.isTTY).toBeFalsy();
    await expect(promptSecret('secret: ')).resolves.toBeUndefined();
  });

  it('promptLine resolves undefined without a TTY', async () => {
    await expect(promptLine('question: ')).resolves.toBeUndefined();
  });
});

describe('terminal prompts read the typed line', () => {
  it('promptSecret reads a hidden line and resolves the trimmed value', async () => {
    const { input, output } = fakeTty();
    const pending = promptSecret('key: ', input, output);
    input.write('  sk-or-v1-typed  \n');
    await expect(pending).resolves.toBe('sk-or-v1-typed');
  });

  it('promptSecret treats an empty line as skipped (undefined)', async () => {
    const { input, output } = fakeTty();
    const pending = promptSecret('key: ', input, output);
    input.write('\n');
    await expect(pending).resolves.toBeUndefined();
  });

  it('promptLine reads and trims a line', async () => {
    const { input, output } = fakeTty();
    const pending = promptLine('setup? [Y/n] ', input, output);
    input.write('y\n');
    await expect(pending).resolves.toBe('y');
  });
});

/**
 * Ctrl+D è una risposta, non una promessa che non si chiude.
 *
 * `rl.question` non chiama mai il suo callback su EOF: readline emette `close`
 * e basta. Una promise che si decide solo lì non si decide affatto, e Node
 * stampa `Detected unsettled top-level await` e esce 13 — misurato su
 * `muffin init` sotto un pty vero il 27/08/2026, alla primissima domanda del
 * primissimo comando, il cui testo dice che Invio la salta.
 *
 * La guardia `isTTY` copriva «nessun terminale» e si leggeva come se coprisse
 * anche questo. È la stessa forma due volte: un input che finisce non è un
 * input che non c'era.
 */
describe('un input che finisce è una risposta', () => {
  it('promptSecret non resta appeso quando il terminale chiude', async () => {
    const { input, output } = fakeTty();
    const pending = promptSecret('key: ', input, output);
    input.end();
    await expect(pending).resolves.toBeUndefined();
  });

  it('promptLine non resta appeso quando il terminale chiude', async () => {
    const { input, output } = fakeTty();
    const pending = promptLine('setup? [Y/n] ', input, output);
    input.end();
    await expect(pending).resolves.toBeUndefined();
  });

  it('una risposta seguita dalla chiusura resta la risposta', async () => {
    // L'ordine dentro il callback è load-bearing: `rl.close()` emette `close`,
    // e se l'ascoltatore risolvesse per primo ogni risposta diventerebbe
    // «non ha risposto» — una chiave incollata e buttata via in silenzio.
    const { input, output } = fakeTty();
    const pending = promptSecret('key: ', input, output);
    input.write('sk-or-v1-typed\n');
    input.end();
    await expect(pending).resolves.toBe('sk-or-v1-typed');
  });
});

/**
 * **Un EOF vale una volta sola per il processo, non per la domanda** — e la
 * metà che non si vede è che una *risposta* non deve valere come EOF.
 *
 * `muffin init` con un runtime locale acceso fa due domande. La prima
 * consumava il Ctrl+D e la seconda restava appesa per sempre, perché in raw
 * mode readline sintetizza l'EOF dal carattere `^D` e il tty non emette mai
 * `end`: `readableEnded` resta `false` e lo stream non sa di essere finito.
 * Chi deve ricordarlo è questo modulo.
 *
 * Ricordare *troppo* è il difetto gemello, e costa quanto l'altro: se una
 * chiusura normale — quella che segue una risposta data — venisse scambiata
 * per un EOF, rispondere «n» alla prima domanda vorrebbe dire non sentirsi
 * chiedere la chiave. Le due direzioni si provano separatamente perché sono
 * due bug diversi con la stessa riga.
 */
describe('un EOF vale per il processo, una risposta no', () => {
  it('dopo un Ctrl+D, la domanda dopo non si pone nemmeno', async () => {
    const { input, output } = fakeTty();
    const primo = promptLine('primo? ', input, output);
    input.end(); // Ctrl+D
    await expect(primo).resolves.toBeUndefined();
    // Senza memoria dell'EOF questa promise non si deciderebbe mai: il test
    // fallirebbe per timeout, che è esattamente come si comportava `init`.
    await expect(promptLine('secondo? ', input, output)).resolves.toBeUndefined();
  });

  it('e lo stesso vale attraverso i due prompt diversi, perché lo stdin è uno solo', async () => {
    const { input, output } = fakeTty();
    const primo = promptLine('runtime locale? [Y/n] ', input, output);
    input.end();
    await expect(primo).resolves.toBeUndefined();
    await expect(promptSecret('chiave: ', input, output)).resolves.toBeUndefined();
  });

  it('ma una risposta data non chiude niente: la domanda dopo si pone eccome', async () => {
    const { input, output } = fakeTty();
    const primo = promptLine('runtime locale? [Y/n] ', input, output);
    input.write('n\n');
    await expect(primo).resolves.toBe('n');

    const secondo = promptSecret('chiave: ', input, output);
    input.write('sk-or-v1-poi\n');
    await expect(secondo).resolves.toBe('sk-or-v1-poi');
  });
});

/**
 * **Una domanda che il terminale cancella un istante dopo averla stampata.**
 *
 * `promptSecret` scriveva la domanda con `output.write(question)` e poi
 * chiamava `rl.question('')`. `rl.question` imposta il prompt e *ridisegna la
 * riga*, e il ridisegno di readline manda `cursorTo(0)` e `clearScreenDown`
 * **direttamente** sullo stream — fuori dal `_writeToOutput` che quella
 * funzione intercettava per togliere l'eco. Quindi la domanda spariva e sotto
 * restava una riga vuota: un terminale che aspetta senza dirlo sembra piantato.
 * Misurato con `tmux capture-pane` su `muffin init` il 03/09/2026, e nella
 * sorgente di Node (`internal/readline/interface.js`, `kRefreshLine`: le due
 * scritture dirette, e `kWriteToOutput` che è l'unica intercettabile).
 *
 * I byte non si leggono, si applicano: dieci ridisegni sono dieci copie in un
 * log e una sola riga a schermo. `cli/schermo.ts` è il misuratore.
 */
describe('la domanda di un prompt nascosto resta a schermo', () => {
  it('si vede la domanda, e non si vede niente di ciò che si scrive', async () => {
    // readline ridisegna la riga solo su un terminale vero: con `TERM=dumb`
    // stampa il prompt e basta, e il difetto non esisterebbe. Fissarlo qui è
    // ciò che rende questo test la prova di un terminale, non della macchina
    // che lo esegue.
    vi.stubEnv('TERM', 'xterm-256color');
    try {
      const { input, output, scritture } = fakeTtyRegistrato();
      const pending = promptSecret('Chiave API (nascosta): ', input, output);
      input.write('sk-or-v1-non-deve-vedersi');
      await respiro();

      const schermo = applica(scritture).righe.join('\n');
      expect(schermo).toContain('Chiave API (nascosta):');
      expect(schermo).not.toContain('sk-or-v1-non-deve-vedersi');
      // Nemmeno la *lunghezza*: né asterischi, né una fila di segnaposto.
      expect(schermo.replace('Chiave API (nascosta): ', '').trim()).toBe('');

      input.write('\n');
      await expect(pending).resolves.toBe('sk-or-v1-non-deve-vedersi');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
