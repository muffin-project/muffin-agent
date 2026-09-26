import { describe, expect, it } from 'vitest';
import { toolLine, toolProgress, toolSubject } from './tool-phrase.js';

/**
 * The step fact is two whole pieces — the phrase and the subject — and it is
 * never shortened here. A surface may wrap, quote or collapse it, but it must
 * not receive a cut: a row like `…26 settembre 2…` is one the owner has to
 * rebuild in their head.
 */
describe('toolProgress · the phrase and the whole subject, never a cut', () => {
  it('a short subject is the phrase and the subject', () => {
    expect(toolProgress('shell_run', { command: 'npm test' })).toEqual({
      phrase: 'guardo con un comando',
      subject: 'npm test',
    });
    expect(toolLine('shell_run', { command: 'npm test' })).toBe('guardo con un comando: npm test');
  });

  it('a long subject is returned whole, character for character', () => {
    const command =
      'grep -rn "continuation" agent/loop/round.ts connectors/telegram/transcript.ts core/turns/store.ts';
    const p = toolProgress('shell_run', { command });
    expect(p.subject).toBe(command);
    expect(toolLine('shell_run', { command })).toBe(`guardo con un comando: ${command}`);
  });

  it('a subject with no valuable field is empty, not invented', () => {
    expect(toolProgress('process_list', {})).toEqual({ phrase: 'guardo i processi', subject: '' });
    expect(toolSubject('process_list', {})).toBe('');
  });

  it('a secret-shaped argument is redacted — whole text, secret replaced', () => {
    const command =
      'curl -H "Authorization: Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" https://example.com/a/very/long/path/here';
    const p = toolProgress('shell_run', { command });
    expect(p.subject).not.toContain('sk-live');
    expect(p.subject).toContain('«redacted:');
    // Redaction is not truncation: the rest of the command survives.
    expect(p.subject).toContain('https://example.com/a/very/long/path/here');
  });

  it('control characters are stripped; ordinary characters are not', () => {
    const p = toolProgress('shell_run', { command: 'echo \u0007ok\u001b[31m' });
    expect(p.subject).toBe('echo ok [31m');
  });

  it('an embedded newline becomes a space; no text is dropped', () => {
    const p = toolProgress('shell_run', { command: 'line1\nline2' });
    expect(p.subject).toBe('line1 line2');
  });
});
