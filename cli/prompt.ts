import { createInterface } from 'node:readline';

/**
 * Read a secret from the terminal without echoing it. Resolves to undefined
 * when the input is not a TTY, so a headless caller falls back to a flag or env
 * var instead of blocking a pipe forever (see cli/init.ts docstring).
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
    rl.question('', (answer) => {
      rl.close();
      output.write('\n');
      const trimmed = answer.trim();
      resolve(trimmed === '' ? undefined : trimmed);
    });
  });
}

/**
 * Ask a plain question on the terminal. Undefined when the input is not a TTY,
 * so the caller can print copy-pasteable guidance instead of hanging on a pipe.
 */
export function promptLine(
  question: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<string | undefined> {
  if (!input.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
