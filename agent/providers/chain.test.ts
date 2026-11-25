import { describe, expect, it } from 'vitest';
import type { LaneChainState } from '../../core/config/provider-chain.js';
import { extractFacts } from '../../core/memory/extract.js';
import { judgeContradiction } from '../../core/memory/judge.js';
import { LlmReranker, RERANK_MIN_CANDIDATES } from '../../core/memory/rerank.js';
import type { Fact } from '../../core/memory/store.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import { ActivityAllowanceError, activityProvider } from './activity-allowance.js';
import { type ChainLink, DEFAULT_COOLDOWN_MS, failoverReason, providerChain } from './chain.js';
import { type LightSpend, lightLane } from './light-lane.js';
import { ReasoningConfigurationError } from './reasoning.js';
import {
  type ChatCall,
  type ChatResult,
  type Provider,
  ProviderError,
  ProviderStreamError,
  type StreamEvent,
} from './types.js';

/**
 * Fixtures only: every provider here is a synthetic in-memory adapter. No
 * request leaves the process, so these prove the chain's decisions, not that
 * any real account answers.
 */

function fail(): never {
  throw new Error('chain must stream');
}

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
    [
      new ProviderError('connection reset', true, undefined, 'transport', undefined, false, {
        connection: true,
      }),
      'outage',
    ],
    [
      new ProviderError('0 Connection error.', false, 0, 'transport', undefined, false, {
        connection: true,
      }),
      'outage',
    ],
  ] as const)('%s → %s', (error, reason) => {
    expect(failoverReason(error)).toBe(reason);
  });

  it.each([
    ['bad request', new ProviderError('x', false, 400)],
    // OpenRouter: 403 = guardrail block or moderation flag on the input.
    ['moderation / guardrail 403', new ProviderError('403 Input flagged', false, 403)],
    ['request conflict 409', new ProviderError('x', true, 409)],
    ['code-less retryable error (local bug wrapped)', new ProviderError('boom', true)],
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
    const last = states.at(-1);
    if (last === undefined) throw new Error('no state published');
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
    const second = scripted('openai-compat', [new ProviderError('bad key', false, 401)]);
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
    for await (const e of (early.chatStream?.bind(early) ?? fail)(call({ stream: true })))
      events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'done', result: { text: 'whole' } });

    const late = providerChain([link('a', failing(true)), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of (late.chatStream?.bind(late) ?? fail)(call({ stream: true })))
          seen.push(e);
      })(),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(seen).toEqual([{ type: 'text_delta', text: 'half' }]);
    expect(second.seen).toHaveLength(1);
  });
});

