import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import {
  AuthProfileError,
  authProfilePath,
  listKeyProfiles,
  managedProfileId,
  rememberKeyProfile,
  selectKeyProfile,
} from './auth-profile.js';
import { loadConfig, saveConfig, writeSecret } from './config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-auth-profile-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  return dir;
}

describe('key auth profiles', () => {
  it('records the secret name and never the key', () => {
    const dir = home();
    runInit({
      home: dir,
      provider: 'openai-compat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-canary-not-in-index',
    });
    rememberKeyProfile(dir, {
      id: 'default',
      provider: 'openrouter',
      method: 'oauth-pkce',
      secretName: 'openrouter_api_key',
    });
    const file = authProfilePath(dir);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('sk-or-v1-canary-not-in-index');
    expect(text).toContain('oauth-pkce');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const listed = JSON.stringify(listKeyProfiles(dir));
    expect(listed).toContain('openrouter_api_key');
    expect(listed).not.toContain('canary');
    expect(listKeyProfiles(dir).find((item) => item.id === 'default')?.lanes).toContain('main');
  });

  it('discovers a canonical secret when the index was never written', () => {
    const dir = home();
    runInit({ home: dir, provider: 'anthropic', apiKey: 'sk-ant-present' });
    writeSecret('openrouter_api_key', 'sk-or-v1-discovered', dir, 'home');
    const found = listKeyProfiles(dir).find((item) => item.provider === 'openrouter');
    expect(found).toMatchObject({
      id: 'default',
      method: 'api-key',
      secretPresent: true,
      lanes: [],
    });
    expect(JSON.stringify(found)).not.toContain('sk-or-v1-discovered');
  });

  it('switch selects an account without copying its key into config', () => {
    const dir = home();
    runInit({
      home: dir,
      provider: 'openai-compat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-default-key',
    });
    writeSecret('openrouter_api_key_work', 'sk-or-v1-work-key', dir, 'home');
    const before = loadConfig(dir);
    saveConfig(
      {
        ...before,
        lightProvider: { kind: 'anthropic', apiKeyRef: 'secret://anthropic_api_key' },
      },
      dir,
    );
    selectKeyProfile(dir, 'openrouter', 'work');
    const config = loadConfig(dir);
    expect(config.provider.apiKeyRef).toBe('secret://openrouter_api_key');
    expect(config.lightProvider?.kind).toBe('anthropic');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('sk-or-v1-work-key');
    expect(listKeyProfiles(dir).find((item) => item.id === 'work')?.selected).toBe(true);
  });

  it('refuses a corrupt index instead of rewriting it', () => {
    const dir = home();
    writeFileSync(authProfilePath(dir), '{', { mode: 0o600 });
    expect(() => listKeyProfiles(dir)).toThrow(AuthProfileError);
    expect(readFileSync(authProfilePath(dir), 'utf8')).toBe('{');
  });

  it('maps only managed secret names to profile ids', () => {
    expect(managedProfileId('openrouter', 'openrouter_api_key')).toBe('default');
    expect(managedProfileId('openrouter', 'openrouter_api_key_work')).toBe('work');
    expect(managedProfileId('openrouter', 'provider_api_key')).toBeNull();
    expect(managedProfileId('anthropic', 'openrouter_api_key')).toBeNull();
    expect(managedProfileId('groq', 'groq_api_key')).toBe('default');
    expect(managedProfileId('groq', 'groq_api_key_work')).toBe('work');
    expect(managedProfileId('groq', 'openrouter_api_key')).toBeNull();
  });

  it('discovers a Groq key as a profile without writing the key or an index', () => {
    const dir = home();
    runInit({
      home: dir,
      provider: 'openai-compat',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_discovered_not_in_index',
    });
    const found = listKeyProfiles(dir).filter((item) => item.provider === 'groq');
    expect(found).toEqual([
      expect.objectContaining({
        id: 'default',
        provider: 'groq',
        method: 'api-key',
        secretName: 'groq_api_key',
        secretPresent: true,
        lanes: ['main', 'light'],
      }),
    ]);
    expect(JSON.stringify(found)).not.toContain('gsk_discovered_not_in_index');
    expect(existsSync(authProfilePath(dir))).toBe(false);
  });
});
