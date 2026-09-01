import { describe, expect, it, vi } from 'vitest';
import { startPresence } from './presence.js';
import type { TelegramApiLike } from './api.js';

/**
 * The streaming half of presence — DAY-1 requirement B11. Rate limit, coalescing,
 * disable-on-failure and the "draft is the activity indicator" rule, each
 * against a fake `TelegramApiLike` that records every call with the fake
 * clock's own timestamp, under `vi.useFakeTimers()` so a test asserting
 * ">=1s apart" costs nothing in wall-clock time and is not flaky under load.
 *
 * Reads through the public `startPresence`/`Presence` contract only — the
 * point of most of these is that they would go red if the *wiring* inside
 * `startPresence` were undone (drop the rate limit, drop the coalescing,
 * drop the heartbeat-silencing), which is the PRACTICES.md#model-judgement-and-deterministic-contracts-stay-separate shape: assert the
 * mechanism is reached, not only that its pieces compile.
 */

type Recorded = { method: string; at: number; text?: string; draftId?: number };

/**
 * `makeOverrides` gets `calls` too, not just a plain object to spread in —
 * a test that wants "record the attempt, THEN fail it" (the disable-on-
 * failure test below) needs to push before throwing, which a bare object
 * literal built before `calls` exists cannot do.
 */
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
    sendMessage: async (chatId, html) => {
      calls.push({ method: 'sendMessage', at: Date.now(), text: html });
      return { message_id: 555, date: 0, chat: { id: chatId, type: 'supergroup' } } as never;
    },
    editMessageText: async (_chatId, _messageId, html) => {
      calls.push({ method: 'editMessageText', at: Date.now(), text: html });
      return true;
    },
    deleteMessage: async () => {
      calls.push({ method: 'deleteMessage', at: Date.now() });
      return true;
    },
    sendChatAction: async () => {
      calls.push({ method: 'sendChatAction', at: Date.now() });
      return true;
    },
    sendMessageDraft: async (_chatId, draftId, text) => {
      calls.push({ method: 'sendMessageDraft', at: Date.now(), text, draftId });
      return true;
    },
    fileUrl: async () => 'https://example.test/file',
    setMyCommands: async () => true,
    answerCallbackQuery: async () => true,
    ...(makeOverrides ? makeOverrides(calls) : {}),
  };
  return { api, calls };
}

/** The live (non-empty-keepalive) drafts sent so far. */
const liveDrafts = (calls: Recorded[]) => calls.filter((c) => c.method === 'sendMessageDraft' && c.text !== '');

