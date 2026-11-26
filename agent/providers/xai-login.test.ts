import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { type Config, loadConfig, saveConfig } from '../../core/config/config.js';
import { XaiOAuthConnection } from '../../core/config/xai-oauth.js';
import { providerErrorReply } from '../loop/provider-error-reply.js';
import { connectionProvider } from './configured.js';
import { ProviderError } from './types.js';
import { verifyInferenceRoute } from './verify.js';

const XAI_LOGIN = {
  kind: 'openai-compat' as const,
  baseUrl: 'https://api.x.ai/v1',
  apiKeyRef: 'secret://xai_oauth',
};

const CALL = {
  model: 'grok-4.7',
  system: [{ type: 'text' as const, text: 's' }],
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  maxOutputTokens: 8,
  stream: false,
};

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-xai-login-'));
  runInit({ home: dir, provider: 'openai-compat', apiKey: 'unused-synthetic-key' });
  return dir;
}

function wire() {
  const seen: Array<{ url: string; authorization: string | null; body: URLSearchParams | null }> =
    [];
  const answers: Array<() => Response> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const isToken = request.url === 'https://auth.x.ai/oauth2/token';
    seen.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      body: isToken ? new URLSearchParams(await request.text()) : null,
    });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected ${request.url}`);
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen, answers };
}

const completion = () =>
  Response.json({
    id: 'r',
    model: 'grok-4.7',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });

describe('an xAI connection on secret://xai_oauth (ADR-0113)', () => {
  it('refreshes a token about to expire before the request and sends the new one', async () => {
    const dir = home();
    await new XaiOAuthConnection(dir).save(
      { accessToken: 'old-access', refreshToken: 'old-refresh', expiresIn: 30 },
      'oauth-pkce',
    );
    const { fetch, seen, answers } = wire();
    answers.push(
      () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' }),
      completion,
      completion,
    );
    const provider = connectionProvider(XAI_LOGIN, dir, fetch);
    expect((await provider.chat(CALL)).text).toBe('ok');
    await provider.chat(CALL);
    expect(seen.map((s) => `${s.url} ${s.authorization ?? ''}`.trim())).toEqual([
      'https://auth.x.ai/oauth2/token',
      'https://api.x.ai/v1/chat/completions Bearer new-access',
      'https://api.x.ai/v1/chat/completions Bearer new-access',
    ]);
    expect(seen[0]?.body?.get('refresh_token')).toBe('old-refresh');
  });

  it('turns a refused refresh into a non-retryable re-login error the chain fails over on', async () => {
    const dir = home();
    await new XaiOAuthConnection(dir).save(
      { accessToken: 'old-access', refreshToken: 'dead-refresh', expiresIn: 1 },
      'oauth-pkce',
    );
    const { fetch, seen, answers } = wire();
    answers.push(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const provider = connectionProvider(XAI_LOGIN, dir, fetch);
    const error = await provider.chat(CALL).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).details).toMatchObject({ reauthentication: 'xai' });
    expect(providerErrorReply(error as ProviderError)).toContain('muffin auth login xai');
    expect(seen.some((s) => s.url.startsWith('https://api.x.ai/'))).toBe(false);
  });

  it('without a login there is no adapter, like a missing key file', () => {
    expect(() => connectionProvider(XAI_LOGIN, home())).toThrow('muffin auth login xai');
  });

  it('the online probe names the login, not a key, as the remedy', async () => {
    const dir = home();
    const config: Config = loadConfig(dir);
    saveConfig(
      { ...config, provider: XAI_LOGIN, models: { ...config.models, main: 'grok-4.7' } },
      dir,
    );
    const result = await verifyInferenceRoute({ home: dir, nonce: 'synthetic123' });
    expect(result.status).toBe('misconfigured');
    expect(result.remedy).toBe('run `muffin auth login xai`');
    expect(result.diagnostic).not.toContain('missing secret');
  });
});
