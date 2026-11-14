import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireInitCredential,
  choiceFromInitPick,
  initPickOverridesPrior,
  type InitCredential,
} from './init-auth.js';

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
      providerId: 'openrouter',
      bound: 'named',
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
      providerId: 'anthropic',
      bound: 'inferred',
    });
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

  it('does not return an unrecognised key, then takes a shape that matches the named provider', async () => {
    const { input, output } = fakeTty();
    const stderr: string[] = [];
    const secrets = ['not-a-catalog-key', 'sk-or-v1-wrong-provider', 'sk-ant-correction'];
    const pending = acquireInitCredential({
      input,
      output,
      stderr: (text) => stderr.push(text),
      promptForSecret: async () => secrets.shift(),
      obtain: async () => {
        throw new Error('oauth should not run');
      },
      stdinIsTTY: true,
    });
    input.write('2\n');
    await dopo();
    input.write('2\n');
    const resolved = await pending;
    expect(resolved).toEqual({
      kind: 'key',
      apiKey: 'sk-ant-correction',
      method: 'api-key',
      providerId: 'anthropic',
      bound: 'named',
    });
    expect(secrets).toEqual([]);
    const shown = stderr.join('');
    expect(shown).not.toContain('not-a-catalog-key');
    expect(shown).not.toContain('sk-or-v1-wrong-provider');
    expect(shown).not.toContain('sk-ant-correction');
    expect(shown).toContain('non la salvo');
  });

  it('an explicit Anthropic choice refuses an OpenRouter key and never returns it', async () => {
    const { input, output } = fakeTty();
    const secrets = ['sk-or-v1-not-anthropic', 'sk-ant-api03-ok'];
    const pending = acquireInitCredential({
      input,
      output,
      stderr: () => {},
      promptForSecret: async () => secrets.shift(),
      stdinIsTTY: true,
    });
    input.write('anthropic\n');
    await expect(pending).resolves.toEqual({
      kind: 'key',
      apiKey: 'sk-ant-api03-ok',
      method: 'api-key',
      providerId: 'anthropic',
      bound: 'named',
    });
    expect(secrets).toEqual([]);
  });

  it('connects ChatGPT on the same menu and returns models, not a stored key', async () => {
    const { input, output } = fakeTty();
    const signIn = vi.fn(async () => ({ profileId: 'p1', connected: true, scopes: [] }));
    const pending = acquireInitCredential({
      input,
      output,
      stderr: () => {},
      home: '/tmp/never',
      chatgpt: () => ({
        session: () => null,
        signIn,
        listModels: async () => [{ slug: 'gpt-test', displayName: 'GPT Test' }],
      }),
      openBrowser: async () => {},
      stdinIsTTY: true,
    });
    input.write('5\n');
    await dopo();
    input.write('gpt-test\n');
    await dopo();
    input.write('\n');
    await expect(pending).resolves.toEqual({
      kind: 'chatgpt',
      models: { main: 'gpt-test', light: 'gpt-test' },
    });
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('a failed ChatGPT connect returns to the menu instead of cancelling init', async () => {
    const { input, output } = fakeTty();
    let signs = 0;
    const pending = acquireInitCredential({
      input,
      output,
      stderr: () => {},
      home: '/tmp/never',
      chatgpt: () => ({
        session: () => null,
        signIn: async () => {
          signs += 1;
          if (signs === 1) throw new Error('browser closed');
          return { profileId: 'p1', connected: true, scopes: [] };
        },
        listModels: async () => [{ slug: 'gpt-test', displayName: 'GPT Test' }],
      }),
      openBrowser: async () => {},
      stdinIsTTY: true,
    });
    input.write('5\n');
    await dopo();
    input.write('5\n');
    await dopo();
    input.write('gpt-test\n');
    await dopo();
    input.write('\n');
    const resolved = await pending;
    expect(signs).toBe(2);
    expect(resolved).toEqual({ kind: 'chatgpt', models: { main: 'gpt-test', light: 'gpt-test' } });
  });

  it('a custom endpoint resolves URL, key and both slugs', async () => {
    const { input, output } = fakeTty();
    const pending = acquireInitCredential({
      input,
      output,
      stderr: () => {},
      promptForSecret: async () => 'custom-secret',
      stdinIsTTY: true,
    });
    input.write('https://llm.example.com/v1\n');
    await dopo();
    input.write('custom-main\n');
    await dopo();
    input.write('\n');
    await expect(pending).resolves.toEqual({
      kind: 'custom',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'custom-secret',
      models: { main: 'custom-main', light: 'custom-main' },
    });
  });
});

describe('choiceFromInitPick — only a named provider replaces inference', () => {
  const inferred: InitCredential = {
    kind: 'key',
    apiKey: 'sk-ant-x',
    method: 'api-key',
    providerId: 'anthropic',
    bound: 'inferred',
  };

  it('leaves an inferred key to chooseProvider', () => {
    expect(choiceFromInitPick(inferred)).toBeUndefined();
    expect(initPickOverridesPrior(inferred)).toBe(false);
    expect(initPickOverridesPrior(undefined)).toBe(false);
    expect(initPickOverridesPrior({ kind: 'skip' })).toBe(false);
  });

  it('names OpenRouter OAuth, a chosen Anthropic key, ChatGPT, and a custom endpoint', () => {
    expect(
      choiceFromInitPick({
        kind: 'key',
        apiKey: 'sk-or-v1-x',
        method: 'oauth-pkce',
        providerId: 'openrouter',
        bound: 'named',
      }),
    ).toMatchObject({ provider: 'openai-compat', reason: 'oauth' });
    expect(
      choiceFromInitPick({
        kind: 'key',
        apiKey: 'sk-ant-x',
        method: 'api-key',
        providerId: 'anthropic',
        bound: 'named',
      }),
    ).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'chosen' });
    expect(
      choiceFromInitPick({ kind: 'chatgpt', models: { main: 'gpt-test', light: 'gpt-test' } }),
    ).toMatchObject({ provider: 'openai-chatgpt', reason: 'chosen' });
    expect(
      choiceFromInitPick({
        kind: 'custom',
        baseUrl: 'https://llm.example.com/v1',
        models: { main: 'm', light: 'l' },
      }),
    ).toEqual({
      provider: 'openai-compat',
      baseUrl: 'https://llm.example.com/v1',
      reason: 'chosen',
    });
    expect(initPickOverridesPrior({ kind: 'chatgpt', models: { main: 'a', light: 'a' } })).toBe(
      true,
    );
  });
});
