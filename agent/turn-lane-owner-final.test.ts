import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import type { TelegramApiLike } from '../connectors/telegram/api.js';
import { deliverTelegram, TelegramDeliveryStore } from '../connectors/telegram/delivery.js';
import { loadConfig, saveConfig } from '../core/config/config.js';
import { TurnLane } from '../core/turns/lane.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { ownerMessage } from './loop/message-origin.js';
import { providerMessages } from './loop/provider-checkpoint.js';
import { type LoopDeps, resumeTurn, runTurn } from './loop.js';
import type { ChatResult, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';
import { type LaneDeliver, makeLaneRunner } from './turn-lane.js';

const answer: ChatResult = {
  text: 'Final answer for this work',
  toolCalls: [],
  model: 'test-model',
  stopReason: 'end',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

it.each(['before plan', 'after plan', 'during send'] as const)(
  'recovers a committed owner question final after a crash %s without rerunning work',
  async (crashAt) => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-owner-final-'));
    const home = join(root, '.muffin');
    runInit({ home, apiKey: 'sk-fixture-never-called' });
    const config = loadConfig(home);
    saveConfig(
      { ...config, surfaces: { ...config.surfaces, telegram: { ownerUserId: 42 } } },
      home,
    );
    let runtime = buildRuntime(home, home);
    try {
      const chat = vi.fn<Provider['chat']>(async () => answer);
      const deps = (): LoopDeps => ({
        ...runtime.deps,
        provider: { kind: 'openai-compat', chat },
        profile: { ...runtime.deps.profile, maxToolsExposed: 7 },
        sendWorkMessage: async () => 'sent',
      });
      const input = {
        tenant: 'host',
        principal: { kind: 'owner', connector: 'telegram', externalId: '42' } as const,
        surface: 'telegram',
        session: deps().sessions.open('fixture-owner'),
        replyTo: { chatId: 42, messageId: 1, channel: 'telegram:42' },
        text: 'Please do the work.',
      };
      // Historical ordinary owner finals also have an address and pending delivery.
      const historic = await runTurn(deps(), input);
      chat.mockResolvedValueOnce({
        ...answer,
        text: '',
        toolCalls: [
          {
            id: 'question',
            name: 'work_message',
            args: { text: 'Which file?', wait_for_reply: true },
          },
        ],
        stopReason: 'tool_use',
      });
      const paused = await runTurn(deps(), input);
      expect(paused.stopped).toBe('suspended');
      const turns = deps().turns;
      const waiting = turns.get(paused.turnId);
      if (waiting?.waitFor == null) throw new Error('missing committed question');
      expect(waiting.ownerQuestionFinal).toBe(true);
      expect(turns.pendingOwnerQuestionFinal()).toBeNull();
      expect(
        turns.answerOwnerQuestion(
          waiting.id,
          waiting.waitFor,
          [...providerMessages(waiting), ownerMessage([{ type: 'text', text: 'Use the draft.' }])],
          () => {},
        ),
      ).toBe(true);
      // Exactly the window after the execution has finished and before the lane
      // updates its scalar delivery receipt: resume directly to omit that step.
      expect(await resumeTurn(deps(), waiting.id)).toMatchObject({
        stopped: 'answered',
        text: answer.text,
      });
      expect(turns.get(waiting.id)).toMatchObject({
        status: 'done',
        waitFor: null,
        delivery: 'pending',
      });

      const now = () => new Date().toISOString();
      const part = (html: string) => ({
        operation: 'send' as const,
        chatId: 42,
        threadId: null,
        replyTo: 1,
        editMessageId: null,
        html,
      });
      const frozen = 'Original frozen wire payload';
      const journal = new TelegramDeliveryStore(runtime.db);
      if (crashAt !== 'before plan') {
        const [planned] = journal.plan(waiting.id, [part(frozen)], now(), waiting.leaseIndex);
        if (crashAt === 'during send') {
          if (!planned) throw new Error('missing frozen plan');
          expect(journal.claim(waiting.id, planned.partIndex, 'lost-response', now())).toBe(true);
        }
      }
      runtime.close();
      runtime = buildRuntime(home, home);

      const restarted = deps();
      const reopenedJournal = new TelegramDeliveryStore(runtime.db);
      const sendMessage = vi.fn<TelegramApiLike['sendMessage']>(async (chatId) => ({
        message_id: 12,
        date: 0,
        chat: { id: chatId, type: 'private', first_name: 'Fixture' },
      }));
      const api = { sendMessage } as unknown as TelegramApiLike;
      const deliver = vi.fn<LaneDeliver>(async (record, text) => {
        const receipt = await deliverTelegram(
          reopenedJournal,
          api,
          record.id,
          [part(text)],
          now,
          record.leaseIndex,
        );
        return receipt === 'sent' ? undefined : receipt;
      });
      const attachStream = vi.fn(() => undefined);
      const run = makeLaneRunner(restarted, deliver, undefined, attachStream);
      // A direct call with a historical id cannot fall through to a refusal send.
      expect(await run(historic.turnId)).toHaveProperty('refused');
      expect(deliver).not.toHaveBeenCalled();

      const lane = new TurnLane({
        turns: restarted.turns,
        modelLane: new ModelLane(),
        pendingReply: () => restarted.turns.pendingOwnerQuestionFinal()?.id,
        run,
      });
      lane.tick();
      await vi.waitFor(() => expect(lane.isRunning()).toBe(false));
      expect(deliver.mock.calls).toEqual([
        [expect.objectContaining({ id: waiting.id, ownerQuestionFinal: true }), answer.text, true],
      ]);
      expect(restarted.turns.get(waiting.id)?.delivery).toBe(
        crashAt === 'during send' ? 'possibly_sent' : 'sent',
      );
      expect(restarted.turns.get(historic.turnId)?.delivery).toBe('pending');
      expect(restarted.turns.pendingOwnerQuestionFinal()).toBeNull();
      expect(attachStream).not.toHaveBeenCalled();
      expect(chat).toHaveBeenCalledTimes(3);
      expect(sendMessage.mock.calls).toEqual(
        crashAt === 'during send'
          ? []
          : [[42, crashAt === 'after plan' ? frozen : answer.text, { replyTo: 1 }]],
      );
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
