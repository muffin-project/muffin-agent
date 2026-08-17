import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider, StreamEvent } from '../../agent/providers/types.js';
import { TelegramConnector, type TelegramConfig } from './connector.js';
import type { TelegramApiLike } from './api.js';
import { UpdateInbox } from './updates.js';

/**
 * The real wiring, B11 — through the actual `TelegramConnector.handle()`,
 * `buildRuntime`, and a scripted provider that streams, not a `Provider`
 * stub that only implements `chat()`. Same shape as `group-context.test.ts`'s
 * own proof for group prompts: the entry point production actually uses (an
 * `Update` off the wire, through `drain()` → `handle()` → `runTurn()`), so a
 * defect in the *composition* — `onDelta` never reaching `presence.streamText`,
 * `presence.stop()` racing the final edit — shows up here even though each
 * piece is correct in isolation.
 *
 * **What this file does not attempt, and why**: a scenario asserting several
 * genuinely time-spaced live edits from one round. `agent/loop.ts` buffers a
 * whole round and releases it in one synchronous burst once `done` confirms
 * no tool call (its own `TurnInput.onDelta` docstring explains why — no
 * earlier point is knowable, and "stream then retract" was rejected). A
 * burst has no gaps for `presence.ts`'s rate limiter to space out, so a
 * single round collapses to exactly one live update in practice — proven
 * below. The rate limiter's own multi-update behaviour is real and is
 * proven where it can actually be observed: `presence.test.ts`, driving
 * `streamText` directly across fake-clock time, independent of how
 * `loop.ts` happens to call it today.
 */

const OWNER = 4242;
const GROUP = -100200;
const STRANGER = 9999;

const groupMsg = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: GROUP, type: 'supergroup' },
      from: { id: STRANGER, is_bot: false, first_name: 'x' },
      text: 'raccontami qualcosa',
    },
  }) as unknown as Update;

const privateMsg = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      text: 'raccontami qualcosa',
    },
  }) as unknown as Update;

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Streams `chunks` (all in one synchronous burst, same as production's `drainStream` replay), then a final `done`. */
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

/** A two-round turn: a tool call first (never streamed), then a streamed final answer. */
function streamingProviderWithToolCall(toolName: string, chunks: string[], finalText: string): Provider {
  let call = 0;
  return {
    kind: 'openai-compat' as const,
    async chat(): Promise<ChatResult> {
      throw new Error('this scenario must stream, not fall back to chat()');
    },
    async *chatStream(_call: ChatCall): AsyncIterable<StreamEvent> {
      if (call++ === 0) {
        // The tool round: some "thinking aloud" text a correct wiring must
        // never let reach a surface, plus the call itself.
        yield { type: 'text_delta', text: 'lascia che controlli...' };
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: toolName };
        yield {
          type: 'done',
          result: {
            text: 'lascia che controlli...',
            toolCalls: [{ id: 'c1', name: toolName, args: {} }],
            stopReason: 'tool_use',
            usage: USAGE,
            model: 'test-model',
          },
        };
        return;
      }
      for (const chunk of chunks) yield { type: 'text_delta', text: chunk };
      yield {
        type: 'done',
        result: { text: finalText, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model' },
      };
    },
  };
}

type Recorded = { method: string; text?: string };

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
    sendMessage: async (chatId, html) => {
      calls.push({ method: 'sendMessage', text: html });
      return { message_id: nextMessageId++, date: 0, chat: { id: chatId, type: 'private' } } as never;
    },
    editMessageText: async (_chatId, _messageId, html) => {
      calls.push({ method: 'editMessageText', text: html });
      return true;
    },
    sendChatAction: async () => {
      calls.push({ method: 'sendChatAction' });
      return true;
    },
    sendMessageDraft: async (_chatId, _draftId, text) => {
      calls.push({ method: 'sendMessageDraft', text });
      return true;
    },
    fileUrl: async () => 'https://example.test/file',
  };
  return { api, calls };
}

function harness(config: TelegramConfig, provider: Provider, api: TelegramApiLike) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tgstream-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-tgstream-ws-'));
  runInit({ home, apiKey: 'sk-tgstream-never-called' });
  const runtime = buildRuntime(home, workspace);
  const loop: LoopDeps = { ...runtime.deps, provider };
  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
    api,
    config,
  });
  return { connector, runtime };
}

async function deliver(connector: TelegramConnector, updates: Update[]): Promise<void> {
  const inbox = (connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('a group turn streams the placeholder as the answer forms (B11)', () => {
  it('edits the placeholder live, and the live content is byte-identical to the finished answer — no separate re-send', async () => {
    const finalText = 'Cera una volta un muffin che parlava.';
    const provider = streamingProvider(['Cera ', 'una volta ', 'un muffin che parlava.'], finalText);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [groupMsg(1)]);

      const edits = calls.filter((c) => c.method === 'editMessageText');
      // At least one live edit happened — proof `onDelta` genuinely reached
      // `presence.streamText`, not just that the final answer got delivered
      // (which would happen even with the wiring deleted, via the ordinary
      // non-streaming finalisation path).
      expect(edits.length).toBeGreaterThanOrEqual(1);
      // Whichever edit is last, it — and the finished answer — agree byte
      // for byte, the same guarantee `cli/repl.test.ts` checks on the CLI
      // side. And it was sent exactly once: streaming already left the
      // placeholder correct, so finalisation recognised the match and did
      // not re-send.
      expect(edits[edits.length - 1]!.text).toBe(finalText);
      expect(edits).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it('never streams the tool round\'s "thinking aloud" text — only the final round reaches the placeholder', async () => {
    const finalText = 'Ecco cosa ho trovato.';
    // A name the model invented — deliberately not registered. `runTool`
    // (`agent/loop.ts`) answers an unknown tool with a `tool_result` telling
    // the model so, never a throw, which is exactly what this scenario
    // needs: a real tool round that resolves on its own, without this test
    // having to reach into the connector to register one.
    const provider = streamingProviderWithToolCall('tool_non_registrato', ['Ecco ', 'cosa ho trovato.'], finalText);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [groupMsg(2)]);

      const edits = calls.filter((c) => c.method === 'editMessageText');
      const allEditText = edits.map((e) => e.text ?? '').join('\n');
      expect(allEditText).not.toContain('lascia che controlli');
      expect(edits[edits.length - 1]?.text).toBe(finalText);
    } finally {
      runtime.close();
    }
  });
});

describe('a private turn streams the draft as the answer forms (B11)', () => {
  it('updates the draft live, then sends the finished answer as a real message — never an edit', async () => {
    const finalText = 'Ciao! Ecco una storia breve.';
    const provider = streamingProvider(['Ciao! ', 'Ecco una storia breve.'], finalText);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [privateMsg(3)]);

      const liveDrafts = calls.filter((c) => c.method === 'sendMessageDraft' && c.text !== '');
      expect(liveDrafts.length).toBeGreaterThanOrEqual(1);
      expect(liveDrafts[liveDrafts.length - 1]!.text).toBe(finalText);

      // The draft never persists on its own (M5-BIS B11 research finding,
      // api.ts#sendMessageDraft): the real answer always arrives as a
      // proper sendMessage, never an edit of the ephemeral preview.
      const sent = calls.filter((c) => c.method === 'sendMessage');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toBe(finalText);
      expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});
