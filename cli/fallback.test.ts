import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configuredProvider } from '../agent/providers/configured.js';
import { inferenceChain, loadConfig, writeAuthoritativeSecret } from '../core/config/config.js';
import { linkId, readChainState, writeLaneChainState } from '../core/config/provider-chain.js';
import { XaiOAuthConnection } from '../core/config/xai-oauth.js';
import { cmdFallback, describeChain } from './fallback.js';
import { runInit } from './init.js';

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'muffin-fallback-cli-'));
  runInit({ home, provider: 'openai-compat', apiKey: 'unused-synthetic-key' });
  const lines: string[] = [];
  return {
    home,
    lines,
    run: (...argv: string[]) => cmdFallback(home, argv, { out: (l) => lines.push(l) }),
  };
}

describe('muffin fallback', () => {
  it('adds catalog links in order, per lane, without typing endpoints or secret names', () => {
    const { home, lines, run } = fresh();
    expect(run('add', 'xai', 'grok-4.7')).toBe(0);
    expect(run('add', 'openrouter', 'openrouter/free')).toBe(0);
    expect(run('add', 'openrouter', 'openrouter/free', '--light')).toBe(0);
    const config = loadConfig(home);
    expect(inferenceChain(config, 'main').map((l) => [l.provider.baseUrl, l.model])).toEqual([
      [config.provider.baseUrl, config.models.main],
      ['https://api.x.ai/v1', 'grok-4.7'],
      ['https://openrouter.ai/api/v1', 'openrouter/free'],
    ]);
    expect(config.fallbacks?.main?.[0]?.provider.apiKeyRef).toBe('secret://xai_api_key');
    expect(config.fallbacks?.light).toHaveLength(1);
    expect(lines.join('\n')).toContain(
      'manca la credenziale: muffin auth login xai (oppure muffin secret set xai_api_key)',
    );
    expect(lines.join('\n')).toContain('la spesa conta nei tetti di budget');
  });

  it('a second account of the same provider is its own link', () => {
    const { home, run } = fresh();
    expect(run('add', 'openrouter', 'some/model', '--account', 'work')).toBe(0);
    expect(loadConfig(home).fallbacks?.main?.[0]?.provider.apiKeyRef).toBe(
      'secret://openrouter_api_key_work',
    );
  });

  it('lists the chain with position, label and missing credentials', () => {
    const { lines, run } = fresh();
    run('add', 'xai', 'grok-4.7');
    lines.length = 0;
    expect(run()).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/main:\n {2}1\. .* — principale/);
    expect(text).toContain(
      '2. xAI API · grok-4.7 — credenziale mancante → muffin auth login xai (oppure muffin secret set xai_api_key)',
    );
  });

  it('removes by provider or by printed position; position 1 belongs to `muffin model`', () => {
    const { home, run } = fresh();
    run('add', 'xai', 'grok-4.7');
    run('add', 'openrouter', 'openrouter/free');
    expect(run('remove', '1')).toBe(2);
    expect(run('remove', 'xai')).toBe(0);
    expect(loadConfig(home).fallbacks?.main?.map((l) => l.model)).toEqual(['openrouter/free']);
    expect(run('remove', '2')).toBe(0);
    expect(loadConfig(home).fallbacks).toBeUndefined();
  });

  it('refuses unknown providers and duplicates without writing', () => {
    const { home, run } = fresh();
    expect(run('add', 'nope', 'x')).toBe(2);
    run('add', 'xai', 'grok-4.7');
    expect(run('add', 'xai', 'grok-4.7')).toBe(0);
    expect(loadConfig(home).fallbacks?.main).toHaveLength(1);
  });

  it('a fallback with no secret yet does not stop the lane from being built', () => {
    const { home, run } = fresh();
    run('add', 'xai', 'grok-4.7');
    writeFileSync(join(home, 'secrets', 'unrelated'), 'x', { mode: 0o600 });
    expect(() => configuredProvider(loadConfig(home), home, undefined, 'main')).not.toThrow();
  });

  it('refuses to guess which of two accounts of one provider to remove', () => {
    const { home, lines, run } = fresh();
    run('add', 'openrouter', 'a/model');
    run('add', 'openrouter', 'b/model', '--account', 'work');
    lines.length = 0;
    expect(run('remove', 'openrouter')).toBe(2);
    expect(lines.join('\n')).toContain('togline uno per posizione (2, 3)');
    expect(loadConfig(home).fallbacks?.main).toHaveLength(2);
  });

  function pausedPrimary(home: string, until: number) {
    const config = loadConfig(home);
    const [primary] = inferenceChain(config, 'main');
    if (primary === undefined) throw new Error('no primary');
    const id = linkId(primary);
    writeLaneChainState(home, 'main', {
      active: id,
      since: until - 60_000,
      cooldowns: { [id]: { until, reason: 'quota', at: until - 60_000, declared: true } },
    });
    return id;
  }

  it('shows the pause with its time zone, and `reset` clears it', () => {
    const { home, lines, run } = fresh();
    run('add', 'xai', 'grok-4.7');
    pausedPrimary(home, Date.now() + 3_600_000);
    lines.length = 0;
    run();
    expect(lines.join('\n')).toMatch(/in pausa: .*riprovo dalle \d\d\/\d\d, \d\d:\d\d \([^)]+\)/);
    expect(describeChain(loadConfig(home), 'main', home).degraded).toBe(true);
    lines.length = 0;
    expect(run('reset')).toBe(0);
    expect(lines.join('\n')).toContain('tolta 1 pausa');
    expect(describeChain(loadConfig(home), 'main', home).degraded).toBe(false);
    expect(run('reset', '--bogus')).toBe(2);
  });

  it('writing a new secret for a paused link lifts its pause, and only that one', () => {
    const { home, run } = fresh();
    // The authoritative write also lands in the persistent store: keep it in the sandbox.
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'));
    run('add', 'xai', 'grok-4.7');
    const config = loadConfig(home);
    const primaryRef = config.provider.apiKeyRef.replace(/^secret:\/\//, '');
    pausedPrimary(home, Date.now() + 3_600_000);
    writeAuthoritativeSecret('xai_api_key', 'synthetic-xai', home);
    expect(describeChain(loadConfig(home), 'main', home).degraded).toBe(true);
    writeAuthoritativeSecret(primaryRef, 'synthetic-new', home);
    expect(readChainState(home).lanes.main?.cooldowns).toEqual({});
    expect(describeChain(loadConfig(home), 'main', home).degraded).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('muffin fallback add xai with the xAI login (ADR-0113)', () => {
  async function loggedIn(home: string) {
    await new XaiOAuthConnection(home).save(
      { accessToken: 'xai-access-canary', refreshToken: 'xai-refresh-canary', expiresIn: 3600 },
      'oauth-device',
    );
  }

  it('uses the login when there is one, the key when --account names it', async () => {
    const { home, lines, run } = fresh();
    await loggedIn(home);
    expect(run('add', 'xai', 'grok-4.7')).toBe(0);
    expect(run('add', 'xai', 'grok-4.6', '--account', 'default')).toBe(0);
    const refs = loadConfig(home).fallbacks?.main?.map((l) => l.provider.apiKeyRef);
    expect(refs).toEqual(['secret://xai_oauth', 'secret://xai_api_key']);
    const text = lines.join('\n');
    expect(text).toContain('credenziale: il tuo login xAI (secret://xai_oauth)');
    expect(text).not.toContain('manca la credenziale: muffin auth login xai\n');
    expect(text).not.toMatch(/canary/);
    lines.length = 0;
    run();
    expect(lines.join('\n')).toContain('2. xAI API (xai_oauth) · grok-4.7');
    expect(lines.join('\n')).not.toMatch(/xai_oauth\) · grok-4.7 — .*credenziale mancante/);
  });

  it('a login xAI refused to refresh counts as a missing credential', async () => {
    const { home, lines, run } = fresh();
    await loggedIn(home);
    run('add', 'xai', 'grok-4.7');
    const file = join(home, 'secrets', 'xai_oauth');
    const store = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...store, lastRefresh: { at: 1, outcome: 'reauth' } }), {
      mode: 0o600,
    });
    lines.length = 0;
    run();
    expect(lines.join('\n')).toContain(
      '2. xAI API (xai_oauth) · grok-4.7 — credenziale mancante → muffin auth login xai',
    );
  });

  it('the chain sends the login access token as the bearer to api.x.ai', async () => {
    const { home, run } = fresh();
    await loggedIn(home);
    run('add', 'xai', 'grok-4.7');
    const config = loadConfig(home);
    // Make the primary fail with an account error so the chain reaches xAI.
    const seen: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(`${request.url} ${request.headers.get('authorization')}`);
      if (!request.url.startsWith('https://api.x.ai/')) {
        return new Response('{"error":{"message":"no credit"}}', { status: 402 });
      }
      return Response.json({
        id: 'r',
        model: 'grok-4.7',
        choices: [{ message: { content: 'ciao' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const provider = configuredProvider(config, home, fetch, 'main');
    const result = await provider.chat({
      model: config.models.main,
      system: [{ type: 'text', text: 's' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 8,
      stream: false,
    });
    expect(result.text).toBe('ciao');
    expect(seen.at(-1)).toBe('https://api.x.ai/v1/chat/completions Bearer xai-access-canary');
  });
});
