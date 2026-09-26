import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from '@grammyjs/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import { type ChatResult, type Provider, ProviderError } from '../../agent/providers/types.js';
import { buildRuntime } from '../../agent/runtime.js';
import { runInit } from '../../cli/init.js';
import type { TurnRecord } from '../../core/turns/store.js';
import { type TelegramApi, TelegramError } from './api.js';
import { type TelegramConfig, TelegramConnector } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

/**
 * The delivery outcome, from a real update off the wire.
 *
 * Two things are asserted here and nowhere else. The first is that the *turn*
 * and the *delivery* end up as two answers on one row — the property
 * `core/scheduler/scheduler.ts:166-171` already had to be taught once, where a
 * failed delivery must never make finished work look unfinished, because that
 * doubles it.
 *
 * The second is smaller and worse: that failing to *record* the delivery cannot
 * fail the delivery. A throw after a successful send marks the update failed,
 * and the next drain sends the owner the whole answer a second time.
 */

const OWNER = 4242;

const privateMsg = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id * 10,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      text: 'ciao',
    },
  }) as unknown as Update;

const reply = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test-model',
});

const config: TelegramConfig = { token: 't', ownerUserId: OWNER, ownerChatId: OWNER };

afterEach(() => vi.restoreAllMocks());

function harness(
  over: {
    send?: (chatId: number, text: string) => Promise<never>;
    breakDeliveryRecord?: boolean;
    provider?: Provider;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tgrec-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-tgrec-ws-'));
  runInit({ home, apiKey: 'sk-tgrec-never-called' });
  const runtime = buildRuntime(home, workspace);

  const provider: Provider = over.provider ?? {
    kind: 'openai-compat',
    chat: async () => reply('ecco la risposta'),
  };
  const turns = over.breakDeliveryRecord
    ? Object.assign(
        Object.create(Object.getPrototypeOf(runtime.deps.turns) as object),
        runtime.deps.turns,
        {
          delivered: () => {
            throw new Error('database is not open');
          },
        },
      )
    : runtime.deps.turns;
  const loop: LoopDeps = { ...runtime.deps, provider, turns };

  const logged: string[] = [];
  const outbound: string[] = [];
  const api = {
    sendMessage:
      over.send ??
      (async (_chatId: number, text: string) => {
        outbound.push(`send:${text}`);
        return {} as never;
      }),
    editMessageText: async (_chatId: number, _id: number, text: string) => {
      outbound.push(`edit:${text}`);
      return {} as never;
    },
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
    // Rich is the transport now; the fake records it as the same send/edit so
    // the behaviour assertions stay about the turn, not the wire.
    sendRichMessage: over.send
      ? async (chatId: number, rich: { html?: string }) => over.send!(chatId, rich.html ?? '')
      : async (_chatId: number, rich: { html?: string }) => {
          outbound.push(`send:${rich.html ?? ''}`);
          return {} as never;
        },
    editMessageRichText: async (_chatId: number, _id: number, rich: { html?: string }) => {
      outbound.push(`edit:${rich.html ?? ''}`);
      return {} as never;
    },
    sendRichMessageDraft: async () => true,
  } as unknown as TelegramApi;

  const inbox = new UpdateInbox(runtime.db);
  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox,
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config,
    log: (line) => logged.push(line),
  });

  return {
    connector,
    inbox,
    logged,
    outbound,
    runtime,
    /** The single turn the drain produced, read from the production store. */
    row: (): TurnRecord | null => {
      const id = (
        runtime.db.prepare(`SELECT id FROM turns LIMIT 1`).get() as { id: string } | undefined
      )?.id;
      return id === undefined ? null : runtime.deps.turns.get(id);
    },
  };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  h.inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('a telegram turn records where the answer goes and whether it got there', () => {
  it('writes the reply address on the row, and marks the delivery sent', async () => {
    const h = harness();
    await deliver(h, [privateMsg(1)]);
    const row = h.row();
    // The address is on the record and not only on the stack. Nothing reads it
    // yet — this same function still delivers — and that is the point: the day
    // the lane delivers instead, the address is already durable. `channel` is
    // the SurfaceRegistry address that day's lane (#41, turno sospeso) needs —
    // without it the row has Telegram's own addressing but nothing saying
    // which registry entry to deliver through.
    expect(row?.replyTo).toMatchObject({
      chatId: OWNER,
      messageId: 10,
      channel: `telegram:${OWNER}`,
    });
    expect(row?.outcome).toBe('answered');
    expect(row?.delivery).toBe('sent');
    h.runtime.close();
  });

  it('a failed send leaves the turn answered and the delivery failed — never both', async () => {
    const h = harness({
      send: async () => {
        throw new TelegramError(429, 'Too Many Requests', 1);
      },
    });
    await deliver(h, [privateMsg(1)]);
    const row = h.row();
    expect(row?.status).toBe('done');
    expect(row?.outcome).toBe('answered');
    expect(row?.delivery).toBe('failed:Telegram 429: Too Many Requests');
    // Unchanged behaviour on the update: it stays pending and is retried, which
    // is what the inbox is for. The record does not take that over in this
    // slice — it only stops the two outcomes from being one.
    expect(h.inbox.pending()).toHaveLength(1);
    h.runtime.close();
  });

  it('delivers a bounded continuable diagnostic after provider retries fail', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        calls += 1;
        throw new ProviderError('secret provider response must not escape', true, 502, 'transport');
      },
    };
    const h = harness({ provider });

    await deliver(h, [privateMsg(9)]);

    const row = h.row();
    expect(calls).toBe(11);
    expect(h.outbound).toHaveLength(1);
    expect(h.outbound[0]).toMatch(/provider|riprendi/i);
    expect(h.outbound[0]).not.toContain('secret provider response');
    // P0-B: the lease yielded instead of closing — same bounded delivery,
    // different row state.
    expect(row?.status).toBe('continuable');
    expect(row?.outcome).toBeNull();
    expect(row?.delivery).toBe('sent');
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it('a failed diagnostic send stays deferred without recomputing', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    let sends = 0;
    const attempts: string[] = [];
    const provider: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        calls += 1;
        throw new ProviderError('connection details stay private', true, 502, 'transport');
      },
    };
    const h = harness({
      provider,
      send: async (_chatId: number, text: string) => {
        attempts.push(text);
        sends += 1;
        // Every attempt fails, so the property under test is observed on the
        // wire regardless of any single retry the delivery may make.
        throw new TelegramError(429, 'Too Many Requests', 1);
      },
    });

    await deliver(h, [privateMsg(10)]);
    expect(h.inbox.pending()).toHaveLength(1);
    // P0-B: the work yielded as continuable; the *delivery* failed.
    expect(h.row()?.status).toBe('continuable');
    expect(h.row()?.delivery).toContain('failed:');

    await (h.connector as unknown as { drain: () => Promise<void> }).drain();

    // No recompute, no redelivery of a diagnostic the row does not store as
    // text: the event stays pending, the failure stays recorded, the doctor
    // still sees both. Redelivery happens for the final answer, once the
    // owner continues the work to `done`.
    expect(calls).toBe(11);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0]).not.toContain('connection details stay private');
    expect(h.inbox.pending()).toHaveLength(1);
    expect(h.row()?.delivery).toContain('failed:');
  });

  it('does not expose an unknown internal exception as a Telegram answer', async () => {
    const h = harness({
      provider: {
        kind: 'openai-compat',
        chat: async () => {
          throw new Error('private internal detail');
        },
      },
    });

    await deliver(h, [privateMsg(11)]);

    expect(h.outbound).toEqual([]);
    expect(h.inbox.pending()).toHaveLength(1);
    expect(h.logged.join('\n')).toContain('private internal detail');
  });

  it('a delivery that cannot be recorded is still a delivery', async () => {
    const h = harness({ breakDeliveryRecord: true });
    await deliver(h, [privateMsg(1)]);
    // The answer was sent. If the bookkeeping write were allowed to throw, the
    // update would be marked failed and the owner would receive the same answer
    // again on the next drain — a worse bug than the missing row.
    expect(h.inbox.pending()).toEqual([]);
    expect(h.logged.join('\n')).toContain('consegna non registrata');
    h.runtime.close();
  });

  it('a suspended turn sends nothing and is not marked delivered — the placeholder is the truth until the lane resumes it', async () => {
    // The model asks to wait: `wait` is registered by `buildRuntime`, so this
    // is the production path — the turn suspends inside `runTurn` and comes
    // back with `stopped: 'suspended'` and an empty text. Before the guard the
    // connector rendered that '' (`renderForTelegram('')` is `['']`), sent an
    // empty message and recorded `sent` on a turn that had not answered.
    let calls = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ...reply(''),
            toolCalls: [
              { id: 'c1', name: 'wait', args: { seconds: 3600, why: 'aspetto il report' } },
            ],
            stopReason: 'tool_use',
          };
        }
        return reply('non dovrei essere chiamato in questo turno');
      },
    };
    const h = harness({ provider });
    await deliver(h, [privateMsg(1)]);
    const row = h.row();
    expect(row?.status).toBe('waiting');
    expect(row?.delivery).toBe('pending'); // addressed, not delivered — never 'sent'
    // The presence placeholder ("sto guardando…") and, since 03/09/2026, the
    // transcript of the one step the turn took before suspending — a real
    // message that stays (`transcript.ts`). No answer, no empty send.
    //
    // Since the first-paint fix (defect B, 2026-09-18) that message is painted
    // running the moment the step starts (`send:⏳ … · 0s`) and settled to done
    // by the final edit (`edit:✓ …`) — before, the whole turn collapsed into a
    // single `send:✓ …` because the provider resolves through pure microtasks
    // with no real gap for the old coalescing timer to fire in. The
    // load-bearing properties are unchanged: no answer text, delivery still
    // pending, the transcript message is the truth until the lane resumes.
    expect(h.outbound.filter((o) => o !== 'send:sto guardando…')).toEqual([
      'send:⏳ mi metto in attesa · 0s',
      'edit:✓ mi metto in attesa',
    ]);
    h.runtime.close();
  });
});
