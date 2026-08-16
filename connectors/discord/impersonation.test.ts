import { describe, expect, it } from 'vitest';
import { parseMessage, principalFor } from './connector.js';
import type { DiscordMessage } from './api.js';

/**
 * Nobody may arrive as the owner without being the owner — the Discord half
 * of `connectors/telegram/impersonation.test.ts`.
 *
 * Discord does not even offer Telegram's accidental shortcut: a DM's
 * `channel_id` is never equal to either party's user id, so there is no
 * "room happens to match the person" coincidence to guard against. What
 * remains, and matters exactly as much, is that nothing here ever reads
 * `author.username`, `author.global_name` or a guild nickname — a display
 * name is chosen by whoever holds the account, and `identify()`
 * (`core/surface/types.ts`) never sees it at all.
 */

const OWNER = '111111111111111111';
const STRANGER = '999999999999999999';

const message = (over: {
  authorId: string;
  content?: string;
  bot?: boolean;
  guildId?: string;
  channelType?: number;
}): DiscordMessage => ({
  id: '1',
  channel_id: '42',
  // A real one-to-one DM, unless the test asks for something else — the
  // fixture default has to be the shape `parseMessage` actually accepts,
  // now that `channel_type` (not `guild_id`'s absence) is the DM check.
  channel_type: over.channelType ?? 1,
  ...(over.guildId !== undefined ? { guild_id: over.guildId } : {}),
  author: { id: over.authorId, username: 'giusto', global_name: 'Giusto', bot: over.bot ?? false },
  content: over.content ?? 'ciao',
});

describe('owner identity', () => {
  it('accepts the owner speaking from their own account', () => {
    const i = parseMessage(message({ authorId: OWNER }));
    expect(principalFor(i!, OWNER).principal.kind).toBe('owner');
  });

  it('refuses a stranger whose display name and username claim to be the owner', () => {
    // The exploit this file exists to close: `global_name`/`username` are
    // exactly the fields a stranger controls, and `parseMessage` does not even
    // extract them into `Incoming` — there is nothing for `principalFor` to be
    // fooled by, structurally, not just by discipline.
    const i = parseMessage(message({ authorId: STRANGER }));
    expect(principalFor(i!, OWNER).principal.kind).toBe('member');
    expect(principalFor(i!, OWNER).tenant).not.toBe('host');
  });

  it('carries an external id on the owner principal, so it is never anonymous', () => {
    const i = parseMessage(message({ authorId: OWNER }));
    const p = principalFor(i!, OWNER).principal;
    expect(p.kind === 'owner' && p.externalId).toBe(OWNER);
  });

  it('has no owner at all while unpaired, even for a message from the right account', () => {
    // The fail-closed direction that replaced "whoever messaged first" for
    // Telegram, unchanged for Discord: absence of a configured owner id is not
    // "trust whoever is here first".
    const i = parseMessage(message({ authorId: OWNER }));
    expect(principalFor(i!, undefined).principal.kind).toBe('member');
    expect(principalFor(i!, undefined).tenant).not.toBe('host');
  });

  it('never treats a bot account as the owner, even one carrying the owner\'s configured id', () => {
    // Not a realistic snowflake collision — the point is structural: `bot: true`
    // refuses the message before identity is even resolved, so a compromised or
    // misconfigured second bot cannot act as the owner by any coincidence of id.
    const i = parseMessage(message({ authorId: OWNER, bot: true }));
    expect(i).toBeNull();
  });

  it('refuses a guild message outright — DM-only for this slice', () => {
    // A realistic guild text message: `channel_type: 0` (GUILD_TEXT) alongside
    // its `guild_id`, not the DM's `1`.
    const i = parseMessage(message({ authorId: OWNER, guildId: '555', channelType: 0 }));
    expect(i).toBeNull();
  });

  it('treats an unknown sender (no author) as nobody, never as the owner', () => {
    const raw: DiscordMessage = { id: '2', channel_id: '42', content: 'ciao' };
    expect(parseMessage(raw)).toBeNull();
  });

  it('refuses a GROUP_DM outright, even from the owner\'s own account', () => {
    // D1 — the defect this file exists to close now. A GROUP_DM
    // (`channel_type: 3`) carries no `guild_id` either, exactly like a real
    // DM: before this check read `channel_type`, `guild_id === undefined`
    // was the only gate, so a GROUP_DM sailed through it and reached
    // `identify()` as `direct: true` — every member of that group became a
    // candidate to be recognised as the owner, not just the real one.
    const i = parseMessage(message({ authorId: OWNER, channelType: 3 }));
    expect(i).toBeNull();
  });

  it('refuses a payload with no channel_type at all — fail-closed, not "assume DM"', () => {
    // Discord's own docs mark `channel_type` optional on `MESSAGE_CREATE`.
    // Treating its absence as "must be a DM" would silently reopen the
    // GROUP_DM hole for any payload shape that omits the field; refusing it
    // is the fail-closed direction ADR-0046 asks for.
    const raw: DiscordMessage = { id: '3', channel_id: '42', author: { id: OWNER, bot: false }, content: 'ciao' };
    expect(parseMessage(raw)).toBeNull();
  });

  it('never derives the host tenant from a non-direct incoming, even carrying the owner\'s own id', () => {
    // The other half of D1: even if some future caller handed `principalFor`
    // an `Incoming` built by hand instead of through `parseMessage`, `direct`
    // is read off the value — never re-asserted `true` — so a `direct: false`
    // incoming cannot become `owner`/`host` no matter whose id it carries.
    const incoming = { messageId: '1', channelId: '42', text: 'ciao', fromId: OWNER, direct: false };
    const { principal, tenant } = principalFor(incoming, OWNER);
    expect(principal.kind).not.toBe('owner');
    expect(tenant).not.toBe('host');
  });
});