describe('telegram presence · streaming (B11)', () => {
  it('sends the first live update immediately and rate-limits the rest to >=1s apart', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1, { isPrivate: true });

      presence.streamText('ciao');
      await vi.advanceTimersByTimeAsync(0);
      expect(liveDrafts(calls)).toHaveLength(1);
      expect(liveDrafts(calls)[0]?.text).toBe('ciao');

      // Arrives 200ms later — inside the 1s window, so it must not fire yet.
      await vi.advanceTimersByTimeAsync(200);
      presence.streamText('ciao mondo');
      await vi.advanceTimersByTimeAsync(200);
      expect(liveDrafts(calls)).toHaveLength(1);

      // The window opens; the coalesced latest value goes out.
      await vi.advanceTimersByTimeAsync(700);
      expect(liveDrafts(calls)).toHaveLength(2);
      expect(liveDrafts(calls)[1]?.text).toBe('ciao mondo');

      const [t0, t1] = liveDrafts(calls).map((c) => c.at);
      expect(t1! - t0!).toBeGreaterThanOrEqual(1000);

      await presence.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a non-zero, stable draft_id on every sendMessageDraft call — the Bot API rejects draft_id 0 with a 400 (api.ts)', async () => {
    // Every fake above (and in streaming.test.ts) took `sendMessageDraft`'s
    // draftId parameter and threw it away, so `nextDraftId()` regressing to
    // "always 0" broke no test: the fakes answered `true` regardless of what
    // they were called with. This test is the one that actually looks at the
    // argument, the same way the real Bot API does.
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1, { isPrivate: true });

      presence.streamText('ciao');
      await vi.advanceTimersByTimeAsync(0);
      presence.streamText('ciao mondo');
      // Past DRAFT_RENEW_MS (22s) too, so this covers both the live-content
      // draft and the empty-text keepalive renewal — `api.ts`'s docstring
      // says a renewal must reuse the same draftId as the preview it renews.
      await vi.advanceTimersByTimeAsync(23_000);
      await presence.stop();

      const draftCalls = calls.filter((c) => c.method === 'sendMessageDraft');
      expect(draftCalls.length).toBeGreaterThan(1);
      const draftIds = draftCalls.map((c) => c.draftId);
      expect(draftIds.every((id) => typeof id === 'number' && id !== 0)).toBe(true);
      // Stable: one presence is one ongoing preview, so every call it makes —
      // live update or keepalive — has to carry the same draft_id, not a
      // fresh one each time.
      expect(new Set(draftIds).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces rapid calls into the latest value instead of sending every one', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1, { isPrivate: true });

      presence.streamText('a');
      await vi.advanceTimersByTimeAsync(0); // first flush fires immediately

      // Three calls landing inside the same rate-limit window.
      presence.streamText('a b');
      presence.streamText('a b c');
      presence.streamText('a b c d');
      await vi.advanceTimersByTimeAsync(1000);

      // Two live sends total, not four — the middle two were coalesced away.
      expect(liveDrafts(calls)).toHaveLength(2);
      expect(liveDrafts(calls)[1]?.text).toBe('a b c d');

      await presence.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns streaming off for the session after the first failed live update, without flooding retries — MUTATION: a rate limit alone would not catch a broken transport looping forever', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi((recorded) => ({
        sendMessageDraft: async (_chatId, _draftId, html) => {
          recorded.push({ method: 'sendMessageDraft', at: Date.now(), text: html });
          if (html === '') return true;
          throw new Error('telegram rejected it');
        },
      }));
      const presence = await startPresence(api, 1, { isPrivate: true });

      presence.streamText('primo tentativo');
      await vi.advanceTimersByTimeAsync(0);
      presence.streamText('secondo tentativo, non deve nemmeno provare');
      await vi.advanceTimersByTimeAsync(5000);

      expect(liveDrafts(calls)).toHaveLength(1); // exactly one content attempt, ever, for this session
      expect(presence.lastStreamedRaw()).toBeUndefined();

      await presence.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops live-updating once the text needs more than one Telegram message, and never sends a partial-then-abandoned draft', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1, { isPrivate: true });

      presence.streamText('x'.repeat(5000)); // over Telegram's 4096-char single-message limit
      await vi.advanceTimersByTimeAsync(0);
      expect(liveDrafts(calls)).toHaveLength(0);

      presence.streamText('x'.repeat(5001)); // still overflowing — must stay off, not retry
      await vi.advanceTimersByTimeAsync(2000);
      expect(liveDrafts(calls)).toHaveLength(0);

      await presence.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the draft IS the activity indicator: real content silences the typing/keepalive heartbeats, not the other way round', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1, { isPrivate: true });
      await vi.advanceTimersByTimeAsync(0);

      // The keepalive did fire at least once before any real content existed.
      const isHeartbeat = (c: Recorded) => c.method === 'sendChatAction' || (c.method === 'sendMessageDraft' && c.text === '');
      expect(calls.some(isHeartbeat)).toBe(true);

      presence.streamText('vero contenuto della risposta');
      await vi.advanceTimersByTimeAsync(0);
      const markAfterFirstFlush = calls.length;

      // Long enough for several heartbeat ticks (4s action, 22s draft) if they
      // were still running.
      await vi.advanceTimersByTimeAsync(30_000);
      const newHeartbeats = calls.slice(markAfterFirstFlush).filter(isHeartbeat);
      expect(newHeartbeats).toHaveLength(0);

      await presence.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() sends a still-pending update immediately instead of abandoning it, and nothing fires after it returns', async () => {
    // A real bug this test exists to pin down: a turn fast enough to finish
    // before a scheduled flush's own `setTimeout` gets a macrotask turn
    // would previously have its live update silently cancelled by `stop()`
    // — streaming would look wired and show nothing, in exactly the shape
    // `connectors/telegram/streaming.test.ts`'s private-chat scenario first
    // caught it in. `stop()` is streaming's *last* act, not a cancellation.
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1, { isPrivate: true });
      await vi.advanceTimersByTimeAsync(0);

      presence.streamText('appena in tempo');
      // No `advanceTimersByTimeAsync` here on purpose: `stop()` is called
      // before the just-scheduled flush's own timer would ever fire on its
      // own, which is exactly the race this test pins down.
      await presence.stop();

      expect(liveDrafts(calls)).toHaveLength(1);
      expect(liveDrafts(calls)[0]?.text).toBe('appena in tempo');
      expect(presence.lastStreamedRaw()).toBe('appena in tempo');

      const before = calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.length).toBe(before); // nothing more fires once stop() has returned
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() is idempotent', async () => {
    const { api } = fakeApi();
    const presence = await startPresence(api, 1, { isPrivate: true });
    await presence.stop();
    await expect(presence.stop()).resolves.toBeUndefined();
  });

  it('group presence never creates an unjournaled message, so a crash cannot orphan a placeholder', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const presence = await startPresence(api, 1, { isPrivate: false, placeholder: 'sto guardando…' });
      expect('editMessageId' in presence).toBe(false);
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);

      presence.streamText('qualcosa');
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);

      await presence.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
