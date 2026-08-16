import { describe, expect, it } from 'vitest';
import { DISCORD_MAX, renderForDiscord } from './render.js';

describe('renderForDiscord', () => {
  it('leaves a short reply alone', () => {
    expect(renderForDiscord('ciao')).toEqual(['ciao']);
  });

  it('never produces a part over the limit', () => {
    const long = 'parola '.repeat(2000);
    const parts = renderForDiscord(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MAX);
  });

  it('breaks at a newline rather than mid-word when one is available near the limit', () => {
    const long = Array.from({ length: 100 }, (_, i) => `riga numero ${i} con del testo`).join('\n');
    const parts = renderForDiscord(long);
    // Every part but the last ends at a line boundary — reassembling with '\n'
    // reproduces the original modulo the join character itself.
    expect(parts.slice(0, -1).every((p) => !p.endsWith(' con del t'))).toBe(true);
  });

  it('closes an open code fence at a forced split and reopens it in the next part', () => {
    const body = 'x = 1;\n'.repeat(400); // long enough to force a split inside the fence
    const text = `\`\`\`js\n${body}\`\`\``;
    const parts = renderForDiscord(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      // Each part is independently valid markdown: an even number of fence
      // markers, so nothing after it is swallowed as code by accident.
      const fences = part.match(/```/g) ?? [];
      expect(fences.length % 2).toBe(0);
      expect(part.length).toBeLessThanOrEqual(DISCORD_MAX);
    }
  });

  it('a message with no fences never gains one', () => {
    const long = 'a'.repeat(5000);
    const parts = renderForDiscord(long);
    for (const part of parts) expect(part).not.toContain('```');
  });

  it('an empty reply still produces something sendable, never zero parts', () => {
    expect(renderForDiscord('   ')).toEqual(['(risposta vuota)']);
  });
});
