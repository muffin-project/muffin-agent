import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { acquireInitCredential } from './init-auth.js';

function dopo(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeTty(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  const input = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
  const output = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  return { input, output };
}

describe('init credential choice', () => {
  it('treats empty Enter as OpenRouter OAuth, not a skip', async () => {
    const { input, output } = fakeTty();
    const stderr: string[] = [];
    const obtain = vi.fn(async () => 'sk-or-v1-canary');
    const pending = acquireInitCredential({
      input,
      output,
      stderr: (text) => stderr.push(text),
      obtain,
      ssh: false,
      stdinIsTTY: true,
    });
    input.write('\n');
    await expect(pending).resolves.toEqual({
      kind: 'key',
      apiKey: 'sk-or-v1-canary',
      method: 'oauth-pkce',
    });
    expect(obtain).toHaveBeenCalledTimes(1);
    expect(stderr.join('')).not.toContain('sk-or-v1-canary');
  });

  it('skips only after an explicit choice and confirmation', async () => {
    const { input, output } = fakeTty();
    const pending = acquireInitCredential({
      input,
      output,
      stderr: () => {},
      obtain: async () => {
        throw new Error('oauth should not run');
      },
      stdinIsTTY: true,
    });
    input.write('3\n');
    await dopo();
    input.write('y\n');
    await expect(pending).resolves.toEqual({ kind: 'skip' });
  });

  it('returns to the menu when skip is declined, then accepts a pasted key', async () => {
    const { input, output } = fakeTty();
    const pending = acquireInitCredential({
      input,
      output,
      stderr: () => {},
      promptForSecret: async () => 'sk-ant-pasted',
      stdinIsTTY: true,
    });
    input.write('3\n');
    await dopo();
    input.write('n\n');
    await dopo();
    input.write('2\n');
    await expect(pending).resolves.toEqual({
      kind: 'key',
      apiKey: 'sk-ant-pasted',
      method: 'api-key',
    });
  });

  it('names Groq on the shared paste path and does not echo the key', async () => {
    const { input, output } = fakeTty();
    const stderr: string[] = [];
    const pending = acquireInitCredential({
      input,
      output,
      stderr: (text) => stderr.push(text),
      promptForSecret: async () => 'gsk_pasted_not_echoed',
      stdinIsTTY: true,
    });
    input.write('2\n');
    await expect(pending).resolves.toEqual({
      kind: 'key',
      apiKey: 'gsk_pasted_not_echoed',
      method: 'api-key',
    });
    const text = stderr.join('');
    expect(text).toContain('gsk_');
    expect(text).toContain('console.groq.com/keys');
    expect(text).not.toContain('gsk_pasted_not_echoed');
  });

  it('does not echo a key that an OAuth error tried to carry', async () => {
    const { input, output } = fakeTty();
    const stderr: string[] = [];
    const pending = acquireInitCredential({
      input,
      output,
      stderr: (text) => stderr.push(text),
      obtain: async () => {
        throw new Error('failed sk-or-v1-canary');
      },
      stdinIsTTY: true,
    });
    input.write('1\n');
    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(stderr.join('')).not.toContain('sk-or-v1-canary');
  });
});
