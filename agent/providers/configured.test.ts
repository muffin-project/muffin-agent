import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { ChatGPTConnection } from '../../core/config/chatgpt-oauth.js';
import { loadConfig, saveConfig } from '../../core/config/config.js';
import { runTurn } from '../loop.js';
import { buildRuntime } from '../runtime.js';
import { configuredProvider } from './configured.js';
import type { Provider } from './types.js';
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
    it(`retries ${failure} through the production governor without a hidden SSE fallback`, async () => {
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
        if (requests === 2) {
          const response = {
            id: 'resp_retry',
            model: 'gpt-6.1-sol',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'ready' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return new Response(
            `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          );
        }
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
        const retries: unknown[] = [];
        const result = await runTurn(runtime.deps, {
          principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
          tenant: 'host',
          surface: 'cli',
          session: runtime.deps.sessions.open(`failure-${failure}`),
          text: 'Reply with ready.',
          onDelta: () => {},
          signal: AbortSignal.timeout(3000),
          onProgress: (event) => {
            if (event.type === 'model_retry') retries.push(event);
          },
        });
        expect(requests).toBe(2);
        expect(result).toMatchObject({ stopped: 'answered', text: 'ready', iterations: 2 });
        expect(retries).toHaveLength(1);
        expect(runtime.deps.turns?.get(result.turnId)?.counters.transportRetriesLeft).toBe(9);
      } finally {
        runtime?.close();
        vi.unstubAllGlobals();
      }
    });
  }
});

describe('configuredProvider keeps main and light credentials and endpoints independent', () => {
  it('sends each lane through its own production adapter configuration', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-lane-provider-'));
    runInit({ home, provider: 'openai-compat', apiKey: 'unused-synthetic-key' });
    const config = loadConfig(home);
    config.provider = {
      kind: 'openai-compat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'secret://main_key',
      routing: { only: ['main-route'] },
    };
    config.lightProvider = {
      kind: 'openai-compat',
      baseUrl: 'https://light.synthetic.test/v1',
      apiKeyRef: 'secret://light_key',
      reasoningDialect: 'reasoning_effort',
    };
    writeFileSync(join(home, 'secrets', 'main_key'), 'main-canary', { mode: 0o600 });
    writeFileSync(join(home, 'secrets', 'light_key'), 'light-canary', { mode: 0o600 });
    const requests: Array<{
      url: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    const fetch = (async (input: unknown, init?: RequestInit) => {
      const request = new Request(input as string | Request, init);
      requests.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json({
        id: 'synthetic',
        model: 'synthetic-served',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as typeof globalThis.fetch;
    const main = configuredProvider(config, home, fetch, 'main');
    const light = configuredProvider(config, home, fetch, 'light');
    const call = {
      model: 'synthetic-requested',
      system: [{ type: 'text' as const, text: 'system' }],
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
      maxOutputTokens: 8,
      stream: false,
    };

    await main.chat(call);
    await light.chat({ ...call, reasoning: { mode: 'on', effort: 'low' } });

    expect(requests[0]).toMatchObject({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      authorization: 'Bearer main-canary',
      body: { provider: { only: ['main-route'] } },
    });
    expect(requests[0]?.body).not.toHaveProperty('reasoning_effort');
    expect(requests[1]).toMatchObject({
      url: 'https://light.synthetic.test/v1/chat/completions',
      authorization: 'Bearer light-canary',
      body: { reasoning_effort: 'low' },
    });
    expect(requests[1]?.body).not.toHaveProperty('provider');
  });
});

describe('verifyInferenceRoute selects lane-specific model and ChatGPT reasoning policy', () => {
  it('uses the light route and low reasoning even when main thinking is off', async () => {
    const { config, home } = fixture();
    config.models.light = 'gpt-light-synthetic';
    config.thinking = 'off';
    config.lightProvider = { ...config.provider };
    let observed: Parameters<Provider['chat']>[0] | undefined;
    const provider: Provider = {
      kind: 'openai-chatgpt',
      async chat(call) {
        observed = call;
        return {
          text: null,
          toolCalls: [{ id: 'probe', name: 'muffin_probe', args: { nonce: 'light-lane-nonce' } }],
          finishReason: 'tool_calls',
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'gpt-light-synthetic',
        };
      },
    };

    const result = await verifyInferenceRoute({
      config,
      home,
      provider,
      lane: 'light',
      nonce: 'light-lane-nonce',
    });

    expect(result.status).toBe('working');
    expect(result.requestedModel).toBe('gpt-light-synthetic');
    expect(observed?.reasoning).toEqual({ mode: 'on', effort: 'low' });
  });
});