describe('provider chain: review follow-ups', () => {
  it('signed thinking blocks reach only the link that produced them (S1)', async () => {
    const primary = scripted('anthropic', [answer('a-served'), planLimit()]);
    const second = scripted('anthropic', [answer('b-served')]);
    const chain = providerChain(
      [link('account-a', primary.provider), link('account-b', second.provider, 'm')],
      { lane: 'main', now: () => NOW },
    );
    const first = await chain.chat(call());
    // The loop echoes the assistant turn with its signed thinking block and
    // the result's metadata, which the chain tagged with link A.
    const echoed = {
      role: 'assistant' as const,
      content: [
        { type: 'thinking' as const, thinking: 'hm', signature: 'sig-from-account-a' },
        { type: 'text' as const, text: 'ciao' },
      ],
      ...(first.providerMetadata === undefined ? {} : { providerMetadata: first.providerMetadata }),
    };
    expect(first.providerMetadata?.link).toBe('account-a');
    await chain.chat(
      call({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'one' }] },
          echoed,
          { role: 'user', content: [{ type: 'text', text: 'two' }] },
        ],
      }),
    );
    expect(primary.seen[1]?.messages[1]?.content[0]).toMatchObject({ type: 'thinking' });
    expect(second.seen[0]?.messages[1]?.content).toEqual([{ type: 'text', text: 'ciao' }]);
    expect(JSON.stringify(second.seen[0])).not.toContain('sig-from-account-a');
  });

  it('reports the kind of the link that will serve next, so callers shape for it (S2)', async () => {
    const compat = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const chatgpt = scripted('openai-chatgpt', [answer('x')]);
    const chain = providerChain([link('a', compat.provider), link('b', chatgpt.provider, 'm')], {
      lane: 'light',
      now: () => NOW,
    });
    expect(chain.kind).toBe('openai-compat');
    await chain.chat(call());
    expect(chain.kind).toBe('openai-chatgpt');
  });

  it('a fallback that cannot honour the reasoning request gets none, instead of failing (S2)', async () => {
    const compat = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const seen: ChatCall[] = [];
    const chatgpt: Provider = {
      kind: 'openai-chatgpt',
      resolveReasoning: (c) => ({
        status: c.thinking === 'off' ? 'unsupported' : 'applied',
        capabilitySource: 'static-snapshot',
      }),
      async chat(c) {
        seen.push(c);
        return answer('x');
      },
    };
    const chain = providerChain([link('a', compat.provider), link('b', chatgpt, 'm')], {
      lane: 'light',
      now: () => NOW,
    });
    await chain.chat(call({ thinking: 'off' }));
    expect(seen[0]).not.toHaveProperty('thinking');
    expect(seen[0]).not.toHaveProperty('reasoning');
  });

  it('a fallback refusing the request keeps the primary error visible and records it (S3)', async () => {
    const quota = planLimit();
    const primary = scripted('openai-chatgpt', [quota]);
    const typo = new ProviderError('404 model not found', false, 404);
    const second = scripted('openai-compat', [typo]);
    const states: LaneChainState[] = [];
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
      onState: (s) => states.push(s),
    });
    await expect(chain.chat(call())).rejects.toBe(quota);
    expect(states.at(-1)?.lastFallbackError).toEqual({
      link: 'b',
      at: NOW,
      status: 404,
      kind: 'ProviderError',
    });
  });

  it('a pause cleared by another process is picked up on the next call (S5)', async () => {
    let fresh: LaneChainState | undefined;
    const primary = scripted('openai-chatgpt', [planLimit(NOW + 3_600_000), answer('back')]);
    const second = scripted('openai-compat', [answer('b')]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
      refresh: () => {
        const value = fresh;
        fresh = undefined;
        return value;
      },
    });
    await chain.chat(call());
    fresh = { active: 'b', since: NOW, cooldowns: {} }; // `muffin fallback reset`
    const result = await chain.chat(call());
    expect(result.route?.index).toBe(0);
  });
});

describe('memory lanes on a chain shape the request for the serving link (S2)', () => {
  it('judge, extract and rerank ask ChatGPT for low reasoning when the compat primary is paused', async () => {
    const compat = scripted('openai-compat', []);
    const chatgpt = scripted('openai-chatgpt', [
      answer('m', '{"verdict":"coexist","reason":"x"}'),
      answer('m', '{"facts":[]}'),
      answer('m', '[0]'),
    ]);
    const chain = providerChain([link('a', compat.provider), link('b', chatgpt.provider, 'm')], {
      lane: 'light',
      now: () => NOW,
      initial: {
        active: 'b',
        since: NOW - 1000,
        cooldowns: { a: { until: NOW + 60_000, reason: 'quota', at: NOW - 1000, declared: true } },
      },
    });
    const existing = {
      id: 1,
      subjectId: 1,
      subjectName: 'Giusto',
      predicate: 'vive_a',
      objectValue: 'Roma',
      objectId: null,
      objectName: null,
      validFrom: null,
      validTo: null,
      recordedAt: '2026-11-01T00:00:00Z',
      expiredAt: null,
      episodeId: 1,
      trustTier: 0,
      confidence: 1,
      origin: 'said',
      importance: 0,
      supersededBy: null,
    } as unknown as Fact;
    await judgeContradiction(chain, 'primary-model', {
      subject: 'Giusto',
      predicate: 'vive_a',
      existing,
      incoming: { object: 'Milano', validFrom: null },
    }).catch(() => undefined);
    await extractFacts(chain, 'primary-model', {
      content: 'ciao',
      speakerName: 'Giusto',
      trustTier: 0,
    }).catch(() => undefined);
    const candidates = Array.from({ length: RERANK_MIN_CANDIDATES }, (_, i) => ({
      kind: 'episode' as const,
      id: i,
      text: `frammento ${i}`,
      trustTier: 0 as const,
      source: 'test',
      score: 1,
    }));
    await new LlmReranker(chain, 'primary-model').rerank('dove vivo?', candidates, 3);

    expect(compat.seen).toHaveLength(0);
    expect(chatgpt.seen).toHaveLength(3);
    for (const sent of chatgpt.seen) {
      expect(sent.reasoning).toEqual({ mode: 'on', effort: 'low' });
      expect(sent).not.toHaveProperty('thinking');
      expect(sent.model).toBe('m');
    }
  });
});

