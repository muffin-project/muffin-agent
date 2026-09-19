import { describe, expect, it } from 'vitest';
import { CompileError, compileForAnthropic, compileForOpenAI } from './compile.js';
import type { Message } from './types.js';

const userText = (text: string, origin?: Message['origin']): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...(origin === undefined ? {} : { origin }),
});

const toolTurn = (): Message[] => [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'c1', name: 'fs_read', input: { path: 'a' } }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: 'c1', content: 'contenuto' }],
    origin: 'tool',
  },
];

describe('compileForOpenAI · validation without reshaping', () => {
  it('passes semantic items through with origins intact', () => {
    const items: Message[] = [
      userText('ricordo', 'memory'),
      userText('fatti', 'runtime'),
      ...toolTurn(),
      userText('domanda', 'owner'),
    ];
    const out = compileForOpenAI(items);
    expect(out.map((m) => m.origin)).toEqual(['memory', 'runtime', undefined, 'tool', 'owner']);
    expect(out.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'user']);
  });

  it('does not merge consecutive user messages: the adapter owns the tool boundary', () => {
    const out = compileForOpenAI([userText('a', 'memory'), userText('b', 'runtime')]);
    expect(out.length).toBe(2);
  });
});

describe('compileForAnthropic · deterministic same-turn folding', () => {
  it('folds consecutive same-role same-origin messages, in block order', () => {
    const out = compileForAnthropic([
      userText('prima'),
      userText('seconda'),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'prima' },
        { type: 'text', text: 'seconda' },
      ],
    });
  });

  it('never folds across origins: harness control stays out of evidence', () => {
    const out = compileForAnthropic([userText('nudge', 'harness'), userText('storia')]);
    expect(out.length).toBe(2);
    expect(out[0]!.origin).toBe('harness');
    expect(out[1]!.origin).toBeUndefined();
  });

  it('keeps tool_result identity: origin tool survives the fold', () => {
    const out = compileForAnthropic(toolTurn());
    expect(out.length).toBe(2);
    expect(out[1]!.origin).toBe('tool');
    expect(out[1]!.content).toEqual([{ type: 'tool_result', toolCallId: 'c1', content: 'contenuto' }]);
  });

  it('concatenates thinking whole, never rewritten', () => {
    const out = compileForAnthropic([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'penso', signature: 'sig' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c9', name: 't', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'c9', content: 'x' }],
      },
    ]);
    expect(out.length).toBe(2);
    expect(out[0]!.content[0]).toEqual({ type: 'thinking', thinking: 'penso', signature: 'sig' });
  });
});

describe('assertCompilable · holes fail here with a name, not at the provider', () => {
  it('rejects an empty message', () => {
    expect(() => compileForOpenAI([{ role: 'user', content: [] }])).toThrow(CompileError);
    expect(() => compileForAnthropic([{ role: 'user', content: [] }])).toThrow(CompileError);
  });

  it('rejects a tool_use outside an assistant message', () => {
    expect(() =>
      compileForOpenAI([
        { role: 'user', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
      ]),
    ).toThrow(/must be assistant/);
  });

  it('rejects a tool_result outside a user message', () => {
    expect(() =>
      compileForOpenAI([
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
        { role: 'assistant', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'x' }] },
      ]),
    ).toThrow(/must be user/);
  });

  it('rejects an orphan tool_result and an unanswered tool_use', () => {
    expect(() =>
      compileForOpenAI([{ role: 'user', content: [{ type: 'tool_result', toolCallId: 'xxx', content: 'x' }] }]),
    ).toThrow(/answers no tool_use/);
    expect(() =>
      compileForOpenAI([
        { role: 'assistant', content: [{ type: 'tool_use', id: 'yyy', name: 't', input: {} }] },
      ]),
    ).toThrow(/has no tool_result/);
  });

  it('rejects thinking outside an assistant message', () => {
    expect(() =>
      compileForOpenAI([{ role: 'user', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] }]),
    ).toThrow(/must be assistant/);
  });

  it('legacy rows without origin compile as ordinary evidence', () => {
    const out = compileForAnthropic([userText('vecchia'), userText('riga')]);
    expect(out.length).toBe(1);
    expect(out[0]!.origin).toBeUndefined();
  });
});
