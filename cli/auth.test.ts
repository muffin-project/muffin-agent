import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { verifyInferenceRoute } from '../agent/providers/verify.js';
import { listKeyProfiles, rememberKeyProfile } from '../core/config/auth-profile.js';
import { loadConfig, readSecret, saveConfig, writeSecret } from '../core/config/config.js';
import { pkceChallenge } from '../core/config/openrouter-oauth.js';
import { PROVIDERS } from '../core/config/providers.js';
import { cmdAuth } from './auth.js';
import { runInit } from './init.js';
import { obtainOpenRouterAuthorization } from './openrouter-connect.js';

const CANARY = 'sk-or-v1-canary-do-not-print';

afterEach(() => {
  vi.unstubAllEnvs();
});

function fixture(): { home: string } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-auth-cmd-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'));
  runInit({ home, provider: 'anthropic', apiKey: 'sk-ant-existing' });
  return { home };
}

const working = {
  status: 'working' as const,
  provider: 'openai-compat' as const,
  requestedModel: 'openrouter/free',
  resolvedModel: 'openrouter/free',
  capability: { completion: 'pass' as const, toolCall: 'pass' as const },
  diagnostic: 'completed probe',
  observedAt: '2026-11-04T00:00:00Z',
  durationMs: 1,
};

