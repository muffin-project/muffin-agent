import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../../agent/loop.js';
import {
  type DraftOptions,
  type InlineButton,
  type TelegramApiLike,
  TelegramError,
} from './api.js';
import { askPlain } from './approval.js';
import { negoziazioneTelegram } from './negoziazione.js';
import { TELEGRAM_MAX } from './render.js';
import { type OutboundRich, RICH_MAX_CHARS } from './rich.js';
import { formatDraftStatus, startTranscript } from './transcript.js';

const DM = negoziazioneTelegram('direct');
const GROUP = negoziazioneTelegram('group');

describe('formatDraftStatus', () => {
  it('always returns a complete status line with a bound unit, never a stub or a bare number', () => {
    expect(formatDraftStatus('sto lavorando', 7000)).toBe('sto lavorando · 7\u00a0s');
    expect(formatDraftStatus('sto preparando il contesto', 0)).toBe(
      'sto preparando il contesto · 0\u00a0s',
    );
    expect(formatDraftStatus('sto lavorando', 7400)).toBe('sto lavorando · 7\u00a0s');
    for (const line of [
      formatDraftStatus('sto preparando il contesto', 0),
      formatDraftStatus('sto lavorando', 1000),
      formatDraftStatus('sto lavorando', 7000),
    ]) {
      expect(line).toMatch(/ · \d+\u00a0s$/);
      expect(line).not.toBe('prep');
      expect(line).not.toMatch(/^\d+$/);
      expect(line).not.toMatch(/\d+$/); // unit is always present; number is not the last char
      expect(line.includes('\u00a0s')).toBe(true);
    }
  });
});

type Call = {
  method: string;
  text?: string | undefined;
  rich?: OutboundRich;
  keyboard?: InlineButton[][] | undefined;
  messageId?: number;
  draftId?: number;
  draftOptions?: DraftOptions | undefined;
  at?: number;
};

function recordingApi(fail: Partial<Record<string, Error>> = {}) {
  const calls: Call[] = [];
  let nextId = 500;
  function record(call: Call) {
    calls.push(call);
    const error = fail[call.method];
    if (error !== undefined) throw error;
    return true;
  }
  function send(chatId: number, call: Call) {
    const messageId = nextId++;
    record({ ...call, messageId });
    return {
      message_id: messageId,
      date: 0,
      chat: { id: chatId, type: 'private' as const, first_name: 'Test' },
    };
  }
  const api = {
    sendMessage: async (chatId, text, options) =>
      send(chatId, { method: 'sendMessage', text, keyboard: options?.keyboard }),
    sendRichMessage: async (chatId, rich, options) =>
      send(chatId, { method: 'sendRichMessage', rich, keyboard: options?.keyboard }),
    editMessageText: async (_chatId, messageId, text, options) =>
      record({ method: 'editMessageText', messageId, text, keyboard: options?.keyboard }),
    editMessageRichText: async (_chatId, messageId, rich, options) =>
      record({ method: 'editMessageRichText', messageId, rich, keyboard: options?.keyboard }),
    editMessageReplyMarkup: async (_chatId, messageId, keyboard = []) =>
      record({ method: 'editMessageReplyMarkup', messageId, keyboard }),
    deleteMessage: async (_chatId, messageId) => record({ method: 'deleteMessage', messageId }),
    sendChatAction: async () => record({ method: 'sendChatAction' }),
    sendMessageDraft: async (_chatId, draftId, text, draftOptions) =>
      record({ method: 'sendMessageDraft', text, draftId, draftOptions, at: Date.now() }),
    sendRichMessageDraft: async (_chatId, draftId, rich, draftOptions) =>
      record({ method: 'sendRichMessageDraft', rich, draftId, draftOptions, at: Date.now() }),
  } satisfies Pick<
    TelegramApiLike,
    | 'sendMessage'
    | 'sendRichMessage'
    | 'editMessageText'
    | 'editMessageRichText'
    | 'editMessageReplyMarkup'
    | 'deleteMessage'
    | 'sendChatAction'
    | 'sendMessageDraft'
    | 'sendRichMessageDraft'
  >;
  return { api: api as unknown as TelegramApiLike, calls };
}

