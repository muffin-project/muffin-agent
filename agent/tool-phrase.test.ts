import { describe, expect, it } from 'vitest';
import { toolLine, toolProgress, toolSubject } from './tool-phrase.js';

/**
 * #616: the step fact carries two pieces — a short line and, only when the
 * subject did not fit, the exact inspectable detail. These tests pin the
 * boundary: no pointless detail for a short subject, no 48-char information
 * loss for a long one, and the same redaction net as any owner-visible output.
 */
describe('toolProgress · compact line, exact detail on demand', () => {
  it('a short subject is one line and no detail at all', () => {
    const p = toolProgress('shell_run', { command: 'npm test' });
    expect(p).toEqual({ summary: 'guardo con un comando: npm test' });
    expect(toolLine('shell_run', { command: 'npm test' })).toBe('guardo con un comando: npm test');
  });

  it('a long subject keeps the compact line and the exact detail', () => {
    const command =
      'grep -rn "continuation" agent/loop/round.ts connectors/telegram/transcript.ts core/turns/store.ts';
    const p = toolProgress('shell_run', { command });
    expect(p.summary.startsWith('guardo con un comando: ')).toBe(true);
    expect(p.summary).toContain('…');
    // The exact command survives, character for character — the 48-char clamp
    // is a display decision, not an information deletion.
    expect(p.detail).toBe(command);
  });

  it('a secret-shaped argument is redacted before the clamp, in both pieces', () => {
    const command =
      'curl -H "Authorization: Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" https://example.com/a/very/long/path/here';
    const p = toolProgress('shell_run', { command });
    expect(p.summary).not.toContain('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(p.detail).toContain('«redacted:');
    expect(p.detail).not.toContain('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(toolLine('shell_run', { command })).not.toContain('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  });

  it('redaction applies before the clamp, so a secret ending past 48 chars cannot slip through', () => {
    // The token starts after the compact line's 48 characters; a clamp-first
    // implementation would show the head of the token with nothing redacted.
    const command = 'curl https://example.com/an/owner/path/that/is/long sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const p = toolProgress('shell_run', { command });
    expect(p.summary).not.toContain('sk-live');
    expect(p.detail).toContain('«redacted:');
    expect(p.detail).not.toContain('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  });

  it('a pathological command is bounded and the cut is declared', () => {
    const command = `echo ${'x'.repeat(2_000)}`;
    const p = toolProgress('shell_run', { command });
    expect(p.detail!.length).toBeLessThanOrEqual(500);
    expect(p.detail!.endsWith('…')).toBe(true);
  });

  it('a tool with no valuable subject has no detail to offer', () => {
    expect(toolProgress('process_list', {})).toEqual({ summary: 'guardo i processi' });
    expect(toolSubject('process_list', {})).toBe('');
  });
});
