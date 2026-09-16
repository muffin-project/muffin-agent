import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { describe, expect, it } from 'vitest';
import { generatePairingCode, startPairing, type PendingPairing } from '../../core/config/pairing.js';
import type { LoopDeps } from '../../agent/loop.js';
import { SessionStore } from '../../core/session/store.js';
import { TelegramConnector, type TelegramConfig, parseUpdate, principalFor } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';
import type { TelegramApi } from './api.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The bind, driven through the real connector.
 *
 * The primitive had nine tests and no caller; this is the caller, and it drives
 * `TelegramConnector.drain()` rather than reimplementing its order — a test
 * that mirrors the logic it checks proves only that I can write the same code
 * twice.
 *
 * What has to hold: an unpaired surface has **no owner at all**, a turn never
 * runs for a message that was a pairing attempt, and the person who echoes the
 * code becomes the owner while everyone else stays a stranger whatever they
 * type.
 */

const OWNER = 777001;
const STRANGER = 777002;

const msg = (id: number, over: { chatId: number; fromId: number; text: string }): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: over.chatId, type: 'private' },
      from: { id: over.fromId, is_bot: false, first_name: 'x' },
      text: over.text,
    },
  }) as unknown as Update;

function harness(config: TelegramConfig) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-pairing-'));
  const sent: { chatId: number; text: string }[] = [];
  const turns: string[] = [];
  const saved: { ownerUserId?: number; ownerChatId?: number; pairing: PendingPairing | null }[] = [];

  const api = {
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return {} as never;
    },
    sendChatAction: async () => true,
  } as unknown as TelegramApi;

  const loop = {
    // A turn that runs is a turn the pairing gate failed to stop.
    provider: {
      kind: 'openai-compat' as const,
      chat: async () => {
        turns.push('turn ran');
        return {
          text: 'ok', toolCalls: [], stopReason: 'end' as const,
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

  const db = new DatabaseCtor(':memory:');
  const connector = new TelegramConnector({
    loop,
    sessions: loop.sessions,
    lane: new ModelLane(),
    inbox: new UpdateInbox(db),
    delivery: new TelegramDeliveryStore(db),
    api,
    config,
    savePairing: (next) => {
      saved.push(next);
    },
  });
  return { connector, sent, turns, saved, config };
}

/** Feeds updates through the inbox exactly as polling would. */
async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('pairing through the connector', () => {
  it('has no owner at all while unpaired', () => {
    const i = parseUpdate(msg(1, { chatId: OWNER, fromId: OWNER, text: 'ciao' }));
    expect(principalFor(i!, undefined).tenant).not.toBe('host');
  });

  it('a message with no sender is nobody, not everybody', async () => {
    // `undefined === undefined` is true, so without the explicit unpaired check
    // a message carrying no `from` would match an absent ownerUserId and arrive
    // as the owner. Constructed here because the mutation that removes that
    // check passed every other test in the file. The check now lives in
    // `identify` (`core/surface/types.ts`) and guards every surface at once —
    // the same hole on Discord is a webhook message, which also has no author.
    const senderless = {
      update_id: 1,
      message: { message_id: 1, date: 0, chat: { id: OWNER, type: 'private' }, text: 'ciao' },
    } as unknown as Update;
    const parsed = parseUpdate(senderless)!;
    expect(parsed.fromId).toBe(0);
    expect(principalFor(parsed, undefined).principal.kind).toBe('member');
    expect(principalFor(parsed, OWNER).principal.kind).toBe('member');
  });

  it('binds the person who echoes the code, and runs no turn for it', async () => {
    const code = generatePairingCode();
    const h = harness({ token: 't', pairing: startPairing(code, new Date()) });

    await deliver(h, [msg(1, { chatId: OWNER, fromId: OWNER, text: code })]);

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ ownerUserId: OWNER, ownerChatId: OWNER, pairing: null });
    expect(h.sent[0]?.text).toMatch(/Sei tu/);
    // The code was never a question for the model.
    expect(h.turns).toEqual([]);
  });

  it('a stranger guessing burns an attempt silently and stays a stranger', async () => {
    const code = generatePairingCode();
    const h = harness({ token: 't', pairing: startPairing(code, new Date()) });

    await deliver(h, [msg(1, { chatId: STRANGER, fromId: STRANGER, text: 'ABCD-1234' })]);

    expect(h.saved[0]?.pairing?.attempts).toBe(1);
    expect(h.saved[0]?.ownerUserId).toBeUndefined();
    expect(h.sent).toEqual([]);
  });

  it('ordinary conversation does not burn the owner tries', async () => {
    // A stranger saying "ciao" must not spend the attempts of someone who is
    // still walking to their phone.
    const h = harness({ token: 't', pairing: startPairing(generatePairingCode(), new Date()) });
    await deliver(h, [msg(1, { chatId: STRANGER, fromId: STRANGER, text: 'ciao come stai' })]);
    expect(h.saved).toHaveLength(0);
  });

  it('once paired, the code path is closed', async () => {
    const code = generatePairingCode();
    const h = harness({ token: 't', ownerUserId: OWNER, pairing: startPairing(code, new Date()) });
    await deliver(h, [msg(1, { chatId: STRANGER, fromId: STRANGER, text: code })]);
    // Already owned: the right code from the wrong person changes nothing.
    expect(h.saved).toHaveLength(0);
  });
});
