import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { loadConfig, saveConfig } from '../../core/config/config.js';
import { clearChainPauses, readChainState } from '../../core/config/provider-chain.js';
import { runTurn } from '../loop.js';
import { buildRuntime } from '../runtime.js';
import { configuredProvider } from './configured.js';
import { type ChatCall, ProviderError, type StreamEvent } from './types.js';

/**
 * Review follow-ups for ADR-0110, through the real OpenAI-compatible adapter
 * and `buildRuntime` with a stubbed `fetch`. Synthetic hosts and keys only:
 * no request leaves the process, so this proves wiring, not any account.
 */

const PRIMARY = 'https://primary.synthetic.test/v1';
const FALLBACK = 'https://fallback.synthetic.test/v1';

type Route = (request: Request) => Promise<Response> | Response;

function stubFetch(routes: Record<string, Route>, hits: string[]) {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as string | Request, init);
    for (const [prefix, route] of Object.entries(routes)) {
      if (request.url.startsWith(prefix)) {
        hits.push(prefix);
        return route(request);
      }
    }
    return new Response(null, { status: 404 });
  });
}

function home(lanes: { main?: boolean; light?: boolean } = { main: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-chain-review-'));
  runInit({ home: dir, provider: 'openai-compat', apiKey: 'primary-canary' });
  const config = loadConfig(dir);
  config.provider = {
    kind: 'openai-compat',
    baseUrl: PRIMARY,
    apiKeyRef: 'secret://provider_api_key',
  };
  // The light lane inherits the main connection.
  delete config.lightProvider;
  config.models = { main: 'synthetic/main', light: 'synthetic/light' };
  const fallback = [
    {
      provider: {
        kind: 'openai-compat' as const,
        baseUrl: FALLBACK,
        apiKeyRef: 'secret://fallback_key',
      },
      model: 'synthetic/fallback-model',
    },
  ];
  config.fallbacks = {
    ...(lanes.main ? { main: fallback } : {}),
    ...(lanes.light ? { light: fallback } : {}),
  };
  saveConfig(config, dir);
  writeFileSync(join(dir, 'secrets', 'fallback_key'), 'fallback-canary', { mode: 0o600 });
  return dir;
}

function completion(text: string, model: string) {
  return Response.json({
    id: 'gen',
    model,
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  });
}

function call(overrides: Partial<ChatCall> = {}): ChatCall {
  return {
    model: 'synthetic/main',
    system: [{ type: 'text', text: 'system' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hey muffin' }] }],
    maxOutputTokens: 16,
    stream: false,
    ...overrides,
  };
}

function turn(runtime: ReturnType<typeof buildRuntime>, session: string) {
  return runTurn(runtime.deps, {
    principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
    tenant: 'host',
    surface: 'cli',
    session: runtime.deps.sessions.open(session),
    text: 'Hey muffin',
    signal: AbortSignal.timeout(5000),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ADR-0110 review: real adapters', () => {
  it('B1: an OpenRouter moderation 403 is the answer, not an outage: no switch, no pause', async () => {
    const dir = home();
    const hits: string[] = [];
    stubFetch(
      {
        [PRIMARY]: () =>
          Response.json(
            {
              error: {
                code: 403,
                message: 'Input was flagged by moderation',
                metadata: {
                  reasons: ['harassment'],
                  flagged_input: 'redacted',
                  provider_name: 'x',
                },
              },
            },
            { status: 403 },
          ),
        [FALLBACK]: () => completion('should not answer', 'synthetic/fallback-model'),
      },
      hits,
    );
    const provider = configuredProvider(loadConfig(dir), dir, undefined, 'main', {
      persistChainState: true,
    });
    const failure = await provider.chat(call()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBe(403);
    expect(hits).toEqual([PRIMARY]);
    expect(readChainState(dir).lanes.main?.cooldowns ?? {}).toEqual({});
  });

  it('a stream that fails before its first event switches links through the real adapter', async () => {
    const dir = home();
    const hits: string[] = [];
    const sse = [
      {
        id: 's',
        model: 'synthetic/fallback-model',
        choices: [{ index: 0, delta: { content: 'ciao ' } }],
      },
      {
        id: 's',
        model: 'synthetic/fallback-model',
        choices: [{ index: 0, delta: { content: 'dal ripiego' } }],
      },
      {
        id: 's',
        model: 'synthetic/fallback-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join('');
    stubFetch(
      {
        [PRIMARY]: () => Response.json({ error: { message: 'overloaded' } }, { status: 503 }),
        [FALLBACK]: () =>
          new Response(`${sse}data: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          }),
      },
      hits,
    );
    const provider = configuredProvider(loadConfig(dir), dir, undefined, 'main', {
      persistChainState: true,
    });
    const events: StreamEvent[] = [];
    if (!provider.chatStream) throw new Error('chain must stream');
    for await (const event of provider.chatStream(call({ stream: true }))) events.push(event);
    expect(hits).toEqual([PRIMARY, FALLBACK]);
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('ciao dal ripiego');
    const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>;
    expect(done.result.route).toMatchObject({ index: 1, model: 'synthetic/fallback-model' });
    expect(Object.values(readChainState(dir).lanes.main?.cooldowns ?? {})[0]).toMatchObject({
      reason: 'outage',
    });
  });
});

describe('ADR-0110 review: production runtime', () => {
  it('light lane: falls through and bills the serving model', async () => {
    const dir = home({ light: true });
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-chain-review-ws-'));
    const hits: string[] = [];
    stubFetch(
      {
        [PRIMARY]: () => Response.json({ error: { message: 'no credit' } }, { status: 402 }),
        [FALLBACK]: () => completion('{}', 'synthetic/fallback-model'),
      },
      hits,
    );
    const runtime = buildRuntime(dir, workspace);
    try {
      const before = runtime.budget.monthToDateUsd();
      const result = await runtime.light.provider.chat(call({ model: runtime.light.model }));
      expect(hits).toEqual([PRIMARY, FALLBACK]);
      expect(result.route).toMatchObject({ index: 1, model: 'synthetic/fallback-model' });
      expect(runtime.budget.monthToDateUsd()).toBeGreaterThan(before);
      expect(readChainState(dir).lanes.light?.active).toContain(FALLBACK);
      expect(readChainState(dir).lanes.main).toBeUndefined();
    } finally {
      runtime.close();
    }
  });

  it('a saved pause survives a restart, and `fallback reset` reaches a running process', async () => {
    const dir = home();
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-chain-review-ws-'));
    const hits: string[] = [];
    let primaryDown = true;
    stubFetch(
      {
        [PRIMARY]: () =>
          primaryDown
            ? Response.json({ error: { message: 'quota' } }, { status: 402 })
            : completion('ciao dal principale', 'synthetic/main'),
        [FALLBACK]: () => completion('ciao dal ripiego', 'synthetic/fallback-model'),
      },
      hits,
    );
    const first = buildRuntime(dir, workspace);
    try {
      expect(await turn(first, 's1')).toMatchObject({ text: 'ciao dal ripiego' });
    } finally {
      first.close();
    }
    expect(hits.slice(0, 2)).toEqual([PRIMARY, FALLBACK]);

    hits.length = 0;
    const second = buildRuntime(dir, workspace);
    try {
      expect(await turn(second, 's2')).toMatchObject({ text: 'ciao dal ripiego' });
      expect(hits).not.toContain(PRIMARY);

      // The account was topped up and the owner ran `muffin fallback reset`
      // in another terminal: the running process must not wait 15 minutes.
      primaryDown = false;
      expect(clearChainPauses(dir)).toBe(1);
      hits.length = 0;
      expect(await turn(second, 's3')).toMatchObject({ text: 'ciao dal principale' });
      expect(hits[0]).toBe(PRIMARY);
      expect(hits).not.toContain(FALLBACK);
    } finally {
      second.close();
    }
  });

  it('adding a fallback to a running process takes effect on the next turn', async () => {
    const dir = home({});
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-chain-review-ws-'));
    const hits: string[] = [];
    stubFetch(
      {
        [PRIMARY]: () => Response.json({ error: { message: 'quota' } }, { status: 402 }),
        [FALLBACK]: () => completion('ciao dal ripiego', 'synthetic/fallback-model'),
      },
      hits,
    );
    const runtime = buildRuntime(dir, workspace);
    try {
      const before = await turn(runtime, 'r1');
      expect(before).not.toMatchObject({ text: 'ciao dal ripiego' });
      expect(hits).not.toContain(FALLBACK);

      const config = loadConfig(dir);
      config.fallbacks = {
        main: [
          {
            provider: {
              kind: 'openai-compat',
              baseUrl: FALLBACK,
              apiKeyRef: 'secret://fallback_key',
            },
            model: 'synthetic/fallback-model',
          },
        ],
      };
      saveConfig(config, dir);
      hits.length = 0;
      expect(await turn(runtime, 'r2')).toMatchObject({ text: 'ciao dal ripiego' });
      expect(hits).toEqual([PRIMARY, FALLBACK]);
    } finally {
      runtime.close();
    }
  });
});
