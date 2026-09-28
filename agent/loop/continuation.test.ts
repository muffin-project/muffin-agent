import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { TurnStore, type ContinuableReason, type TurnCounters } from '../../core/turns/store.js';
import {
  CONTINUATION_TTL_MS,
  askWhichContinuation,
  buildFreshCounters,
  isContinuationAsk,
  resolveContinuation,
  resolveFollowup,
  routeContinuationTarget,
  type ContinuationCandidate,
} from './continuation.js';

const owner: Principal = { kind: 'owner', connector: 'telegram', externalId: '987654321' };
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
    // These rows carry no pending ambiguity question: the followup layer reads
    // none, so only `single`/`none`/`ambiguous` remain for the bind-time test.
    latestContinuationQuestion: () => null,
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

describe('ambiguity followups · durable, positional or by id', () => {
  const candidates: ContinuationCandidate[] = [
    { id: 'aaa111aaa111', updatedAt: '2026-09-18T17:10:00.000Z', summary: 'turno provider_empty' },
    { id: 'bbb222bbb222', updatedAt: '2026-09-18T17:12:00.000Z', summary: 'turno provider_empty' },
  ];

  const counters: TurnCounters = {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 10,
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
    activeModelMs: 0,
  };

  /**
   * Un vero `TurnStore` su un database SQLite in memoria, orologio fissato a
   * `NOW`: la domanda è una riga, non una voce di mappa. `askWhichContinuation`
   * scrive i candidati sulla riga della domanda (`setContinuationCandidates`),
   * e qui si ripercorre esattamente quella scrittura.
   */
  function questionAt(now: number, sessionId = 'owner'): TurnStore {
    const store = new TurnStore(new Database(':memory:'), () => new Date(now));
    const record = store.create({
      id: randomBytes(16).toString('hex'),
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      sessionId,
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'riprendi' }] }],
      taint: 0,
      counters,
    });
    store.setContinuationCandidates(record.id, candidates);
    return store;
  }

  it.each([['il primo', 'aaa111aaa111'], ['1', 'aaa111aaa111'], ['il secondo', 'bbb222bbb222'], ['2', 'bbb222bbb222']])(
    'positional: %s',
    (text, id) => {
      expect(resolveFollowup(questionAt(NOW), 'owner', text, NOW + 1000)?.turnId).toBe(id);
    },
  );

  it('id prefix resolves', () => {
    expect(resolveFollowup(questionAt(NOW), 'owner', 'bbb222', NOW + 1000)?.turnId).toBe('bbb222bbb222');
  });

  it('anything else is ordinary conversation and keeps the question pending', () => {
    const store = questionAt(NOW);
    expect(resolveFollowup(store, 'owner', 'lascia stare', NOW + 1000)).toBeNull();
    expect(resolveFollowup(store, 'owner', 'il primo', NOW + 1000)?.turnId).toBe('aaa111aaa111');
  });

  it('a question older than the TTL resolves nothing', () => {
    expect(resolveFollowup(questionAt(NOW), 'owner', 'il primo', NOW + 11 * 60 * 1000)).toBeNull();
  });

  it('no question resolves nothing', () => {
    expect(resolveFollowup(new TurnStore(new Database(':memory:')), 'owner', 'il primo', NOW)).toBeNull();
  });

  /**
   * La durabilità è il punto della correzione. Due handle distinti sullo stesso
   * database non condividono **niente** tranne le righe: la mappa in RAM che
   * questa funzione sostituiva perdeva la domanda a ogni riavvio del gateway
   * (l'owner ne fa molti), e il numero digitato diventava conversazione
   * ordinaria. MUTATION-PROVABLE: se `resolveFollowup` rileggesse una mappa di
   * processo invece della riga, questo handle non troverebbe nulla.
   */
  it('durable: a question written by one store resolves through a second handle over the same database', () => {
    const db = new Database(':memory:');
    const writer = new TurnStore(db, () => new Date(NOW));
    const record = writer.create({
      id: randomBytes(16).toString('hex'),
      principal: owner,
      tenant: 'host',
      surface: 'telegram',
      sessionId: 'owner',
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'riprendi' }] }],
      taint: 0,
      counters,
    });
    writer.setContinuationCandidates(record.id, candidates);

    const reader = new TurnStore(db, () => new Date(NOW + 1000));
    expect(resolveFollowup(reader, 'owner', 'il secondo', NOW + 1000)?.turnId).toBe('bbb222bbb222');
  });

  /**
   * La scrittura è l'altra metà della cucitura, e va provata dal punto in cui
   * la produzione la esegue: `askWhichContinuation`. Un test che chiama
   * `setContinuationCandidates` a mano resta verde anche se quella riga
   * sparisce dal loop (reperto della review di PR #707). Qui il file è reale e
   * l'handle di lettura è aperto dopo la chiusura di quello di scrittura:
   * MUTATION-PROVABLE — senza la scrittura nel loop, nessun candidato esiste
   * sulla riga e la risposta numerica non risolve più.
   */
  it('the question the loop writes resolves through a fresh handle over the same file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-continuation-'));
    try {
      const dbPath = join(dir, 'turns.db');
      const writerDb = new Database(dbPath);
      const writer = new TurnStore(writerDb, () => new Date(NOW));
      const sessions = new SessionStore(dir);
      await askWhichContinuation(
        { turns: writer, sessions, model: 'test-model', now: () => new Date(NOW) },
        {
          principal: owner,
          tenant: 'host',
          surface: 'telegram',
          sessionId: 'owner',
          session: sessions.open('owner'),
          text: 'riprendi',
          candidates,
        },
      );
      writerDb.close();

      const reader = new TurnStore(new Database(dbPath), () => new Date(NOW + 1000));
      expect(resolveFollowup(reader, 'owner', 'il secondo', NOW + 1000)?.turnId).toBe('bbb222bbb222');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      truncationsUsed: 7,
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
      truncationsUsed: 0,
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
