import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramApiLike } from './api.js';
import { TELEGRAM_MAX } from './render.js';
import { startTranscript } from './transcript.js';

/**
 * The transcript, driven directly: what one turn's events become on the wire.
 *
 * Fake timers because the whole file is about *when* an edit goes out, and a
 * suite that only asserts *what* was sent would stay green while the counter
 * stops moving (the exact defect the owner saw). The clock is `vi`'s, so
 * `now` is `Date.now` under fake timers and `setTimeout` is the faked one.
 */

type Call = { method: string; text?: string; messageId?: number };

function recordingApi(fail: { send?: boolean; edit?: boolean } = {}): { api: TelegramApiLike; calls: Call[] } {
  const calls: Call[] = [];
  let next = 500;
  const api = {
    sendMessage: async (chatId: number, html: string) => {
      if (fail.send) throw new Error('simulato');
      const messageId = next++;
      calls.push({ method: 'sendMessage', text: html, messageId });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } };
    },
    editMessageText: async (_chatId: number, messageId: number, html: string) => {
      if (fail.edit) throw new Error('simulato');
      calls.push({ method: 'editMessageText', text: html, messageId });
      return true;
    },
    deleteMessage: async (_chatId: number, messageId: number) => {
      calls.push({ method: 'deleteMessage', messageId });
      return true;
    },
  } as unknown as TelegramApiLike;
  return { api, calls };
}

const start = (n: string, args?: unknown) => ({ type: 'tool_start' as const, name: n, capability: 'x', args });
const end = (n: string, isError = false, args?: unknown) => ({ type: 'tool_end' as const, name: n, ms: 1, isError, args });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one bubble per segment', () => {
  it('the preamble and its steps share one message; the model speaking again opens the next', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);

    t.spoke('Prima leggo la spesa.', 'tool-call');
    t.report(start('fs_read', { path: 'spesa.txt' }));
    await vi.advanceTimersByTimeAsync(0);
    t.report(end('fs_read', false, { path: 'spesa.txt' }));
    // A second tool round with no words: same segment.
    t.report(start('fs_read', { path: 'altro.txt' }));
    t.report(end('fs_read', false, { path: 'altro.txt' }));
    await vi.advanceTimersByTimeAsync(2_000);
    // Now the model talks again before acting: a new message.
    t.spoke('Ora scrivo il totale.', 'tool-call');
    t.report(start('fs_write', { path: 'totale.txt' }));
    t.report(end('fs_write', false, { path: 'totale.txt' }));
    await vi.advanceTimersByTimeAsync(2_000);
    await t.stop();

    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.text).toContain('Prima leggo la spesa.');
    expect(sends[1]!.text).toContain('Ora scrivo il totale.');
    // The first message ends up carrying both reads, marked done, and nothing live.
    const first = calls.filter((c) => c.messageId === sends[0]!.messageId).at(-1)!.text!;
    expect(first).toContain('✓ leggo un file: spesa.txt');
    expect(first).toContain('✓ leggo un file: altro.txt');
    expect(first).not.toContain('⏳');
    expect(first).not.toContain('<i>');
    // Nothing is ever deleted.
    expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0);
  });

  it('a turn that answers with no tool call sends nothing from here at all', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);
    t.report({ type: 'round', n: 1 });
    t.report({ type: 'model', model: 'm', ms: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(5_000);
    await t.stop();
    expect(calls).toEqual([]);
  });

  it('a superseded attempt is named, not removed', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);
    t.spoke('Provo così.', 'superseded');
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const text = calls.at(-1)!.text!;
    expect(text).toContain('Provo così.');
    expect(text).toContain('↺ quel tentativo è stato sostituito');
  });
});

