import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '../providers/types.js';
import {
  countCacheBreakpoints,
  MAX_CACHE_BREAKPOINTS,
  placeCacheBreakpoints,
} from './cache-breakpoints.js';

function text(value: string, cache?: 'stable'): ContentBlock {
  return cache === undefined ? { type: 'text', text: value } : { type: 'text', text: value, cache };
}

function history(value: string): Message {
  return { role: 'user', content: [text(value)] };
}

function clock(value = '## Questo turno'): Message {
  return { role: 'user', origin: 'runtime', content: [text(value)] };
}

function current(value: string): Message {
  return { role: 'user', origin: 'owner', content: [text(value)] };
}

function isMarked(message: Message | undefined): boolean {
  return (
    message?.content.some((block) => block.type === 'text' && block.cache === 'stable') === true
  );
}

describe('cache breakpoints', () => {
  it('marks the system prefix and stable history before the clock, never the clock or the current message', () => {
    const messages = [
      history('a'),
      history('b'),
      history('c'),
      history('d'),
      history('e'),
      clock(),
      current('adesso'),
    ];
    const placed = placeCacheBreakpoints([text('sistema')], messages);
    expect(countCacheBreakpoints(placed.system, placed.messages)).toBe(MAX_CACHE_BREAKPOINTS);
    expect(placed.system[0]).toMatchObject({ cache: 'stable' });
    expect(placed.messages.map(isMarked)).toEqual([false, false, true, true, true, false, false]);
  });

  it('does not mutate the transcript it was given', () => {
    const messages = [history('a'), clock(), current('adesso')];
    placeCacheBreakpoints([text('sistema')], messages);
    expect(messages[0]?.content[0]).toEqual({ type: 'text', text: 'a' });
    expect(messages[1]?.content[0]).not.toHaveProperty('cache');
  });

  it('skips a history message with no text, and never spends a breakpoint on memory or the clock', () => {
    const toolOnly: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: '1', name: 'fs_read', input: {} }],
    };
    const memory: Message = { role: 'user', origin: 'memory', content: [text('ricordo')] };
    const placed = placeCacheBreakpoints(
      [text('sistema')],
      [history('prima'), toolOnly, history('dopo'), memory, clock(), current('adesso')],
    );
    expect(countCacheBreakpoints(placed.system, placed.messages)).toBe(3);
    expect(placed.messages.map(isMarked)).toEqual([true, false, true, false, false, false]);
    expect(placed.messages[1]?.content[0]).not.toHaveProperty('cache');
  });

  it('marks nothing in the tail when the request has no runtime clock', () => {
    const placed = placeCacheBreakpoints([text('sistema')], [history('a'), current('adesso')]);
    expect(countCacheBreakpoints(placed.system, placed.messages)).toBe(1);
    expect(placed.messages.map(isMarked)).toEqual([false, false]);
  });
});
