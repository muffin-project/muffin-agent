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

  it('does not start OAuth without a terminal or for Anthropic, Groq, or xAI', async () => {
    const { home } = fixture();
    const obtain = vi.fn(async () => CANARY);
    const out: string[] = [];
    const sink = (line: string) => out.push(line);
    expect(
      await cmdAuth(home, ['login', 'openrouter'], { out: sink, obtain, stdinIsTTY: false }),
    ).toBe(1);
    expect(
      await cmdAuth(home, ['login', 'anthropic'], { out: sink, obtain, stdinIsTTY: true }),
    ).toBe(2);
    expect(await cmdAuth(home, ['login', 'grok'], { out: sink, obtain, stdinIsTTY: true })).toBe(2);
    expect(await cmdAuth(home, ['login', 'xai'], { out: sink, obtain, stdinIsTTY: true })).toBe(2);
    expect(await cmdAuth(home, ['login', 'groq'], { out: sink, obtain, stdinIsTTY: true })).toBe(2);
    expect(obtain).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/Console\/API key/);
    expect(out.join('\n')).toMatch(/xAI\/Grok/);
    expect(out.join('\n')).toContain(PROVIDERS.groq.keysUrl);
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

  it('switches a Groq account on Groq lanes and leaves the other lane alone', async () => {
    const { home } = fixture();
    const before = loadConfig(home);
    saveConfig(
      {
        ...before,
        provider: {
          kind: 'openai-compat',
          baseUrl: PROVIDERS.groq.baseUrl,
          apiKeyRef: 'secret://groq_api_key',
        },
      },
      home,
    );
    writeSecret('groq_api_key', 'gsk_default_not_printed', home, 'home');
    writeSecret('groq_api_key_work', 'gsk_work_not_printed', home, 'home');
    const out: string[] = [];
    const code = await cmdAuth(home, ['switch', 'groq', 'work'], {
      out: (line) => out.push(line),
      stdinIsTTY: true,
    });
    const config = loadConfig(home);
    expect(code).toBe(0);
    expect(config.provider.apiKeyRef).toBe('secret://groq_api_key_work');
    expect(config.models).toEqual(before.models);
    expect(config.lightProvider?.kind).toBe('anthropic');
    expect(out.join('\n')).toContain('main');
    expect(out.join('\n')).not.toContain('gsk_work_not_printed');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain('gsk_work_not_printed');
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
