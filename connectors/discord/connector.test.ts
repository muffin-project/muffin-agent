import DatabaseCtor from 'better-sqlite3';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMessage, principalFor, type ConnectorDeps, DiscordConnector } from './connector.js';
import { DiscordInbox } from './inbox.js';
import type { LoopDeps } from '../../agent/loop.js';
import { CONSERVATIVE } from '../../agent/profiles/profile.js';
import { SessionStore } from '../../core/session/store.js';
import type { DiscordApi, DiscordMessage } from './api.js';

/**
 * The two decisions this file makes that nothing downstream can correct: what
 * counts as a message, and who is speaking — the Discord half of
 * `connectors/telegram/connector.test.ts`. Identity's own guarantees live in
 * `impersonation.test.ts`; this file is parsing mechanics and the connector's
 * own durability/delivery behaviour.
 */

const OWNER = '888000000000000001';

describe('reading a MESSAGE_CREATE dispatch', () => {
  it('reads a plain DM', () => {
    const parsed = parseMessage({ id: '1', channel_id: '42', author: { id: OWNER, bot: false }, content: 'ciao' });
    expect(parsed).toMatchObject({ channelId: '42', text: 'ciao', fromId: OWNER, messageId: '1' });
  });

  it('carries the first attachment when there is one, text or not', () => {
    const withText = parseMessage({
      id: '1',
      channel_id: '42',
      author: { id: OWNER, bot: false },
      content: 'guarda',
      attachments: [{ id: 'a1', filename: 'nota.pdf', size: 10, url: 'https://cdn/x' }],
    });
    expect(withText?.attachment?.filename).toBe('nota.pdf');

    // A file with no text is still a complete thought — same rule as Telegram.
    const noText = parseMessage({
      id: '2',
      channel_id: '42',
      author: { id: OWNER, bot: false },
      content: '',
      attachments: [{ id: 'a1', filename: 'nota.pdf', size: 10, url: 'https://cdn/x' }],
    });
    expect(noText).not.toBeNull();
    expect(noText?.text).toBe('');
  });

  it('skips what it cannot handle instead of guessing', () => {
    expect(parseMessage({ id: '1', channel_id: '42', content: 'ciao' })).toBeNull(); // no author
    expect(parseMessage({ id: '1', channel_id: '42', author: { id: OWNER, bot: false }, content: '' })).toBeNull(); // no text, no attachment
    expect(parseMessage({ id: '1', channel_id: '42', author: { id: OWNER, bot: false }, content: '   ' })).toBeNull(); // whitespace only
    expect(
      parseMessage({ id: '1', channel_id: '42', guild_id: '9', author: { id: OWNER, bot: false }, content: 'ciao' }),
    ).toBeNull(); // guild — out of scope for this slice
    expect(parseMessage({ id: '1', channel_id: '42', author: { id: OWNER, bot: true }, content: 'ciao' })).toBeNull(); // a bot, including this one
    expect(parseMessage({ id: '1', channel_id: '42', author: { id: OWNER, system: true }, content: 'ciao' })).toBeNull(); // Discord's own system messages
  });

  it('does not decide who the owner is', () => {
    const parsed = parseMessage({ id: '1', channel_id: '42', author: { id: OWNER, bot: false }, content: 'ciao' })!;
    expect(Object.keys(parsed)).not.toContain('isOwner');
  });
});

describe('who is speaking', () => {
  it('gives the owner the host tenant with a DM', () => {
    const parsed = parseMessage({ id: '1', channel_id: '42', author: { id: OWNER, bot: false }, content: 'ciao' })!;
    expect(principalFor(parsed, OWNER)).toEqual({
      principal: { kind: 'owner', connector: 'discord', externalId: OWNER },
      tenant: 'host',
    });
  });
});

