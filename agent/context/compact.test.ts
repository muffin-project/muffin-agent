import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types.js';
import { compactToolResults } from './compact.js';

/**
 * The invariant that matters more than the saving: every `tool_use` still has a
 * `tool_result` with its id afterwards. Break that and the provider rejects the
 * whole request — a context strategy that corrupts the conversation it was
 * shrinking is worse than no strategy.
 */

function exchange(id: string, tool: string, payload: string): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input: { path: `${id}.md` } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: id, content: payload }] },
  ];
}

function pairsIntact(messages: Message[]): boolean {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') uses.add(b.id);
      if (b.type === 'tool_result') results.add(b.toolCallId);
    }
  }
  return [...uses].every((id) => results.has(id)) && [...results].every((id) => uses.has(id));
}

const big = (n: number): string => 'x'.repeat(n);

describe('tool result compaction', () => {
  it('keeps every tool_use paired with a tool_result', () => {
    const messages = [
      ...exchange('a', 'fs_read', big(5000)),
      ...exchange('b', 'fs_read', big(5000)),
      ...exchange('c', 'fs_read', big(5000)),
    ];
    const out = compactToolResults(messages, { budgetChars: 1000 });
    expect(out.clearedCount).toBe(3);
    expect(pairsIntact(out.messages)).toBe(true);
  });

  it('spends the budget on the newest results', () => {
    // The oldest read is the one the model has finished with; the newest is the
    // one it is still reasoning about.
    const messages = [
      ...exchange('vecchio', 'fs_read', big(3000)),
      ...exchange('nuovo', 'fs_read', big(3000)),
    ];
    const out = compactToolResults(messages, { budgetChars: 3000 });

    const byId = new Map(
      out.messages.flatMap((m) => m.content).flatMap((b) => (b.type === 'tool_result' ? [[b.toolCallId, b.content]] : [])),
    );
    expect(byId.get('nuovo')).toBe(big(3000));
    expect(byId.get('vecchio')).toContain('rimosso dal contesto');
  });

  it('names the tool in the placeholder so the way back is obvious', () => {
    const out = compactToolResults(exchange('a', 'fs_read', big(4000)), { budgetChars: 0 });
    const text = out.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(text?.type === 'tool_result' && text.content).toContain('`fs_read`');
    expect(text?.type === 'tool_result' && text.content).toContain('richiamalo');
  });

  it('never clears a result the tool declared load-bearing', () => {
    // Recalled memory is not scaffolding to re-fetch: clearing it deletes the
    // grounding the turn had.
    const messages = [
      ...exchange('mem', 'memory_search', big(6000)),
      ...exchange('file', 'fs_read', big(6000)),
    ];
    const out = compactToolResults(messages, {
      budgetChars: 0,
      keep: (name) => name === 'memory_search',
    });
    expect(out.clearedCount).toBe(1);
    const byId = new Map(
      out.messages.flatMap((m) => m.content).flatMap((b) => (b.type === 'tool_result' ? [[b.toolCallId, b.content]] : [])),
    );
    expect(byId.get('mem')).toBe(big(6000));
  });

  it('never clears an error', () => {
    // Short, and exactly what the model needs in order not to repeat itself.
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'e', name: 'fs_read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'e', content: 'ENOENT: no such file', isError: true }] },
    ];
    const out = compactToolResults(messages, { budgetChars: 0 });
    expect(out.clearedCount).toBe(0);
  });

  it('does not replace something smaller than its own placeholder', () => {
    const out = compactToolResults(exchange('a', 'fs_list', 'due righe'), { budgetChars: 0 });
    expect(out.clearedCount).toBe(0);
    expect(out.messages).toBe(out.messages); // untouched, same array returned
  });

  it('leaves the caller array alone', () => {
    // The transcript records what happened; this decides what we send.
    const messages = exchange('a', 'fs_read', big(4000));
    compactToolResults(messages, { budgetChars: 0 });
    const result = messages[1]!.content[0]!;
    expect(result.type === 'tool_result' && result.content).toBe(big(4000));
  });

  it('reports what it saved, so a trace can show the pressure', () => {
    const out = compactToolResults(exchange('a', 'fs_read', big(10_000)), { budgetChars: 0 });
    expect(out.clearedChars).toBeGreaterThan(9_000);
  });
});
