import { describe, expect, it } from 'vitest';
import { CONSERVATIVE, loadProfiles, selectProfile } from '../profiles/profile.js';
import { lightLane, type LightSpend } from './light-lane.js';
import type { ChatCall, ChatResult, Provider } from './types.js';

/**
 * The boundary the memory lane never had.
 *
 * Two things the loop does around every model call — bill it, and send the
 * sampling parameter the model accepts — reached only the main lane.
 * `core/memory/{extract,judge,rerank}.ts` are a second entry point to the same
 * provider, and got neither.
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
