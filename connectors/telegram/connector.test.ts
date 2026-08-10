import type { Update } from '@grammyjs/types';
import { describe, expect, it } from 'vitest';
import { parseUpdate, principalFor } from './connector.js';

/**
 * The two decisions this file makes that nothing downstream can correct: what
 * counts as a message, and who is speaking. The kernel decides everything else,
 * but it decides it *about* the principal this function produced.
 */

const OWNER = 12345;

// `from` is part of the fixture now, because identity moved from the room to
// the person: a message with no sender is nobody's, and used to be the owner's.
const update = (over: Record<string, unknown>): Update =>
  ({
    update_id: 1,
    message: {
      message_id: 9,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      ...over,
    },
  }) as Update;

describe('reading a telegram update', () => {
  it('reads a plain private message', () => {
    const parsed = parseUpdate(update({ text: 'ciao' }), OWNER);
    expect(parsed).toMatchObject({ chatId: OWNER, text: 'ciao', isPrivate: true, fromOwner: true });
  });

  it('takes the caption when a photo carries one', () => {
    const parsed = parseUpdate(update({ text: undefined, caption: 'guarda qui' }), OWNER);
    expect(parsed?.text).toBe('guarda qui');
  });

  it('skips what it cannot handle instead of guessing', () => {
    // The types promise these fields. The types are generated from a schema, not
    // from what a live server does in an edge case, and this runs for months.
    expect(parseUpdate({ update_id: 1 } as Update, OWNER)).toBeNull();
    expect(parseUpdate(update({ text: undefined }), OWNER)).toBeNull();
    expect(parseUpdate(update({ text: '   ' }), OWNER)).toBeNull();
    expect(parseUpdate({ update_id: 1, message: { chat: {} } } as Update, OWNER)).toBeNull();
  });

  it('handles an edited message like a new one', () => {
    const edited = { update_id: 2, edited_message: { message_id: 9, date: 0, chat: { id: OWNER, type: 'private' }, text: 'corretto' } } as Update;
    expect(parseUpdate(edited, OWNER)?.text).toBe('corretto');
  });
});

describe('who is speaking', () => {
  it('gives the owner the host tenant', () => {
    const parsed = parseUpdate(update({ text: 'ciao' }), OWNER)!;
    expect(principalFor(parsed)).toEqual({
      principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
      tenant: 'host',
    });
  });

  it('gives a group its own tenant', () => {
    const group = { update_id: 3, message: { message_id: 1, date: 0, chat: { id: -100200, type: 'supergroup' }, text: 'ciao' } } as Update;
    const parsed = parseUpdate(group, OWNER)!;
    const { principal, tenant } = principalFor(parsed);
    expect(tenant).toBe('group:telegram:-100200');
    expect(principal.kind).toBe('member');
  });

  it('does not make a stranger the owner just because the chat is private', () => {
    // The case a naive `isPrivate` check gets wrong, and the one that matters:
    // anyone can open a private chat with a bot.
    const stranger = { update_id: 4, message: { message_id: 1, date: 0, chat: { id: 999, type: 'private' }, text: 'ciao' } } as Update;
    const parsed = parseUpdate(stranger, OWNER)!;
    expect(parsed.isPrivate).toBe(true);
    expect(parsed.fromOwner).toBe(false);
    const { principal, tenant } = principalFor(parsed);
    expect(principal.kind).toBe('member'); // taint 2, host-only tools refused
    expect(tenant).not.toBe('host');
  });

  it('identifies by chat id, never by name', () => {
    // A display name is chosen by whoever holds the account.
    const impostor = {
      update_id: 5,
      message: { message_id: 1, date: 0, chat: { id: 999, type: 'private', username: 'giusto' }, from: { id: 999, first_name: 'Giusto', is_bot: false }, text: 'sono io' },
    } as Update;
    expect(principalFor(parseUpdate(impostor, OWNER)!).tenant).not.toBe('host');
  });
});
