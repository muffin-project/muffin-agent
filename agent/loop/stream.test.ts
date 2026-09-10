import { describe, expect, it } from 'vitest';
import type { ChatResult, StreamEvent } from '../providers/types.js';
import { ProviderStreamError } from '../providers/types.js';
import { drainStream, edgeTrimmer, retryDelayMs } from './stream.js';

const doneResult = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

async function* streamOf(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) yield event;
}

describe('retryDelayMs', () => {
  it('is 1-based and never exceeds the 8s ceiling, doubling the ceiling each attempt', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ceiling = Math.min(8_000, 500 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const delay = retryDelayMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(ceiling || 1);
      }
    }
  });

  it('is full jitter, not a fixed value — repeated calls at the same attempt vary', () => {
    const delays = new Set(Array.from({ length: 30 }, () => retryDelayMs(4)));
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('drainStream', () => {
  it('forwards every text_delta to onChunk, in order, and returns the done result', async () => {
    const seen: string[] = [];
    const result = await drainStream(
      streamOf([
        { type: 'text_delta', text: 'ci' },
        { type: 'text_delta', text: 'ao' },
        { type: 'done', result: doneResult('ciao') },
      ]),
      (text) => seen.push(text),
    );
    expect(seen).toEqual(['ci', 'ao']);
    expect(result).toEqual(doneResult('ciao'));
  });

  it('drops thinking_delta, tool_call_delta and usage events without forwarding them', async () => {
    const seen: string[] = [];
    const activity: string[] = [];
    await drainStream(
      streamOf([
        { type: 'thinking_delta', text: 'hmm' },
        { type: 'tool_call_delta', index: 0, id: 't1', name: 'fs_read', argsDelta: '{}' },
        { type: 'usage', usage: { inputTokens: 3 } },
        { type: 'text_delta', text: 'ok' },
        { type: 'done', result: doneResult('ok') },
      ]),
      (text) => seen.push(text),
      (kind) => activity.push(kind),
    );
    expect(seen).toEqual(['ok']);
    expect(activity).toEqual(['thinking', 'tool_call', 'text']);
  });

  it('throws ProviderStreamError(partial: true) when the stream ends without a done event — MUTATION: returning instead of throwing must go red', async () => {
    await expect(
      drainStream(streamOf([{ type: 'text_delta', text: 'partial' }]), () => {}),
    ).rejects.toMatchObject({ constructor: ProviderStreamError, partial: true });
  });
});

describe('edgeTrimmer', () => {
  it('emits nothing while only whitespace has arrived', () => {
    const trim = edgeTrimmer();
    expect(trim('   ')).toBeNull();
    expect(trim('\n')).toBeNull();
  });

  it('swallows leading whitespace once real text starts', () => {
    const trim = edgeTrimmer();
    trim('   ');
    expect(trim('  ciao')).toBe('ciao');
  });

  it('holds trailing whitespace until proven internal — MUTATION: emitting the trailing space immediately must go red', () => {
    const trim = edgeTrimmer();
    expect(trim('ciao ')).toBe('ciao');
    // The space held from the chunk above is internal: more text follows it.
    expect(trim('bello')).toBe(' bello');
  });

  it('drops held trailing whitespace the round simply ends on', () => {
    const trim = edgeTrimmer();
    expect(trim('ciao')).toBe('ciao');
    expect(trim('  ')).toBeNull();
    // Nothing more ever arrives: the two trailing spaces are never emitted,
    // which is what keeps this byte-identical to `full.trim()`.
  });

  it('concatenating every non-null piece equals the whole input trimmed, chunk-by-chunk or all at once', () => {
    const whole = '  ciao   bello,   come va?   ';
    const chunked = ['  cia', 'o   be', 'llo,', '   come va?', '   '];

    const wholeTrim = edgeTrimmer();
    const wholeOut = [wholeTrim(whole)].filter((x): x is string => x !== null).join('');

    const chunkTrim = edgeTrimmer();
    const chunkOut = chunked
      .map((c) => chunkTrim(c))
      .filter((x): x is string => x !== null)
      .join('');

    expect(wholeOut).toBe(whole.trim());
    expect(chunkOut).toBe(whole.trim());
  });
});
