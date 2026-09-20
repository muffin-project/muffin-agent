import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider, StreamEvent } from '../../agent/providers/types.js';
import { TelegramConnector, type TelegramConfig } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { TelegramApiLike } from './api.js';
import { TelegramDeliveryStore } from './delivery.js';
import { negoziazioneTelegram } from './negoziazione.js';
import { renderForTelegram } from './render.js';
import { startTranscript } from './transcript.js';
import { UpdateInbox } from './updates.js';
import type { OutboundRich } from './rich.js';

/**
 * Bot API 10.3 rich, end to end through the real connector:
 *
 * - G: a DM table answer previews as a rich draft and lands as ONE rich
 *   final — no preview/final duplication, no legacy send beside it;
 * - H: a group/topic table answer rides rich with thread routing intact;
 * - D: an over-compat answer never touches rich and arrives whole through
 *   the existing bounded legacy chunks;
 * - A: ordinary prose is provably untouched (no rich anywhere).
 *
 * Unit-level fault behaviour (rejection → fallback, ambiguous → no retry)
 * is `rich-delivery.test.ts`; the draft method-switch is at the bottom,
 * driving `startTranscript` directly across fake-clock time.
 */

const OWNER = 4242;
const GROUP = -100200;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

const TABLE = ['| nome | q |', '| --- | --- |', '| pane | 2 |', '| latte | 3 |'].join('\n');

const privateMsg = (id: number, text: string): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      text,
    },
  }) as unknown as Update;

const groupTopicMsg = (id: number, text: string): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: GROUP, type: 'supergroup' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      is_topic_message: true,
      message_thread_id: 7,
      text,
    },
  }) as unknown as Update;

function streamingProvider(chunks: string[], finalText: string): Provider {
  return {
    kind: 'openai-compat' as const,
    async chat(): Promise<ChatResult> {
      throw new Error('this scenario must stream, not fall back to chat()');
    },
    async *chatStream(_call: ChatCall): AsyncIterable<StreamEvent> {
      for (const chunk of chunks) yield { type: 'text_delta', text: chunk };
      yield {
        type: 'done',
        result: { text: finalText, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model' },
      };
    },
  };
}

function plainProvider(finalText: string): Provider {
  return {
    kind: 'openai-compat' as const,
    async chat(): Promise<ChatResult> {
      return { text: finalText, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model' };
    },
  };
}

type Call = {
  method: string;
  text?: string;
  rich?: OutboundRich;
  messageId?: number;
  threadId?: number | null;
  draftOptions?: { canStop?: boolean; keepOnStop?: boolean };
};

function recordingApi(): { api: TelegramApiLike; calls: Call[] } {
  const calls: Call[] = [];
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
    sendMessage: async (chatId, html, options) => {
      const messageId = nextMessageId++;
      calls.push({ method: 'sendMessage', text: html, messageId, threadId: options?.threadId ?? null });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
    },
    sendRichMessage: async (chatId, rich, options) => {
      const messageId = nextMessageId++;
      calls.push({ method: 'sendRichMessage', rich, messageId, threadId: options?.threadId ?? null });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
    },
    editMessageText: async (_chatId, messageId, html) => {
      calls.push({ method: 'editMessageText', text: html, messageId });
      return true;
    },
    editMessageRichText: async (_chatId, messageId, rich) => {
      calls.push({ method: 'editMessageRichText', rich, messageId });
      return true;
    },
    editMessageReplyMarkup: async (_chatId, messageId) => {
      calls.push({ method: 'editMessageReplyMarkup', messageId });
      return true;
    },
    deleteMessage: async (_chatId, messageId) => {
      calls.push({ method: 'deleteMessage', messageId });
      return true;
    },
    sendChatAction: async () => {
      calls.push({ method: 'sendChatAction' });
      return true;
    },
    sendMessageDraft: async (_chatId, _draftId, text, options) => {
      calls.push({ method: 'sendMessageDraft', text, draftOptions: { canStop: options?.canStop, keepOnStop: options?.keepOnStop } });
      return true;
    },
    sendRichMessageDraft: async (_chatId, _draftId, rich, options) => {
      calls.push({ method: 'sendRichMessageDraft', rich, draftOptions: { canStop: options?.canStop, keepOnStop: options?.keepOnStop } });
      return true;
    },
    fileUrl: async () => 'https://example.test/file',
    setMyCommands: async () => true,
    answerCallbackQuery: async () => true,
  };
  return { api, calls };
}

function harness(config: TelegramConfig, provider: Provider, api: TelegramApiLike) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tgrich-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-tgrich-ws-'));
  runInit({ home, apiKey: 'sk-tgrich-never-called' });
  const runtime = buildRuntime(home, workspace);
  const loop: LoopDeps = { ...runtime.deps, provider };
  const inbox = new UpdateInbox(runtime.db);
  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox,
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config,
  });
  (connector as unknown as { meUsername: string }).meUsername = 'MuffinBot';
  return { connector, runtime };
}

