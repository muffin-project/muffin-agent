import { describe, expect, it } from 'vitest';
import type { LaneChainState } from '../../core/config/provider-chain.js';
import { ActivityAllowanceError } from './activity-allowance.js';
import { type ChainLink, DEFAULT_COOLDOWN_MS, failoverReason, providerChain } from './chain.js';
import {
  type ChatCall,
  type ChatResult,
  type Provider,
  ProviderError,
  type StreamEvent,
} from './types.js';

/**
 * Fixtures only: every provider here is a synthetic in-memory adapter. No
 * request leaves the process, so these prove the chain's decisions, not that
 * any real account answers.
 */

const NOW = Date.parse('2026-11-25T14:00:00Z');

function call(overrides: Partial<ChatCall> = {}): ChatCall {
  return {
    model: 'primary-model',
    system: [{ type: 'text', text: 'system' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hey muffin' }] }],
    maxOutputTokens: 16,
    stream: false,
    ...overrides,
  };
}

function answer(model: string, text = 'ciao'): ChatResult {
  return {
    text,
    toolCalls: [],
    stopReason: 'end',
    usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model,
  };
}

type Script = Array<ChatResult | Error>;

function scripted(kind: Provider['kind'], script: Script) {
  const seen: ChatCall[] = [];
  const provider: Provider = {
    kind,
    async chat(c) {
      seen.push(c);
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { provider, seen };
}

function link(id: string, provider: Provider, model?: string): ChainLink {
  return {
    id,
    label: id,
    kind: provider.kind,
    baseUrl: `https://${id}.synthetic.test/v1`,
    ...(model === undefined ? {} : { model }),
    create: () => provider,
  };
}

const planLimit = (retryAt?: number) =>
  new ProviderError(
    'ChatGPT plan usage limit exceeded',
    false,
    429,
    'transport',
    undefined,
    false,
    { quota: 'chatgpt-plan', ...(retryAt === undefined ? {} : { retryAt }) },
  );

describe('failoverReason: account and service failures move on, request failures do not', () => {
  it.each([
    [planLimit(), 'quota'],
    [new ProviderError('x', false, 402), 'quota'],
    [new ProviderError('x', false, 401), 'auth'],
    [new ProviderError('x', false, 403), 'auth'],
    [
      new ProviderError('x', false, undefined, 'transport', undefined, false, {
        reauthentication: 'chatgpt',
      }),
      'auth',
    ],
    [
      new ProviderError('x', false, undefined, 'transport', undefined, false, {
        credentials: 'unavailable',
      }),
      'auth',
    ],
    [new ProviderError('x', true, 429), 'rate_limit'],
    [new ProviderError('x', true, 503), 'outage'],
    [new ProviderError('x', true, 500), 'outage'],
    [new ProviderError('connection reset', true), 'outage'],
  ] as const)('%s → %s', (error, reason) => {
    expect(failoverReason(error)).toBe(reason);
  });

  it.each([
    ['bad request', new ProviderError('x', false, 400)],
    ['model not found', new ProviderError('x', false, 404)],
    ['unprocessable', new ProviderError('x', false, 422)],
    ['unparseable tool arguments', new ProviderError('x', true, undefined, 'output')],
    ['local abort', new ProviderError('aborted', false)],
    ['activity allowance', new ActivityAllowanceError('model')],
    ['plain bug', new TypeError('undefined is not a function')],
  ])('%s is rethrown, not failed over', (_name, error) => {
    expect(failoverReason(error)).toBeNull();
  });
});

describe('provider chain', () => {
  it('a single link is the bare adapter, with no wrapper in between', () => {
    const only = scripted('openai-compat', []).provider;
    expect(providerChain([link('only', only)], { lane: 'main' })).toBe(only);
  });

  it('a plan usage limit on link 1 falls through to link 2 within the same call', async () => {
    const reset = NOW + 2 * 24 * 60 * 60_000;
    const primary = scripted('openai-chatgpt', [planLimit(reset)]);
    const second = scripted('openai-compat', [answer('grok-served')]);
    const states: LaneChainState[] = [];
    const events: string[] = [];
    const chain = providerChain(
      [link('chatgpt', primary.provider), link('xai', second.provider, 'grok-model')],
      {
        lane: 'main',
        now: () => NOW,
        onState: (s) => states.push(s),
        onFailover: (e) => events.push(`${e.from.id}->${e.to?.id}:${e.reason}`),
      },
    );

    const result = await chain.chat(call());

    expect(result.text).toBe('ciao');
    expect(primary.seen[0]?.model).toBe('primary-model');
    expect(second.seen[0]?.model).toBe('grok-model');
    expect(result.route).toMatchObject({
      kind: 'openai-compat',
      model: 'grok-model',
      index: 1,
      baseUrl: 'https://xai.synthetic.test/v1',
    });
    expect(events).toEqual(['chatgpt->xai:quota']);
    const last = states.at(-1)!;
    expect(last.active).toBe('xai');
    // The reset the provider declared is the cooldown, capped at one day.
    expect(last.cooldowns.chatgpt).toMatchObject({ reason: 'quota', declared: true });
    expect(last.cooldowns.chatgpt?.until).toBe(NOW + 24 * 60 * 60_000);
  });

  it('skips a cooling link on the next call and returns to it once the cooldown ends', async () => {
    let now = NOW;
    const primary = scripted('openai-chatgpt', [planLimit(), answer('primary-served')]);
    const second = scripted('openai-compat', [answer('a'), answer('b')]);
    const states: LaneChainState[] = [];
    const chain = providerChain(
      [link('chatgpt', primary.provider), link('openrouter', second.provider, 'free-model')],
      { lane: 'main', now: () => now, onState: (s) => states.push(s) },
    );

    await chain.chat(call());
    await chain.chat(call());
    expect(primary.seen).toHaveLength(1); // second call went straight to link 2
    expect(second.seen).toHaveLength(2);

    now += DEFAULT_COOLDOWN_MS.quota + 1;
    const back = await chain.chat(call());
    expect(back.route?.index).toBe(0);
    expect(primary.seen).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ active: 'chatgpt', cooldowns: {} });
  });

  it('a Retry-After on a rate limit becomes the declared cooldown', async () => {
    const primary = scripted('openai-compat', [
      new ProviderError('rate limited', true, 429, 'transport', 90_000),
    ]);
    const second = scripted('openai-compat', [answer('b')]);
    const states: LaneChainState[] = [];
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'light',
      now: () => NOW,
      onState: (s) => states.push(s),
    });
    await chain.chat(call());
    expect(states.at(-1)?.cooldowns.a).toEqual({
      until: NOW + 90_000,
      reason: 'rate_limit',
      at: NOW,
      declared: true,
    });
  });

  it('a content error is the request, not the account: rethrown, no other link called', async () => {
    const bad = new ProviderError('400 invalid tool schema', false, 400);
    const primary = scripted('openai-compat', [bad]);
    const second = scripted('openai-compat', [answer('never')]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    await expect(chain.chat(call())).rejects.toBe(bad);
    expect(second.seen).toHaveLength(0);
  });

  it('when every link refuses, the primary error is the one the caller sees', async () => {
    const first = planLimit();
    const primary = scripted('openai-chatgpt', [first]);
    const second = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    await expect(chain.chat(call())).rejects.toBe(first);
  });

  it('all links cooling: still tries them in priority order instead of refusing', async () => {
    const primary = scripted('openai-chatgpt', [planLimit(), answer('primary')]);
    const second = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    await expect(chain.chat(call())).rejects.toBeInstanceOf(ProviderError);
    const result = await chain.chat(call());
    expect(result.route?.index).toBe(0);
  });

  it('an abort is never failed over', async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const second = scripted('openai-compat', [answer('never')]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
    });
    await expect(chain.chat(call({ signal: controller.signal }))).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(second.seen).toHaveLength(0);
  });

  it('a link whose credential is missing is built lazily and fails over as signed out', async () => {
    const second = scripted('openai-compat', [answer('ok')]);
    const events: string[] = [];
    const chain = providerChain(
      [
        {
          id: 'missing',
          label: 'missing',
          kind: 'openai-compat',
          create: () => {
            throw new Error('no secret at secrets/xai_api_key');
          },
        },
        link('b', second.provider, 'm'),
      ],
      { lane: 'main', now: () => NOW, onFailover: (e) => events.push(e.reason) },
    );
    const result = await chain.chat(call());
    expect(result.route?.index).toBe(1);
    expect(events).toEqual(['auth']);
  });

  it('honours a cooldown persisted by a previous process', async () => {
    const primary = scripted('openai-chatgpt', [answer('never')]);
    const second = scripted('openai-compat', [answer('b')]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
      initial: {
        active: 'b',
        since: NOW - 1000,
        cooldowns: { a: { until: NOW + 60_000, reason: 'quota', at: NOW - 1000, declared: true } },
      },
    });
    const result = await chain.chat(call());
    expect(result.route?.index).toBe(1);
    expect(primary.seen).toHaveLength(0);
  });

  it('reasoning continuations reach only the link that produced them', async () => {
    const primary = scripted('openai-chatgpt', [planLimit()]);
    const second = scripted('openai-compat', [answer('b')]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    await chain.chat(
      call({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'one' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'two' }],
            providerMetadata: { reasoning: { provider: 'openai-chatgpt', details: ['enc'] } },
          },
          { role: 'user', content: [{ type: 'text', text: 'three' }] },
        ],
      }),
    );
    // Link 1 (no tag = produced before the chain) keeps its reasoning; link 2 does not see it.
    expect(primary.seen[0]?.messages[1]?.providerMetadata?.reasoning).toBeDefined();
    expect(second.seen[0]?.messages[1]?.providerMetadata).toBeUndefined();
    expect(second.seen[0]?.messages[1]?.content).toEqual([{ type: 'text', text: 'two' }]);
  });

  it('stream: fails over before the first event, never after bytes reached the caller', async () => {
    const failing = (afterDelta: boolean): Provider => ({
      kind: 'openai-compat',
      chat: async () => {
        throw new Error('unused');
      },
      async *chatStream(): AsyncIterable<StreamEvent> {
        if (afterDelta) yield { type: 'text_delta', text: 'half' };
        throw new ProviderError('503', true, 503);
      },
    });
    const second = scripted('openai-compat', [answer('m', 'whole'), answer('m', 'unused')]);

    const early = providerChain([link('a', failing(false)), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    const events: StreamEvent[] = [];
    for await (const e of early.chatStream!(call({ stream: true }))) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'done', result: { text: 'whole' } });

    const late = providerChain([link('a', failing(true)), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of late.chatStream!(call({ stream: true }))) seen.push(e);
      })(),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(seen).toEqual([{ type: 'text_delta', text: 'half' }]);
    expect(second.seen).toHaveLength(1);
  });
});