describe('muffin auth', () => {
  it('stores an OpenRouter OAuth key, retargets main, and probes', async () => {
    const { home } = fixture();
    const before = loadConfig(home);
    const out: string[] = [];
    const obtain = vi.fn(async () => CANARY);
    const verify = vi.fn<typeof verifyInferenceRoute>(async () => working);
    const code = await cmdAuth(home, ['login', 'openrouter'], {
      out: (line) => out.push(line),
      obtain,
      verify,
      stdinIsTTY: true,
      ssh: false,
    });
    const text = out.join('\n');
    const config = loadConfig(home);
    expect(code).toBe(1);
    expect(text).toContain('not an OpenRouter id');
    expect(text).not.toContain(CANARY);
    expect(readSecret('secret://openrouter_api_key', home)).toBe(CANARY);
    expect(config.provider).toMatchObject({
      kind: 'openai-compat',
      baseUrl: PROVIDERS.openrouter.baseUrl,
      apiKeyRef: 'secret://openrouter_api_key',
    });
    expect(config.models).toEqual(before.models);
    expect(config.lightProvider?.kind).toBe('anthropic');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain(CANARY);
    expect(readFileSync(join(home, 'auth-profiles.json'), 'utf8')).not.toContain(CANARY);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(
      listKeyProfiles(home).find((item) => item.provider === 'openrouter' && item.id === 'default')
        ?.method,
    ).toBe('oauth-pkce');
  });

  it('reports working only when the saved route passes the probe', async () => {
    const { home } = fixture();
    const config = loadConfig(home);
    saveConfig({ ...config, models: { ...config.models, main: 'openrouter/free' } }, home);
    const out: string[] = [];
    const code = await cmdAuth(home, ['login', 'openrouter', '--code'], {
      out: (line) => out.push(line),
      obtain: async () => CANARY,
      verify: async () => working,
      stdinIsTTY: true,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Probe: working');
    expect(out.join('\n')).not.toContain('Configured, not working');
    expect(out.join('\n')).not.toContain(CANARY);
  });

  it('keeps the key when the probe fails', async () => {
    const { home } = fixture();
    const config = loadConfig(home);
    saveConfig({ ...config, models: { ...config.models, main: 'openrouter/free' } }, home);
    const out: string[] = [];
    const code = await cmdAuth(home, ['login', 'openrouter'], {
      out: (line) => out.push(line),
      obtain: async () => CANARY,
      verify: async () => ({
        ...working,
        status: 'auth_failed',
        diagnostic: 'endpoint rejected the credential',
      }),
      stdinIsTTY: true,
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('Configured, not working');
    expect(out.join('\n')).not.toContain('Probe: working');
    expect(readSecret('secret://openrouter_api_key', home)).toBe(CANARY);
    expect(out.join('\n')).not.toContain(CANARY);
  });

  it('does not start OAuth without a terminal or for Anthropic', async () => {
    const { home } = fixture();
    const obtain = vi.fn(async () => CANARY);
    const obtainXai = vi.fn();
    const out: string[] = [];
    const sink = (line: string) => out.push(line);
    expect(
      await cmdAuth(home, ['login', 'openrouter'], { out: sink, obtain, stdinIsTTY: false }),
    ).toBe(1);
    expect(
      await cmdAuth(home, ['login', 'anthropic'], { out: sink, obtain, stdinIsTTY: true }),
    ).toBe(2);
    expect(await cmdAuth(home, ['login', 'xai'], { out: sink, obtainXai, stdinIsTTY: false })).toBe(
      1,
    );
    expect(
      await cmdAuth(home, ['login', 'xai', '--code', '--device'], {
        out: sink,
        obtainXai,
        stdinIsTTY: true,
      }),
    ).toBe(2);
    expect(obtain).not.toHaveBeenCalled();
    expect(obtainXai).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/Console\/API key/);
    expect(out.join('\n')).toMatch(/xAI login needs a terminal/);
    expect(out.join('\n')).not.toContain(CANARY);
  });

  it('switches an OpenRouter account on main and leaves light and the model alone', async () => {
    const { home } = fixture();
    const before = loadConfig(home);
    saveConfig(
      {
        ...before,
        provider: {
          kind: 'openai-compat',
          baseUrl: PROVIDERS.openrouter.baseUrl,
          apiKeyRef: 'secret://openrouter_api_key',
        },
      },
      home,
    );
    writeSecret('openrouter_api_key', 'sk-or-v1-default-key', home, 'home');
    writeSecret('openrouter_api_key_work', 'sk-or-v1-work-key', home, 'home');
    rememberKeyProfile(home, {
      id: 'default',
      provider: 'openrouter',
      method: 'api-key',
      secretName: 'openrouter_api_key',
    });
    const out: string[] = [];
    const code = await cmdAuth(home, ['switch', 'openrouter', 'work'], {
      out: (line) => out.push(line),
      stdinIsTTY: true,
    });
    const config = loadConfig(home);
    expect(code).toBe(0);
    expect(config.provider.apiKeyRef).toBe('secret://openrouter_api_key_work');
    expect(config.models).toEqual(before.models);
    expect(config.lightProvider?.kind).toBe('anthropic');
    expect(out.join('\n')).toContain('main');
    expect(out.join('\n')).not.toContain('sk-or-v1-work-key');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain('sk-or-v1-work-key');
  });

  it('lists profiles without creating a ChatGPT credential file', async () => {
    const { home } = fixture();
    writeSecret('openrouter_api_key', CANARY, home, 'home');
    const out: string[] = [];
    expect(await cmdAuth(home, ['status'], { out: (line) => out.push(line) })).toBe(0);
    expect(out.join('\n')).toContain('openrouter default api-key secret://openrouter_api_key');
    expect(out.join('\n')).not.toContain(CANARY);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(home, 'secrets', 'chatgpt'))).toBe(false);
  });
});

describe('OpenRouter PKCE from the CLI', () => {
  it('uses the real headless challenge and never prints the verifier or the key', async () => {
    let verifier = '';
    const out: string[] = [];
    const key = await obtainOpenRouterAuthorization({
      mode: 'code',
      out: (line) => out.push(line),
      promptCode: async () => 'one-use-code',
      exchange: async (input) => {
        verifier = input.verifier;
        expect(input.code).toBe('one-use-code');
        return CANARY;
      },
    });
    expect(key).toBe(CANARY);
    const url = out
      .map((line) => {
        try {
          return new URL(line);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.origin === 'https://openrouter.ai');
    expect(url?.searchParams.get('code_challenge')).toBe(pkceChallenge(verifier));
    expect(url?.searchParams.has('callback_url')).toBe(false);
    const printed = out.join('\n');
    expect(printed).not.toContain(verifier);
    expect(printed).not.toContain(CANARY);
    expect(printed).not.toContain('one-use-code');
  });
});

describe('muffin auth login xai (ADR-0113)', () => {
  const XAI_ACCESS = 'xai-access-canary';
  const XAI_REFRESH = 'xai-refresh-canary';

  function xaiFetch(modelsStatus = 200) {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      urls.push(`${request.url} ${request.headers.get('authorization') ?? ''}`);
      if (request.url.endsWith('/oauth2/userinfo'))
        return Response.json({ email: 'me@example.com' });
      if (request.url === 'https://api.x.ai/v1/models') {
        return modelsStatus === 200
          ? Response.json({ data: [{ id: 'grok-4.7' }, { id: 'grok-4.6' }] })
          : new Response('{"error":"The caller does not have permission"}', {
              status: modelsStatus,
            });
      }
      if (request.url === 'https://auth.x.ai/oauth2/revoke') return new Response(null);
      throw new Error(`unexpected ${request.url}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  const obtainXai = vi.fn(async () => ({
    token: { accessToken: XAI_ACCESS, refreshToken: XAI_REFRESH, expiresIn: 3600 },
    method: 'oauth-pkce' as const,
  }));

  it('saves the login, checks api.x.ai with it, and never prints a token', async () => {
    const { home } = fixture();
    const { fetchImpl, urls } = xaiFetch();
    const out: string[] = [];
    const code = await cmdAuth(home, ['login', 'xai'], {
      out: (line) => out.push(line),
      obtainXai,
      fetch: fetchImpl,
      stdinIsTTY: true,
      ssh: true,
    });
    const text = out.join('\n');
    expect(code).toBe(0);
    expect(obtainXai).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'device' }));
    expect(text).toContain('xAI login saved at secret://xai_oauth for me@example.com');
    expect(text).toContain('muffin fallback add xai grok-4.7');
    expect(text).toContain('api.x.ai accepts this login (2 models visible)');
    expect(text).not.toMatch(/canary/);
    expect(urls).toContain(`https://api.x.ai/v1/models Bearer ${XAI_ACCESS}`);
    const stored = JSON.parse(readFileSync(join(home, 'secrets', 'xai_oauth'), 'utf8'));
    expect(stored).toMatchObject({ accessToken: XAI_ACCESS, refreshToken: XAI_REFRESH });
    // The main lane is untouched: the login is chosen per chain link.
    expect(loadConfig(home).provider.kind).toBe('anthropic');

    out.length = 0;
    expect(await cmdAuth(home, ['status'], { out: (line) => out.push(line) })).toBe(0);
    expect(out.join('\n')).toContain(
      'xai login oauth-pkce secret://xai_oauth inactive ok me@example.com',
    );
    expect(out.join('\n')).not.toMatch(/canary/);
  });

  it('points xAI links that name a missing default key at the login', async () => {
    const { home } = fixture();
    const config = loadConfig(home);
    saveConfig(
      {
        ...config,
        fallbacks: {
          main: [
            {
              provider: {
                kind: 'openai-compat',
                baseUrl: 'https://api.x.ai/v1',
                apiKeyRef: 'secret://xai_api_key',
              },
              model: 'grok-4.7',
            },
            {
              provider: {
                kind: 'openai-compat',
                baseUrl: 'https://api.x.ai/v1',
                apiKeyRef: 'secret://xai_api_key_work',
              },
              model: 'grok-4.6',
            },
          ],
        },
      },
      home,
    );
    const out: string[] = [];
    await cmdAuth(home, ['login', 'xai', '--browser'], {
      out: (line) => out.push(line),
      obtainXai,
      fetch: xaiFetch().fetchImpl,
      stdinIsTTY: true,
    });
    const links = loadConfig(home).fallbacks?.main ?? [];
    expect(links.map((link) => link.provider.apiKeyRef)).toEqual([
      'secret://xai_oauth',
      'secret://xai_api_key_work',
    ]);
    expect(out.join('\n')).toContain('now use the login: main 2');
    expect(out.join('\n')).toContain('Used by: main 2');
  });

  it('leaves a link with a stored key alone', async () => {
    const { home } = fixture();
    writeSecret('xai_api_key', 'xai-key-canary', home, 'persistent');
    const config = loadConfig(home);
    const link = {
      provider: {
        kind: 'openai-compat' as const,
        baseUrl: 'https://api.x.ai/v1',
        apiKeyRef: 'secret://xai_api_key',
      },
      model: 'grok-4.7',
    };
    saveConfig({ ...config, fallbacks: { main: [link] } }, home);
    await cmdAuth(home, ['login', 'xai'], {
      out: () => {},
      obtainXai,
      fetch: xaiFetch().fetchImpl,
      stdinIsTTY: true,
    });
    expect(loadConfig(home).fallbacks?.main?.[0]?.provider.apiKeyRef).toBe('secret://xai_api_key');
  });

  it('reports a 403 from api.x.ai as plan gating with the API-key way out', async () => {
    const { home } = fixture();
    const out: string[] = [];
    const code = await cmdAuth(home, ['login', 'xai'], {
      out: (line) => out.push(line),
      obtainXai,
      fetch: xaiFetch(403).fetchImpl,
      stdinIsTTY: true,
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('api.x.ai refused this login (HTTP 403)');
    expect(out.join('\n')).toContain('muffin secret set xai_api_key');
    expect(out.join('\n')).not.toContain('caller does not have permission');
  });

  it('logout revokes and names the links still using the login', async () => {
    const { home } = fixture();
    const { fetchImpl } = xaiFetch();
    await cmdAuth(home, ['login', 'xai'], {
      out: () => {},
      obtainXai,
      fetch: fetchImpl,
      stdinIsTTY: true,
    });
    const config = loadConfig(home);
    saveConfig(
      {
        ...config,
        fallbacks: {
          light: [
            {
              provider: {
                kind: 'openai-compat',
                baseUrl: 'https://api.x.ai/v1',
                apiKeyRef: 'secret://xai_oauth',
              },
              model: 'grok-4.7',
            },
          ],
        },
      },
      home,
    );
    const out: string[] = [];
    const { XaiOAuthConnection } = await import('../core/config/xai-oauth.js');
    const xai = new XaiOAuthConnection(home, { fetch: fetchImpl });
    expect(await cmdAuth(home, ['logout', 'xai'], { out: (line) => out.push(line), xai })).toBe(0);
    expect(out.join('\n')).toContain('the renewable session was revoked');
    expect(out.join('\n')).toContain('Still configured to use it: light 2');
    out.length = 0;
    expect(await cmdAuth(home, ['logout', 'xai'], { out: (line) => out.push(line), xai })).toBe(0);
    expect(out.join('\n')).toContain('xAI is not logged in.');
  });
});
