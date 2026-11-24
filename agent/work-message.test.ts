import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import { loadConfig, saveConfig } from '../core/config/config.js';
import { decodeWaitFor } from '../core/turns/wait.js';
import { ownerMessage } from './loop/message-origin.js';
import { providerMessages } from './loop/provider-checkpoint.js';
import { type LoopDeps, resumeTurn, runTurn, type TurnInput } from './loop.js';
import type { ChatResult, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';

const calls = (...toolCalls: ChatResult['toolCalls']): ChatResult => ({
  text: '',
  model: 'test-model',
  toolCalls,
  stopReason: 'tool_use',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const final: ChatResult = { ...calls(), text: 'Final result', stopReason: 'end' };
const work = (id: string, text: string, wait?: true) => ({
  id,
  name: 'work_message',
  args: { text, ...(wait === undefined ? {} : { wait_for_reply: wait }) },
});

function deferred<T>() {
  let finish: ((result: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    finish = done;
  });
  return { promise, resolve: (value: T) => finish?.(value) };
}

function fixture(script: ChatResult[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-work-message-'));
  runInit({ home, apiKey: 'sk-never-called' });
  const config = loadConfig(home);
  saveConfig({ ...config, surfaces: { ...config.surfaces, telegram: { ownerUserId: 42 } } }, home);
  let runtime = buildRuntime(home, home);
  const chat = vi.fn<Provider['chat']>(async () => script.shift() ?? final);
  const send = vi.fn<NonNullable<LoopDeps['sendWorkMessage']>>(async () => 'sent');
  const loop = (): LoopDeps => ({
    ...runtime.deps,
    provider: { kind: 'openai-compat', chat },
    sendWorkMessage: send,
  });
  const deps = loop();
  const input: TurnInput = {
    tenant: 'host',
    principal: { kind: 'owner', connector: 'telegram', externalId: '42' },
    surface: 'telegram',
    session: deps.sessions.open('owner'),
    replyTo: { chatId: 42, messageId: 1, channel: 'telegram:42' },
    text: 'Please do this.',
  };
  return {
    deps,
    input,
    chat,
    send,
    restart: () => {
      runtime.close();
      runtime = buildRuntime(home, home);
      return loop();
    },
    close: () => {
      runtime.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

it('exposes the work message on the first owner DM round under catalogue pressure, and continues to the final result', async () => {
  const h = fixture([calls(work('ack', 'I’ll check.'))]);
  try {
    const result = await runTurn(h.deps, h.input);
    const firstMenu = h.chat.mock.calls[0]?.[0].tools?.map((tool) => tool.name);
    expect(firstMenu).toEqual(
      expect.arrayContaining(['work_message', 'fs_write', 'capability_search']),
    );
    expect(firstMenu).not.toContain('fs_edit');
    expect(h.send.mock.calls).toEqual([
      [result.turnId, expect.stringMatching(/^[a-f0-9]{64}$/), 'I’ll check.'],
    ]);
    expect(result).toMatchObject({ stopped: 'answered', text: 'Final result' });
  } finally {
    h.close();
  }
});

it('waits for the journal callback and only confirms a sent receipt; caps attempts', async () => {
  const h = fixture([calls(work('a', 'Starting.'), work('b', 'Found it.'), work('c', 'Extra.'))]);
  try {
    const entered = deferred<void>();
    const receipt = deferred<'possibly_sent'>();
    h.send.mockImplementationOnce(() => {
      entered.resolve();
      return receipt.promise;
    });
    h.send.mockResolvedValueOnce('deferred');
    const pending = runTurn(h.deps, h.input);
    await entered.promise;
    expect(h.chat).toHaveBeenCalledTimes(1);
    receipt.resolve('possibly_sent');
    const result = await pending;
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[0]?.[1]).not.toBe(h.send.mock.calls[1]?.[1]);
    const recorded = h.deps.turns.recordedOutcomes(result.turnId);
    for (const id of ['a', 'b'])
      expect(recorded.get(id)).toMatchObject({
        isError: true,
        content: expect.stringContaining('not confirmed'),
      });
    expect(recorded.get('c')).toMatchObject({
      isError: true,
      content: expect.stringContaining('limit reached'),
    });
  } finally {
    h.close();
  }
});

it('hides and refuses directly named calls outside the paired owner DM', async () => {
  const h = fixture([]);
  try {
    const forbidden: [LoopDeps, Partial<TurnInput>][] = [
      [h.deps, { surface: 'cli' }],
      [h.deps, { jobId: 'scheduled' }],
      [
        h.deps,
        {
          tenant: 'group:telegram:-42',
          principal: {
            kind: 'member',
            connector: 'telegram',
            externalId: '42',
            tenantId: 'group:telegram:-42',
          },
        },
      ],
      [h.deps, { replyTo: undefined }],
      [h.deps, { replyTo: { chatId: 43, messageId: 1, channel: 'telegram:43' } }],
      [h.deps, { replyTo: { chatId: 42, messageId: 1, channel: 'telegram:43' } }],
      [{ ...h.deps, sendWorkMessage: undefined }, {}],
      [{ ...h.deps, workMessageOwner: () => ({}) }, {}],
    ];
    for (const [deps, overrides] of forbidden) {
      h.chat.mockClear();
      h.chat.mockResolvedValueOnce(calls(work('guess', 'Do not send.', true)));
      const result = await runTurn(deps, { ...h.input, ...overrides });
      expect(h.chat).toHaveBeenCalled();
      expect((h.chat.mock.calls[0]?.[0].tools ?? []).map((tool) => tool.name)).not.toContain(
        'work_message',
      );
      expect(result.stopped).not.toBe('suspended');
      expect(h.deps.turns.get(result.turnId)?.waitFor).toBeNull();
      expect(h.deps.turns.recordedOutcomes(result.turnId).get('guess')?.isError).toBe(true);
    }
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    h.close();
  }
});

it('honors surface.reply again when taint rises inside a tool batch', async () => {
  const h = fixture([
    calls(
      { id: 'read', name: 'fs_read', args: { path: 'note.txt' } },
      work('blocked', 'Do not deliver.'),
    ),
  ]);
  try {
    h.deps.tools = h.deps.tools.map((tool) =>
      tool.spec.name === 'fs_read'
        ? { ...tool, handler: () => ({ tier: 2, content: 'local bytes' }) }
        : tool,
    );
    const policy = h.deps.decide;
    h.deps.decide = (req) =>
      req.capability === 'surface.reply' && req.taint >= 2
        ? { effect: 'deny', code: 'principal_forbidden' }
        : policy(req);
    const result = await runTurn(h.deps, h.input);
    expect(h.chat.mock.calls[0]?.[0].tools?.map((tool) => tool.name)).toContain('work_message');
    expect(h.deps.turns.recordedOutcomes(result.turnId).get('read')?.tier).toBe(2);
    expect(h.deps.turns.recordedOutcomes(result.turnId).has('blocked')).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    h.close();
  }
});

it('rechecks the paired owner after projection and rejects a model-selected destination', async () => {
  const h = fixture([
    calls({
      id: 'target',
      name: 'work_message',
      args: { text: 'Update.', destination: 'telegram:99' },
    }),
    calls(work('revoked', 'Another update.')),
  ]);
  try {
    const readOwner = h.deps.workMessageOwner;
    h.deps.workMessageOwner = vi
      .fn(() => ({}))
      .mockImplementationOnce(() => readOwner?.() ?? {})
      .mockImplementationOnce(() => readOwner?.() ?? {});
    const result = await runTurn(h.deps, h.input);
    expect(h.chat.mock.calls[0]?.[0].tools?.map((tool) => tool.name)).toContain('work_message');
    const outcomes = h.deps.turns.recordedOutcomes(result.turnId);
    expect(outcomes.get('target')?.content).toContain('Provide text');
    expect(outcomes.get('revoked')?.content).toContain('unavailable');
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    h.close();
  }
});

it('rejects a question mixed with another effect, persists a solo question, and resumes once across a runtime restart', async () => {
  const h = fixture([
    calls(work('mixed', 'Not this one.', true), work('progress', 'I started.')),
    calls(work('solo', 'Which file?', true)),
    calls(work('repeat', 'Which file again?', true)),
  ]);
  try {
    const result = await runTurn(h.deps, h.input);
    const questions = h.deps.turns.ownerQuestions();
    const waiting = questions[0];
    expect(questions).toHaveLength(1);
    expect(waiting).toMatchObject({ id: result.turnId, status: 'waiting' });
    expect(decodeWaitFor(waiting?.waitFor ?? null)).toEqual({
      kind: 'owner_reply',
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      question: 'Which file?',
    });
    expect(result).toMatchObject({ stopped: 'suspended', text: '' });
    expect(h.send.mock.calls.map((entry) => entry[2])).toEqual(['I started.']);
    expect(h.deps.turns.recordedOutcomes(result.turnId).get('mixed')).toMatchObject({
      isError: true,
    });

    const restarted = h.restart();
    const row = restarted.turns.get(result.turnId);
    if (row?.waitFor == null) throw new Error('question was not durable');
    expect(restarted.turns.wake(row.id)).toBe(false);
    const messages = [
      ...providerMessages(row),
      ownerMessage([{ type: 'text', text: 'Use draft.txt.' }]),
    ];
    const consume = vi.fn();
    expect(restarted.turns.answerOwnerQuestion(row.id, row.waitFor, messages, consume)).toBe(true);
    expect(restarted.turns.answerOwnerQuestion(row.id, row.waitFor, messages, consume)).toBe(false);
    expect(consume).toHaveBeenCalledTimes(1);
    const finished = await resumeTurn(restarted, row.id);
    expect(finished).toMatchObject({ stopped: 'answered', turnId: row.id, text: 'Final result' });
    expect(h.chat.mock.calls[2]?.[0].messages).toContainEqual(
      ownerMessage([{ type: 'text', text: 'Use draft.txt.' }]),
    );
    expect(restarted.turns.recordedOutcomes(row.id).get('repeat')).toMatchObject({ isError: true });
    expect(h.send).toHaveBeenCalledTimes(1);
  } finally {
    h.close();
  }
});

it('scrubs recognized secret values and sensitive resource echoes before sending and checkpointing the question', async () => {
  const echo = 'sensitive fixture value that is not shaped like a key';
  const secret = `sk-ant-api03-${'a'.repeat(45)}`;
  const body = `Needs attention: ${echo}; ${secret}`;
  const h = fixture([
    calls({ id: 'read', name: 'fs_read', args: { path: 'credentials.txt' } }),
    calls(work('progress', body)),
    calls(work('question', `Which option? ${body}`, true)),
  ]);
  try {
    h.deps.tools = h.deps.tools.map((tool) =>
      tool.spec.name === 'fs_read'
        ? { ...tool, handler: () => ({ tier: 2, content: echo }) }
        : tool,
    );
    const result = await runTurn(h.deps, h.input);
    expect(result.stopped).toBe('suspended');
    const row = h.deps.turns.get(result.turnId);
    const uses = providerMessages(row).flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_use' && block.name === 'work_message'),
    );
    expect(uses).toHaveLength(2);
    const safeOutputs = [h.send.mock.calls[0]?.[2], decodeWaitFor(row?.waitFor ?? null), ...uses];
    for (const output of safeOutputs) {
      const serialized = JSON.stringify(output);
      expect(serialized).toContain('Needs attention');
      expect(serialized).not.toContain(echo);
      expect(serialized).not.toContain(secret);
    }
  } finally {
    h.close();
  }
});

it('resumes a question without an answer at its deadline and refuses to repeat it', async () => {
  const h = fixture([
    calls(work('question', 'Which option?', true)),
    calls(work('repeat', 'Still waiting?', true)),
  ]);
  try {
    const running = await runTurn(h.deps, h.input);
    const row = h.deps.turns.get(running.turnId);
    if (row?.wakeAt == null) throw new Error('question has no deadline');
    const now = () => new Date(row.wakeAt ?? '');
    expect(h.deps.turns.wake(row.id, now())).toBe(true);
    const result = await resumeTurn({ ...h.deps, now }, row.id);
    expect(result).toMatchObject({ stopped: 'answered', turnId: row.id });
    expect(JSON.stringify(h.chat.mock.calls[1]?.[0].messages)).toContain('No reply arrived');
    expect(h.deps.turns.recordedOutcomes(row.id).get('repeat')?.isError).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    h.close();
  }
});

it.each(['endToolCall', 'suspend'] as const)(
  'does not publish or leave an armed wait if %s fails',
  async (method) => {
    const h = fixture([calls(work('question', 'Which option?', true))]);
    try {
      vi.spyOn(h.deps.turns, method).mockImplementationOnce(() => {
        throw new Error('injected storage failure');
      });
      const result = await runTurn(h.deps, h.input);
      expect(result.stopped).not.toBe('suspended');
      expect(h.deps.turns.ownerQuestions()).toEqual([]);
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  },
);

it.each(['progress receipt', 'question barrier'] as const)(
  'does not replay an effect after losing the claim before the %s is recorded',
  async (write) => {
    const question = write === 'question barrier';
    const h = fixture([calls(work('call', 'Chosen text.', question ? true : undefined))]);
    try {
      const loseClaim = () => h.deps.turns.reclaim(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
      if (question) {
        vi.spyOn(h.deps.turns, 'suspend').mockImplementationOnce(() => {
          loseClaim();
          return false;
        });
      } else {
        h.send.mockImplementationOnce(async () => {
          loseClaim();
          return 'sent';
        });
        vi.spyOn(h.deps.turns, 'endToolCall').mockImplementationOnce(() => {
          throw new Error('injected lost receipt');
        });
      }
      const interrupted = await runTurn(h.deps, h.input);
      expect(h.deps.turns.get(interrupted.turnId)?.status).toBe('interrupted');
      const restarted = h.restart();
      const result = await resumeTurn(restarted, interrupted.turnId);
      expect(result).toMatchObject({ stopped: 'answered', turnId: interrupted.turnId });
      expect(restarted.turns.ownerQuestions()).toEqual([]);
      expect(h.send).toHaveBeenCalledTimes(question ? 0 : 1);
      const resumed = h.chat.mock.calls.at(-1)?.[0].messages;
      expect(JSON.stringify(resumed)).toContain(
        question ? 'question was not sent' : 'non è possibile sapere',
      );
    } finally {
      h.close();
    }
  },
);
