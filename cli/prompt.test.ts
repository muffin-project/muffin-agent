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
