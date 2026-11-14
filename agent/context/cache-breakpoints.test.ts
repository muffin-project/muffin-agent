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

function user(value: string): Message {
  return { role: 'user', content: [text(value)] };
}

describe('cache breakpoints', () => {
  it('marks the system prefix and the last three text-bearing messages, and never a fifth', () => {
    const messages = [user('a'), user('b'), user('c'), user('d'), user('e')];
    const placed = placeCacheBreakpoints([text('sistema')], messages);
    expect(countCacheBreakpoints(placed.system, placed.messages)).toBe(MAX_CACHE_BREAKPOINTS);
    expect(placed.system[0]).toMatchObject({ cache: 'stable' });
    const marked = placed.messages.map((message) =>
      message.content.some((block) => block.type === 'text' && block.cache === 'stable'),
    );
    expect(marked).toEqual([false, false, true, true, true]);
  });

  it('does not mutate the transcript it was given', () => {
    const messages = [user('a')];
    placeCacheBreakpoints([text('sistema')], messages);
    expect(messages[0]?.content[0]).toEqual({ type: 'text', text: 'a' });
  });

  it('skips a message that has no text block instead of spending a breakpoint on it', () => {
    const toolOnly: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: '1', name: 'fs_read', input: {} }],
    };
    const placed = placeCacheBreakpoints(
      [text('sistema')],
      [user('prima'), toolOnly, user('dopo')],
    );
    expect(countCacheBreakpoints(placed.system, placed.messages)).toBe(3);
    expect(placed.messages[1]?.content[0]).not.toHaveProperty('cache');
  });
});
