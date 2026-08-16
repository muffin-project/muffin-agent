import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatePairingCode, startPairing, type PendingPairing } from '../../core/config/pairing.js';
import type { LoopDeps } from '../../agent/loop.js';
import { SessionStore } from '../../core/session/store.js';
import { DiscordConnector, type DiscordConfig, parseMessage, principalFor } from './connector.js';
import { DiscordInbox } from './inbox.js';
import type { DiscordApi } from './api.js';
import type { DiscordMessage } from './api.js';

/**
 * The bind, driven through the real connector — the Discord half of
 * `connectors/telegram/pairing-flow.test.ts`, same reason: a test that
 * reimplements `drain()`'s order proves only that the logic can be written
 * twice, not that the connector runs it.
 */

const OWNER = '777000000000000001';
const STRANGER = '777000000000000002';

const msg = (id: string, over: { authorId: string; text: string }): DiscordMessage => ({
  id,
  channel_id: '42',
  author: { id: over.authorId, username: 'x', bot: false },
  content: over.text,
});

function harness(config: DiscordConfig) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-discord-pairing-'));
  const sent: { channelId: string; text: string }[] = [];
  const turns: string[] = [];
  const saved: { ownerUserId?: string; pairing: PendingPairing | null }[] = [];

  const api = {
    sendMessage: async (channelId: string, text: string) => {
      sent.push({ channelId, text });
      return {} as never;
    },
    typing: async () => undefined,
  } as unknown as DiscordApi;

  const loop = {
    provider: {
      kind: 'openai-compat' as const,
      chat: async () => {
        turns.push('turn ran');
        return {
          text: 'ok',
          toolCalls: [],
          stopReason: 'end' as const,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 't',
        };
      },
    },
    profile: { iterationCap: 2 },
    model: 't',
    tools: [],
    decide: () => ({ effect: 'allow' as const }),
    tracer: { start: () => ({ traceId: 't', setAttributes: () => {}, end: () => {} }) },
    sessions: new SessionStore(home),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'x', group: 'x' },
  } as unknown as LoopDeps;

  const connector = new DiscordConnector({
    loop,
    sessions: loop.sessions,
    inbox: new DiscordInbox(new DatabaseCtor(':memory:')),
    api,
    config,
    savePairing: (next) => {
      saved.push(next);
    },
  });
  return { connector, sent, turns, saved, config };
}

/** Feeds messages through the inbox exactly as the gateway's dispatch handler would. */
async function deliver(h: ReturnType<typeof harness>, messages: DiscordMessage[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: DiscordInbox } }).deps.inbox;
  for (const m of messages) inbox.accept(m.id, m, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('pairing through the connector', () => {
  it('has no owner at all while unpaired', () => {
    const i = parseMessage(msg('1', { authorId: OWNER, text: 'ciao' }));
    expect(principalFor(i!, undefined).tenant).not.toBe('host');
  });

  it('a message with no author is nobody, not everybody', async () => {
    // The same hole `connectors/telegram/pairing-flow.test.ts` names for
    // Telegram, in Discord's own shape: a webhook message carries no `author`
    // at all, and without the explicit check `undefined === undefined` would
    // read as a match against an unset owner id.
    const senderless = { id: '1', channel_id: '42', content: 'ciao' } as DiscordMessage;
    expect(parseMessage(senderless)).toBeNull();
  });

  it('binds the person who echoes the code, and runs no turn for it', async () => {
    const code = generatePairingCode();
    const h = harness({ token: 't', pairing: startPairing(code, new Date()) });

    await deliver(h, [msg('1', { authorId: OWNER, text: code })]);

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ ownerUserId: OWNER, pairing: null });
    expect(h.sent[0]?.text).toMatch(/Sei tu/);
    expect(h.turns).toEqual([]);
  });

  it('a stranger guessing burns an attempt and stays a stranger', async () => {
    const code = generatePairingCode();
    const h = harness({ token: 't', pairing: startPairing(code, new Date()) });

    await deliver(h, [msg('1', { authorId: STRANGER, text: 'ABCD-1234' })]);

    expect(h.saved[0]?.pairing?.attempts).toBe(1);
    expect(h.saved[0]?.ownerUserId).toBeUndefined();
    expect(h.sent[0]?.text).toMatch(/Non è quello/);
  });

  it('ordinary conversation does not burn the owner tries', async () => {
    const h = harness({ token: 't', pairing: startPairing(generatePairingCode(), new Date()) });
    await deliver(h, [msg('1', { authorId: STRANGER, text: 'ciao come stai' })]);
    expect(h.saved).toHaveLength(0);
  });

  it('once paired, the code path is closed', async () => {
    const code = generatePairingCode();
    const h = harness({ token: 't', ownerUserId: OWNER, pairing: startPairing(code, new Date()) });
    await deliver(h, [msg('1', { authorId: STRANGER, text: code })]);
    expect(h.saved).toHaveLength(0);
  });
});
