import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describeChain } from '../../cli/fallback.js';
import { runInit } from '../../cli/init.js';
import { loadConfig, saveConfig } from '../../core/config/config.js';
import { readChainState } from '../../core/config/provider-chain.js';
import { runTurn } from '../loop.js';
import { buildRuntime } from '../runtime.js';

/**
 * Production wiring of the provider chain (ADR-0110), with fixtures on the
 * wire: the real ChatGPT and OpenAI-compatible adapters, `buildRuntime`, the
 * loop and the budget engine, but a stubbed `fetch`. No real account is
 * contacted — this proves the wiring, not that any provider answers.
 */

const FALLBACK = 'https://fallback.synthetic.test/v1';

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-chain-runtime-'));
  runInit({ home: dir, provider: 'openai-compat', apiKey: 'unused-synthetic-key' });
  const config = loadConfig(dir);
  config.provider = {
    kind: 'openai-chatgpt',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyRef: 'secret://chatgpt',
  };
  config.models = { main: 'gpt-6.2-sol', light: config.models.light };
  config.fallbacks = {
    main: [
      {
        provider: { kind: 'openai-compat', baseUrl: FALLBACK, apiKeyRef: 'secret://fallback_key' },
        model: 'synthetic/fallback-model',
      },
    ],
  };
  saveConfig(config, dir);
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'secrets', 'fallback_key'), 'fallback-canary', { mode: 0o600 });
  writeFileSync(
    join(dir, 'secrets', 'chatgpt'),
    JSON.stringify({
      version: 1,
      hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      activeProfileId: 'profile-test',
      profiles: [
        {
          id: 'profile-test',
          clientId: 'oaiapp_test',
          subject: 'synthetic-subject',
          tokens: {
            tokenType: 'Bearer',
            accessToken: 'oauth-access-canary',
            refreshToken: 'refresh-canary',
            idToken: 'verified-before-storage',
            scopes: ['chatgpt.tokens.use.direct', 'offline_access', 'resource.invoke'],
            expiresAt: Date.now() + 3600000,
            pendingIdentity: false,
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  return dir;
}

describe('provider chain in the production runtime', () => {
  it('a ChatGPT plan usage limit falls through to the next link, billed as that link', async () => {
    const dir = home();
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-chain-ws-'));
    const hits: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const request = new Request(input as string | Request, init);
      const url = request.url;
      if (url === 'https://api.openai.com/v1/models')
        return Response.json({
          models: [
            {
              slug: 'gpt-6.2-sol',
              display_name: 'Sol',
              visibility: 'list',
              supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
              default_reasoning_level: 'low',
            },
          ],
        });
      if (url.startsWith('https://api.openai.com/v1/responses')) {
        hits.push('chatgpt');
        return Response.json(
          {
            error: {
              code: 'subscription_sharing_usage_limit_exceeded',
              message: 'usage limit',
              resets_in_seconds: 7200,
            },
          },
          { status: 429 },
        );
      }
      if (url.startsWith(`${FALLBACK}/chat/completions`)) {
        hits.push('fallback');
        expect(request.headers.get('authorization')).toBe('Bearer fallback-canary');
        const body = (await request.json()) as { model: string };
        expect(body.model).toBe('synthetic/fallback-model');
        return Response.json({
          id: 'gen-fallback',
          model: 'synthetic/fallback-model',
          choices: [{ message: { content: 'ciao dal ripiego' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        });
      }
      return new Response(null, { status: 404 });
    });
    let runtime: ReturnType<typeof buildRuntime> | undefined;
    try {
      runtime = buildRuntime(dir, workspace);
      const before = runtime.budget.monthToDateUsd();
      const result = await runTurn(runtime.deps, {
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        surface: 'cli',
        session: runtime.deps.sessions.open('chain-usage-limit'),
        text: 'Hey muffin',
        signal: AbortSignal.timeout(5000),
      });
      expect(result).toMatchObject({ stopped: 'answered', text: 'ciao dal ripiego' });
      expect(hits.slice(0, 2)).toEqual(['chatgpt', 'fallback']);
      // A ChatGPT lane bills $0; the fallback is a metered endpoint and must not.
      expect(runtime.budget.monthToDateUsd()).toBeGreaterThan(before);

      const lane = readChainState(dir).lanes.main;
      expect(lane?.active).toContain(FALLBACK);
      const cooldown = Object.values(lane?.cooldowns ?? {})[0];
      expect(cooldown).toMatchObject({ reason: 'quota', declared: true });
      if (cooldown === undefined) throw new Error('no cooldown recorded');
      // The provider's reset (2 h), not the 15-minute default; ms of clock skew allowed.
      expect(Math.abs(cooldown.until - cooldown.at - 7_200_000)).toBeLessThan(1000);

      const shown = describeChain(loadConfig(dir), 'main', dir);
      expect(shown.degraded).toBe(true);
      expect(shown.lines[0]).toContain('in pausa: quota/piano esaurito');
      expect(shown.lines[1]).toContain('ha risposto per ultimo');
      expect(JSON.stringify(readChainState(dir))).not.toContain('canary');

      // Second turn: the cooling primary is skipped, no extra round trip.
      hits.length = 0;
      await runTurn(runtime.deps, {
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        surface: 'cli',
        session: runtime.deps.sessions.open('chain-usage-limit-2'),
        text: 'Ancora?',
        signal: AbortSignal.timeout(5000),
      });
      expect(hits).not.toContain('chatgpt');

      // S4: after a restart, status still reads the persisted pause — and an
      // expired one stops being reported as degraded.
      runtime.close();
      runtime = undefined;
      const restarted = describeChain(loadConfig(dir), 'main', dir);
      expect(restarted.degraded).toBe(true);
      const expired = describeChain(loadConfig(dir), 'main', dir, cooldown.until + 1);
      expect(expired.degraded).toBe(false);
      expect(expired.lines[0]).not.toContain('in pausa');
    } finally {
      runtime?.close();
      vi.unstubAllGlobals();
    }
  });
});