describe('provider chain: second review (masking only refusals)', () => {
  const cases: Array<[string, () => Error]> = [
    [
      'malformed output (profile recovery cascade)',
      () => new ProviderError('malformed tool arguments', true, undefined, 'output'),
    ],
    [
      'a retryable transport failure without a failover status',
      () => new ProviderError('in-band error', true),
    ],
    [
      'non-retryable malformed output (unexpected tool name)',
      () => new ProviderError('unexpected function name x', false, undefined, 'output'),
    ],
    ['activity allowance', () => new ActivityAllowanceError('model')],
  ];
  for (const [name, make] of cases) {
    it(`a fallback's ${name} reaches the caller as itself, not as the primary's refusal`, async () => {
      const quota = planLimit();
      const own = make();
      const primary = scripted('openai-chatgpt', [quota]);
      const second = scripted('openai-compat', [own]);
      const states: LaneChainState[] = [];
      const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
        lane: 'main',
        now: () => NOW,
        onState: (s) => states.push(s),
      });
      await expect(chain.chat(call())).rejects.toBe(own);
      expect(states.at(-1)?.lastFallbackError).toBeUndefined();
      expect(states.at(-1)?.cooldowns.a).toBeDefined();
    });
  }

  it("a fallback's stream that broke before its first event goes to the loop's non-stream retry", async () => {
    const quota = planLimit();
    const broken = new ProviderStreamError('stream ended before any event', false);
    const primary: Provider = {
      kind: 'openai-chatgpt',
      chat: fail,
      // biome-ignore lint/correctness/useYield: throws before the first event
      async *chatStream() {
        throw quota;
      },
    };
    const second: Provider = {
      kind: 'openai-compat',
      chat: fail,
      // biome-ignore lint/correctness/useYield: throws before the first event
      async *chatStream() {
        throw broken;
      },
    };
    const chain = providerChain([link('a', primary), link('b', second, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    const drain = async () => {
      for await (const _ of (chain.chatStream?.bind(chain) ?? fail)(call({ stream: true }))) {
        // nothing arrives
      }
    };
    await expect(drain()).rejects.toBe(broken);
  });

  it('the light lane and the allowance wrapper report the serving link kind (S2)', async () => {
    const compat = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const chatgpt = scripted('openai-chatgpt', [answer('x')]);
    const chain = providerChain([link('a', compat.provider), link('b', chatgpt.provider, 'm')], {
      lane: 'light',
      now: () => NOW,
    });
    const light = lightLane(chain, { profile: CONSERVATIVE });
    const main = activityProvider(chain);
    expect([light.kind, main.kind]).toEqual(['openai-compat', 'openai-compat']);
    await chain.chat(call());
    expect([light.kind, main.kind]).toEqual(['openai-chatgpt', 'openai-chatgpt']);
  });

  it('the light lane bills the model the fallback route served when the reply names none', async () => {
    const compat = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const second = scripted('openai-compat', [answer('')]);
    const chain = providerChain(
      [link('a', compat.provider), link('b', second.provider, 'fallback-model')],
      { lane: 'light', now: () => NOW },
    );
    const spent: LightSpend[] = [];
    await lightLane(chain, { profile: CONSERVATIVE, record: (e) => spent.push(e) }).chat(call());
    expect(spent[0]?.model).toBe('fallback-model');
  });

  it("a fallback's unsupported reasoning setting is a refusal: masked and recorded", async () => {
    const quota = planLimit();
    const refused = new ReasoningConfigurationError({
      status: 'unsupported',
      capabilitySource: 'account-catalog',
      reason: 'no reasoning on this model',
    });
    const primary = scripted('openai-chatgpt', [quota]);
    const second = scripted('openai-compat', [refused]);
    const states: LaneChainState[] = [];
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
      onState: (s) => states.push(s),
    });
    await expect(chain.chat(call())).rejects.toBe(quota);
    expect(states.at(-1)?.lastFallbackError).toEqual({
      link: 'b',
      at: NOW,
      kind: 'ReasoningConfigurationError',
    });
  });
});

