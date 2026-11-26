import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from '@grammyjs/types';
import { describe, expect, it, vi } from 'vitest';
import type { ChatResult, Provider, StreamEvent } from '../../agent/providers/types.js';
import { buildRuntime } from '../../agent/runtime.js';
import { runInit } from '../../cli/init.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import { type DraftOptions, type TelegramApiLike, TelegramError } from './api.js';
import { TelegramConnector } from './connector.js';
import { TelegramDeliveryStore } from './delivery.js';
import type { OutboundRich } from './rich.js';
import { UpdateInbox } from './updates.js';

// Drive a real update through the inbox, connector, and streaming turn loop.
// Hold the provider before `done` to distinguish a live preview from a final send.
const OWNER = 4242;
const GROUP = -100200;
const TOPIC = 77;
const PREAMBLE = 'Prima devo controllare.';
const TOOL = 'unregistered_probe';
const QUERY = 'tool argument fixture';
const PREFIX = 'Ecco cosa ho trovato';
const FINAL = `${PREFIX}: è pronto.`;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function message(chatId: number, threadId?: number): Update {
  const direct = chatId === OWNER;
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: direct
        ? { id: chatId, type: 'private', first_name: 'Owner' }
        : { id: chatId, type: 'supergroup', title: 'Group' },
      from: { id: direct ? OWNER : 9999, is_bot: false, first_name: 'Sender' },
      text: direct ? 'Cosa hai trovato?' : '@MuffinBot cosa hai trovato?',
      ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
    },
  };
}

function gatedProvider(withTool: boolean | 'unqualified' = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let round = 0;
  // The unknown tool produces a real tool_result and a second round without
  // any side effects. The blocking-tool test separately exercises an allowed handler.
  const atFinalPrefix = vi.fn();
  const provider: Provider = {
    kind: 'openai-compat',
    async chat(): Promise<ChatResult> {
      throw new Error('this scenario must stream');
    },
    async *chatStream(): AsyncIterable<StreamEvent> {
      if (withTool && round++ === 0) {
        const opener = withTool === 'unqualified' ? PREFIX : PREAMBLE;
        yield { type: 'text_delta', text: opener };
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: TOOL };
        yield {
          type: 'done',
          result: {
            text: opener,
            toolCalls: [{ id: 'c1', name: TOOL, args: { query: QUERY } }],
            stopReason: 'tool_use',
            usage: USAGE,
            model: 'test-model',
          },
        };
        return;
      }
      yield { type: 'text_delta', text: PREFIX };
      atFinalPrefix();
      await gate;
      yield { type: 'text_delta', text: FINAL.slice(PREFIX.length) };
      yield {
        type: 'done',
        result: {
          text: FINAL,
          toolCalls: [],
          stopReason: 'end',
          usage: USAGE,
          model: 'test-model',
        },
      };
    },
  };
  return { provider, release, atFinalPrefix };
}

type Recorded = {
  method: string;
  chatId: number;
  threadId?: number | undefined;
  draftId?: number | undefined;
  action?: string | undefined;
  text?: string;
  rich?: OutboundRich;
  draftOptions?: DraftOptions | undefined;
};

function recordingApi(): { api: TelegramApiLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let nextMessageId = 900;
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
    getChatMember: async () => ({ status: 'member' }),
    leaveChat: async () => true,
    sendMessage: async (chatId, text, options) => {
      calls.push({ method: 'sendMessage', chatId, text, threadId: options?.threadId });
      return { message_id: nextMessageId++ } as never;
    },
    sendRichMessage: async (chatId, rich, options) => {
      calls.push({ method: 'sendRichMessage', chatId, rich, threadId: options?.threadId });
      return { message_id: nextMessageId++ } as never;
    },
    editMessageText: async (chatId, _id, text) => {
      calls.push({ method: 'editMessageText', chatId, text });
      return true;
    },
    editMessageRichText: async (chatId, _id, rich) => {
      calls.push({ method: 'editMessageRichText', chatId, rich });
      return true;
    },
    editMessageReplyMarkup: async (chatId) => {
      calls.push({ method: 'editMessageReplyMarkup', chatId });
      return true;
    },
    deleteMessage: async (chatId) => {
      calls.push({ method: 'deleteMessage', chatId });
      return true;
    },
    sendChatAction: async (chatId, action, threadId) => {
      calls.push({ method: 'sendChatAction', chatId, action, threadId });
      return true;
    },
    sendMessageDraft: async (chatId, draftId, text, draftOptions) => {
      calls.push({ method: 'sendMessageDraft', chatId, draftId, text, draftOptions });
      return true;
    },
    sendRichMessageDraft: async (chatId, draftId, rich, draftOptions) => {
      calls.push({ method: 'sendRichMessageDraft', chatId, draftId, rich, draftOptions });
      return true;
    },
    fileUrl: async () => 'https://example.test/file',
    setMyCommands: async () => true,
    answerCallbackQuery: async () => true,
  };
  return { api, calls };
}

