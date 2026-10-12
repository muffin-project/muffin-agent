import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { runInit } from './init.js';
import { loadConfig, ConfigSchema } from '../core/config/config.js';
import { ChatGPTConnection } from '../core/config/chatgpt-oauth.js';
import { cmdChatGPT } from './chatgpt.js';
import type { VerificationResult, verifyInferenceRoute } from '../agent/providers/verify.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'muffin-chatgpt-command-'));
  runInit({
    home,
    provider: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'synthetic-key',
  });
  const out: string[] = [];
  const connection = new ChatGPTConnection(home);
  vi.spyOn(connection, 'listModels').mockResolvedValue([
    { slug: 'gpt-6.1-sol', displayName: 'Sol' },
  ]);
  return { home, out, connection, sink: (line: string) => out.push(line) };
}
const working = (): VerificationResult => ({
  status: 'working',
  provider: 'openai-chatgpt',
  requestedModel: 'gpt-6.1-sol',
  resolvedModel: 'gpt-6.1-sol',
  capability: { completion: 'pass', toolCall: 'pass' },
  diagnostic: 'completed probe',
  observedAt: '2026-10-12T00:00:00Z',
  durationMs: 1,
});

describe('ChatGPT account and fixed model command', () => {
  it('requires the public route and dedicated connection reference, rejects router settings', () => {
    const f = fixture();
    const config = loadConfig(f.home);
    const provider = {
      kind: 'openai-chatgpt',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyRef: 'secret://chatgpt',
    };
    expect(ConfigSchema.safeParse({ ...config, provider }).success).toBe(true);
    for (const bad of [
      { ...provider, baseUrl: 'https://evil.example/v1' },
      { ...provider, apiKeyRef: 'secret://provider_api_key' },
      { ...provider, reasoningDialect: 'reasoning_effort' },
    ]) {
      expect(ConfigSchema.safeParse({ ...config, provider: bad }).success).toBe(false);
    }
  });
  it('preserves configured route when catalog or completed probe does not verify the exact model', async () => {
    const f = fixture();
    const before = loadConfig(f.home);
    const verify = vi.fn<typeof verifyInferenceRoute>(async () => working());
    expect(
      await cmdChatGPT(f.home, ['use', 'absent'], {
        out: f.sink,
        connection: f.connection,
        verify,
      }),
    ).toBe(1);
    expect(verify).not.toHaveBeenCalled();
    verify.mockResolvedValue({ ...working(), resolvedModel: 'another-model' });
    expect(
      await cmdChatGPT(f.home, ['use', 'gpt-6.1-sol'], {
        out: f.sink,
        connection: f.connection,
        verify,
      }),
    ).toBe(1);
    expect(loadConfig(f.home)).toEqual(before);
    verify.mockResolvedValue({ ...working(), status: 'provider_error' });
    expect(
      await cmdChatGPT(f.home, ['use', 'gpt-6.1-sol'], {
        out: f.sink,
        connection: f.connection,
        verify,
      }),
    ).toBe(1);
    expect(loadConfig(f.home)).toEqual(before);
  });
  it('pins both lanes only after verified inference and passes the production candidate into the probe', async () => {
    const f = fixture();
    const verify = vi.fn<typeof verifyInferenceRoute>(async () => working());
    expect(
      await cmdChatGPT(f.home, ['use', 'gpt-6.1-sol'], {
        out: f.sink,
        connection: f.connection,
        verify,
      }),
    ).toBe(0);
    expect(loadConfig(f.home).models).toEqual({ main: 'gpt-6.1-sol', light: 'gpt-6.1-sol' });
    expect(verify.mock.calls[0]?.[0]).toMatchObject({
      home: f.home,
      config: { provider: { kind: 'openai-chatgpt', baseUrl: 'https://api.openai.com/v1' } },
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[1]?.[0]).toMatchObject({ thinking: 'low', model: 'gpt-6.1-sol' });
    expect(f.out.join('\n')).toContain('Using ChatGPT plan');
  });
  it('preserves config when the main probe passes but the internal memory policy fails', async () => {
    const f = fixture();
    const before = loadConfig(f.home);
    const verify = vi
      .fn<typeof verifyInferenceRoute>()
      .mockResolvedValueOnce(working())
      .mockResolvedValueOnce({
        ...working(),
        status: 'misconfigured',
        diagnostic: 'unsupported low',
      });
    expect(
      await cmdChatGPT(f.home, ['use', 'gpt-6.1-sol'], {
        out: f.sink,
        connection: f.connection,
        verify,
      }),
    ).toBe(1);
    expect(loadConfig(f.home)).toEqual(before);
  });
  it('login saves a connection without switching provider or model', async () => {
    const f = fixture();
    const before = loadConfig(f.home);
    vi.spyOn(f.connection, 'signIn').mockResolvedValue({
      profileId: 'test',
      connected: true,
      scopes: ['chatgpt.tokens.use.direct'],
    });
    expect(
      await cmdChatGPT(f.home, ['login'], {
        out: f.sink,
        connection: f.connection,
        openBrowser: async () => {},
      }),
    ).toBe(0);
    expect(loadConfig(f.home)).toEqual(before);
  });
  it('routes an explicit saved profile to reauthorization and --new to a new registration', async () => {
    const f = fixture();
    const signin = vi.spyOn(f.connection, 'signIn').mockResolvedValue({
      profileId: 'saved',
      connected: true,
      scopes: ['chatgpt.tokens.use.direct'],
    });
    expect(
      await cmdChatGPT(f.home, ['login', 'saved'], {
        out: f.sink,
        connection: f.connection,
        openBrowser: async () => {},
      }),
    ).toBe(0);
    expect(signin.mock.calls[0]?.[0]).toMatchObject({ profileId: 'saved' });
    expect(
      await cmdChatGPT(f.home, ['login', '--new'], {
        out: f.sink,
        connection: f.connection,
        openBrowser: async () => {},
      }),
    ).toBe(0);
    expect(signin.mock.calls[1]?.[0]).toMatchObject({ newProfile: true });
    expect(
      await cmdChatGPT(f.home, ['login', '--bogus'], { out: f.sink, connection: f.connection }),
    ).toBe(2);
    expect(signin).toHaveBeenCalledTimes(2);
  });
});
