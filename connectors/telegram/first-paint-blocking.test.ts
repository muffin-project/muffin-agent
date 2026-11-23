import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from '@grammyjs/types';
import { describe, expect, it, vi } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatResult, Provider } from '../../agent/providers/types.js';
import { buildRuntime } from '../../agent/runtime.js';
import { runInit } from '../../cli/init.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { DraftOptions, TelegramApiLike } from './api.js';
import { type TelegramConfig, TelegramConnector } from './connector.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

const OWNER = 4242;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const TOOL = 'first_tool_probe';
const QUERY = 'private tool query fixture';
const TOOL_RESULT = 'internal tool result fixture';

const privateMsg = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      text: 'ciao',
    },
  }) as unknown as Update;

describe('DM status before the first answer', () => {
  it('shows stoppable status before recall and through a real tool call without exposing its details', async () => {
    type Call = {
      method: string;
      text?: string;
      rich?: unknown;
      draftOptions?: DraftOptions;
      messageId?: number;
    };
    const calls: Call[] = [];
    let nextMessageId = 900;
    const api = {
      sendMessage: async (chatId: number, html: string) => {
        const messageId = nextMessageId++;
        calls.push({ method: 'sendMessage', text: html, messageId });
        return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
      },
      editMessageText: async (_chatId: number, messageId: number, html: string) => {
        calls.push({ method: 'editMessageText', text: html, messageId });
        return true;
      },
      sendRichMessage: async (chatId: number, rich: unknown) => {
        const messageId = nextMessageId++;
        calls.push({ method: 'sendRichMessage', rich, messageId });
        return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
      },
      editMessageRichText: async (_chatId: number, messageId: number, rich: unknown) => {
        calls.push({ method: 'editMessageRichText', rich, messageId });
        return true;
      },
      sendChatAction: async () => true,
      sendMessageDraft: async (
        _chatId: number,
        _draftId: number,
        text: string,
        draftOptions: DraftOptions,
      ) => {
        calls.push({ method: 'sendMessageDraft', text, draftOptions });
        return true;
      },
      sendRichMessageDraft: async (
        _chatId: number,
        _draftId: number,
        rich: unknown,
        draftOptions: DraftOptions,
      ) => {
        calls.push({ method: 'sendRichMessageDraft', rich, draftOptions });
        return true;
      },
      editMessageReplyMarkup: async () => {
        calls.push({ method: 'editMessageReplyMarkup' });
        return true;
      },
      deleteMessage: async () => {
        calls.push({ method: 'deleteMessage' });
        return true;
      },
    } as unknown as TelegramApiLike;
    const drafts = () => calls.filter((c) => c.method.endsWith('Draft'));
    const payload = (c: Call | undefined) => c?.text ?? JSON.stringify(c?.rich ?? '');
    const durableCalls = () => calls.filter((c) => !c.method.endsWith('Draft'));

    let releaseTool!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const handler = vi.fn(async (_args: unknown) => {
      await gate;
      return { content: TOOL_RESULT, tier: 0 as const };
    });
    const blockingTool: LoopDeps['tools'][number] = {
      spec: {
        name: TOOL,
        description: 'probe',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      capability: 'probe.blocking',
      throwTier: 0,
      handler,
    };

    // No streaming or preamble: only status drafts appear before the tool.
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let n = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      chat: async (): Promise<ChatResult> => {
        if (n++ === 0) {
          await modelGate;
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: TOOL, args: { query: QUERY } }],
            stopReason: 'tool_use',
            usage: USAGE,
            model: 'test-model',
          };
        }
        return {
          text: 'fatto.',
          toolCalls: [],
          stopReason: 'end',
          usage: USAGE,
          model: 'test-model',
        };
      },
    };

    const home = mkdtempSync(join(tmpdir(), 'muffin-firstpaint-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-firstpaint-ws-'));
    runInit({ home, apiKey: 'sk-firstpaint-never-called' });
    const runtime = buildRuntime(home, workspace);
    let releaseRecall!: () => void;
    const recallGate = new Promise<void>((resolve) => {
      releaseRecall = resolve;
    });
    const vectors = runtime.deps.memory?.recall.vectors;
    if (vectors === undefined) throw new Error('The fixture needs the runtime vector index');
    const recallSearch = vi.spyOn(vectors, 'search').mockImplementation(async () => {
      await recallGate;
      return [];
    });
    const loop: LoopDeps = {
      ...runtime.deps,
      tools: [...runtime.deps.tools, blockingTool],
      decide: () => ({ effect: 'allow' }),
      provider,
    };
    const inbox = new UpdateInbox(runtime.db);
    const connector = new TelegramConnector({
      loop,
      sessions: runtime.deps.sessions,
      lane: new ModelLane(),
      inbox,
      delivery: new TelegramDeliveryStore(runtime.db),
      api,
      config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER } as TelegramConfig,
    });
    (connector as unknown as { meUsername: string }).meUsername = 'MuffinBot';

    let draining: Promise<void> | undefined;
    try {
      inbox.accept([privateMsg(1)], new Date().toISOString());
      draining = (connector as unknown as { drain: () => Promise<void> }).drain();
      await vi.waitFor(() => expect(recallSearch).toHaveBeenCalledOnce());
      expect(n).toBe(0);
      expect(payload(drafts()[0])).toContain('preparo il contesto');
      expect(durableCalls()).toEqual([]);
      releaseRecall();
      await vi.waitFor(() => expect(payload(drafts().at(-1))).toContain('sto lavorando'));
      expect(n).toBe(1);
      releaseModel();
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      expect(handler.mock.calls[0]?.[0]).toEqual({ query: QUERY });
      await vi.waitFor(() => expect(payload(drafts().at(-1))).toContain('sto lavorando'), {
        timeout: 3_000,
      });
      expect(durableCalls()).toEqual([]);
      releaseTool();
      await draining;

      expect(durableCalls()).toMatchObject([
        { method: expect.stringMatching(/^send(Rich)?Message$/) },
      ]);
      expect(payload(durableCalls()[0])).toContain('fatto.');
      for (const draft of drafts()) {
        expect(draft.draftOptions?.canStop).toBe(true);
        expect(draft.draftOptions?.keepOnStop).not.toBe(true);
      }
      const wire = calls.map(payload).join('\n');
      for (const detail of [TOOL, QUERY, TOOL_RESULT, 'Processo', '⏳'])
        expect(wire).not.toContain(detail);
    } finally {
      releaseRecall();
      releaseModel();
      releaseTool();
      await draining?.catch(() => {});
      runtime.close();
    }
  });
});
