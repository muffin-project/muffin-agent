/**
 * `memory_propose` — the model stages an intent, the reconciler decides.
 *
 * The load-bearing property: the tool never writes a belief itself (that
 * call lives in `core/memory/ingest.ts`, proven by `proposals.test.ts`'s
 * single-writer scan), and its answer is the durable outcome — "Ricordo"
 * only when the canonical reconciler committed, "rimandata" when the lane
 * was busy, never a claim ahead of the commit.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { resolveContradiction } from '../../core/memory/maintenance.js';
import { MemoryStore } from '../../core/memory/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import type { ChatCall, ChatResult, Provider } from '../providers/types.js';
import { type ProposeDeps, proposeMemory } from './memory-propose.js';

/** Scripted judge: coexist/accept by default, scripted verdicts on demand. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly replies: string[] = []) {}
  async chat(_request?: ChatCall): Promise<ChatResult> {
    const text =
      this.replies[this.i++] ??
      '{"reasoning":"nessun conflitto","verdict":"coexist","confidence":0.9}';
    return {
      text,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

class Unavailable implements Provider {
  readonly kind = 'openai-compat' as const;
  async chat(_request?: ChatCall): Promise<ChatResult> {
    throw new Error('provider 503');
  }
}

const NOW = () => new Date('2026-08-04T12:00:00Z');
const CTX = { tenant: 'host', turnId: 'turn-propose-1', taint: () => 0 as const };

function seed(
  replies: string[] = [],
  provider?: Provider,
): {
  store: MemoryStore;
  deps: ProposeDeps;
  turnEpisode: number;
} {
  const store = new MemoryStore(new DatabaseCtor(':memory:'));
  const home = mkdtempSync(join(tmpdir(), 'muffin-propose-tool-'));
  const deps: ProposeDeps = {
    store,
    provider: provider ?? new Scripted(replies),
    model: 'test-light',
    tracer: new SimpleTracer(new JsonlExporter(home)),
    now: NOW,
  };
  const turnEpisode = store.addEpisode({
    tenantId: 'host',
    connector: 'cli',
    threadKey: 't',
    role: 'user',
    kind: 'message',
    content: 'ricorda che il mio commercialista è Mario',
    trustTier: 0,
    createdAt: '2026-08-04T11:00:00Z',
    turnId: CTX.turnId,
  });
  return { store, deps, turnEpisode };
}

const ricorda = {
  subject: 'owner',
  predicate: 'accountant',
  object: 'Mario',
  kind: 'owner-stated',
};

describe('memory_propose — validation at the boundary', () => {
  it('requires subject, predicate and object', async () => {
    const h = seed();
    for (const args of [
      {},
      { subject: 'owner' },
      { ...ricorda, object: '' },
      { ...ricorda, object: '  ' },
    ]) {
      const out = await proposeMemory(h.deps, CTX, args);
      expect(out.isError).toBe(true);
    }
    expect(h.store.pendingProposals('host')).toHaveLength(0);
  });

  it('requires kind to name the producer honestly', async () => {
    const h = seed();
    const out = await proposeMemory(h.deps, CTX, { ...ricorda, kind: 'remember' });
    expect(out.isError).toBe(true);
    expect(h.store.pendingProposals('host')).toHaveLength(0);
  });

  it('rejects malformed evidence ids without touching the store', async () => {
    const h = seed();
    const out = await proposeMemory(h.deps, CTX, { ...ricorda, evidence_ids: '12' });
    expect(out.isError).toBe(true);
    expect(h.store.pendingProposals('host')).toHaveLength(0);
  });

  it('refuses foreign evidence — no cross-tenant citation', async () => {
    const h = seed();
    const foreign = h.store.addEpisode({
      tenantId: 'group:x',
      connector: 'telegram',
      threadKey: 'g',
      role: 'user',
      kind: 'message',
      content: 'ciao',
      trustTier: 2,
      createdAt: '2026-08-04T11:00:00Z',
    });
    const out = await proposeMemory(h.deps, CTX, {
      ...ricorda,
      kind: 'agent-inference',
      evidence_ids: [foreign],
    });
    expect(out.isError).toBe(true);
    expect(h.store.pendingProposals('host')).toHaveLength(0);
  });
});

describe('memory_propose — stage durably, reconcile canonically, answer honestly', () => {
  it('owner-stated ricorda becomes a belief and the answer says so', async () => {
    const h = seed();
    const out = await proposeMemory(h.deps, CTX, ricorda);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Ricordo:');
    const me = h.store.findEntity('host', 'owner')!;
    const facts = h.store.activeFacts('host', me, 'accountant');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.objectValue).toBe('Mario');
    expect(facts[0]!.origin).toBe('said');
    expect(facts[0]!.episodeId).toBe(h.turnEpisode);
  });

  it('agent inference cites its evidence and stays inferred', async () => {
    const h = seed();
    const e1 = h.store.addEpisode({
      tenantId: 'host',
      connector: 'cli',
      threadKey: 't',
      role: 'user',
      kind: 'message',
      content: 'il commercialista è Mario',
      trustTier: 0,
      createdAt: '2026-08-04T10:00:00Z',
    });
    const out = await proposeMemory(h.deps, CTX, {
      subject: 'owner',
      predicate: 'accountant',
      object: 'Mario',
      kind: 'agent-inference',
      evidence_ids: [e1],
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Ricordo:');
    const me = h.store.findEntity('host', 'owner')!;
    expect(h.store.activeFacts('host', me, 'accountant')[0]!.origin).toBe('inferred');
  });

  it('judge failure leaves a conflict for review and keeps the source taint', async () => {
    const h = seed([], new Unavailable());
    const me = h.store.upsertEntity('host', 'owner', 'person', '2026-08-04T10:00:00Z');
    const oldEvidence = h.store.addEpisode({
      tenantId: 'host',
      connector: 'cli',
      threadKey: 't',
      role: 'user',
      kind: 'message',
      content: 'il mio commercialista è Marco',
      trustTier: 0,
      createdAt: '2026-08-04T10:00:00Z',
    });
    const oldFact = h.store.addFact({
      tenantId: 'host',
      subjectId: me,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: oldEvidence,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const untrustedEvidence = h.store.addEpisode({
      tenantId: 'host',
      connector: 'web',
      threadKey: 'research',
      role: 'tool',
      kind: 'message',
      content: 'the accountant is Lucia',
      trustTier: 3,
      createdAt: '2026-08-04T11:30:00Z',
    });

    const out = await proposeMemory(h.deps, CTX, {
      subject: 'owner',
      predicate: 'accountant',
      object: 'Lucia',
      kind: 'agent-inference',
      evidence_ids: [untrustedEvidence],
    });
    const proposal = h.store.listProposals('host', { status: 'review' })[0]!;
    const review = h.store.pendingReview('host')[0]!;

    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Sottoposto a revisione');
    expect(out.content).not.toContain('Ricordo:');
    expect(out.tier).toBe(3);
    expect(proposal.trustTier).toBe(3);
    expect(proposal.resultingFactIds).toHaveLength(1);
    expect(h.store.activeFacts('host', me, 'accountant')).toHaveLength(2);
    expect(review).toMatchObject({ kind: 'contradiction', existingFactId: oldFact });
  });

  it('a repeated call returns the recorded outcome and writes no second belief', async () => {
    const h = seed();
    const first = await proposeMemory(h.deps, CTX, ricorda);
    const second = await proposeMemory(h.deps, CTX, ricorda);
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    // Same evidence (the turn's message), same candidate: the retry adopts
    // the first call's recorded outcome and verifies that the fact is current.
    expect(first.content).toContain('Ricordo:');
    expect(second.content).toContain('Ricordo:');
    const me = h.store.findEntity('host', 'owner')!;
    const facts = h.store.activeFacts('host', me, 'accountant');
    expect(facts).toHaveLength(1);
    expect(second.content).toContain(`fatto #${facts[0]!.id}`);
    expect(h.store.pendingProposals('host')).toHaveLength(0);
  });

  it('does not replay an old acceptance as current after its fact is retired', async () => {
    const h = seed();
    const first = await proposeMemory(h.deps, CTX, ricorda);
    const me = h.store.findEntity('host', 'owner')!;
    const acceptedFact = h.store.activeFacts('host', me, 'accountant')[0]!;
    expect(first.content).toContain('Ricordo:');

    const replacementEpisode = h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: 'il commercialista ora è Lucia', trustTier: 0, createdAt: '2026-08-04T11:30:00Z',
    });
    const replacement = h.store.addFact({
      tenantId: 'host', subjectId: me, predicate: 'accountant', objectValue: 'Lucia',
      episodeId: replacementEpisode, trustTier: 0, confidence: 0.9, extractionV: 1,
      recordedAt: '2026-08-04T11:30:00Z',
    });
    h.store.supersede('host', acceptedFact.id, replacement, '2026-08-04T11:30:00Z');

    const replay = await proposeMemory(h.deps, CTX, ricorda);
    expect(replay.content).toContain('era stata accettata');
    expect(replay.content).toContain('memory_search');
    expect(replay.content).not.toContain('Ricordo:');
    expect(h.store.activeFacts('host', me, 'accountant').map((fact) => fact.id)).toEqual([replacement]);
  });

  it('a held lane lock records the intent and says so — never claims the belief', async () => {
    const h = seed();
    // Held by someone else, still alive: the parent process's pid can only
    // be dead if this test is an orphan. Same-pid re-acquire would succeed
    // (same holder), which is why the foreign pid matters here.
    const held = h.store.acquireIngestLock(NOW(), process.ppid);
    expect('held' in held).toBe(false);
    const taintedContext = { ...CTX, taint: () => 3 as const };
    try {
      // Explicit NOW: the tool defaults to the real clock, against which an
      // August claim reads as hard-stale and stealable. Same clock both
      // sides, like production.
      const out = await proposeMemory(h.deps, taintedContext, ricorda, NOW);
      expect(out.isError).toBeUndefined();
      expect(out.content).toContain('rimandata');
      expect(out.content).not.toContain('Ricordo:');
      // Durable: the proposal survived, the belief does not exist yet.
      expect(h.store.pendingProposals('host')).toHaveLength(1);
      expect(out.tier).toBe(3);
      expect(h.store.pendingProposals('host')[0]!.trustTier).toBe(3);
      expect(h.store.hasActiveFacts('host')).toBe(false);
    } finally {
      h.store.releaseIngestLock(process.ppid);
    }
    // And the next drain converges: exactly one belief.
    const drained = await proposeMemory(h.deps, CTX, ricorda);
    expect(drained.content).toContain('Ricordo:');
    expect(drained.tier).toBe(3);
    const me = h.store.findEntity('host', 'owner')!;
    const facts = h.store.activeFacts('host', me, 'accountant');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.trustTier).toBe(3);
    const replayed = await proposeMemory(h.deps, CTX, ricorda);
    expect(replayed.tier).toBe(3);
  });

  it('supersede answers with the update, review answers with the caution', async () => {
    const h = seed([
      '{"reasoning":"cambio dichiarato","verdict":"supersede","confidence":0.95}',
      '{"reasoning":"non chiaro","verdict":"review","confidence":0.5}',
    ]);
    const me = h.store.upsertEntity('host', 'owner', 'person', '2026-08-04T10:00:00Z');
    h.store.addFact({
      tenantId: 'host',
      subjectId: me,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: h.turnEpisode,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    h.store.addFact({
      tenantId: 'host',
      subjectId: me,
      predicate: 'city',
      objectValue: 'Milano',
      episodeId: h.turnEpisode,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const corrected = await proposeMemory(h.deps, CTX, { ...ricorda, object: 'Lucia' });
    expect(corrected.content).toContain('Aggiorno:');
    const review = await proposeMemory(h.deps, CTX, {
      subject: 'owner',
      predicate: 'city',
      object: 'Cagliari',
      kind: 'agent-inference',
    });
    expect(review.content).toContain('Sottoposto a revisione');
    expect(review.content).not.toContain('non era un verdetto del giudice');
    expect(review.content).not.toContain('Ricordo:');
    // Both stay: the cautious outcome never retires quietly.
    expect(h.store.activeFacts('host', me, 'city')).toHaveLength(2);
  });

  it('describes review as a past outcome after the owner resolves it', async () => {
    const h = seed(['{"reasoning":"non chiaro","verdict":"review","confidence":0.5}']);
    const me = h.store.upsertEntity('host', 'owner', 'person', '2026-08-04T10:00:00Z');
    h.store.addFact({
      tenantId: 'host',
      subjectId: me,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: h.turnEpisode,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const proposal = {
      subject: 'owner',
      predicate: 'accountant',
      object: 'Lucia',
      kind: 'agent-inference',
    };

    const first = await proposeMemory(h.deps, CTX, proposal);
    const row = h.store.listProposals('host', { status: 'review' })[0]!;
    const incomingFactId = row.resultingFactIds[0]!;
    expect(first.content).toContain('Sottoposto a revisione');
    expect(h.store.openContradictions('host')).toHaveLength(1);

    expect(resolveContradiction(h.store, 'host', incomingFactId, NOW())).toHaveLength(1);
    expect(h.store.openContradictions('host')).toHaveLength(0);

    const replay = await proposeMemory(h.deps, CTX, proposal);
    expect(replay.content).toContain('Sottoposto a revisione');
    expect(replay.content).toContain('stato corrente');
    expect(replay.content).not.toContain('non era un verdetto del giudice');
    expect(replay.content).not.toContain('resta da decidere');
    expect(h.store.activeFacts('host', me, 'accountant')).toHaveLength(1);
    expect(h.store.listProposals('host', { status: 'review' })).toHaveLength(1);
  });
});