async function deliver(connector: TelegramConnector, updates: Update[]): Promise<void> {
  const inbox = (connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('rich end to end · DM draft to rich final, no duplication (G)', () => {
  it('a table answer previews rich and lands as exactly one rich message', async () => {
    const provider = streamingProvider([TABLE], TABLE);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [privateMsg(3, 'quanto costa?')]);

      // The preview rode the rich draft, with the owner's Stop control on it.
      const richDrafts = calls.filter((c) => c.method === 'sendRichMessageDraft');
      expect(richDrafts.length).toBeGreaterThan(0);
      for (const draft of richDrafts) expect(draft.draftOptions?.canStop).toBe(true);
      expect(richDrafts[0]!.rich!.blocks![0]).toMatchObject({ type: 'table' });

      // The durable delivery is exactly one rich message — no legacy send
      // beside the preview (the OpenClaw/Hermes duplication shape), no edit,
      // nothing to delete.
      expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1);
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});

describe('rich end to end · group/topic keeps thread routing (H)', () => {
  it('a table answer in a forum topic rides one rich send inside the topic', async () => {
    const provider = streamingProvider([TABLE], TABLE);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [groupTopicMsg(4, '@MuffinBot quanto costa?')]);

      const rich = calls.filter((c) => c.method === 'sendRichMessage');
      expect(rich).toHaveLength(1);
      // The topic survives the mode change: a rich final in General instead
      // of the topic would be a misdelivery, not a rendering choice.
      expect(rich[0]!.threadId).toBe(7);
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});

describe('rich end to end · over-compat answers stay whole on legacy (D)', () => {
  it('a huge table never touches rich and arrives complete in bounded chunks', async () => {
    const rows = Array.from({ length: 400 }, (_, k) => `| voce ${k} | descrizione numero ${k} con un po di testo |`).join('\n');
    const huge = `| nome | dettaglio |\n| --- | --- |\n${rows}`;
    const provider = plainProvider(huge);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [privateMsg(5, 'dammi tutto')]);

      expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'sendRichMessageDraft')).toHaveLength(0);
      const sends = calls.filter((c) => c.method === 'sendMessage');
      expect(sends.length).toBeGreaterThan(1);
      for (const send of sends) expect(send.text!.length).toBeLessThanOrEqual(4096);
      const joined = sends.map((s) => s.text).join('\n');
      expect(joined).toContain('voce 0');
      expect(joined).toContain('voce 399');
    } finally {
      runtime.close();
    }
  });
});

describe('rich end to end · ordinary prose is untouched (A)', () => {
  it('a simple answer sends legacy once, with zero rich anywhere', async () => {
    const provider = plainProvider('Ciao, tutto bene con **calma**.');
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [privateMsg(6, 'come va?')]);

      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      expect(calls.filter((c) => c.method.startsWith('sendRich'))).toHaveLength(0);
      expect(calls.filter((c) => c.method.startsWith('editMessageRich'))).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});

describe('rich drafts · the preview follows the partial across fake time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a prose partial previews legacy, then a table partial switches the renewal to rich', async () => {
    const calls: Call[] = [];
    const api = {
      sendMessageDraft: async (_c: number, _d: number, text: string) => {
        calls.push({ method: 'sendMessageDraft', text });
        return true;
      },
      sendRichMessageDraft: async (_c: number, _d: number, rich: OutboundRich) => {
        calls.push({ method: 'sendRichMessageDraft', rich });
        return true;
      },
      sendMessage: async () => {
        throw new Error('unused in this fake');
      },
      editMessageText: async () => {
        throw new Error('unused in this fake');
      },
    } as unknown as TelegramApiLike;
    const t = startTranscript(api, 1, { negotiation: negoziazioneTelegram('direct') });

    t.live('sto scrivendo la risposta');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'sendRichMessageDraft')).toHaveLength(0);

    // The model keeps typing and a table takes shape: the renewal switches
    // method under the same draft, legacy preview replaced, not doubled.
    t.live(`sto scrivendo la risposta\n\n${TABLE}`);
    await vi.advanceTimersByTimeAsync(2_000);
    const richDrafts = calls.filter((c) => c.method === 'sendRichMessageDraft');
    expect(richDrafts.length).toBeGreaterThan(0);
    expect(richDrafts[0]!.rich!.blocks!.some((b) => b.type === 'table')).toBe(true);
    // One preview at a time: after the switch no further legacy renewal.
    const legacyAfter = calls.filter((c) => c.method === 'sendMessageDraft').length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(legacyAfter);
    await t.stop();
  });

  it('an unfinished table partial never emits a broken rich draft', async () => {
    const calls: Call[] = [];
    const api = {
      sendMessageDraft: async () => {
        calls.push({ method: 'sendMessageDraft' });
        return true;
      },
      sendRichMessageDraft: async () => {
        calls.push({ method: 'sendRichMessageDraft' });
        return true;
      },
      sendMessage: async () => {
        throw new Error('unused in this fake');
      },
      editMessageText: async () => {
        throw new Error('unused in this fake');
      },
    } as unknown as TelegramApiLike;
    const t = startTranscript(api, 1, { negotiation: negoziazioneTelegram('direct') });

    // A table header without its delimiter row is not a table yet.
    t.live('| nome | q |');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls.filter((c) => c.method === 'sendRichMessageDraft')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'sendMessageDraft').length).toBeGreaterThan(0);
    await t.stop();
  });

  it('every legacy draft carries the Stop control', async () => {
    const seen: ({ canStop?: boolean } | undefined)[] = [];
    const api = {
      sendMessageDraft: async (_c: number, _d: number, _t: string, options?: { canStop?: boolean }) => {
        seen.push({ canStop: options?.canStop });
        return true;
      },
      sendRichMessageDraft: async () => true,
      sendMessage: async () => {
        throw new Error('unused in this fake');
      },
      editMessageText: async () => {
        throw new Error('unused in this fake');
      },
    } as unknown as TelegramApiLike;
    const t = startTranscript(api, 1, { negotiation: negoziazioneTelegram('direct') });

    t.live('una risposta semplice che si forma');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) expect(options?.canStop).toBe(true);
    await t.stop();
  });
});
