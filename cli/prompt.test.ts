import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptLine, promptSecret } from './prompt.js';

/** A writable/readable pair that claims to be a TTY, so the prompts engage. */
function fakeTty(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  const input = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 }) as unknown as NodeJS.WriteStream;
  return { input, output };
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
