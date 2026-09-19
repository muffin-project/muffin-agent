import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types.js';
import { harnessMessage, isHarnessMessage, ownerMessage, provenanceMessage, splitWorkEvidence, toolMessage } from './message-origin.js';

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

  it('marks owner input and tool evidence distinctly from harness', () => {
    const owner = ownerMessage([{ type: 'text', text: 'ciao' }]);
    const tool = toolMessage([{ type: 'tool_result', toolCallId: 'c1', content: 'x' }]);
    expect(owner.origin).toBe('owner');
    expect(tool.origin).toBe('tool');
    expect(isHarnessMessage(owner)).toBe(false);
    expect(isHarnessMessage(tool)).toBe(false);
    // Neither is control: both survive a continuation split as evidence.
    const { evidence, harness } = splitWorkEvidence([owner, tool]);
    expect(evidence).toEqual([owner, tool]);
    expect(harness).toEqual([]);
  });

  it('a persisted row without origin stays fail-safe evidence, never control', () => {
    // Rows written before the marker existed, or replayed from the session
    // file (which stores no origin): they must survive continuation and must
    // never read as harness control or as the current owner input.
    const legacy: Message = { role: 'user', content: [{ type: 'text', text: 'vecchia riga' }] };
    expect(isHarnessMessage(legacy)).toBe(false);
    expect(legacy.origin).toBeUndefined();
    const { evidence, harness } = splitWorkEvidence([legacy]);
    expect(evidence).toEqual([legacy]);
    expect(harness).toEqual([]);
  });

  it('provenanceMessage is the single constructor every marker goes through', () => {
    expect(provenanceMessage('user', 'memory', [])).toEqual({ role: 'user', content: [], origin: 'memory' });
    expect(provenanceMessage('user', 'runtime', [])).toEqual({ role: 'user', content: [], origin: 'runtime' });
    expect(provenanceMessage('user', 'work', [])).toEqual({ role: 'user', content: [], origin: 'work' });
  });
});
