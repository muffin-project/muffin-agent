import { describe, expect, it } from 'vitest';
import { recallTaint } from './recall.js';
import { recallTaintOrigin, recallUntrustedTaint } from './recall-taint.js';

describe('recallUntrustedTaint', () => {
  it('ignores owner and known-contact memories when computing policy taint', () => {
    const result = {
      items: [
        {
          id: 1,
          kind: 'fact' as const,
          text: 'mi chiamo Giusto',
          trustTier: 0 as const,
          source: 'tu',
          score: 1,
        },
        {
          id: 2,
          kind: 'fact' as const,
          text: 'un amico noto',
          trustTier: 1 as const,
          source: 'contatto noto',
          score: 1,
        },
      ],
      strategies: [],
      gaps: [],
      pinnedOverflow: 0,
    };
    expect(recallTaint(result)).toBe(1);
    expect(recallUntrustedTaint(result)).toBe(0);
    expect(recallTaintOrigin(result)).toBeNull();
  });

  it('raises only for untrusted web or group memories, with an honest origin', () => {
    const web = {
      items: [
        {
          id: 1,
          kind: 'episode' as const,
          text: 'ciao',
          trustTier: 0 as const,
          source: 'tu',
          score: 1,
        },
        {
          id: 2,
          kind: 'episode' as const,
          text: 'una pagina',
          trustTier: 3 as const,
          source: 'web',
          score: 1,
        },
      ],
      strategies: [],
      gaps: [],
      pinnedOverflow: 0,
    };
    expect(recallTaint(web)).toBe(3);
    expect(recallUntrustedTaint(web)).toBe(3);
    expect(recallTaintOrigin(web)).toBe('un ricordo preso dal web');

    const group = {
      ...web,
      items: [
        {
          id: 1,
          kind: 'episode' as const,
          text: 'ciao dal gruppo',
          trustTier: 2 as const,
          source: 'gruppo',
          score: 1,
        },
      ],
    };
    expect(recallUntrustedTaint(group)).toBe(2);
    expect(recallTaintOrigin(group)).toBe('un messaggio di un gruppo');
  });
});