function harness(over: { attachment?: { filename: string; content: string } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-discord-connector-'));
  const sent: { channelId: string; text: string }[] = [];
  const delivered: [string, string][] = [];
  const reindexed: { tenantId: string; path: string; tier: number }[] = [];

  const api = {
    sendMessage: async (channelId: string, text: string) => {
      sent.push({ channelId, text });
      return {} as never;
    },
    typing: async () => undefined,
    download: async () => Buffer.from(over.attachment?.content ?? ''),
  } as unknown as DiscordApi;

  const loop = {
    provider: {
      kind: 'openai-compat' as const,
      chat: async () => ({
        text: 'fatto',
        toolCalls: [],
        stopReason: 'end' as const,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 't',
      }),
    },
    profile: CONSERVATIVE,
    model: 't',
    tools: [],
    decide: () => ({ effect: 'allow' as const }),
    tracer: { start: () => ({ traceId: 't', setAttributes: () => {}, end: () => {} }) },
    sessions: new SessionStore(home),
    turns: {
      create: () => {},
      delivered: (id: string, state: string) => delivered.push([id, state]),
    },
    budgetExhausted: () => false,
    systemPrompts: { owner: 'x', group: 'x' },
  } as unknown as LoopDeps;

  const vaultRoot = mkdtempSync(join(tmpdir(), 'muffin-discord-vault-'));
  // `downloadToVault` writes into `<root>/inbox/`; production creates it once
  // in `cli/surface.ts` before the connector ever runs.
  mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });
  const deps: ConnectorDeps = {
    loop,
    sessions: loop.sessions,
    inbox: new DiscordInbox(new DatabaseCtor(':memory:')),
    api,
    config: { token: 't', ownerUserId: OWNER },
    vault: {
      root: vaultRoot,
      reindexPath: async (tenantId, path, tier) => {
        reindexed.push({ tenantId, path, tier });
        return { skipped: [], documents: [] };
      },
    },
  };
  const connector = new DiscordConnector(deps);
  return { connector, sent, delivered, reindexed, deps };
}

async function deliver(h: ReturnType<typeof harness>, messages: DiscordMessage[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: DiscordInbox } }).deps.inbox;
  for (const m of messages) inbox.accept(m.id, m, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('handling a DM end to end', () => {
  it('answers and records the delivery on the turn', async () => {
    const h = harness();
    await deliver(h, [{ id: '1', channel_id: '42', author: { id: OWNER, bot: false }, content: 'ciao' }]);

    expect(h.sent).toEqual([{ channelId: '42', text: 'fatto' }]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.[1]).toBe('sent');
  });

  it('ingests an attachment into the vault before the turn runs, tagged with the sender tenant', async () => {
    const h = harness({ attachment: { filename: 'nota.txt', content: 'hello' } });
    await deliver(h, [
      {
        id: '1',
        channel_id: '42',
        author: { id: OWNER, bot: false },
        content: 'guarda',
        attachments: [{ id: 'a1', filename: 'nota.txt', size: 5, url: 'https://cdn/x' }],
      },
    ]);

    expect(h.reindexed).toHaveLength(1);
    expect(h.reindexed[0]?.tenantId).toBe('host'); // the owner's DM
    expect(h.reindexed[0]?.tier).toBe(0); // owner-sent, tier 0
  });
});

describe('durability — a message survives a failure mid-turn', () => {
  it('stays pending, not lost, when the turn throws', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-discord-fail-'));
    const inbox = new DiscordInbox(new DatabaseCtor(':memory:'));
    const loop = {
      provider: { kind: 'openai-compat' as const, chat: async () => { throw new Error('modello giù'); } },
      profile: CONSERVATIVE,
      model: 't',
      tools: [],
      decide: () => ({ effect: 'allow' as const }),
      tracer: { start: () => ({ traceId: 't', setAttributes: () => {}, end: () => {} }) },
      sessions: new SessionStore(home),
      turns: { create: () => {}, delivered: () => {} },
      budgetExhausted: () => false,
      systemPrompts: { owner: 'x', group: 'x' },
    } as unknown as LoopDeps;
    const api = { sendMessage: async () => ({}) as never, typing: async () => undefined } as unknown as DiscordApi;
    const connector = new DiscordConnector({ loop, sessions: loop.sessions, inbox, api, config: { token: 't', ownerUserId: OWNER } });

    const raw: DiscordMessage = { id: '1', channel_id: '42', author: { id: OWNER, bot: false }, content: 'ciao' };
    inbox.accept(raw.id, raw, new Date().toISOString());
    await (connector as unknown as { drain: () => Promise<void> }).drain();

    // Not silently dropped: still pending, with the failure recorded, so the
    // next drain (a restart, or the next dispatch) tries again instead of the
    // message vanishing the way a Discord-side redelivery never happens on
    // its own (`inbox.ts`'s whole reason to exist).
    const pending = inbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.messageId).toBe('1');
  });
});