describe('the counter moves on its own', () => {
  it('a running step is re-edited with a growing elapsed time although no event fires', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);
    t.report(start('shell_run', { command: 'npm test' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)!.text).toMatch(/⏳ eseguo un comando: npm test · 0s/);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    const seconds = calls.map((c) => /· (\d+)s/.exec(c.text ?? '')?.[1]).filter((s) => s !== undefined);
    expect(seconds.length).toBeGreaterThanOrEqual(2);
    expect(Number(seconds.at(-1))).toBeGreaterThan(Number(seconds[0]));
    await t.stop();
    // Quiet after stop: no further edits however long we wait.
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(before);
  });

  it('never more than one call per window, and never two on the wire at once', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { isPrivate: false });
    t.report(start('memory_search', { query: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    t.report(end('memory_search'));
    t.report(start('memory_search', { query: 'b' }));
    t.report(end('memory_search'));
    t.report(start('memory_search', { query: 'c' }));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(1); // the create; the group floor is 3 s
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toContain('✓ cerco in memoria: a');
    expect(calls[1]!.text).toContain('✓ cerco in memoria: b');
    expect(calls[1]!.text).toContain('⏳ cerco in memoria: c');
    await t.stop();
  });
});

describe('nothing is cut', () => {
  it('a preamble longer than one message becomes several, in order, each within the limit', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);
    const long = Array.from({ length: 300 }, (_, i) => `riga ${i} di un preambolo molto lungo che non deve sparire`).join('\n');
    t.spoke(long, 'tool-call');
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends.length).toBeGreaterThan(1);
    for (const s of sends) expect(s.text!.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(sends[0]!.text).toContain('riga 0 ');
    expect(sends.map((s) => s.text).join('\n')).toContain('riga 299 ');
    // The step is on the last one, where the reader is.
    expect(calls.filter((c) => c.messageId === sends.at(-1)!.messageId).at(-1)!.text).toContain('leggo un file: x');
  });

  it('a step that would overflow the segment opens the next one instead of being dropped', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);
    t.spoke('x'.repeat(TELEGRAM_MAX - 30), 'tool-call');
    t.report(start('fs_read', { path: 'un-percorso-lungo-abbastanza-da-non-entrare.txt' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[1]!.text).toContain('leggo un file');
    for (const s of sends) expect(s.text!.length).toBeLessThanOrEqual(TELEGRAM_MAX);
  });
});

describe('stop() is the last edit, never a deletion', () => {
  it('marks a step the turn abandoned and drops the live counter', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);
    t.report(start('shell_run', { command: 'sleep 99' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const last = calls.at(-1)!;
    expect(last.method).toBe('editMessageText');
    expect(last.text).toContain('✗ eseguo un comando: sleep 99 — interrotto');
    expect(last.text).not.toMatch(/· \d+s/);
    expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
  });

  it('is idempotent and ignores events after it', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);
    t.report(start('fs_read', { path: 'a' }));
    t.report(end('fs_read'));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const n = calls.length;
    await t.stop();
    t.report(start('fs_read', { path: 'b' }));
    t.spoke('ancora', 'tool-call');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(n);
  });

  it('does not hold the answer hostage to a send that never returns', async () => {
    const calls: Call[] = [];
    const api = {
      sendMessage: async () => {
        calls.push({ method: 'sendMessage' });
        return new Promise(() => {}); // never resolves
      },
      editMessageText: async () => true,
    } as unknown as TelegramApiLike;
    const t = startTranscript(api, 1);
    t.report(start('fs_read', { path: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    const stopping = t.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopping).resolves.toBeUndefined();
  });
});

describe('a Bot API failure is swallowed and disables the rest of the turn', () => {
  it('after a failed create nothing else is attempted, and stop() makes no call', async () => {
    const log: string[] = [];
    const { api, calls } = recordingApi({ send: true });
    const t = startTranscript(api, 1, { log: (l) => log.push(l) });
    t.report(start('fs_read', { path: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    t.report(end('fs_read'));
    t.spoke('e poi', 'tool-call');
    await vi.advanceTimersByTimeAsync(10_000);
    await t.stop();
    expect(calls).toEqual([]);
    expect(log.join('\n')).toContain('trascrizione del turno sospesa');
  });

  it('escapes what the model wrote — the line is sent with parse_mode HTML', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1);
    t.report(start('fs_read', { path: '<b>x</b>' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    expect(calls[0]!.text).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(calls[0]!.text).not.toContain('<b>x</b>');
  });
});
