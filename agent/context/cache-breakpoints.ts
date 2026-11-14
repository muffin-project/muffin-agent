import type { ContentBlock, Message } from '../providers/types.js';

/**
 * Where a provider may be asked to cache.
 *
 * Anthropic and OpenRouter accept at most four `cache_control` breakpoints
 * per request; a fifth is a 400. Hermes marks the fixed system prefix and the
 * last three messages, which is exactly that budget: one breakpoint on the
 * prefix, three on the tail. A provider that does not understand the marker
 * never sees it — the adapters emit `cache_control` only for Anthropic and
 * for OpenRouter (`explicitCache`).
 *
 * The last message of a turn often carries the clock (`## Questo turno`).
 * Marking it still matches Hermes: that breakpoint misses, the two behind it
 * and the system prefix can hit on the next request. The falsifier is a trace
 * where cache writes dominate reads; then stop marking the message that
 * contains the clock.
 */
export const MAX_CACHE_BREAKPOINTS = 4;
/** How many messages, counting from the end, receive a breakpoint. The system prefix takes the remaining slot. */
export const MESSAGE_CACHE_BREAKPOINTS = 3;

function withoutCache(block: ContentBlock): ContentBlock {
  if (block.type !== 'text') return { ...block };
  const { cache: _cache, ...rest } = block;
  return rest;
}

/**
 * Copies the request and marks the system prefix plus the last text block of
 * each of the last three messages that contain one.
 *
 * Does not mutate the transcript. Cache marks are a property of this request,
 * not of the session row: the next request's "last three" are a different
 * three, and a mark left on the stored message would ride into a provider
 * that should not see it twice.
 */
export function placeCacheBreakpoints(
  system: readonly ContentBlock[],
  messages: readonly Message[],
): { system: ContentBlock[]; messages: Message[] } {
  const systemOut = system.map(withoutCache);
  for (let i = systemOut.length - 1; i >= 0; i--) {
    const block = systemOut[i];
    if (block?.type === 'text') {
      systemOut[i] = { ...block, cache: 'stable' };
      break;
    }
  }
  let used = systemOut.filter((block) => block.type === 'text' && block.cache === 'stable').length;

  const messagesOut: Message[] = messages.map((message) => ({
    ...message,
    content: message.content.map(withoutCache),
  }));

  let marked = 0;
  for (
    let i = messagesOut.length - 1;
    i >= 0 && marked < MESSAGE_CACHE_BREAKPOINTS && used < MAX_CACHE_BREAKPOINTS;
    i--
  ) {
    const message = messagesOut[i];
    if (message === undefined) continue;
    const content = message.content;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block?.type === 'text') {
        content[j] = { ...block, cache: 'stable' };
        marked += 1;
        used += 1;
        break;
      }
    }
  }
  return { system: systemOut, messages: messagesOut };
}

/** How many breakpoints a placed request actually carries. The adapters must not add more. */
export function countCacheBreakpoints(
  system: readonly ContentBlock[],
  messages: readonly Message[],
): number {
  const inSystem = system.filter(
    (block) => block.type === 'text' && block.cache === 'stable',
  ).length;
  const inMessages = messages.reduce(
    (n, message) =>
      n +
      message.content.filter((block) => block.type === 'text' && block.cache === 'stable').length,
    0,
  );
  return inSystem + inMessages;
}
