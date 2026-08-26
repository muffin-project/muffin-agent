import { describe, expect, it, vi } from 'vitest';
import { startProgress, formatTelegramProgress } from './progress.js';
import type { TelegramApiLike } from './api.js';
import type { TurnEvent } from '../../agent/loop.js';

/**
 * `startProgress` — M5-BIS B13. Rate limit, coalescing, no-op-on-unchanged,
 * disable-on-failure and cleanup-on-stop, each against a fake `TelegramApiLike`
 * that records every call with the fake clock's own timestamp, the same shape
 * `presence.test.ts` uses for the sibling sink and for the same reason: a test
 * asserting ">=3s apart" costs nothing in wall-clock time and is not flaky
 * under load.
 *
 * Reads through the public `startProgress`/`ProgressReporter` contract only —
 * the point of most of these is that they would go red if the *wiring* inside
 * `startProgress` were undone (drop the rate limit, drop the coalescing, drop
 * disable-on-failure), which is the PRACTICES §5 shape: assert the mechanism
 * is reached, not only that its pieces compile. The *composition* — that
 * `agent/loop.ts`'s real `onProgress` calls reach a real `TelegramConnector`'s
 * Telegram calls — is `streaming.test.ts`'s own "M5-BIS B13" describe block,
 * not this file.
 */

type Recorded = { method: string; at: number; text?: string; messageId?: number };

function fakeApi(makeOverrides?: (calls: Recorded[]) => Partial<TelegramApiLike>): { api: TelegramApiLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let nextMessageId = 700;
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
      const messageId = nextMessageId++;
      calls.push({ method: 'sendMessage', at: Date.now(), text: html, messageId });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
    },
    editMessageText: async (_chatId, messageId, html) => {
      calls.push({ method: 'editMessageText', at: Date.now(), text: html, messageId });
      return true;
    },
    deleteMessage: async (_chatId, messageId) => {
      calls.push({ method: 'deleteMessage', at: Date.now(), messageId });
      return true;
    },
    sendChatAction: async () => {
      throw new Error('unused in this fake');
    },
    sendMessageDraft: async () => {
      throw new Error('unused in this fake');
    },
    fileUrl: async () => 'https://example.test/file',
    ...(makeOverrides ? makeOverrides(calls) : {}),
  };
  return { api, calls };
}

const round = (n: number): TurnEvent => ({ type: 'round', n });
const toolStart = (name: string): TurnEvent => ({ type: 'tool_start', name, capability: 'test' });
const toolEnd = (name: string, isError = false): TurnEvent => ({ type: 'tool_end', name, ms: 1, isError });
const modelEvent = (stopReason: string): TurnEvent => ({
  type: 'model',
  model: 'test-model',
  ms: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  stopReason,
});

describe('telegram progress · formatTelegramProgress (M5-BIS B13)', () => {
  it('renders every TurnEvent variant as one summarised line — brief\'s own example shape', () => {
    expect(formatTelegramProgress(3, round(3), 0)).toBe('passaggio 3 · sto pensando · 0s');
    expect(formatTelegramProgress(2, modelEvent('tool_use'), 5000)).toBe('passaggio 2 · ho deciso i prossimi passi · 5s');
    expect(formatTelegramProgress(2, modelEvent('end'), 5000)).toBe('passaggio 2 · sto scrivendo la risposta · 5s');
    expect(formatTelegramProgress(4, toolStart('shell_run'), 47_000)).toBe('passaggio 4 · sto usando shell_run · 47s');
    expect(formatTelegramProgress(4, toolEnd('shell_run', false), 50_000)).toBe('passaggio 4 · shell_run fatto · 50s');
    expect(formatTelegramProgress(4, toolEnd('shell_run', true), 50_000)).toBe('passaggio 4 · shell_run fallito · 50s');
  });

  it('escapes HTML in a tool name — the model chooses `call.name`, and this line is sent with parse_mode HTML', () => {
    const text = formatTelegramProgress(1, toolStart('<script>&</script>'), 0);
    expect(text).not.toContain('<script>');
    expect(text).toBe('passaggio 1 · sto usando &lt;script&gt;&amp;&lt;/script&gt; · 0s');
  });

  it('rounds elapsed time to the nearest second and never prints a negative one', () => {
    expect(formatTelegramProgress(1, round(1), 499)).toBe('passaggio 1 · sto pensando · 0s');
    expect(formatTelegramProgress(1, round(1), 500)).toBe('passaggio 1 · sto pensando · 1s');
    expect(formatTelegramProgress(1, round(1), -50)).toBe('passaggio 1 · sto pensando · 0s');
  });
});

