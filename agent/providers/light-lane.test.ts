import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LIGHT_TRANSPORT_RETRIES } from '../loop/types.js';
import { CONSERVATIVE, loadProfiles, selectProfile } from '../profiles/profile.js';
import { lightLane, type LightSpend } from './light-lane.js';
import { ProviderError, type ChatCall, type ChatResult, type Provider } from './types.js';

/**
 * The boundary the memory lane never had.
 *
 * Three things the loop does around every model call — bill it, own transport
 * retries, and send only the sampling parameter the model accepts — reached
 * only the main lane. `core/memory/{extract,judge,rerank}.ts` are a second
 * entry point to the same provider and need all three at this boundary.
 */

class Echo implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  async chat(call: ChatCall): Promise<ChatResult> {
    this.seen.push(call);
    return {
      text: 'ok',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
      model: 'claude-haiku-4-5-20251001',
    };
  }
}

const call = (over: Partial<ChatCall> = {}): ChatCall => ({
  model: 'light',
  system: [{ type: 'text', text: 's' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  maxOutputTokens: 500,
  temperature: 0,
  stream: false,
  ...over,
});

const ok = (): ChatResult => ({
  text: 'ok',
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'light-served',
});

afterEach(() => vi.restoreAllMocks());

describe('billing the light lane', () => {
  it('records what the call cost, with the model the provider actually served', async () => {
    const inner = new Echo();
    const billed: LightSpend[] = [];
    const lane = lightLane(inner, { profile: CONSERVATIVE, record: (e) => billed.push(e) });

    await lane.chat(call());

    expect(billed).toEqual([
      {
        // Not `call.model` ('light'): the price table is keyed on what served
        // the request, and the two differ on every alias.
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 11,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    ]);
  });

  it('bills nothing for a call that threw — a failure is not a charge', async () => {
    const billed: LightSpend[] = [];
    const lane = lightLane(
      {
        kind: 'anthropic',
        chat: async () => {
          throw new Error('502');
        },
      },
      { profile: CONSERVATIVE, record: (e) => billed.push(e) },
    );
    await expect(lane.chat(call())).rejects.toThrow('502');
    expect(billed).toEqual([]);
  });
});

describe('transport retry ownership', () => {
  it('retries a transient transport failure twice, then bills the one successful logical call', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const billed: LightSpend[] = [];
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          if (attempts <= MAX_LIGHT_TRANSPORT_RETRIES) {
            throw new ProviderError('502', true, 502, 'transport');
          }
          return ok();
        },
      },
      { profile: CONSERVATIVE, record: (e) => billed.push(e) },
    );

    await expect(lane.chat(call())).resolves.toMatchObject({ text: 'ok' });
    expect(attempts).toBe(MAX_LIGHT_TRANSPORT_RETRIES + 1);
    expect(billed).toHaveLength(1);
  });

  it('stops after the bounded transport budget instead of multiplying attempts below the lane', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'anthropic',
        chat: async () => {
          attempts += 1;
          throw new ProviderError('429', true, 429, 'transport');
        },
      },
      { profile: CONSERVATIVE },
    );

    await expect(lane.chat(call())).rejects.toThrow('429');
    expect(attempts).toBe(MAX_LIGHT_TRANSPORT_RETRIES + 1);
  });

  it('never retries malformed model output even when the adapter marks it retryable', async () => {
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          throw new ProviderError('malformed tool arguments', true, undefined, 'output');
        },
      },
      { profile: CONSERVATIVE },
    );

    await expect(lane.chat(call())).rejects.toThrow('malformed tool arguments');
    expect(attempts).toBe(1);
  });

  it('never retries a permanent transport refusal', async () => {
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          throw new ProviderError('401', false, 401, 'transport');
        },
      },
      { profile: CONSERVATIVE },
    );

    await expect(lane.chat(call())).rejects.toThrow('401');
    expect(attempts).toBe(1);
  });

  it('an abort during the failed attempt cancels the backoff and no second wire attempt starts', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const lane = lightLane(
      {
        kind: 'openai-compat',
        chat: async () => {
          attempts += 1;
          controller.abort('owner-stop');
          throw new ProviderError('502', true, 502, 'transport');
        },
      },
      { profile: CONSERVATIVE },
    );

    await expect(lane.chat(call({ signal: controller.signal }))).rejects.toThrow('502');
    expect(attempts).toBe(1);
  });
});

describe('sampling, which no profile edit could reach', () => {
  it('keeps temperature for a model whose profile says deterministic', async () => {
    const inner = new Echo();
    await lightLane(inner, { profile: CONSERVATIVE }).chat(call());
    expect(inner.seen[0]?.temperature).toBe(0);
  });

  /**
   * The failure this prevents, in production terms: `--light-model` pointed at
   * anything from Opus 4.7 onward would 400 on **every consolidation**, and now
   * that consolidation runs unattended the failure is a memory that silently
   * stops filling. The three memory files hardcode `temperature: 0` outside the
   * profile system, so nothing in `agent/profiles/*` could have corrected it.
   */
  it('drops it — the key, not just the value — when the model refuses one', async () => {
    const inner = new Echo();
    const frontier = selectProfile('claude-opus-4-7', loadProfiles());
    expect(frontier.sampling).toBe('model-default');

    await lightLane(inner, { profile: frontier }).chat(call());
    // `in`, not `=== undefined`: an explicit undefined can still be serialised
    // as a key, and a present key is exactly what the model rejects.
    expect('temperature' in (inner.seen[0] ?? {})).toBe(false);
  });

  it('leaves a call that never asked for a temperature alone', async () => {
    const inner = new Echo();
    const frontier = selectProfile('claude-opus-4-7', loadProfiles());
    const bare = call();
    delete bare.temperature;
    await lightLane(inner, { profile: frontier }).chat(bare);
    expect(inner.seen[0]).toEqual(bare);
  });
});
