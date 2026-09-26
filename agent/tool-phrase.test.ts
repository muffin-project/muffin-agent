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

  it('a secret-shaped argument is redacted in both pieces, down to its prefix', () => {
    const command =
      'curl -H "Authorization: Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" https://example.com/a/very/long/path/here';
    const p = toolProgress('shell_run', { command });
    // Asserting the prefix, not only the whole literal: a clamp-first
    // implementation leaks the token's head, which the full literal misses.
    expect(p.summary).not.toContain('sk-live');
    expect(p.detail).toContain('«redacted:');
    expect(p.detail).not.toContain('sk-live');
    expect(toolLine('shell_run', { command })).not.toContain('sk-live');
  });

  it('redaction applies before the clamp: a token cut by the clamp cannot leak its head', () => {
    const token = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    // The token begins 12 characters before the 48-char clamp (prefix length
    // 35). Clamp-first would render `sk-live-ABCD…`: after `sk-` only 9
    // characters survive, below the regex's 16, so the redaction would miss it
    // and the head of the token would be shown. Redact-first replaces the whole
    // token with the marker, and the trailing URL keeps the redacted subject
    // long enough to have a detail.
    const prefix = `curl https://x.co/${'a'.repeat(16)}/`;
    const command = `${prefix}${token} https://example.com/a/very/long/path/that/exceeds/forty/eight`;
    const p = toolProgress('shell_run', { command });
    expect(p.summary).not.toContain('sk-live');
    expect(p.summary).toContain('«redact');
    expect(p.detail).toContain('«redacted:');
    expect(p.detail).not.toContain('sk-live');
  });

  it('cuts a long subject at a word boundary, never mid-word', () => {
    // #616: "Do not make the summary by blindly slicing the raw argument at N
    // characters." The old hard clamp produced `…26 settembre 2…`; the reader
    // had to rebuild the truncated word.
    const p = toolProgress('web_search', {
      query: 'notizie intelligenza artificiale 26 settembre 2026 da verificare',
    });
    expect(p.summary).toBe('cerco sul web: notizie intelligenza artificiale 26 settembre…');
    expect(p.detail).toBe('notizie intelligenza artificiale 26 settembre 2026 da verificare');
  });

  it('cuts an unbroken subject (a URL) hard, and the detail keeps it whole', () => {
    const url = 'https://example.com/a/very/long/path/that/has/no/spaces/at/all/and/keeps/going';
    const p = toolProgress('http_get', { url });
    // No space to cut at: the hard cut is the only option, and the detail is
    // the reason it is not an information loss.
    expect(p.summary).toBe(`apro una pagina: ${url.slice(0, 47)}…`);
    expect(p.detail).toBe(url);
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