describe('telegram progress · startProgress (M5-BIS B13)', () => {
  it('creates the status message on the first event and rate-limits edits to >=3s apart', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      expect(calls[0]?.text).toBe('passaggio 1 · sto pensando · 0s');

      // Arrives inside the 3s window (at t=1s) — must coalesce, not fire yet.
      await vi.advanceTimersByTimeAsync(1000);
      progress.report(toolStart('shell_run'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);

      // The window opens at t=3s; the coalesced latest value goes out as an
      // edit — but its elapsed time reads "1s", not "3s": a progress event
      // reports a fact already true *when it happened* (`report`'s own call
      // site, t=1s), never re-timestamped at whatever later instant the
      // throttle finally lets it out.
      await vi.advanceTimersByTimeAsync(1000);
      const edits = calls.filter((c) => c.method === 'editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.text).toBe('passaggio 1 · sto usando shell_run · 1s');

      const [t0, t1] = [calls[0]!.at, edits[0]!.at];
      expect(t1 - t0).toBeGreaterThanOrEqual(3000);

      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never duplicates the message — every update after the first edits the same message id', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      progress.report(round(2));
      await vi.advanceTimersByTimeAsync(3000);
      progress.report(round(3));
      await vi.advanceTimersByTimeAsync(3000);

      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      const messageId = calls[0]!.messageId;
      const edits = calls.filter((c) => c.method === 'editMessageText');
      expect(edits.length).toBeGreaterThanOrEqual(1);
      expect(edits.every((c) => c.messageId === messageId)).toBe(true);

      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips an edit whose rendered text has not changed since the last one shown — Telegram itself rejects a no-op edit', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(toolStart('shell_run'));
      await vi.advanceTimersByTimeAsync(0);
      const afterFirst = calls.length;

      // The exact same event again, at the exact same fake-clock instant: the
      // rendered line is byte-identical.
      progress.report(toolStart('shell_run'));
      await vi.advanceTimersByTimeAsync(3000); // well past the throttle window reopening
      expect(calls.length).toBe(afterFirst); // no edit was ever attempted

      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('MUTATION-worthy: disables further attempts after the first failed send, without retrying into it', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { api } = fakeApi(() => ({
        sendMessage: async () => {
          attempts += 1; // counted before throwing, so a dropped `disabled` flag still shows up
          throw new Error('telegram rejected it');
        },
      }));
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0); // one attempt, fails
      progress.report(round(2));
      await vi.advanceTimersByTimeAsync(5000); // past the throttle window — a second attempt here would mean `disabled` never latched
      progress.report(round(3));
      await vi.advanceTimersByTimeAsync(5000);

      expect(attempts).toBe(1);
      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed edit (after a successful create) also disables the rest of the turn — MUTATION: dropping `disabled` would retry every 3s forever', async () => {
    vi.useFakeTimers();
    try {
      let editAttempts = 0;
      const { api, calls } = fakeApi(() => ({
        editMessageText: async () => {
          editAttempts += 1;
          throw new Error('telegram rejected it');
        },
      }));
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0); // the create succeeds
      progress.report(round(2));
      await vi.advanceTimersByTimeAsync(3000); // one failed edit attempt
      progress.report(round(3)); // must not attempt a second edit
      await vi.advanceTimersByTimeAsync(10_000);

      expect(editAttempts).toBe(1);
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() removes the status message it created, with the same message id', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      const messageId = calls[0]!.messageId;

      await progress.stop();

      const deletions = calls.filter((c) => c.method === 'deleteMessage');
      expect(deletions).toHaveLength(1);
      expect(deletions[0]?.messageId).toBe(messageId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() before any event was ever shown makes no API call at all', async () => {
    const { api, calls } = fakeApi();
    const progress = startProgress(api, 1);
    await progress.stop();
    expect(calls).toHaveLength(0);
  });

  it('stop() is idempotent', async () => {
    vi.useFakeTimers();
    try {
      const { api } = fakeApi();
      const progress = startProgress(api, 1);
      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      await progress.stop();
      await expect(progress.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a report() after stop() is ignored — no message is recreated', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);
      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      await progress.stop();
      const before = calls.length;

      progress.report(round(2));
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT force out a never-yet-shown update on stop() — deliberate divergence from presence.ts', async () => {
    // `presence.ts`'s own `stop()` forces out whatever `streamText` last
    // accumulated, because that channel (`sendMessageDraft`) is exclusive to
    // it. This reporter's `send()` calls `sendMessage`/`editMessageText` —
    // the *same* methods the durable answer is sent on — so a forced flush
    // here would inject one more call onto that exact channel for a status
    // line about to be deleted regardless. `connectors/telegram/inbound-
    // unit.test.ts`'s fault-point tests are what first caught this the other
    // way round (extra `sendMessage` calls where those tests assert an exact
    // count) — this test pins the fix down directly.
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(round(1)); // schedules its own flush at wait=0, never allowed to fire
      // No `advanceTimersByTimeAsync` here on purpose — `stop()` runs before
      // that timer ever would.
      await progress.stop();

      expect(calls).toHaveLength(0); // nothing sent, nothing to delete
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed deleteMessage on stop() is swallowed, not thrown', async () => {
    vi.useFakeTimers();
    try {
      const { api } = fakeApi(() => ({
        deleteMessage: async () => {
          throw new Error('telegram rejected it');
        },
      }));
      const progress = startProgress(api, 1);
      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);

      await expect(progress.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('traces a swallowed failure through the optional logger, and never throws without one', async () => {
    vi.useFakeTimers();
    try {
      const logged: string[] = [];
      const { api } = fakeApi(() => ({
        sendMessage: async () => {
          throw new Error('telegram rejected it');
        },
      }));
      const progress = startProgress(api, 1, { log: (line) => logged.push(line) });
      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);

      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('telegram rejected it');
      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
