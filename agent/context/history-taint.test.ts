import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../core/session/store.js';
import { historyTaint, messageTier, reinjectedHistory } from './history-taint.js';

/**
 * The pure half of the DAY-1 readiness invariant "session history does not
 * launder taint": given messages and a resolved traceId→taint map, what
 * tier does the set carry? `agent/session-history-taint.test.ts` covers the
 * wiring — that `agent/loop.ts` actually calls this before the kernel decides
 * anything; this file covers the three-source resolution and the cut on their
 * own, without a database or a provider.
 */

const msg = (over: Partial<SessionMessage> = {}): SessionMessage => ({
  role: 'assistant',
  content: 'ciao',
  surface: 'cli',
  createdAt: '2026-08-17T10:00:00.000Z',
  ...over,
});

describe('messageTier — three sources, tried in order', () => {
  it('trusts an explicit tier over everything else', () => {
    expect(messageTier(msg({ tier: 1, traceId: 't1' }), new Map([['t1', 3]]))).toBe(1);
  });

  it('falls back to the traceId, resolved through the map', () => {
    expect(messageTier(msg({ traceId: 't1' }), new Map([['t1', 2]]))).toBe(2);
  });

  it('a traceId that resolves to nothing is the same as no traceId', () => {
    expect(messageTier(msg({ role: 'assistant', traceId: 'ghost' }), new Map())).toBe(3);
    expect(messageTier(msg({ role: 'user', traceId: 'ghost' }), new Map())).toBe(0);
  });

  it('fail-closed: a user line with neither source is 0 — the owner\'s own words by construction', () => {
    expect(messageTier(msg({ role: 'user' }), new Map())).toBe(0);
  });

  it('fail-closed: an assistant line with neither source is the scale\'s ceiling — doubt raises, never lowers', () => {
    expect(messageTier(msg({ role: 'assistant' }), new Map())).toBe(3);
  });

  it('fail-closed: same for a tool line with neither source', () => {
    expect(messageTier(msg({ role: 'tool' }), new Map())).toBe(3);
  });
});

describe('historyTaint — the max over the set, never a guess', () => {
  it('is 0 over an empty set', () => {
    expect(historyTaint([], new Map())).toBe(0);
  });

  it('takes the max, not the last or the first', () => {
    const messages = [msg({ tier: 0 }), msg({ tier: 3 }), msg({ tier: 1 })];
    expect(historyTaint(messages, new Map())).toBe(3);
  });

  it('one tier-3 message is enough to taint the whole set, whatever else is clean', () => {
    const messages = [msg({ role: 'user', tier: 0 }), msg({ role: 'assistant', tier: 0 }), msg({ role: 'assistant', tier: 3 })];
    expect(historyTaint(messages, new Map())).toBe(3);
  });
});

describe('reinjectedHistory — the same cut buildContext renders, single source of truth', () => {
  it('drops tool rows: they are never shown as history text at all', () => {
    const history: SessionMessage[] = [
      msg({ role: 'user', content: 'leggi il file' }),
      msg({ role: 'assistant', content: 'chiamo fs_read' }),
      msg({ role: 'tool', content: 'contenuto del file', toolCallId: 'c1', toolName: 'fs_read' }),
      msg({ role: 'assistant', content: 'ecco cosa dice' }),
    ];
    const { kept, dropped } = reinjectedHistory(history, 40);
    expect(kept.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(dropped).toBe(0);
  });

  it('keeps only the most recent maxTurns, and reports how many were cut', () => {
    const history: SessionMessage[] = Array.from({ length: 45 }, (_, i) =>
      msg({ role: i % 2 === 0 ? 'user' : 'assistant', content: `messaggio ${i}` }),
    );
    const { kept, dropped } = reinjectedHistory(history, 40);
    expect(kept).toHaveLength(40);
    expect(dropped).toBe(5);
    // Oldest-first, and the cut is at the front — the same order buildContext
    // renders in, and the same five the "compattazione" test in
    // session-history-taint.test.ts relies on being gone.
    expect(kept[0]?.content).toBe('messaggio 5');
    expect(kept.at(-1)?.content).toBe('messaggio 44');
  });

  it('a message cut from kept cannot taint historyTaint — the property is on what is reinjected', () => {
    const history: SessionMessage[] = [
      msg({ role: 'assistant', tier: 3, content: 'vecchissimo e tainted' }),
      ...Array.from({ length: 40 }, (_, i) => msg({ role: i % 2 === 0 ? 'user' : 'assistant', tier: 0, content: `filler ${i}` })),
    ];
    const { kept, dropped } = reinjectedHistory(history, 40);
    expect(dropped).toBe(1);
    expect(kept.some((m) => m.content === 'vecchissimo e tainted')).toBe(false);
    expect(historyTaint(kept, new Map())).toBe(0);
  });
});