describe('provider chain: a passing failure on the last link stays retryable (N5)', () => {
  const passing: Array<[string, () => ProviderError]> = [
    ['a retryable 503', () => new ProviderError('down', true, 503)],
    ['a retryable 429', () => new ProviderError('slow down', true, 429, 'transport', 2_000)],
    [
      'a dropped connection',
      () =>
        new ProviderError('socket hang up', true, undefined, 'transport', undefined, false, {
          connection: true,
        }),
    ],
  ];
  for (const [name, make] of passing) {
    it(`chat: ${name} on the last link reaches the caller, every pause recorded`, async () => {
      const quota = planLimit();
      const own = make();
      const primary = scripted('openai-chatgpt', [quota]);
      const second = scripted('openai-compat', [own]);
      const states: LaneChainState[] = [];
      const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
        lane: 'main',
        now: () => NOW,
        onState: (s) => states.push(s),
      });
      await expect(chain.chat(call())).rejects.toBe(own);
      expect(states.at(-1)?.cooldowns.a?.reason).toBe('quota');
      expect(states.at(-1)?.cooldowns.b).toBeDefined();
    });

    it(`stream: ${name} on the last link reaches the caller`, async () => {
      const quota = planLimit();
      const own = make();
      const throwing = (kind: Provider['kind'], error: Error): Provider => ({
        kind,
        chat: fail,
        // biome-ignore lint/correctness/useYield: throws before the first event
        async *chatStream() {
          throw error;
        },
      });
      const chain = providerChain(
        [
          link('a', throwing('openai-chatgpt', quota)),
          link('b', throwing('openai-compat', own), 'm'),
        ],
        { lane: 'main', now: () => NOW },
      );
      const drain = async () => {
        for await (const _ of (chain.chatStream?.bind(chain) ?? fail)(call({ stream: true }))) {
          // nothing arrives
        }
      };
      await expect(drain()).rejects.toBe(own);
    });
  }

  it('a 5xx the adapter marked non-retryable still shows the primary error', async () => {
    const quota = planLimit();
    const primary = scripted('openai-chatgpt', [quota]);
    const second = scripted('openai-compat', [new ProviderError('gone', false, 503)]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    await expect(chain.chat(call())).rejects.toBe(quota);
  });

  it('only the last link counts: a passing middle failure before a final auth failure shows the primary', async () => {
    const quota = planLimit();
    const primary = scripted('openai-chatgpt', [quota]);
    const middle = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const last = scripted('openai-compat', [new ProviderError('bad key', false, 401)]);
    const chain = providerChain(
      [link('a', primary.provider), link('b', middle.provider, 'm'), link('c', last.provider, 'n')],
      { lane: 'main', now: () => NOW },
    );
    await expect(chain.chat(call())).rejects.toBe(quota);
  });

  it('an account failure on the last link shows the primary even if marked retryable', async () => {
    const quota = planLimit();
    const primary = scripted('openai-chatgpt', [quota]);
    const second = scripted('openai-compat', [new ProviderError('credits', true, 402)]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    await expect(chain.chat(call())).rejects.toBe(quota);
  });

  it('a refusal on the last link stays hidden behind the primary', async () => {
    const quota = planLimit();
    const primary = scripted('openai-chatgpt', [quota]);
    const middle = scripted('openai-compat', [new ProviderError('down', true, 503)]);
    const last = scripted('openai-compat', [new ProviderError('no such model', false, 404)]);
    const chain = providerChain(
      [link('a', primary.provider), link('b', middle.provider, 'm'), link('c', last.provider, 'n')],
      { lane: 'main', now: () => NOW },
    );
    await expect(chain.chat(call())).rejects.toBe(quota);
  });

  it("the primary's own outage stays the error when the fallback then fails for an account reason", async () => {
    const down = new ProviderError('down', true, 503);
    const primary = scripted('openai-chatgpt', [down]);
    const second = scripted('openai-compat', [new ProviderError('down too', false, 401)]);
    const chain = providerChain([link('a', primary.provider), link('b', second.provider, 'm')], {
      lane: 'main',
      now: () => NOW,
    });
    await expect(chain.chat(call())).rejects.toBe(down);
  });
});
