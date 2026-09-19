import { describe, expect, it } from 'vitest';
import { resolveConversationId } from './conversation.js';

describe('resolveConversationId · the seam OpenRouter session_id hangs from', () => {
  it('is stable across turns of the same session', () => {
    const session = { id: 'telegram:-100', file: '/dev/null' };
    expect(resolveConversationId(session)).toBe(resolveConversationId(session));
  });

  it('differs across sessions', () => {
    expect(resolveConversationId({ id: 'telegram:-100', file: '/a' })).not.toBe(
      resolveConversationId({ id: 'telegram:-200', file: '/b' }),
    );
  });

  it('is never a turn id: two turns of one session share it', () => {
    const session = { id: 's1', file: '/dev/null' };
    const conversation = resolveConversationId(session);
    expect(conversation).not.toBe('turn-aaa');
    expect(conversation).not.toBe('turn-bbb');
    expect(resolveConversationId(session)).toBe(conversation);
  });

  it('documents the residual: the private owner scope is still session-valued', () => {
    // `identify()` maps every private owner surface to sessionKey 'owner',
    // so conversation and principal coincide in VALUE here — though the loop
    // passes this function's return, never the principal key. The durable
    // generation primitive (bumped on `/new`) that separates them in value
    // is the P0 migration contract, not this function: when it lands, this
    // test goes red first, on purpose.
    expect(resolveConversationId({ id: 'owner', file: '/dev/null' })).toBe('owner');
  });
});
