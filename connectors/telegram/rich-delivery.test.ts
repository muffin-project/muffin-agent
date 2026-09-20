import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { TelegramError, type TelegramApiLike } from './api.js';
import {
  deliverTelegram,
  type TelegramDeliveryPlanPart,
  TelegramDeliveryStore,
} from './delivery.js';
import { renderForTelegram } from './render.js';
import { planRich, type OutboundRich } from './rich.js';

/**
 * Bot API 10.3 rich delivery (`delivery.ts`): the fault matrix.
 *
 * - B: structured answers ride ONE `sendRichMessage`;
 * - C: past-4096 rich is still one rich send, never a legacy split;
 * - E: deterministic rich rejection → frozen legacy chunks, no throw;
 * - F: ambiguous transport failure → `possibly_sent`, NO fallback send;
 * - H: rich edits + thread/topic routing through rejection;
 * - I: fallback past 4096 is actually chunked;
 * - peer modes: no OpenClaw-style giant plain send, no Hermes-style blind retry.
 *
 * Connector-level proofs (DM draft→final, over-compat end-to-end, stop
 * abort) live in `rich-connector.test.ts` and `stop-generation.test.ts`.
 */

const TABLE = ['| nome | q |', '| --- | --- |', '| pane | 2 |', '| latte | 3 |'].join('\n');

const at = (() => {
  let n = 0;
  return () => `2026-09-20T12:00:${String(n++).padStart(2, '0')}.000Z`;
})();

function richRequest(markdown: string, over: Partial<TelegramDeliveryPlanPart> = {}): TelegramDeliveryPlanPart[] {
  const plan = planRich(markdown);
  if (plan.mode !== 'rich') throw new Error(`test setup: expected a rich plan for ${JSON.stringify(markdown.slice(0, 60))}`);
  const legacy: TelegramDeliveryPlanPart[] = renderForTelegram(markdown).map((html) => ({
    operation: 'send',
    chatId: 42,
    threadId: null,
    replyTo: null,
    editMessageId: null,
    html,
  }));
  return [{ ...legacy[0]!, ...over, kind: 'rich' as const, rich: plan.message, fallback: legacy }];
}

function legacyRequest(markdown: string): TelegramDeliveryPlanPart[] {
  return renderForTelegram(markdown).map((html) => ({
    operation: 'send',
    chatId: 42,
    threadId: null,
    replyTo: null,
    editMessageId: null,
    html,
  }));
}

type Calls = { method: string; html?: string; rich?: OutboundRich; threadId?: number | null }[];

function trackingApi(failRich?: (rich: OutboundRich) => Promise<never>): { api: TelegramApiLike; calls: Calls } {
  const calls: Calls = [];
  let nextId = 1000;
  const api = {
    sendMessage: vi.fn(async (_chatId: number, html: string, options?: { threadId?: number }) => {
      calls.push({ method: 'sendMessage', html, threadId: options?.threadId ?? null });
      return { message_id: nextId++, date: 0, chat: { id: 42, type: 'private' } };
    }),
    sendRichMessage: vi.fn(async (_chatId: number, rich: OutboundRich, options?: { threadId?: number }) => {
      calls.push({ method: 'sendRichMessage', rich, threadId: options?.threadId ?? null });
      if (failRich) return failRich(rich);
      return { message_id: nextId++, date: 0, chat: { id: 42, type: 'private' } };
    }),
    editMessageText: vi.fn(async (_chatId: number, _messageId: number, html: string) => {
      calls.push({ method: 'editMessageText', html });
      return true;
    }),
    editMessageRichText: vi.fn(async (_chatId: number, _messageId: number, rich: OutboundRich) => {
      calls.push({ method: 'editMessageRichText', rich });
      return { message_id: 777, date: 0, chat: { id: 42, type: 'private' } };
    }),
  } as unknown as TelegramApiLike;
  return { api, calls };
}

