import { describe, expect, it, vi } from 'vitest';
import { startPresence } from './presence.js';
import type { TelegramApiLike } from './api.js';

/**
 * Presence, after B11's streaming moved into `transcript.ts#live()`
 * (2026-09-04, `docs/evidence/turno-sospendibile.md`). What is left is the
 * "typing…" heartbeat alone — no draft, no rate limiter, no disable-on-
 * failure state machine, because there is no longer a second live channel
 * for those to protect. Fake timers because the one thing left to prove is
 * still a *when*: the heartbeat keeps firing every `ACTION_RENEW_MS`, and
 * stops the moment `stop()` is called.
 */

type Recorded = { method: string; at: number };

function fakeApi(makeOverrides?: (calls: Recorded[]) => Partial<TelegramApiLike>): { api: TelegramApiLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const api: TelegramApiLike = {
    call: async () => {
      throw new Error('unused in this fake');
    },
    upload: async () => {
      throw new Error('unused in this fake');
    },
    getMe: async () => {
      throw new Error('unused in this fake');
    },
    getUpdates: async () => [],
    sendMessage: async (chatId) => {
      calls.push({ method: 'sendMessage', at: Date.now() });
      return { message_id: 555, date: 0, chat: { id: chatId, type: 'supergroup' } } as never;
    },
    editMessageText: async () => {
      calls.push({ method: 'editMessageText', at: Date.now() });
      return true;
    },
    editMessageReplyMarkup: async () => {
      calls.push({ method: 'editMessageReplyMarkup', at: Date.now() });
      return true;
    },
    deleteMessage: async () => {
      calls.push({ method: 'deleteMessage', at: Date.now() });
      return true;
    },
    getChatMember: async () => ({ status: 'member' }),
    leaveChat: async () => true,
    sendChatAction: async () => {
      calls.push({ method: 'sendChatAction', at: Date.now() });
      return true;
    },
    sendMessageDraft: async () => {
      calls.push({ method: 'sendMessageDraft', at: Date.now() });
      return true;
    },
    sendRichMessage: async () => {
      throw new Error('unused in this fake');
    },
    editMessageRichText: async () => {
      throw new Error('unused in this fake');
    },
    sendRichMessageDraft: async () => {
      throw new Error('unused in this fake');
    },
    fileUrl: async () => 'https://example.test/file',
    setMyCommands: async () => true,
    answerCallbackQuery: async () => true,
    ...(makeOverrides ? makeOverrides(calls) : {}),
  };
  return { api, calls };
}

describe('telegram presence · the "typing…" heartbeat', () => {
  it('sends the action immediately, then again every ~4s, in a private chat and in a group alike', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1);
      expect(calls.filter((c) => c.method === 'sendChatAction')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(calls.filter((c) => c.method === 'sendChatAction')).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(calls.filter((c) => c.method === 'sendChatAction')).toHaveLength(4);

      await presence.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() cancels the heartbeat — nothing fires after it returns', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1);
      await presence.stop();

      const before = calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() is idempotent', async () => {
    const { api } = fakeApi();
    const presence = await startPresence(api, 1);
    await presence.stop();
    await expect(presence.stop()).resolves.toBeUndefined();
  });

  it('a failed sendChatAction is swallowed — it is decoration, never worth taking the turn down for', async () => {
    vi.useFakeTimers();
    try {
      const { api } = fakeApi((recorded) => ({
        sendChatAction: async () => {
          recorded.push({ method: 'sendChatAction', at: Date.now() });
          throw new Error('telegram rejected it');
        },
      }));
      const presence = await startPresence(api, 1);
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(presence.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never creates or edits a message — B11 streaming now lives entirely in transcript.ts', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1);
      await vi.advanceTimersByTimeAsync(10_000);
      await presence.stop();

      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
