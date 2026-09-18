import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types.js';
import { rehydrateSensitiveEchoes } from './echo-rehydrate.js';

const SECRET = 'password-supersegreta-123';

function readPair(id: string, path: string, content: string, isError = false): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'fs_read', input: { path } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: id, content, ...(isError ? { isError: true } : {}) }] },
  ];
}

describe('echo-rehydrate · deterministic replay of the live collector', () => {
  it('rebuilds echoes for sensitive names from durable pairs', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'leggi' }] },
      ...readPair('c1', 'credenziali.txt', SECRET),
    ];
    expect(rehydrateSensitiveEchoes(messages)).toEqual([SECRET]);
  });

  it('ignores non-sensitive names, errors and other tools', () => {
    const messages: Message[] = [
      ...readPair('c1', 'note.md', 'pubblico'),
      ...readPair('c2', 'segreto.txt', 'fallito', true),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c3', name: 'fs_list', input: { path: 'segreto.txt' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c3', content: 'elenco' }] },
    ];
    expect(rehydrateSensitiveEchoes(messages)).toEqual([]);
  });

  it('collects nothing on a fresh transcript', () => {
    expect(rehydrateSensitiveEchoes([{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }])).toEqual([]);
  });
});