describe('rich delivery · the happy paths', () => {
  it('B: a table answer rides ONE sendRichMessage, never sendMessage', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const { api, calls } = trackingApi();

    await expect(deliverTelegram(store, api, 'turn-rich', richRequest(TABLE), at)).resolves.toBe('sent');

    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
    expect(calls[0]!.rich!.blocks![0]).toMatchObject({ type: 'table' });
    expect(store.parts('turn-rich')).toMatchObject([{ kind: 'rich', status: 'sent' }]);
  });

  it('C: a rich answer past 4096 chars is still one rich send, not a legacy split', async () => {
    const rows = Array.from({ length: 80 }, (_, k) => `| voce numero ${k} con descrizione estesa e dettagli | ${k} | nota ${k} |`).join('\n');
    const markdown = `| nome | q | nota |\n| --- | --- | --- |\n${rows}`;
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const { api, calls } = trackingApi();

    await expect(deliverTelegram(store, api, 'turn-rich-long', richRequest(markdown), at)).resolves.toBe('sent');

    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('A: a simple prose answer uses the legacy path byte-identical', async () => {
    const markdown = 'Ciao, tutto bene con **calma** e `codice`.';
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const { api, calls } = trackingApi();

    await expect(deliverTelegram(store, api, 'turn-plain', legacyRequest(markdown), at)).resolves.toBe('sent');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'sendMessage' });
    // Byte-identical to what the pre-rich surface always sent.
    expect(calls[0]!.html).toBe(renderForTelegram(markdown)[0]);
    expect(store.parts('turn-plain')).toMatchObject([{ kind: 'legacy', status: 'sent' }]);
  });

  it('a plan() with a rich part missing its fallback throws fail-fast', () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const plan = planRich(TABLE);
    if (plan.mode !== 'rich') throw new Error('setup');
    expect(() =>
      store.plan('turn-broken', [{ operation: 'send', chatId: 1, threadId: null, replyTo: null, editMessageId: null, html: 'x', kind: 'rich', rich: plan.message }], at()),
    ).toThrow(/senza fallback/);
  });
});

describe('rich delivery · deterministic rejection falls back without loss', () => {
  function rejectedOnce(): { api: TelegramApiLike; calls: Calls } {
    let attempts = 0;
    return trackingApi(async () => {
      attempts += 1;
      throw new TelegramError(400, 'Bad Request: RICH_MESSAGE_INVALID');
    });
  }

  it('E: a 400 on sendRichMessage delivers the frozen legacy chunks and does not throw', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const { api, calls } = rejectedOnce();

    await expect(deliverTelegram(store, api, 'turn-fallback', richRequest(TABLE), at)).resolves.toBe('sent');

    // Exactly one rich attempt — a refusal is pronounced, never retried.
    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1);
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    // The OpenClaw failure mode, named: the fallback is bounded chunks, NOT
    // one giant plain send.
    for (const send of sends) expect(send.html!.length).toBeLessThanOrEqual(4096);
    expect(store.parts('turn-fallback').filter((p) => p.kind === 'rich')).toMatchObject([{ status: 'rejected' }]);
  });

  it('I: a long rich answer rejected degrades to chunked legacy without loss', async () => {
    const rows = Array.from({ length: 80 }, (_, k) => `| voce numero ${k} con descrizione estesa e dettagli | ${k} | nota ${k} |`).join('\n');
    const markdown = `| nome | q | nota |\n| --- | --- | --- |\n${rows}`;
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const { api, calls } = rejectedOnce();

    await expect(deliverTelegram(store, api, 'turn-fallback-long', richRequest(markdown), at)).resolves.toBe('sent');

    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends.length).toBeGreaterThan(1);
    for (const send of sends) expect(send.html!.length).toBeLessThanOrEqual(4096);
    // No loss: every row survives across the chunks.
    const joined = sends.map((s) => s.html).join('\n');
    expect(joined).toContain('voce numero 0');
    expect(joined).toContain('voce numero 79');
  });

  it('recovery after a rich rejection never re-attempts the rich payload', async () => {
    const db = new DatabaseCtor(':memory:');
    const first = new TelegramDeliveryStore(db);
    const { api, calls } = rejectedOnce();

    await expect(deliverTelegram(first, api, 'turn-replay', richRequest(TABLE), at)).resolves.toBe('sent');
    const afterFirst = calls.length;

    // A crash and a second process: the frozen rows decide, not a re-render.
    const second = new TelegramDeliveryStore(db);
    await expect(deliverTelegram(second, api, 'turn-replay', richRequest(TABLE), at)).resolves.toBe('sent');

    expect(calls).toHaveLength(afterFirst);
    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1);
  });

  it('a client-side protocol refusal (oversized rich) takes the same fallback road', async () => {
    // `plan()` refuses to freeze a rich row without fallback; the oversized
    // case reaches delivery only via `api.ts#assertRichFits`, which throws
    // the same 400 class. Here the homologous shape: a fake whose rich
    // method throws synchronously like the client guard.
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const { api, calls } = trackingApi();
    (api.sendRichMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TelegramError(400, 'Bad Request: rich message 40000 chars over the 32768 protocol maximum'));

    await expect(deliverTelegram(store, api, 'turn-oversize', richRequest(TABLE), at)).resolves.toBe('sent');
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(true);
  });
});