const isDraft = (c: Call) => c.method.endsWith('Draft');
const isSend = (c: Call) => c.method === 'sendMessage' || c.method === 'sendRichMessage';
const isEdit = (c: Call) => c.method === 'editMessageText' || c.method === 'editMessageRichText';

function visibleText(call: Call | undefined): string {
  const html = call?.text ?? call?.rich?.html;
  if (html !== undefined)
    return html.replace(/<br\s*\/?>/g, '\n').replace(/<\/?(?:b|i|pre|code)>/g, '');
  return call?.rich?.blocks?.map((block) => ('text' in block ? block.text : '')).join('\n') ?? '';
}

const lastKeyboard = (calls: Call[]) => calls.filter((c) => c.keyboard !== undefined).at(-1);
const callbacks = (call: Call | undefined) =>
  call?.keyboard?.flat().map((button) => button.callback_data);
const removeKeyboard = (calls: Call[]) =>
  calls.filter((c) => c.method === 'editMessageReplyMarkup' && c.keyboard?.length === 0);
// The waiting mark is presentation. The question itself includes the command's newlines.
const questionText = (call: Call | undefined) => visibleText(call).replace(/^⏸\s*/, '');

const toolName = 'shell_run_write';
const toolArgs = { command: 'echo raw-command', cwd: '/raw-working-directory' };
const toolStart = {
  type: 'tool_start',
  name: toolName,
  capability: 'sys.shell.write',
  args: toolArgs,
} as const;
const toolEnd = {
  type: 'tool_end',
  name: toolName,
  isError: false,
  ms: 1,
  args: toolArgs,
} as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ordinary turns', () => {
  it('does not write or hand off anything in a group, even after tool work and streamed text', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, -1, { negotiation: GROUP });
    t.report({ type: 'preparing_context' });
    t.live('Prima controllo');
    t.spoke('Prima controllo', 'tool-call');
    t.report(toolStart);
    await vi.advanceTimersByTimeAsync(GROUP.editEveryMs);
    t.report(toolEnd);
    t.live('Ecco il risultato');
    await vi.advanceTimersByTimeAsync(GROUP.editEveryMs);
    await t.stop();

    expect(calls).toEqual([]);
    expect(t.handoff()).toBeNull();
  });

  it('starts a native stoppable DM draft before the first token and only shows generic status during tools', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report({ type: 'preparing_context' });
    // Invocation is synchronous: context preparation may block before a timer can run.
    expect(calls[0]).toMatchObject({
      method: 'sendRichMessageDraft',
      rich: {
        blocks: [{ type: 'thinking', text: expect.stringContaining('sto preparando il contesto') }],
      },
      draftOptions: { canStop: true },
    });
    await vi.advanceTimersByTimeAsync(0);

    t.report(toolStart);
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    expect(calls.at(-1)?.rich?.blocks).toEqual([
      { type: 'thinking', text: expect.stringContaining('sto lavorando') },
    ]);

    t.report(toolEnd);
    t.report({ type: 'round', n: 2 });
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    await t.stop();

    const wire = JSON.stringify(calls);
    for (const hidden of [
      toolName,
      toolArgs.command,
      toolArgs.cwd,
      'Processo',
      '"type":"details"',
    ]) {
      expect(wire).not.toContain(hidden);
    }
    for (const call of calls) {
      expect(call.method).toBe('sendRichMessageDraft');
      expect(call.draftOptions?.canStop).toBe(true);
      expect(call.draftOptions?.keepOnStop).not.toBe(true);
    }
    expect(t.handoff()).toBeNull();
  });

  it.each(['tool-call', 'superseded'] as const)(
    'clears the streamed DM preview at a %s boundary before new tokens arrive',
    async (reason) => {
      const { api, calls } = recordingApi();
      const t = startTranscript(api, 1, { negotiation: DM });
      t.report({ type: 'round', n: 1 });
      t.live('Questo è un frammento');
      await vi.advanceTimersByTimeAsync(DM.editEveryMs);
      expect(visibleText(calls.at(-1))).toBe('Questo è un frammento');

      const beforeBoundary = calls.length;
      t.spoke('Questo è un frammento', reason);
      await vi.advanceTimersByTimeAsync(DM.editEveryMs);
      const updates = calls.slice(beforeBoundary);
      expect(updates.length).toBeGreaterThan(0);
      for (const update of updates) {
        expect(update.rich?.blocks).toEqual([
          { type: 'thinking', text: expect.stringMatching(/\S/) },
        ]);
        expect(JSON.stringify(update)).not.toContain('Questo è un frammento');
      }

      t.live('Ecco');
      t.live('Ecco la risposta');
      await vi.advanceTimersByTimeAsync(DM.editEveryMs);
      expect(visibleText(calls.at(-1))).toBe('Ecco la risposta');
      await t.stop();
      expect(calls.every(isDraft)).toBe(true);
      expect(t.handoff()).toBeNull();
    },
  );

  it('renews a silent DM preview within its TTL under one draft ID, then stops without sending an empty draft', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('Sto scrivendo la risposta');
    await vi.advanceTimersByTimeAsync(2 * DM.draftTtlMs);

    expect(calls.length).toBeGreaterThan(1);
    const first = calls[0];
    expect(first?.draftId).toBeGreaterThan(0);
    let previous = first?.at ?? Number.NEGATIVE_INFINITY;
    for (const call of calls) {
      expect(isDraft(call)).toBe(true);
      expect(call.draftId).toBe(first?.draftId);
      expect(visibleText(call)).toBe('Sto scrivendo la risposta');
      const at = call.at ?? Number.POSITIVE_INFINITY;
      expect(at - previous).toBeLessThan(DM.draftTtlMs);
      previous = at;
    }
    expect(Date.now() - previous).toBeLessThan(DM.draftTtlMs);

    const beforeStop = calls.length;
    await t.stop();
    await t.stop();
    t.report(toolStart);
    t.spoke('Testo tardivo', 'tool-call');
    t.live('Testo tardivo');
    await vi.advanceTimersByTimeAsync(2 * DM.draftTtlMs);
    expect(calls).toHaveLength(beforeStop);
    expect(t.handoff()).toBeNull();
  });

  it('does not hold up stop when Telegram never acknowledges the draft', async () => {
    const { api } = recordingApi();
    const sendRichMessageDraft = vi.fn(() => new Promise<boolean>(() => {}));
    const t = startTranscript({ ...api, sendRichMessageDraft }, 1, { negotiation: DM });
    t.report({ type: 'preparing_context' });
    expect(sendRichMessageDraft).toHaveBeenCalledOnce();

    const stopping = t.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopping).resolves.toBeUndefined();
  });

  it('falls back to bounded draft text beyond the rich protocol limit', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    const line = 'Una riga intera della risposta.';
    t.live(`Inizio\n${`${line}\n`.repeat(Math.ceil(RICH_MAX_CHARS / line.length))}Ultima riga.`);
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);

    const last = calls.at(-1);
    const fallback = last?.text ?? last?.rich?.html;
    expect(last?.method).toMatch(/Draft$/);
    expect(fallback).toBeDefined();
    expect(visibleText(last).length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(visibleText(last).split('\n').at(-1)).toBe('Ultima riga.');
    expect(visibleText(last).split('\n')[0]).toBe(line);
    expect(last?.draftOptions?.canStop).toBe(true);
    await t.stop();
    expect(calls.every(isDraft)).toBe(true);
  });

  it('keeps the DM draft stoppable after a definite rich refusal', async () => {
    const { api, calls } = recordingApi({
      sendRichMessageDraft: new TelegramError(400, 'Bad Request: rich refused'),
    });
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report({ type: 'preparing_context' });
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);

    expect(calls.slice(0, 2)).toMatchObject([
      { method: 'sendRichMessageDraft' },
      {
        method: 'sendMessageDraft',
        draftId: calls[0]?.draftId,
        text: expect.stringContaining('sto preparando il contesto'),
        draftOptions: { canStop: true },
      },
    ]);
    t.live('Una risposta in arrivo');
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    expect(calls.at(-1)).toMatchObject({
      method: 'sendMessageDraft',
      text: 'Una risposta in arrivo',
      draftOptions: { canStop: true },
    });
    await t.stop();
    expect(calls.every(isDraft)).toBe(true);
    expect(t.handoff()).toBeNull();
  });

  it('stops attempting drafts when both transports refuse, with no durable fallback or handoff', async () => {
    const refusal = new TelegramError(400, 'Bad Request: draft refused');
    const { api, calls } = recordingApi({
      sendRichMessageDraft: refusal,
      sendMessageDraft: refusal,
    });
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report({ type: 'round', n: 1 });
    await vi.advanceTimersByTimeAsync(0);
    t.report(toolStart);
    t.live('Una risposta in arrivo');
    await vi.advanceTimersByTimeAsync(DM.draftTtlMs);
    await t.stop();

    expect(calls.map((c) => c.method)).toEqual(['sendRichMessageDraft', 'sendMessageDraft']);
    expect(t.handoff()).toBeNull();
  });
});

