import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { TelegramError, type TelegramApiLike } from './api.js';
import {
  deliverTelegram,
  type TelegramDeliveryPlanPart,
  TelegramDeliveryStore,
} from './delivery.js';
import { UpdateInbox } from './updates.js';

const at = (() => {
  let n = 0;
  return () => `2026-08-25T12:00:${String(n++).padStart(2, '0')}.000Z`;
})();

function sendPart(html: string, index: number): TelegramDeliveryPlanPart {
  return {
    operation: 'send',
    chatId: 42,
    replyTo: index === 0 ? 7 : null,
    editMessageId: null,
    html,
  };
}

function apiWith(sendMessage: TelegramApiLike['sendMessage']): TelegramApiLike {
  return { sendMessage } as TelegramApiLike;
}

describe('TelegramDeliveryStore — write ahead and crash recovery', () => {
  it('adds its schema to a populated production database without changing the durable inbox', () => {
    const db = new DatabaseCtor(':memory:');
    const inbox = new UpdateInbox(db);
    inbox.accept([{ update_id: 77 }], '2026-08-25T11:59:00.000Z');

    const store = new TelegramDeliveryStore(db);

    expect(inbox.get(77)).toMatchObject({ updateId: 77, turnId: null, settledAt: null });
    expect(store.parts('turn-never-planned')).toEqual([]);
  });

  it('an attempting row becomes possibly_sent after restart, never pending', () => {
    const db = new DatabaseCtor(':memory:');
    const first = new TelegramDeliveryStore(db);
    first.plan('turn-1', [sendPart('answer', 0)], at());
    expect(first.claim('turn-1', 0, 'attempt-a', at())).toBe(true);

    const afterRestart = new TelegramDeliveryStore(db);

    expect(afterRestart.parts('turn-1')).toMatchObject([
      { status: 'possibly_sent', attemptId: 'attempt-a', html: 'answer' },
    ]);
  });

  it('first writer wins the per-part attempt claim', () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    store.plan('turn-race', [sendPart('answer', 0)], at());

    expect(store.claim('turn-race', 0, 'winner', at())).toBe(true);
    expect(store.claim('turn-race', 0, 'loser', at())).toBe(false);
    expect(store.parts('turn-race')[0]?.attemptId).toBe('winner');
  });

  it('recovery keeps the first frozen wire plan byte-for-byte', () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    store.plan('turn-frozen', [sendPart('<b>originale</b>', 0)], at());

    expect(store.plan('turn-frozen', [sendPart('<i>render nuovo</i>', 0)], at())).toMatchObject([
      { html: '<b>originale</b>', replyTo: 7, status: 'pending' },
    ]);
  });
});

describe('deliverTelegram — ambiguous effects are terminal', () => {
  it('does not retry when Telegram accepted a message but its response was lost', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    let accepted = 0;
    const sendMessage = vi.fn(async () => {
      accepted += 1;
      throw new TypeError('response stream closed');
    });
    const plan = [sendPart('answer', 0)];

    await expect(deliverTelegram(store, apiWith(sendMessage), 'turn-unknown', plan, at)).resolves.toBe(
      'possibly_sent',
    );
    await expect(deliverTelegram(store, apiWith(sendMessage), 'turn-unknown', plan, at)).resolves.toBe(
      'possibly_sent',
    );

    expect(accepted).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(store.parts('turn-unknown')[0]?.status).toBe('possibly_sent');
  });

  it('lets one concurrent delivery cross the wire and defers the loser', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    let release!: (message: { message_id: number }) => void;
    const sendMessage = vi.fn(
      () => new Promise<{ message_id: number }>((resolve) => {
        release = resolve;
      }) as never,
    );
    const plan = [sendPart('answer', 0)];

    const winner = deliverTelegram(store, apiWith(sendMessage), 'turn-concurrent', plan, at);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await expect(deliverTelegram(store, apiWith(sendMessage), 'turn-concurrent', plan, at)).resolves.toBe('deferred');
    release({ message_id: 91 });

    await expect(winner).resolves.toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(store.parts('turn-concurrent')[0]).toMatchObject({ status: 'sent', telegramMessageId: 91 });
  });

  it('never replays a confirmed multipart prefix and stops the suffix after an ambiguous part', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const sent: string[] = [];
    const sendMessage = vi.fn(async (_chatId: number, html: string) => {
      sent.push(html);
      if (html === 'part-1') throw new TypeError('accepted, response lost');
      return { message_id: sent.length } as never;
    });
    const plan = ['part-0', 'part-1', 'part-2'].map(sendPart);

    expect(await deliverTelegram(store, apiWith(sendMessage), 'turn-multipart', plan, at)).toBe('possibly_sent');
    expect(await deliverTelegram(store, apiWith(sendMessage), 'turn-multipart', plan, at)).toBe('possibly_sent');

    expect(sent).toEqual(['part-0', 'part-1']);
    expect(store.parts('turn-multipart').map((part) => part.status)).toEqual([
      'sent',
      'possibly_sent',
      'pending',
    ]);
  });

  it('retries only the explicitly rejected part, not an earlier confirmed one', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const sent: string[] = [];
    let rejectOnce = true;
    const sendMessage = vi.fn(async (_chatId: number, html: string) => {
      if (html === 'part-1' && rejectOnce) {
        rejectOnce = false;
        throw new TelegramError(429, 'Too Many Requests', 1);
      }
      sent.push(html);
      return { message_id: sent.length } as never;
    });
    const plan = ['part-0', 'part-1', 'part-2'].map(sendPart);

    await expect(deliverTelegram(store, apiWith(sendMessage), 'turn-rejected', plan, at)).rejects.toThrow('429');
    await expect(deliverTelegram(store, apiWith(sendMessage), 'turn-rejected', plan, at)).resolves.toBe('sent');

    expect(sent).toEqual(['part-0', 'part-1', 'part-2']);
    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(store.parts('turn-rejected').map((part) => part.status)).toEqual(['sent', 'sent', 'sent']);
  });
});
