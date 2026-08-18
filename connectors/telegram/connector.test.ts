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
    const parsed = parseUpdate(update({ text: 'ciao' }));
    expect(parsed).toMatchObject({ chatId: OWNER, text: 'ciao', isPrivate: true, fromId: OWNER });
  });

  it('keeps a caption apart from text, typed as what it is', () => {
    // M5-BIS B16: a caption used to fall back into `.text` as if the sender had
    // typed it as a separate line. It is the attachment's caption, not the
    // sender's own message, so it gets its own field — `composeTurnText`
    // fences it into the turn separately (`connector.ts`).
    const parsed = parseUpdate(update({ text: undefined, caption: 'guarda qui' }));
    expect(parsed?.caption).toBe('guarda qui');
    expect(parsed?.text).toBe('');
  });

  it('skips what it cannot handle instead of guessing', () => {
    // The types promise these fields. The types are generated from a schema, not
    // from what a live server does in an edge case, and this runs for months.
    expect(parseUpdate({ update_id: 1 } as Update)).toBeNull();
    expect(parseUpdate(update({ text: undefined }))).toBeNull();
    expect(parseUpdate(update({ text: '   ' }))).toBeNull();
    expect(parseUpdate({ update_id: 1, message: { chat: {} } } as Update)).toBeNull();
  });

  it('handles an edited message like a new one', () => {
    const edited = { update_id: 2, edited_message: { message_id: 9, date: 0, chat: { id: OWNER, type: 'private' }, text: 'corretto' } } as Update;
    expect(parseUpdate(edited)?.text).toBe('corretto');
  });

  it('does not decide who the owner is', () => {
    // Parsing reads a message; authorising its sender is a separate job, and
    // mixing them is how the *room* ended up being compared against the owner —
    // it was the field already in scope. Nothing on `Incoming` answers "is this
    // the owner", so a future caller cannot reach for a half-computed answer.
    const parsed = parseUpdate(update({ text: 'ciao' }))!;
    expect(Object.keys(parsed)).not.toContain('fromOwner');
  });
});

describe('who is speaking', () => {
  it('gives the owner the host tenant', () => {
    const parsed = parseUpdate(update({ text: 'ciao' }))!;
    expect(principalFor(parsed, OWNER)).toEqual({
      principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
      tenant: 'host',
    });
  });

  it('gives a group its own tenant', () => {
    const group = { update_id: 3, message: { message_id: 1, date: 0, chat: { id: -100200, type: 'supergroup' }, text: 'ciao' } } as Update;
    const parsed = parseUpdate(group)!;
    const { principal, tenant } = principalFor(parsed, OWNER);
    expect(tenant).toBe('group:telegram:-100200');
    expect(principal.kind).toBe('member');
  });

  it('does not make a stranger the owner just because the chat is private', () => {
    // The case a naive `isPrivate` check gets wrong, and the one that matters:
    // anyone can open a private chat with a bot.
    const stranger = { update_id: 4, message: { message_id: 1, date: 0, chat: { id: 999, type: 'private' }, from: { id: 999, is_bot: false, first_name: 's' }, text: 'ciao' } } as Update;
    const parsed = parseUpdate(stranger)!;
    expect(parsed.isPrivate).toBe(true);
    const { principal, tenant } = principalFor(parsed, OWNER);
    expect(principal.kind).toBe('member'); // taint 2, host-only tools refused
    expect(tenant).not.toBe('host');
  });

  it('identifies by authenticated sender id, never by name', () => {
    // A display name is chosen by whoever holds the account.
    const impostor = {
      update_id: 5,
      message: { message_id: 1, date: 0, chat: { id: 999, type: 'private', username: 'giusto' }, from: { id: 999, first_name: 'Giusto', is_bot: false }, text: 'sono io' },
    } as Update;
    expect(principalFor(parseUpdate(impostor)!, OWNER).tenant).not.toBe('host');
  });
});