/** Read text even when a rich payload nests it in another block. */
function visibleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(visibleText).join('');
  if (value === null || typeof value !== 'object') return '';
  const { summary, text, blocks } = value as Record<string, unknown>;
  return visibleText(summary) + visibleText(text) + visibleText(blocks);
}

const textOf = (c: Recorded): string =>
  c.text ?? c.rich?.html ?? c.rich?.markdown ?? visibleText(c.rich?.blocks);
const draft = (c: Recorded): boolean => c.method.endsWith('Draft');
const typing = (c: Recorded): boolean => c.method === 'sendChatAction';
const durable = (c: Recorded): boolean => !draft(c) && !typing(c);

function expectOnlyAnswer(calls: Recorded[], chatId: number, threadId?: number): void {
  const messages = calls.filter(durable);
  expect(messages).toMatchObject([
    { method: expect.stringMatching(/^send(Rich)?Message$/), chatId, threadId },
  ]);
  expect(messages.map(textOf)).toEqual([FINAL]);
  expect(JSON.stringify(messages)).not.toMatch(/"type":"details"|Processo/);
}

function expectInterimThenAnswer(calls: Recorded[], chatId: number, threadId?: number): void {
  const messages = calls.filter(durable);
  expect(messages).toMatchObject([
    { method: expect.stringMatching(/^send(Rich)?Message$/), chatId, threadId },
    { method: expect.stringMatching(/^send(Rich)?Message$/), chatId, threadId },
  ]);
  expect(messages.map(textOf)).toEqual([PREAMBLE, FINAL]);
  expect(JSON.stringify(calls)).not.toMatch(/"type":"details"|Processo/);
  for (const detail of [TOOL, QUERY, 'Processo']) {
    expect(JSON.stringify(messages)).not.toContain(detail);
  }
  // The final answer is a new message, never an edit of the interim.
  expect(calls.filter((c) => c.method.startsWith('editMessage')).length).toBe(0);
}

function expectDraftRestartedAfterInterim(calls: Recorded[]): void {
  const interimAt = calls.findIndex((c) => durable(c) && textOf(c) === PREAMBLE);
  expect(interimAt).toBeGreaterThanOrEqual(0);
  const draftsBefore = calls.slice(0, interimAt).filter(draft);
  const draftsAfter = calls.slice(interimAt + 1).filter(draft);
  expect(draftsBefore.length).toBeGreaterThan(0);
  expect(draftsAfter.length).toBeGreaterThan(0);
  const beforeId = draftsBefore.at(-1)?.draftId;
  const afterIds = new Set(draftsAfter.map((c) => c.draftId));
  expect(beforeId).toBeGreaterThan(0);
  expect(afterIds.size).toBeGreaterThan(0);
  expect(afterIds.has(beforeId)).toBe(false);
}