describe('approval messages', () => {
  const request: ApprovalRequest = {
    capability: toolStart.capability,
    prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
    resource: 'command: echo ciao\ncwd: .',
    description: 'stampa la parola ciao',
    taint: 2,
  };
  const approvalId = 'aabb';

  it('in a group, a first tool followed by ask sends the exact question as the first bubble', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, -1, { negotiation: GROUP });
    t.report(toolStart);
    expect(calls).toEqual([]);
    await expect(t.ask({ request, approvalId })).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(GROUP.editEveryMs);

    expect(calls).toHaveLength(1);
    expect(calls.filter(isSend)).toHaveLength(1);
    expect(questionText(calls[0])).toBe(askPlain(request));
    expect(callbacks(calls[0])).toEqual(['ok:aabb', 'no:aabb']);
    await t.stop();
  });

  it('binds the DM question, callback cleanup, streamed answer and handoff to the same message', async () => {
    const { api, calls } = recordingApi();
    const onAsked = vi.fn();
    const t = startTranscript(api, 1, { negotiation: DM, onAsked });
    t.report({ type: 'preparing_context' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some(isDraft)).toBe(true);
    const beforeAsk = calls.length;
    await expect(t.ask({ request, approvalId })).resolves.toBe(true);
    expect(calls.filter(isSend)).toHaveLength(1);
    const question = calls.find(isSend);
    const messageId = question?.messageId;
    expect(messageId).toBeGreaterThan(0);
    expect(visibleText(question)).toContain(request.resource);
    expect(callbacks(question)).toEqual(['ok:aabb', 'no:aabb']);
    expect(onAsked.mock.calls).toEqual([[{ approvalId, messageId }]]);

    // The loop's notification after ask() must not write a second question.
    const afterAsk = calls.length;
    t.report({ type: 'ask', name: toolName, capability: request.capability });
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    expect(calls).toHaveLength(afterAsk);

    t.resolveAsk({ approvalId, capability: request.capability }, true);
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    expect(removeKeyboard(calls)).toEqual([
      { method: 'editMessageReplyMarkup', messageId, keyboard: [] },
    ]);
    const resolved = visibleText(calls.filter(isEdit).at(-1));
    expect(resolved).toContain(request.resource);
    expect(resolved).toContain('sys.shell.write: consentito');

    const partial = 'Ecco la risposta in arrivo';
    t.report(toolStart);
    t.report(toolEnd);
    t.live(partial);
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    const streamed = calls.filter(isEdit).at(-1);
    expect(streamed?.messageId).toBe(messageId);
    expect(visibleText(streamed)).toContain(partial);

    await t.stop();
    expect(calls.slice(beforeAsk).some(isDraft)).toBe(false);
    expect(calls.filter(isSend)).toHaveLength(1);
    expect(calls.filter(isEdit).every((call) => call.messageId === messageId)).toBe(true);
    const handoff = t.handoff();
    expect(handoff).toEqual({
      messageId,
      approvals: expect.any(Array),
      approvalHtml: expect.any(String),
    });
    for (const approval of [handoff?.approvals.join('\n'), handoff?.approvalHtml]) {
      expect(approval).toContain('echo ciao');
      expect(approval).toContain('sys.shell.write: consentito');
      expect(approval).not.toContain(partial);
      expect(approval).not.toContain('sto preparando il contesto');
      expect(approval).not.toContain(toolArgs.command);
    }
  });

  it.each(['aaaa', 'bbbb'])(
    'resolves the exact approval id %s when two resources share a capability',
    async (firstId) => {
      const { api, calls } = recordingApi();
      const onAsked = vi.fn();
      const t = startTranscript(api, 1, { negotiation: DM, onAsked });
      const first = { request: { ...request, resource: 'command: echo uno' }, approvalId: 'aaaa' };
      const second = { request: { ...request, resource: 'command: echo due' }, approvalId: 'bbbb' };
      for (const input of [first, second]) {
        await expect(t.ask(input)).resolves.toBe(true);
        expect(visibleText(calls.filter((c) => isSend(c) || isEdit(c)).at(-1))).toContain(
          input.request.resource,
        );
        expect(callbacks(lastKeyboard(calls))).toEqual([
          `ok:${input.approvalId}`,
          `no:${input.approvalId}`,
        ]);
      }
      const messageId = calls.find(isSend)?.messageId;
      expect(onAsked.mock.calls).toEqual([
        [{ approvalId: 'aaaa', messageId }],
        [{ approvalId: 'bbbb', messageId }],
      ]);

      const [decided, pending] = firstId === first.approvalId ? [first, second] : [second, first];
      t.resolveAsk({ approvalId: firstId, capability: request.capability }, true);
      await vi.advanceTimersByTimeAsync(DM.editEveryMs);
      expect(callbacks(lastKeyboard(calls))).toEqual([
        `ok:${pending.approvalId}`,
        `no:${pending.approvalId}`,
      ]);
      const entries = visibleText(calls.filter(isEdit).at(-1)).split(/(?=[⏸✓✗]\s)/u);
      const resolved = entries.find((entry) => entry.includes(decided.request.resource));
      const waiting = entries.find((entry) => entry.includes(pending.request.resource));
      expect(resolved).toMatch(/^✓[\s\S]*consentito/);
      expect(waiting).toMatch(/^⏸/);
      expect(waiting).not.toContain('consentito');

      t.resolveAsk({ approvalId: pending.approvalId, capability: request.capability }, false);
      await vi.advanceTimersByTimeAsync(DM.editEveryMs);
      expect(removeKeyboard(calls)).toEqual([
        { method: 'editMessageReplyMarkup', messageId, keyboard: [] },
      ]);
      expect(visibleText(calls.filter(isEdit).at(-1))).toContain('sys.shell.write: rifiutato');
      await t.stop();
      expect(calls.filter(isSend)).toHaveLength(1);
    },
  );

  it('reattaches and deduplicates a re-asked approval with the same id', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    const input = { request, approvalId };
    await t.ask(input);
    const messageId = calls.find(isSend)?.messageId;
    const beforeReask = calls.length;
    await expect(t.ask(input)).resolves.toBe(true);
    expect(lastKeyboard(calls.slice(beforeReask))?.messageId).toBe(messageId);
    expect(callbacks(lastKeyboard(calls))).toEqual(['ok:aabb', 'no:aabb']);

    t.resolveAsk({ approvalId, capability: request.capability }, true);
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    expect(removeKeyboard(calls)).toEqual([
      { method: 'editMessageReplyMarkup', messageId, keyboard: [] },
    ]);
    expect(visibleText(calls.filter(isEdit).at(-1)).match(/command: echo ciao/g)).toHaveLength(1);
    await t.stop();
  });

  it('uses legacy for a deterministic approval refusal and still binds the accepted message id', async () => {
    const { api, calls } = recordingApi({
      sendRichMessage: new TelegramError(400, 'Bad Request: rich refused'),
    });
    const onAsked = vi.fn();
    const t = startTranscript(api, -1, { negotiation: GROUP, onAsked });
    await expect(t.ask({ request, approvalId })).resolves.toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['sendRichMessage', 'sendMessage']);
    expect(callbacks(calls[1])).toEqual(['ok:aabb', 'no:aabb']);
    expect(onAsked.mock.calls).toEqual([[{ approvalId, messageId: calls[1]?.messageId }]]);
    expect(t.handoff()?.messageId).toBe(calls[1]?.messageId);
    await t.stop();
  });

  it('returns false and never records a binding when neither approval transport accepts', async () => {
    const refusal = new TelegramError(400, 'Bad Request: question refused');
    const { api, calls } = recordingApi({ sendRichMessage: refusal, sendMessage: refusal });
    const onAsked = vi.fn();
    const t = startTranscript(api, -1, { negotiation: GROUP, onAsked });
    await expect(t.ask({ request, approvalId })).resolves.toBe(false);
    expect(onAsked).not.toHaveBeenCalled();
    expect(t.handoff()).toBeNull();
    await t.stop();
    expect(calls.map((call) => call.method)).toEqual(['sendRichMessage', 'sendMessage']);
  });

  it('does not resend or bind an approval when the rich send outcome is ambiguous', async () => {
    const { api, calls } = recordingApi({
      sendRichMessage: new TelegramError(0, 'response stream closed'),
    });
    const onAsked = vi.fn();
    const t = startTranscript(api, -1, { negotiation: GROUP, onAsked });
    await expect(t.ask({ request, approvalId })).resolves.toBe('uncertain');
    expect(onAsked).not.toHaveBeenCalled();
    expect(t.handoff()).toBeNull();
    await t.stop();
    expect(calls.map((call) => call.method)).toEqual(['sendRichMessage']);
  });

  it('keeps an accepted question accepted even if the binding hook throws', async () => {
    const { api, calls } = recordingApi();
    const onAsked = vi.fn(() => {
      throw new Error('binding hook failed');
    });
    const t = startTranscript(api, 1, { negotiation: DM, onAsked });
    await expect(t.ask({ request, approvalId })).resolves.toBe(true);
    expect(onAsked).toHaveBeenCalledOnce();
    expect(t.handoff()?.messageId).toBe(calls.find(isSend)?.messageId);
    await t.stop();
  });

  it('clears the pending keyboard on stop and ignores late inputs', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    await expect(t.ask({ request, approvalId })).resolves.toBe(true);
    const messageId = calls.find(isSend)?.messageId;
    await t.stop();
    expect(removeKeyboard(calls)).toEqual([
      { method: 'editMessageReplyMarkup', messageId, keyboard: [] },
    ]);
    expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);

    const afterStop = calls.length;
    await t.stop();
    t.resolveAsk({ approvalId, capability: request.capability }, true);
    await expect(t.ask({ request, approvalId: 'late' })).resolves.toBe(false);
    t.live('Too late');
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    expect(calls).toHaveLength(afterStop);
  });
});
