import { describe, expect, it } from 'vitest';
import { identify, tierOf } from './types.js';

describe('private identity before pairing', () => {
  it('keeps a private DM private without granting owner authority', () => {
    const identity = identify(
      { connector: 'telegram', authorId: '4242', conversationId: '4242', direct: true },
      undefined,
    );

    expect(identity.principal.kind).toBe('member');
    expect(identity.tenant).toBe('direct:telegram:4242');
    expect(identity.sessionKey).toBe('telegram:4242');
    expect(tierOf(identity.principal)).toBe(2);
  });

  it('still isolates a real group as a group tenant', () => {
    const identity = identify(
      { connector: 'telegram', authorId: '4242', conversationId: '-100', direct: false },
      undefined,
    );

    expect(identity.principal.kind).toBe('member');
    expect(identity.tenant).toBe('group:telegram:-100');
    expect(identity.sessionKey).toBe('telegram:-100');
  });

  it('promotes only the paired account in a private DM', () => {
    const identity = identify(
      { connector: 'telegram', authorId: '4242', conversationId: '4242', direct: true },
      '4242',
    );

    expect(identity.principal.kind).toBe('owner');
    expect(identity.tenant).toBe('host');
    expect(identity.sessionKey).toBe('owner');
    expect(tierOf(identity.principal)).toBe(0);
  });
});
