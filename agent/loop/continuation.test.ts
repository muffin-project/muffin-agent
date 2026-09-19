import { describe, expect, it } from 'vitest';
import type { Principal } from '../../core/policy/types.js';
import type { ContinuableReason } from '../../core/turns/store.js';
import {
  CONTINUATION_TTL_MS,
  buildFreshCounters,
  isContinuationAsk,
  noteAmbiguity,
  resolveContinuation,
  resolveFollowup,
  routeContinuationTarget,
  type ContinuationCandidate,
} from './continuation.js';

const owner: Principal = { kind: 'owner', connector: 'telegram', externalId: '130493441' };
const NOW = Date.parse('2026-09-18T17:16:35.000Z');

const reason = (over: Partial<ContinuableReason> = {}): ContinuableReason => ({
  class: 'provider_empty',
  lease: 0,
  at: '2026-09-18T17:14:09.000Z',
  ...over,
});

function rowsFor(ids: string[]) {
  return {
    // Like the store: only rows newer than `since` are eligible.
    continuableFor: (_session: string, _principal: Principal, since: string) =>
      ids
        .map((id, i) => ({ id, updatedAt: `2026-09-18T17:1${i}:00.000Z`, reason: reason() }))
        .filter((r) => r.updatedAt >= since),
  };
}

const ask = (text: string, ids: string[], extra: { hasAttachment?: boolean; nowMs?: number } = {}) =>
  resolveContinuation({
    turns: rowsFor(ids),
    principal: owner,
    sessionId: 'owner',
    text,
    hasAttachment: extra.hasAttachment ?? false,
    nowMs: extra.nowMs ?? NOW,
  });

describe('isContinuationAsk · conservative by construction', () => {
  it.each([
    'riprendi',
    'Riprendi',
    'riprendi.',
    'riprendi senza ripetere le cose due volte',
    'Riprendi senza ripetere le cose due volte',
    'continua',
    'continua pure',
    'vai avanti',
    'vai avanti per favore',
    'prosegui da dove eri rimasto',
    'riparti',
    'riprendi, per favore',
  ])('continua: %s', (text) => {
    expect(isContinuationAsk(text)).toBe(true);
  });

  it.each([
    'riprendi quel testo e riscrivilo',
    'riprendi il lavoro sul video',
    'riprendiamo il video di domani',
    'puoi riprendere il discorso di ieri?',
    'ho ripreso il lavoro',
    'riprendi e poi dimmi anche il meteo',
    'continua a monitorare il sito',
    'vai avanti tu con la spesa',
    '',
    'ciao',
  ])('conversazione ordinaria: %s', (text) => {
    expect(isContinuationAsk(text)).toBe(false);
  });
});

describe('resolveContinuation · 0 / 1 / N candidates', () => {
  it('no candidate is ordinary conversation', () => {
    expect(ask('riprendi', [])).toEqual({ kind: 'none' });
  });

  it('one eligible candidate auto-continues without confirmation', () => {
    expect(ask('riprendi', ['abc123'])).toEqual({ kind: 'single', turnId: 'abc123' });
    expect(ask('Riprendi senza ripetere le cose due volte', ['abc123'])).toEqual({
      kind: 'single',
      turnId: 'abc123',
    });
  });

  it('more than one is ambiguity, never a guess', () => {
    const match = ask('riprendi', ['aaa', 'bbb']);
    expect(match.kind).toBe('ambiguous');
    if (match.kind !== 'ambiguous') throw new Error('unreachable');
    expect(match.candidates.map((c) => c.id)).toEqual(['aaa', 'bbb']);
  });

  it('attachments carry new content: never a grant', () => {
    expect(ask('riprendi', ['abc123'], { hasAttachment: true })).toEqual({ kind: 'none' });
  });

  it('rows older than the TTL are not eligible', () => {
    expect(ask('riprendi', ['abc123'], { nowMs: NOW + CONTINUATION_TTL_MS + 1000 })).toEqual({ kind: 'none' });
  });
});

describe('ambiguity followups · transient, positional or by id', () => {
  const candidates: ContinuationCandidate[] = [
    { id: 'aaa111aaa111', updatedAt: '2026-09-18T17:10:00.000Z', summary: 'turno provider_empty' },
    { id: 'bbb222bbb222', updatedAt: '2026-09-18T17:12:00.000Z', summary: 'turno provider_empty' },
  ];

  it.each([['il primo', 'aaa111aaa111'], ['1', 'aaa111aaa111'], ['il secondo', 'bbb222bbb222'], ['2', 'bbb222bbb222']])(
    'positional: %s',
    (text, id) => {
      noteAmbiguity('owner', candidates, NOW);
      expect(resolveFollowup('owner', text, NOW + 1000)?.turnId).toBe(id);
    },
  );

  it('id prefix resolves', () => {
    noteAmbiguity('owner', candidates, NOW);
    expect(resolveFollowup('owner', 'bbb222', NOW + 1000)?.turnId).toBe('bbb222bbb222');
  });

  it('anything else is ordinary conversation and keeps the question pending', () => {
    noteAmbiguity('owner', candidates, NOW);
    expect(resolveFollowup('owner', 'lascia stare', NOW + 1000)).toBeNull();
    expect(resolveFollowup('owner', 'il primo', NOW + 1000)?.turnId).toBe('aaa111aaa111');
  });

  it('an expired question resolves nothing', () => {
    noteAmbiguity('owner', candidates, NOW);
    expect(resolveFollowup('owner', 'il primo', NOW + 11 * 60 * 1000)).toBeNull();
  });

  it('no question resolves nothing', () => {
    expect(resolveFollowup('sessione-mai-vista', 'il primo', NOW)).toBeNull();
  });
});

describe('routeContinuationTarget · the bind-time answer', () => {
  it('single and followup route, ambiguity and none do not', () => {
    const base = { turns: rowsFor(['abc123']), principal: owner, sessionId: 'owner', hasAttachment: false, nowMs: NOW };
    expect(routeContinuationTarget({ ...base, text: 'riprendi' })).toBe('abc123');
    expect(routeContinuationTarget({ ...base, turns: rowsFor([]), text: 'riprendi' })).toBeNull();
    expect(routeContinuationTarget({ ...base, turns: rowsFor(['a', 'b']), text: 'riprendi' })).toBeNull();
    expect(routeContinuationTarget({ ...base, text: 'riprendi quel testo' })).toBeNull();
  });
});

describe('buildFreshCounters · the reset contract in one place', () => {
  it('resets lease-local capacity and preserves cumulative and crash-budget state', () => {
    const from = {
      iterations: 19,
      recoveriesUsed: 5,
      transportRetriesLeft: 3,
      toolCallsMade: 16,
      nudgedForCompletion: true,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      spentUsd: 1.5,
      resumes: 2,
      contextBuilt: true,
      activeModelMs: 100,
    };
    expect(buildFreshCounters(from)).toEqual({
      iterations: 19,
      recoveriesUsed: 0,
      transportRetriesLeft: 10,
      toolCallsMade: 0,
      nudgedForCompletion: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 2,
      contextBuilt: true,
      activeModelMs: 0,
    });
  });
});
