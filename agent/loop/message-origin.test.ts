import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types.js';
import { harnessMessage, isHarnessMessage, splitWorkEvidence } from './message-origin.js';

describe('message-origin · control vs evidence', () => {
  it('marks harness control and only that', () => {
    const control = harnessMessage('user', [{ type: 'text', text: 'Non ho ricevuto risposta.' }]);
    expect(isHarnessMessage(control)).toBe(true);
    const owner: Message = { role: 'user', content: [{ type: 'text', text: 'Non ho ricevuto risposta.' }] };
    expect(isHarnessMessage(owner)).toBe(false);
  });

  it('splits evidence from control without touching either half', () => {
    const evidence: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'riprendi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'fs_read', input: { path: 'a' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'x' }] },
    ];
    const control = harnessMessage('user', [{ type: 'text', text: 'Devi rispondere con una tool call adesso.' }]);
    const { evidence: kept, harness: dropped } = splitWorkEvidence([...evidence, control]);
    expect(kept).toEqual(evidence);
    expect(dropped).toEqual([control]);
  });
});
