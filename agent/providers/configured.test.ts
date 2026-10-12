import { buildRuntime } from '../runtime.js';
import { runTurn } from '../loop.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { loadConfig, saveConfig } from '../../core/config/config.js';
import { ChatGPTConnection } from '../../core/config/chatgpt-oauth.js';
import { configuredProvider } from './configured.js';
import { verifyInferenceRoute } from './verify.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'muffin-chatgpt-wiring-'));
  runInit({ home, provider: 'openai-compat', apiKey: 'unused-synthetic-key' });
  const config = loadConfig(home);
  config.provider = {
    kind: 'openai-chatgpt',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyRef: 'secret://chatgpt',
  };
  config.models = { main: 'gpt-6.1-sol', light: 'gpt-6.1-sol' };
  mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, 'secrets', 'chatgpt'),
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
  return { home, config };
}

function wire(nonce: string) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    const req = new Request(_input as string | Request, init);
    expect(req.headers.get('authorization')).toBe('Bearer oauth-access-canary');
    if (req.url === 'https://api.openai.com/v1/models')
      return Response.json({
        models: [
          {
            slug: 'gpt-6.1-sol',
            display_name: 'Sol',
            visibility: 'list',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'medium' },
              { effort: 'high' },
            ],
            default_reasoning_level: 'low',
          },
        ],
      });
    const request = (await req.json()) as Record<string, unknown>;
    requests.push(request);
    const response = {
      id: 'resp_test',
      status: 'completed',
      model: 'gpt-6.1-sol',
      output: [
        {
          type: 'function_call',
          namespace: 'muffin',
          name: 'muffin_probe',
          call_id: 'call_test',
          arguments: JSON.stringify({ nonce }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    };
    return new Response(
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe('configured production provider and online verifier share ChatGPT route', () => {
  it('uses protected OAuth connection and Responses wire, rather than Chat Completions', async () => {
    const { config, home } = fixture();
    const h = wire('synthetic123');
    expect(await new ChatGPTConnection(home).accessToken()).toBe('oauth-access-canary');
    const provider = configuredProvider(config, home, h.fetch);
    expect(provider.kind).toBe('openai-chatgpt');
    const result = await verifyInferenceRoute({
      config,
      home,
      fetch: h.fetch,
      nonce: 'synthetic123',
    });
    expect(result.status, result.diagnostic).toBe('working');
    expect(result.resolvedModel).toBe(config.models.main);
    expect(h.requests[0]).toMatchObject({
      model: 'gpt-6.1-sol',
      stream: true,
      store: false,
      tool_choice: 'required',
    });
    expect(JSON.stringify(result)).not.toContain('canary');
    const disabled = await verifyInferenceRoute({
      config: { ...config, thinking: 'off' },
      home,
      fetch: h.fetch,
      nonce: 'synthetic123',
    });
    expect(disabled.status).not.toBe('working');
    expect(h.requests).toHaveLength(1);
    const light = await verifyInferenceRoute({
      config,
      home,
      fetch: h.fetch,
      nonce: 'synthetic123',
      thinking: 'low',
    });
    expect(light.status, light.diagnostic).toBe('working');
    expect(h.requests[1]).toMatchObject({ reasoning: { effort: 'low' } });
  });
  for (const failure of ['before-first-event', 'truncated-stream']) {
    it(`does not invoke a second SSE request through the production loop on ${failure}`, async () => {
      const { config, home } = fixture();
      saveConfig(config, home);
      const workspace = mkdtempSync(join(tmpdir(), 'muffin-chatgpt-runtime-ws-'));
      let requests = 0;
      vi.stubGlobal('fetch', async (input: unknown) => {
        if (String(input) === 'https://api.openai.com/v1/models')
          return Response.json({
            models: [
              {
                slug: 'gpt-6.1-sol',
                display_name: 'Sol',
                visibility: 'list',
                supported_reasoning_levels: [
                  { effort: 'low' },
                  { effort: 'medium' },
                  { effort: 'high' },
                ],
                default_reasoning_level: 'low',
              },
            ],
          });
        if (!String(input).startsWith('https://api.openai.com/v1/responses'))
          return new Response(null, { status: 503 });
        requests += 1;
        if (failure === 'before-first-event') throw new Error('synthetic transport loss');
        return new Response(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      let runtime: ReturnType<typeof buildRuntime> | undefined;
      try {
        runtime = buildRuntime(home, workspace);
        expect(runtime.deps.provider.kind).toBe('openai-chatgpt');
        runtime.deps.recordSpend?.({
          model: 'gpt-6.1-sol',
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          tenant: 'host',
          capability: 'llm.chat',
        });
        expect(runtime.budget.monthToDateUsd()).toBe(0);
        const rows = runtime.db.prepare('SELECT input_tokens, output_tokens FROM spend').all();
        expect(rows).toContainEqual({ input_tokens: 50, output_tokens: 20 });
        await runTurn(runtime.deps, {
          principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
          tenant: 'host',
          surface: 'cli',
          session: runtime.deps.sessions.open(`failure-${failure}`),
          text: 'Reply with ready.',
          onDelta: () => {},
          signal: AbortSignal.timeout(3000),
        }).catch(() => undefined);
        expect(requests).toBe(1);
      } finally {
        runtime?.close();
        vi.unstubAllGlobals();
      }
    });
  }
});