describe('rich delivery · ambiguous failure never duplicates', () => {
  it('F: a transport failure after sendRichMessage is possibly_sent with NO fallback send', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    // Hermes' stacked-retry shape: the POST may have landed, only the
    // response was lost. Any second visible send is a duplicate answer.
    const { api, calls } = trackingApi(async () => {
      throw new TypeError('response stream closed');
    });

    await expect(deliverTelegram(store, api, 'turn-ambiguous', richRequest(TABLE), at)).resolves.toBe('possibly_sent');
    await expect(deliverTelegram(store, api, 'turn-ambiguous', richRequest(TABLE), at)).resolves.toBe('possibly_sent');

    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
    expect(store.parts('turn-ambiguous')).toMatchObject([{ kind: 'rich', status: 'possibly_sent' }]);
  });
});

describe('rich delivery · edits and thread routing', () => {
  it('H: a rich edit on a transcript-owned message keeps chat and message, overflow keeps the thread', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const { api, calls } = trackingApi();
    // Records AND refuses: `mockRejectedValueOnce` would bypass the fake's
    // recording implementation, hiding the very attempt this test counts.
    (api.editMessageRichText as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_chatId: number, _messageId: number, rich: OutboundRich) => {
      calls.push({ method: 'editMessageRichText', rich });
      throw new TelegramError(400, 'Bad Request: RICH_MESSAGE_INVALID');
    });

    const plan = planRich(TABLE);
    if (plan.mode !== 'rich') throw new Error('setup');
    const legacyEdit: TelegramDeliveryPlanPart = {
      operation: 'edit',
      chatId: 42,
      threadId: 7,
      replyTo: null,
      editMessageId: 9001,
      html: renderForTelegram(TABLE)[0]!,
    };
    const legacyOverflow: TelegramDeliveryPlanPart = {
      operation: 'send',
      chatId: 42,
      threadId: 7,
      replyTo: null,
      editMessageId: null,
      html: 'overflow',
    };
    const requested: TelegramDeliveryPlanPart[] = [
      { ...legacyEdit, kind: 'rich' as const, rich: plan.message, fallback: [legacyEdit, legacyOverflow] },
    ];

    await expect(deliverTelegram(store, api, 'turn-rich-edit', requested, at)).resolves.toBe('sent');

    // One rich edit attempt on the owned message, then the frozen legacy road.
    const richEdits = calls.filter((c) => c.method === 'editMessageRichText');
    expect(richEdits).toHaveLength(1);
    const legacyEdits = calls.filter((c) => c.method === 'editMessageText');
    expect(legacyEdits).toHaveLength(1);
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    // The overflow send stays in the topic: existing thread routing is exact.
    expect(sends[0]!.threadId).toBe(7);
  });

  it('a rich edit refused as "not modified" is a delivery, not a failure', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const { api, calls } = trackingApi();
    (api.editMessageRichText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TelegramError(400, 'Bad Request: message is not modified: specified new message content is exactly the same'),
    );

    const plan = planRich(TABLE);
    if (plan.mode !== 'rich') throw new Error('setup');
    const requested: TelegramDeliveryPlanPart[] = [
      {
        operation: 'edit',
        chatId: 42,
        threadId: null,
        replyTo: null,
        editMessageId: 9001,
        html: 'excerpt',
        kind: 'rich' as const,
        rich: plan.message,
        fallback: [
          { operation: 'edit', chatId: 42, threadId: null, replyTo: null, editMessageId: 9001, html: renderForTelegram(TABLE)[0]! },
        ],
      },
    ];

    await expect(deliverTelegram(store, api, 'turn-rich-same', requested, at)).resolves.toBe('sent');
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
    expect(store.parts('turn-rich-same')).toMatchObject([{ kind: 'rich', status: 'sent' }]);
  });
});