function harness(provider: Provider, api: TelegramApiLike) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tgstream-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-tgstream-ws-'));
  runInit({ home, apiKey: 'sk-tgstream-never-called' });
  const runtime = buildRuntime(home, workspace);
  const inbox = new UpdateInbox(runtime.db);
  const loop = { ...runtime.deps, provider };
  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox,
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
  });
  loop.sendInterimMessage = connector.sendInterimMessage;
  // drain() bypasses connect() and its getMe() call.
  (connector as unknown as { meUsername: string }).meUsername = 'MuffinBot';
  return {
    runtime,
    deliver(update: Update): Promise<void> {
      inbox.accept([update], new Date().toISOString());
      return (connector as unknown as { drain: () => Promise<void> }).drain();
    },
  };
}

describe('ordinary Telegram replies', () => {
  it.each([
    { name: 'a group', threadId: undefined },
    { name: 'a forum topic', threadId: TOPIC },
  ])(
    'sends a qualified preamble in $name, keeps typing, then lands the answer as a new message',
    async ({ threadId }) => {
      const { provider, release, atFinalPrefix } = gatedProvider(true);
      const { api, calls } = recordingApi();
      const h = harness(provider, api);
      const draining = h.deliver(message(GROUP, threadId));

      try {
        await vi.waitFor(() => expect(atFinalPrefix).toHaveBeenCalledOnce(), { timeout: 3_000 });
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.filter(durable).map(textOf)).toEqual([PREAMBLE]);
        for (const c of calls.filter(typing)) {
          expect(c).toMatchObject({
            method: 'sendChatAction',
            action: 'typing',
            chatId: GROUP,
            threadId,
          });
        }
        expect(calls.filter(draft)).toEqual([]);

        release();
        await draining;

        expect(calls.filter(draft)).toEqual([]);
        expectInterimThenAnswer(calls, GROUP, threadId);
        expect(calls.filter(typing).length).toBeGreaterThan(0);
      } finally {
        release();
        await draining.catch(() => {});
        h.runtime.close();
      }
    },
  );

  it.each([
    { name: 'a group', threadId: undefined },
    { name: 'a forum topic', threadId: TOPIC },
  ])(
    'keeps an unqualified preamble ephemeral in $name and sends only the finished answer',
    async ({ threadId }) => {
      const { provider, release, atFinalPrefix } = gatedProvider('unqualified');
      const { api, calls } = recordingApi();
      const h = harness(provider, api);
      const draining = h.deliver(message(GROUP, threadId));

      try {
        await vi.waitFor(() => expect(atFinalPrefix).toHaveBeenCalledOnce(), { timeout: 3_000 });
        expect(calls.filter(durable)).toEqual([]);
        for (const c of calls) {
          expect(c).toMatchObject({
            method: 'sendChatAction',
            action: 'typing',
            chatId: GROUP,
            threadId,
          });
        }

        release();
        await draining;

        expect(calls.filter(draft)).toEqual([]);
        expectOnlyAnswer(calls, GROUP, threadId);
      } finally {
        release();
        await draining.catch(() => {});
        h.runtime.close();
      }
    },
  );

  it('streams provisional text in DM and lands just the answer after a single round', async () => {
    const { provider, release } = gatedProvider(false);
    const { api, calls } = recordingApi();
    const h = harness(provider, api);
    const draining = h.deliver(message(OWNER));

    try {
      await vi.waitFor(
        () => {
          const latest = calls.filter(draft).at(-1);
          expect(latest && textOf(latest)).toBe(PREFIX);
        },
        { timeout: 3_000 },
      );
      expect(calls.filter(durable)).toEqual([]);

      release();
      await draining;

      for (const c of calls.filter(draft)) {
        expect(c.draftOptions?.canStop).toBe(true);
        expect(c.draftOptions?.keepOnStop).not.toBe(true);
      }
      const wire = JSON.stringify(calls);
      for (const detail of [TOOL, QUERY, 'Processo']) expect(wire).not.toContain(detail);
      expectOnlyAnswer(calls, OWNER);
    } finally {
      release();
      await draining.catch(() => {});
      h.runtime.close();
    }
  });

  it('promotes a qualified DM preamble, restarts the status draft, then sends the answer as a new message', async () => {
    const { provider, release } = gatedProvider(true);
    const { api, calls } = recordingApi();
    const h = harness(provider, api);
    const draining = h.deliver(message(OWNER));

    try {
      await vi.waitFor(
        () => {
          expect(calls.filter(durable).map(textOf)).toEqual([PREAMBLE]);
          const latest = calls.filter(draft).at(-1);
          expect(latest && textOf(latest)).toBe(PREFIX);
        },
        { timeout: 3_000 },
      );

      release();
      await draining;

      for (const c of calls.filter(draft)) {
        expect(c.draftOptions?.canStop).toBe(true);
        expect(c.draftOptions?.keepOnStop).not.toBe(true);
      }
      const wire = JSON.stringify(calls);
      for (const detail of [TOOL, QUERY, 'Processo']) expect(wire).not.toContain(detail);
      expectInterimThenAnswer(calls, OWNER);
      expectDraftRestartedAfterInterim(calls);
    } finally {
      release();
      await draining.catch(() => {});
      h.runtime.close();
    }
  });

  it('leaves an unqualified DM preamble in the draft only and still sends just the answer', async () => {
    const { provider, release } = gatedProvider('unqualified');
    const { api, calls } = recordingApi();
    const h = harness(provider, api);
    const draining = h.deliver(message(OWNER));

    try {
      await vi.waitFor(
        () => {
          const latest = calls.filter(draft).at(-1);
          expect(latest && textOf(latest)).toBe(PREFIX);
        },
        { timeout: 3_000 },
      );
      expect(calls.filter(durable)).toEqual([]);

      release();
      await draining;

      for (const detail of [TOOL, QUERY, 'Processo', PREFIX]) {
        if (detail === PREFIX) continue;
        expect(JSON.stringify(calls.filter(durable))).not.toContain(detail);
      }
      expectOnlyAnswer(calls, OWNER);
    } finally {
      release();
      await draining.catch(() => {});
      h.runtime.close();
    }
  });

  it('still sends only the answer when Telegram rejects the DM preview and rich final', async () => {
    const { provider, release } = gatedProvider(false);
    const { api, calls } = recordingApi();
    // Explicit refusals: no draft or rich send was accepted. The legacy
    // final must still succeed and must not reconstruct a tool transcript.
    const refusal = () => new TelegramError(400, 'Bad Request: RICH_MESSAGE_INVALID');
    const sendRichMessageDraft = vi.fn(async () => {
      throw refusal();
    });
    const sendMessageDraft = vi.fn(async () => {
      throw new TelegramError(400, 'Bad Request: draft refused');
    });
    const sendRichMessage = vi.fn(async () => {
      throw refusal();
    });
    const h = harness(provider, {
      ...api,
      sendRichMessageDraft,
      sendMessageDraft,
      sendRichMessage,
    });

    try {
      release();
      await h.deliver(message(OWNER));

      expect(sendRichMessageDraft).toHaveBeenCalled();
      expect(sendMessageDraft).toHaveBeenCalled();
      expect(sendRichMessage).toHaveBeenCalledOnce();
      expect(calls.filter(durable)).toMatchObject([{ method: 'sendMessage', text: FINAL }]);
      expectOnlyAnswer(calls, OWNER);
    } finally {
      h.runtime.close();
    }
  });

  it('sends a qualified preamble even if the DM preview and rich transport are refused', async () => {
    const { provider, release } = gatedProvider(true);
    const { api, calls } = recordingApi();
    const refusal = () => new TelegramError(400, 'Bad Request: RICH_MESSAGE_INVALID');
    const sendRichMessageDraft = vi.fn(async () => {
      throw refusal();
    });
    const sendMessageDraft = vi.fn(async () => {
      throw new TelegramError(400, 'Bad Request: draft refused');
    });
    const sendRichMessage = vi.fn(async () => {
      throw refusal();
    });
    const h = harness(provider, {
      ...api,
      sendRichMessageDraft,
      sendMessageDraft,
      sendRichMessage,
    });

    try {
      release();
      await h.deliver(message(OWNER));

      expect(calls.filter(durable).map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);
      expect(calls.filter(durable).map(textOf)).toEqual([PREAMBLE, FINAL]);
    } finally {
      h.runtime.close();
    }
  });
});
