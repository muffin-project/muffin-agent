import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Update } from '@grammyjs/types';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatResult, Provider } from '../../agent/providers/types.js';
import { TelegramConnector, type TelegramConfig } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { TelegramApiLike } from './api.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

/**
 * FIRST-TOOL FALSIFIER (owner, 2026-09-18): the frozen-timer test proved a
 * timer dependency, but the owner watched ~70 s of nothing with real timers.
 * The stronger property — the one that explains 70 s and not just 0 ms —
 * is ordering, not timing:
 *
 *   `api.sendMessage` for the FIRST `tool_start` must be INVOKED before
 *   execution enters a potentially synchronous/blocking tool handler.
 *
 * `runTool` (`agent/loop/tool-call.ts`) emits `tool_start` synchronously and
 * invokes the handler in the same stack, immediately after `onProgress`
 * returns. Anything the transcript defers past `report()`'s own stack —
 * a `setTimeout` of any length, even 0, or a `.then()` microtask — has not
 * run when a blocking handler takes the event loop, so the first visible
 * progress dies for exactly as long as the tool runs. A microtask-only fix
 * would pass a microtask-awaiting test and still fail the owner.
 *
 * This file proves the property through the production path
 * (`drain()` → `runTurn` → `runTool` → `transcript.report`), with a tool
 * whose handler monopolises the event loop on entry (deterministic
 * busy-spin, not a 70-second test) plus a deferred gate. No fake timers, no
 * sleeps, no second tool, no second model event. On the pre-fix transcript
 * it fails deterministically (0 sends at handler entry); after the fix the
 * send is already started when the handler is entered.
 */

const OWNER = 4242;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

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

describe('first paint beats a blocking first tool handler', () => {
  it('the first running step is sent before the handler body can block the loop', async () => {
    type Call = { method: string; text?: string; messageId?: number };
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
      sendChatAction: async () => true,
      sendMessageDraft: async () => true,
    } as unknown as TelegramApiLike;

    // The handler records, on its very first synchronous line, how many
    // persistent sends had already STARTED — then blocks the loop on purpose.
    const enteredWithSends: number[] = [];
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseTool!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const blockingTool: any = {
      spec: { name: 'sonda_bloccante_xyz', description: 'probe', inputSchema: { type: 'object' } as any },
      capability: 'probe.bloccante',
      handler: async () => {
        enteredWithSends.push(calls.filter((c) => c.method === 'sendMessage').length);
        enteredResolve();
        // Deterministic blocking seam: a synchronous monopolisation of the
        // event loop. Short on purpose — the assertion above does not depend
        // on its length; it stands for the owner's 70-second search.
        const until = Date.now() + 30;
        while (Date.now() < until) {
          // busy-spin: no timers, no I/O, no yield
        }
        await gate;
        return { content: 'risultato sonda', tier: 0 as const };
      },
    };

    // Plain `chat()` provider, no streaming: nothing is ever shown before the
    // tool round, so `tool_start` is literally the transcript's first fact —
    // no preamble paint can hide behind this assertion.
    let n = 0;
    const provider: Provider = {
      kind: 'openai-compat',
      chat: async (): Promise<ChatResult> => {
        if (n++ === 0) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'sonda_bloccante_xyz', args: {} }],
            stopReason: 'tool_use',
            usage: USAGE,
            model: 'test-model',
          };
        }
        return { text: 'fatto.', toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model' };
      },
    };

    const home = mkdtempSync(join(tmpdir(), 'muffin-firstpaint-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-firstpaint-ws-'));
    runInit({ home, apiKey: 'sk-firstpaint-never-called' });
    const runtime = buildRuntime(home, workspace);
    (runtime.deps as any).tools = [...(runtime.deps as any).tools, blockingTool];
    (runtime.deps as any).decide = () => ({ effect: 'allow' as const });
    const loop: LoopDeps = { ...(runtime.deps as any), provider };
    const inbox = new UpdateInbox((runtime as any).db);
    const connector = new TelegramConnector({
      loop,
      sessions: (runtime.deps as any).sessions,
      lane: new ModelLane(),
      inbox,
      delivery: new TelegramDeliveryStore((runtime as any).db),
      api,
      config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER } as TelegramConfig,
    });
    (connector as unknown as { meUsername: string }).meUsername = 'MuffinBot';

    try {
      inbox.accept([privateMsg(1)], new Date().toISOString());
      const draining = (connector as unknown as { drain: () => Promise<void> }).drain();
      await entered;
      // THE invariant: started synchronously from the first durable progress
      // fact, before tool execution could monopolise the event loop.
      expect(enteredWithSends[0]).toBeGreaterThanOrEqual(1);
      expect(calls[0]!.method).toBe('sendMessage');
      expect(calls[0]!.text).toContain('⏳');
      releaseTool();
      await draining;
      // …and the turn still ends as exactly one message, answer merged in.
      const sends = calls.filter((c) => c.method === 'sendMessage');
      expect(sends).toHaveLength(1);
      const last = calls.filter((c) => c.method === 'editMessageText').at(-1)!;
      expect(last.text).toContain('fatto.');
    } finally {
      runtime.close();
    }
  });
});
