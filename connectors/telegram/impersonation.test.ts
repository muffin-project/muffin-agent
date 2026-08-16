import { describe, expect, it } from 'vitest';
import type { Update } from '@grammyjs/types';
import { parseUpdate, principalFor } from './connector.js';

/**
 * Nobody may arrive as the owner without being the owner.
 *
 * Identity here used to be the *chat* id — the room — rather than the *user*
 * id. In a one-to-one chat those coincide, and that accident was carrying the
 * whole check. The comment above it had already reasoned correctly that a
 * display name is chosen by whoever holds the account, and then compared the
 * conversation instead of the person.
 */

const OWNER = 4242;
const STRANGER = 9999;

const update = (over: {
  chatId: number;
  fromId: number;
  type?: 'private' | 'group';
}): Update =>
  ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: over.chatId, type: over.type ?? 'private' },
      from: { id: over.fromId, is_bot: false, first_name: 'x' },
      text: 'ciao',
    },
  }) as unknown as Update;

describe('owner identity', () => {
  it('accepts the owner speaking from their own account', () => {
    const i = parseUpdate(update({ chatId: OWNER, fromId: OWNER }));
    expect(principalFor(i!, OWNER).principal.kind).toBe('owner');
  });

  it('refuses someone else speaking in a chat that carries the owner id', () => {
    // The exploit: the room matches, the person does not.
    const i = parseUpdate(update({ chatId: OWNER, fromId: STRANGER }));
    expect(principalFor(i!, OWNER).principal.kind).toBe('member');
  });

  it('does not promote the owner to host tenant inside a group', () => {
    // Even the owner speaking in a group is a member of that group's tenant:
    // otherwise group content lands in host memory.
    const i = parseUpdate(update({ chatId: -100, fromId: OWNER, type: 'group' }));
    expect(principalFor(i!, OWNER).tenant).toBe('group:telegram:-100');
  });

  it('carries an external id on the owner principal, so it is never anonymous', () => {
    const i = parseUpdate(update({ chatId: OWNER, fromId: OWNER }));
    const p = principalFor(i!, OWNER).principal;
    expect(p.kind === 'owner' && p.externalId).toBe(String(OWNER));
  });

  it('has no owner at all while unpaired, even for a message that looks right', () => {
    // The fail-closed direction that replaced "whoever messaged first". A bot's
    // username is discoverable, so that was a race, not an election.
    const i = parseUpdate(update({ chatId: OWNER, fromId: OWNER }));
    expect(principalFor(i!, undefined).principal.kind).toBe('member');
    expect(principalFor(i!, undefined).tenant).not.toBe('host');
  });
});
