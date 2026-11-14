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
 * Wire order is history, memory, the runtime clock, then the current user
 * message. The clock is rebuilt every turn, so a mark on it — or on anything
 * after it — writes a prefix the next turn cannot read. Marks stay on the
 * system block and on stable history (no origin) up to the last text message
 * before the clock. Memory and harness lines sit in that span but are not
 * stable, so they are skipped and the breakpoint's prefix stops before them.
 */
export const MAX_CACHE_BREAKPOINTS = 4;
/** How many stable history messages before the clock receive a breakpoint. The system prefix takes the remaining slot. */
export const MESSAGE_CACHE_BREAKPOINTS = 3;

function withoutCache(block: ContentBlock): ContentBlock {
  if (block.type !== 'text') return { ...block };
  const { cache: _cache, ...rest } = block;
  return rest;
}

/**
 * Copies the request and marks the system prefix plus the last text block of
 * up to three stable history messages before the runtime clock.
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

  const clockAt = messagesOut.findIndex((message) => message.origin === 'runtime');
  // No clock means this request has no stable/volatile seam. Marking the
  // tail would put the breakpoint on whatever arrived last, which is the
  // bug this function exists to avoid.
  if (clockAt === -1) return { system: systemOut, messages: messagesOut };

  let marked = 0;
  for (
    let i = clockAt - 1;
    i >= 0 && marked < MESSAGE_CACHE_BREAKPOINTS && used < MAX_CACHE_BREAKPOINTS;
    i--
  ) {
    const message = messagesOut[i];
    if (message === undefined || message.origin !== undefined) continue;
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
