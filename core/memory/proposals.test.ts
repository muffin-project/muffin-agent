import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { type ChatCall, type ChatResult, type Provider, ProviderError } from '../../agent/providers/types.js';
import { JsonlExporter, SimpleTracer } from '../tracing/tracer.js';
import { type IngestDeps, reconcilePendingProposals, reconcileProposal } from './ingest.js';
import { resolveContradiction, sweepDuplicates } from './maintenance.js';
import { proposeMemoryRecord } from './proposals.js';
import { MemoryStore } from './store.js';

/**
 * ADR-0051 slice 1 — the durable MemoryProposal primitive.
 *
 * Claim: producers (owner-stated ricorda, agent inference) write durable
 * proposals; the single canonical reconciler accepts/merges/supersedes/
 * reviews/rejects with provenance intact; exactly one belief per accepted
 * proposal; kill-9 between intent and commit loses nothing and duplicates
 * nothing.
 */

/** Replays scripted model answers so the pipeline is tested, not the model. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly replies: string[]) {}
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
  constructor(private readonly message = 'provider 503') {}
  async chat(_request?: ChatCall): Promise<ChatResult> {
    throw new ProviderError(this.message, false, 502);
  }
}

const HOST = 'host';
const NOW = () => new Date('2026-08-04T12:00:00Z');

function harness(
  replies: string[] = [],
  provider?: Provider,
): { store: MemoryStore; deps: IngestDeps; home: string } {
  const store = new MemoryStore(new DatabaseCtor(':memory:'));
  const home = mkdtempSync(join(tmpdir(), 'muffin-proposal-'));
  const deps: IngestDeps = {
    store,
    provider: provider ?? new Scripted(replies),
    model: 'test-light',
    tracer: new SimpleTracer(new JsonlExporter(home)),
    now: NOW,
  };
  return { store, deps, home };
}

const episode = (s: MemoryStore, content: string, tier: 0 | 1 | 2 | 3 = 0) =>
  s.addEpisode({
    tenantId: HOST,
    connector: 'cli',
    threadKey: 't',
    role: 'user',
    kind: 'message',
    content,
    trustTier: tier,
    createdAt: '2026-08-04T11:00:00Z',
  });

const verdict = (v: string, confidence = 0.95) =>
  JSON.stringify({ reasoning: 'giudizio di prova', verdict: v, confidence });

const proposeOwner = (
  store: MemoryStore,
  over: {
    subject?: string;
    predicate?: string;
    object?: string;
    episodeId?: number;
    producer?: 'owner-stated' | 'agent-inference';
  } = {},
) => {
  const ep = over.episodeId ?? episode(store, 'ricorda che il mio commercialista è Mario');
  return proposeMemoryRecord(store, {
    tenantId: HOST,
    subject: over.subject ?? 'owner',
    subjectKind: 'person',
    predicate: over.predicate ?? 'accountant',
    object: over.object ?? 'Mario',
    producer: over.producer ?? 'owner-stated',
    sourceEpisodeIds: [ep],
    content: 'ricorda che il mio commercialista è Mario',
    confidence: 0.95,
  });
};

describe('MemoryProposal — propose is durable and idempotent', () => {
  it('records a proposal durably and returns its id', () => {
    const { store } = harness();
    const { id, duplicate } = proposeOwner(store);
    expect(duplicate).toBe(false);
    const row = store.proposalById(HOST, id)!;
    expect(row.status).toBe('pending');
    expect(row.producer).toBe('owner-stated');
    expect(row.subject).toBe('owner');
    expect(row.predicate).toBe('accountant');
  });

  it('double-propose of the same content returns the same proposal, no second row', () => {
    const { store } = harness();
    // Same content from the same evidence: one intent, stated twice. A new
    // episode would be new evidence and therefore a different key — that is
    // the source-identity rule, not a duplicate.
    const ep = episode(store, 'ricorda che il mio commercialista è Mario');
    const first = proposeOwner(store, { episodeId: ep });
    const second = proposeOwner(store, { episodeId: ep });
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    expect(store.pendingProposals(HOST)).toHaveLength(1);
  });

  it('encodes candidate fields without delimiter collisions', () => {
    const { store } = harness();
    const ep = episode(store, 'same source');
    const first = proposeOwner(store, {
      episodeId: ep,
      subject: 'owner|x',
      predicate: 'p',
    });
    const second = proposeOwner(store, {
      episodeId: ep,
      subject: 'owner',
      predicate: 'x|p',
    });

    expect(second.id).not.toBe(first.id);
    expect(second.duplicate).toBe(false);
    expect(store.pendingProposals(HOST)).toHaveLength(2);
  });

  it('treats valid_from as proposal identity and trims it consistently', () => {
    const { store } = harness();
    const ep = episode(store, 'same source');
    const base = {
      tenantId: HOST,
      subject: 'owner',
      predicate: 'accountant',
      object: 'Mario',
      producer: 'owner-stated' as const,
      sourceEpisodeIds: [ep],
      content: 'owner accountant Mario',
      confidence: 0.9,
    };
    const first = proposeMemoryRecord(store, { ...base, validFrom: '2024-01-01' });
    const same = proposeMemoryRecord(store, { ...base, validFrom: ' 2024-01-01 ' });
    const changed = proposeMemoryRecord(store, { ...base, validFrom: '2025-01-01' });

    expect(same).toEqual({ id: first.id, duplicate: true });
    expect(changed.id).not.toBe(first.id);
    expect(changed.duplicate).toBe(false);
    expect(store.proposalById(HOST, first.id)?.validFrom).toBe('2024-01-01');
    expect(store.proposalById(HOST, changed.id)?.validFrom).toBe('2025-01-01');
    expect(store.pendingProposals(HOST)).toHaveLength(2);
  });

  it('raises a duplicate pending proposal to the latest runtime-derived context tier', () => {
    const { store } = harness();
    const ep = episode(store, 'inferenza dal prompt');
    const input = {
      tenantId: HOST,
      subject: 'owner',
      subjectKind: 'person',
      predicate: 'preference',
      object: 'tea',
      producer: 'agent-inference' as const,
      sourceEpisodeIds: [ep],
      content: 'owner preference tea',
      confidence: 0.8,
    };
    const first = proposeMemoryRecord(store, { ...input, contextTier: 0 });
    const second = proposeMemoryRecord(store, { ...input, contextTier: 3 });
    expect(second).toEqual({ id: first.id, duplicate: true });
    expect(store.proposalById(HOST, first.id)?.trustTier).toBe(3);
  });

  it('derives the tier from the evidence, never from the caller — taint is not washed', () => {
    const { store } = harness();
    const ep = episode(store, 'Tizio dice che il bonifico va a IBAN XX', 2);
    proposeMemoryRecord(store, {
      tenantId: HOST,
      subject: 'Tizio',
      subjectKind: 'person',
      predicate: 'claims',
      object: 'il bonifico va a IBAN XX',
      producer: 'agent-inference',
      sourceEpisodeIds: [ep],
      content: 'inferenza su Tizio',
      confidence: 0.8,
    });
    expect(store.pendingProposals(HOST)[0]!.trustTier).toBe(2);
  });

  it('refuses a proposal with no evidence — a belief without provenance is not staged', () => {
    const { store } = harness();
    expect(() =>
      proposeMemoryRecord(store, {
        tenantId: HOST,
        subject: 'owner',
        subjectKind: 'person',
        predicate: 'accountant',
        object: 'Mario',
        producer: 'agent-inference',
        sourceEpisodeIds: [],
        content: 'senza prove',
        confidence: 0.8,
      }),
    ).toThrow(/evidence/i);
  });

  it('refuses foreign evidence — a proposal cannot cite another tenant’s episodes', () => {
    const { store } = harness();
    const foreign = store.addEpisode({
      tenantId: 'group:x',
      connector: 'telegram',
      threadKey: 'g',
      role: 'user',
      kind: 'message',
      content: 'ciao',
      trustTier: 2,
      createdAt: '2026-08-04T11:00:00Z',
    });
    expect(() =>
      proposeMemoryRecord(store, {
        tenantId: HOST,
        subject: 'owner',
        subjectKind: 'person',
        predicate: 'accountant',
        object: 'Mario',
        producer: 'agent-inference',
        sourceEpisodeIds: [foreign],
        content: 'citazione straniera',
        confidence: 0.8,
      }),
    ).toThrow();
  });
});

describe('MemoryProposal — one canonical reconciliation, every outcome', () => {
  it('accept: no existing belief → exactly one belief, provenance intact', async () => {
    const { store, deps } = harness();
    const { id } = proposeOwner(store);
    const out = await reconcileProposal(deps, HOST, id);
    expect(out.status).toBe('accepted');

    const me = store.findEntity(HOST, 'owner')!;
    const facts = store.activeFacts(HOST, me, 'accountant');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.objectValue).toBe('Mario');
    // Provenance travels: owner-tier evidence, said (never inferred), same episode.
    expect(facts[0]!.trustTier).toBe(0);
    expect(facts[0]!.origin).toBe('said');
    const proposal = store.proposalById(HOST, id)!;
    expect(proposal.status).toBe('accepted');
    expect(proposal.resultingFactIds).toEqual([facts[0]!.id]);
    expect(proposal.decidedAt).not.toBeNull();
  });

  it('merge: same as the current belief → no new row, one belief', async () => {
    const { store, deps } = harness([verdict('coexist')]);
    const ep = episode(store, 'il mio commercialista è Mario');
    const me = store.upsertEntity(HOST, 'owner', 'person', '2026-08-04T11:00:00Z');
    const current = store.addFact({
      tenantId: HOST,
      subjectId: me,
      predicate: 'accountant',
      objectValue: 'Mario',
      episodeId: ep,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const { id } = proposeOwner(store, {
      episodeId: episode(store, 'ricorda che il mio commercialista è Mario'),
    });
    const out = await reconcileProposal(deps, HOST, id);
    expect(out.status).toBe('merged');
    expect(store.activeFacts(HOST, me, 'accountant')).toHaveLength(1);
    expect(store.proposalById(HOST, id)!.resultingFactIds).toEqual([current]);
  });

  it('supersede: owner corrects the belief → old retired, one current belief', async () => {
    const { store, deps } = harness([verdict('supersede')]);
    const me = store.upsertEntity(HOST, 'owner', 'person', '2026-08-04T11:00:00Z');
    const oldEp = episode(store, 'il mio commercialista è Marco');
    const oldId = store.addFact({
      tenantId: HOST,
      subjectId: me,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: oldEp,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const { id } = proposeOwner(store, {
      object: 'Lucia',
      episodeId: episode(store, 'ricorda che il mio commercialista ora è Lucia'),
    });
    const out = await reconcileProposal(deps, HOST, id);
    expect(out.status).toBe('superseded');
    expect(store.factById(HOST, oldId)!.expiredAt).not.toBeNull();
    const current = store.activeFacts(HOST, me, 'accountant');
    expect(current).toHaveLength(1);
    expect(current[0]!.objectValue).toBe('Lucia');
  });

  it('review: unsure judge → both stay, durable review row, proposal marked review', async () => {
    const { store, deps } = harness([verdict('review', 0.5)]);
    const me = store.upsertEntity(HOST, 'owner', 'person', '2026-08-04T11:00:00Z');
    const oldEp = episode(store, 'il mio commercialista è Marco');
    store.addFact({
      tenantId: HOST,
      subjectId: me,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: oldEp,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const { id } = proposeOwner(store, {
      object: 'Lucia',
      episodeId: episode(store, 'forse il commercialista è Lucia'),
    });
    const out = await reconcileProposal(deps, HOST, id);
    expect(out.status).toBe('review');
    expect(store.activeFacts(HOST, me, 'accountant')).toHaveLength(2);
    expect(store.openContradictions(HOST)).toHaveLength(1);
  });

  it('judge failure on a conflict is sanitized, durably reviewable, and never accepted', async () => {
    const canary = 'upstream-private-bearer-canary-9f82';
    const { store, deps, home } = harness(
      [],
      new Unavailable(`502 upstream echoed Authorization: Bearer ${canary}`),
    );
    const me = store.upsertEntity(HOST, 'owner', 'person', '2026-08-04T11:00:00Z');
    const oldEp = episode(store, 'il mio commercialista è Marco');
    const oldId = store.addFact({
      tenantId: HOST,
      subjectId: me,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: oldEp,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const { id } = proposeOwner(store, {
      object: 'Lucia',
      episodeId: episode(store, 'ricorda che il mio commercialista ora è Lucia'),
    });

    const out = await reconcileProposal(deps, HOST, id);
    const proposal = store.proposalById(HOST, id)!;
    const review = store.pendingReview(HOST)[0]!;

    expect(out.status).toBe('review');
    expect(out.report.errors.join('\n')).not.toContain(canary);
    expect(proposal.status).toBe('review');
    expect(proposal.resultingFactIds).toEqual(out.factIds);
    expect(proposal.detail).toContain('giudice non raggiungibile');
    expect(proposal.detail).toContain('provider HTTP 502');
    expect(proposal.detail).not.toContain(canary);
    expect(store.activeFacts(HOST, me, 'accountant')).toHaveLength(2);
    expect(review).toMatchObject({
      kind: 'contradiction',
      existingFactId: oldId,
      incomingFactId: out.factIds[0],
    });
    expect(review.detail).toContain('provider HTTP 502');
    expect(review.detail).not.toContain(canary);
    expect(store.openContradictions(HOST)).toHaveLength(1);
    expect(out.report.needsReview).toHaveLength(1);

    const trace = readdirSync(join(home, 'traces'))
      .map((file) => readFileSync(join(home, 'traces', file), 'utf8'))
      .join('\n');
    expect(trace).not.toContain(canary);

    const retried = await reconcileProposal(deps, HOST, id);
    expect(retried.status).toBe('review');
    expect(store.activeFacts(HOST, me, 'accountant')).toHaveLength(2);
    expect(store.pendingReview(HOST)).toHaveLength(1);

    const incomingFactId = out.factIds[0];
    if (incomingFactId === undefined) throw new Error('review did not record the incoming fact');
    expect(resolveContradiction(store, HOST, incomingFactId, NOW())).toHaveLength(1);
    expect(store.openContradictions(HOST)).toHaveLength(0);
  });

  it('unreadable judge output on a proposal opens the same actionable conflict', async () => {
    const rawResponse = 'unparseable judge response canary 4d91';
    const { store, deps } = harness([rawResponse]);
    const me = store.upsertEntity(HOST, 'owner', 'person', '2026-08-04T11:00:00Z');
    const oldEp = episode(store, 'il mio commercialista è Marco');
    const oldId = store.addFact({
      tenantId: HOST,
      subjectId: me,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: oldEp,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const { id } = proposeOwner(store, {
      object: 'Lucia',
      episodeId: episode(store, 'ricorda che il mio commercialista ora è Lucia'),
    });

    const out = await reconcileProposal(deps, HOST, id);
    const proposal = store.proposalById(HOST, id)!;
    const review = store.pendingReview(HOST)[0]!;
    const incomingFactId = out.factIds[0];
    if (incomingFactId === undefined) throw new Error('review did not record the incoming fact');

    expect(out.status).toBe('review');
    expect(proposal.status).toBe('review');
    expect(proposal.resultingFactIds).toEqual(out.factIds);
    expect(proposal.detail).toContain('[non-json]');
    expect(proposal.detail).not.toContain(rawResponse);
    expect(store.activeFacts(HOST, me, 'accountant')).toHaveLength(2);
    expect(review).toMatchObject({
      kind: 'contradiction',
      existingFactId: oldId,
      incomingFactId,
    });
    expect(review.detail).toContain('[non-json]');
    expect(review.detail).toContain(rawResponse);
    expect(store.openContradictions(HOST)).toHaveLength(1);
    expect(out.report.needsReview).toHaveLength(1);
    expect(out.report.needsReview[0]?.why).toContain('[non-json]');
    expect(out.report.needsReview[0]?.why).not.toContain(rawResponse);

    const retried = await reconcileProposal(deps, HOST, id);
    expect(retried.status).toBe('review');
    expect(store.activeFacts(HOST, me, 'accountant')).toHaveLength(2);
    expect(store.pendingReview(HOST)).toHaveLength(1);
    expect(resolveContradiction(store, HOST, incomingFactId, NOW())).toHaveLength(1);
    expect(store.openContradictions(HOST)).toHaveLength(0);
  });

  it('reject: blank candidate → no belief, proposal marked rejected', async () => {
    const { store, deps } = harness();
    const ep = episode(store, 'ricorda questo');
    const { id } = proposeMemoryRecord(store, {
      tenantId: HOST,
      subject: 'owner',
      subjectKind: 'person',
      predicate: 'accountant',
      object: '   ',
      producer: 'owner-stated',
      sourceEpisodeIds: [ep],
      content: 'ricorda questo',
      confidence: 0.9,
    });
    const out = await reconcileProposal(deps, HOST, id);
    expect(out.status).toBe('rejected');
    expect(store.hasActiveFacts(HOST)).toBe(false);
  });

  it('reject: evidence withdrawn before reconcile → no belief', async () => {
    const { store, deps } = harness();
    const ep = episode(store, 'ricorda che il mio commercialista è Mario');
    const { id } = proposeOwner(store, { episodeId: ep });
    store.supersedeEpisodes(HOST, [ep], NOW().toISOString());
    const out = await reconcileProposal(deps, HOST, id);
    expect(out.status).toBe('rejected');
    expect(store.hasActiveFacts(HOST)).toBe(false);
  });

  it('reconcile is idempotent — a second reconcile writes no second belief', async () => {
    const { store, deps } = harness();
    const { id } = proposeOwner(store);
    const first = await reconcileProposal(deps, HOST, id);
    const second = await reconcileProposal(deps, HOST, id);
    expect(second.status).toBe(first.status);
    expect(second.factIds).toEqual(first.factIds);
    const me = store.findEntity(HOST, 'owner')!;
    expect(store.activeFacts(HOST, me, 'accountant')).toHaveLength(1);
  });

  it('two producers, one belief — owner-stated plus agent-inference converge', async () => {
    const { store, deps } = harness();
    const ep1 = episode(store, 'ricorda che il mio commercialista è Mario');
    const ep2 = episode(store, 'a proposito, il commercialista è Mario');
    const a = proposeMemoryRecord(store, {
      tenantId: HOST,
      subject: 'owner',
      subjectKind: 'person',
      predicate: 'accountant',
      object: 'Mario',
      producer: 'owner-stated',
      sourceEpisodeIds: [ep1],
      content: 'ricorda che il mio commercialista è Mario',
      confidence: 0.95,
    });
    const b = proposeMemoryRecord(store, {
      tenantId: HOST,
      subject: 'owner',
      subjectKind: 'person',
      predicate: 'accountant',
      object: 'Mario',
      producer: 'agent-inference',
      sourceEpisodeIds: [ep2],
      content: 'inferisco che il commercialista sia Mario',
      confidence: 0.7,
    });
    expect(b.id).not.toBe(a.id);
    await reconcileProposal(deps, HOST, a.id);
    const out = await reconcileProposal(deps, HOST, b.id);
    expect(out.status).toBe('merged');
    const me = store.findEntity(HOST, 'owner')!;
    expect(store.activeFacts(HOST, me, 'accountant')).toHaveLength(1);
  });
});

describe('MemoryProposal — kill durability and exactly-once', () => {
  function fileHarness(
    dir: string,
    replies: string[] = [],
  ): { db: Database.Database; store: MemoryStore; deps: IngestDeps; file: string } {
    const file = join(dir, 'muffin.db');
    const db = new DatabaseCtor(file);
    const store = new MemoryStore(db);
    const home = mkdtempSync(join(tmpdir(), 'muffin-proposal-kill-'));
    const deps: IngestDeps = {
      store,
      provider: new Scripted(replies),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      now: NOW,
    };
    return { db, store, deps, file };
  }

  it('kill between propose and reconcile loses nothing and duplicates nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-proposal-dir-'));
    // Boot 1: the owner says "ricorda", the proposal is committed, then kill -9.
    const first = fileHarness(dir);
    const ep = episode(first.store, 'ricorda che il mio commercialista è Mario');
    const { id } = proposeOwner(first.store, { episodeId: ep });
    // The crash: no flush, no reconcile, no in-memory state survives. better-sqlite3
    // is synchronous, so the INSERT above is already on disk; closing here only
    // models the process dying before any further write.
    first.db.close();

    // Boot 2: a fresh process on the same file reconciles the pending queue.
    const second = fileHarness(dir);
    expect(second.store.pendingProposals(HOST)).toHaveLength(1);
    const out = await reconcilePendingProposals(second.deps, HOST);
    expect(out.reconciled).toBe(1);
    const me = second.store.findEntity(HOST, 'owner')!;
    expect(second.store.activeFacts(HOST, me, 'accountant')).toHaveLength(1);
    expect(second.store.proposalById(HOST, id)!.status).toBe('accepted');
    // And a third boot reconciles nothing new: exactly one belief, forever.
    const third = fileHarness(dir);
    const again = await reconcilePendingProposals(third.deps, HOST);
    expect(again.reconciled).toBe(0);
    const meAgain = third.store.findEntity(HOST, 'owner')!;
    expect(third.store.activeFacts(HOST, meAgain, 'accountant')).toHaveLength(1);
    third.db.close();
    second.db.close();
  });
});

describe('MemoryProposal — the writer stays single', () => {
  it('only the canonical reconciler writes beliefs (no second belief-writer)', () => {
    // The falsifier, as a test: walk the shipped sources and prove `addFact`
    // is called only from the store itself and the canonical reconciler.
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const roots = ['core', 'agent', 'cli', 'connectors'].map((d) => join(repoRoot, d));
    const allowed = new Set(['core/memory/store.ts', 'core/memory/ingest.ts']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
        const text = readFileSync(full, 'utf8');
        if (!/\.addFact\(/.test(text)) continue;
        const rel = relative(repoRoot, full);
        if (allowed.has(rel)) continue;
        offenders.push(rel);
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('MemoryProposal — the duplicate sweep shares the reconciliation lane', () => {
  it('defers a sweep while a judge holds a candidate snapshot, keeping the review actionable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-proposal-sweep-race-'));
    const file = join(dir, 'muffin.db');
    const makeHarness = () => {
      const db = new DatabaseCtor(file);
      const store = new MemoryStore(db);
      const home = mkdtempSync(join(tmpdir(), 'muffin-proposal-sweep-race-traces-'));
      const deps: IngestDeps = {
        store,
        provider: new Scripted([]),
        model: 'test-light',
        tracer: new SimpleTracer(new JsonlExporter(home)),
        now: NOW,
      };
      return { db, store, deps };
    };
    const first = makeHarness();
    const second = makeHarness();
    let signalJudgeStarted!: () => void;
    const judgeStarted = new Promise<void>((resolve) => {
      signalJudgeStarted = resolve;
    });
    let releaseJudge!: (text: string) => void;
    const judgeReply = new Promise<string>((resolve) => {
      releaseJudge = resolve;
    });
    const deferredJudge: Provider = {
      kind: 'openai-compat',
      async chat(): Promise<ChatResult> {
        signalJudgeStarted();
        const text = await judgeReply;
        return {
          text,
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'test',
        };
      },
    };
    first.deps.provider = deferredJudge;

    const subjectId = first.store.upsertEntity(HOST, 'owner', 'person', '2026-08-04T11:00:00Z');
    const firstEpisode = episode(first.store, 'il commercialista è Marco');
    const secondEpisode = episode(first.store, 'il commercialista è Marco');
    const firstDuplicateId = first.store.addFact({
      tenantId: HOST,
      subjectId,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: firstEpisode,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const candidateId = first.store.addFact({
      tenantId: HOST,
      subjectId,
      predicate: 'accountant',
      objectValue: 'Marco',
      episodeId: secondEpisode,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-08-04T10:00:00Z',
    });
    const { id: proposalId } = proposeOwner(first.store, {
      object: 'Lucia',
      producer: 'agent-inference',
      episodeId: episode(first.store, 'inferisco che il commercialista sia Lucia'),
    });
    expect(firstDuplicateId).toBeLessThan(candidateId);

    const reconciliation = reconcileProposal(first.deps, HOST, proposalId);
    try {
      await judgeStarted;
      const sweep = sweepDuplicates(second.store, HOST, NOW());
      expect(sweep).toMatchObject({ busy: true, merges: [] });
      expect(first.store.activeFacts(HOST, subjectId, 'accountant').map((fact) => fact.id)).toEqual(
        [firstDuplicateId, candidateId],
      );
      const retried = proposeMemoryRecord(second.store, {
        tenantId: HOST,
        subject: 'owner',
        subjectKind: 'person',
        predicate: 'accountant',
        object: 'Lucia',
        producer: 'agent-inference',
        sourceEpisodeIds: [first.store.proposalById(HOST, proposalId)!.sourceEpisodeIds[0]!],
        content: 'ricorda che il mio commercialista è Mario',
        confidence: 0.95,
        contextTier: 3,
      });
      expect(retried).toEqual({ id: proposalId, duplicate: true });

      releaseJudge(verdict('review', 0.5));
      const out = await reconciliation;
      expect(out.status).toBe('review');
      const incomingId = out.factIds[0];
      expect(first.store.factById(HOST, incomingId!)?.trustTier).toBe(3);
      if (incomingId === undefined) throw new Error('review did not record the incoming fact');
      expect(first.store.openContradictions(HOST)).toEqual([
        expect.objectContaining({ existingFactId: candidateId, incomingFactId: incomingId }),
      ]);
      expect(resolveContradiction(second.store, HOST, incomingId, NOW())).toHaveLength(1);
      expect(first.store.openContradictions(HOST)).toHaveLength(0);
    } finally {
      releaseJudge(verdict('review', 0.5));
      await reconciliation.catch(() => undefined);
      first.db.close();
      second.db.close();
    }
  });
});

describe('MemoryProposal — duplicate tier promotion is ordered with reconciliation', () => {
  it('holds the SQLite writer slot from duplicate insert through tier promotion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-proposal-tier-order-'));
    const file = join(dir, 'muffin.db');
    const db = new DatabaseCtor(file);
    const store = new MemoryStore(db);
    const sourceEpisode = episode(store, 'ricorda che il mio commercialista è Mario');
    const { id: proposalId } = proposeOwner(store, { episodeId: sourceEpisode });
    const home = mkdtempSync(join(tmpdir(), 'muffin-proposal-tier-traces-'));
    const deps: IngestDeps = {
      store,
      provider: new Scripted([]),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      now: NOW,
    };

    const reconcileReady = join(dir, 'reconcile-ready');
    const reconcileGo = join(dir, 'reconcile-go');
    const reconcileDone = join(dir, 'reconcile-done');
    const stageReady = join(dir, 'stage-ready');
    const stageGo = join(dir, 'stage-go');
    const stagePaused = join(dir, 'stage-paused');
    const stageRelease = join(dir, 'stage-release');
    const stageDone = join(dir, 'stage-done');
    const reconcileScript = `
      import { existsSync, writeFileSync } from 'node:fs';
      import DatabaseCtor from 'better-sqlite3';
      import { MemoryStore } from '${join(process.cwd(), 'core/memory/store.ts')}';
      import { reconcileProposal } from '${join(process.cwd(), 'core/memory/ingest.ts')}';
      const [dbFile, id, readyFile, goFile, doneFile] = process.argv.slice(1);
      const db = new DatabaseCtor(dbFile);
      db.pragma('busy_timeout = 250');
      const store = new MemoryStore(db);
      writeFileSync(readyFile, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(goFile)) Atomics.wait(wait, 0, 0, 10);
      try {
        const out = await reconcileProposal({
          store,
          provider: { kind: 'openai-compat', async chat() { throw new Error('judge not expected'); } },
          model: 'test-light',
          tracer: {},
        }, 'host', Number(id));
        writeFileSync(doneFile, JSON.stringify({ kind: 'resolved', status: out.status }));
      } catch (error) {
        writeFileSync(doneFile, JSON.stringify({
          kind: error?.code === 'SQLITE_BUSY' ? 'busy' : 'error',
          code: error?.code,
          message: String(error),
        }));
      } finally {
        db.close();
      }
    `;
    const stageScript = `
      import { existsSync, writeFileSync } from 'node:fs';
      import DatabaseCtor from 'better-sqlite3';
      import { MemoryStore } from '${join(process.cwd(), 'core/memory/store.ts')}';
      import { proposeMemoryRecord } from '${join(process.cwd(), 'core/memory/proposals.ts')}';
      const [dbFile, episodeId, readyFile, goFile, pausedFile, releaseFile, doneFile] = process.argv.slice(1);
      const db = new DatabaseCtor(dbFile);
      let paused = false;
      const instrumented = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') return (sql) => {
            const statement = target.prepare(sql);
            if (!paused && String(sql).includes('INSERT OR IGNORE INTO memory_proposals')) {
              return new Proxy(statement, {
                get(inner, key) {
                  if (key === 'run') return (...args) => {
                    const result = inner.run(...args);
                    paused = true;
                    writeFileSync(pausedFile, 'paused');
                    const wait = new Int32Array(new SharedArrayBuffer(4));
                    while (!existsSync(releaseFile)) Atomics.wait(wait, 0, 0, 10);
                    return result;
                  };
                  const value = Reflect.get(inner, key, inner);
                  return typeof value === 'function' ? value.bind(inner) : value;
                },
              });
            }
            return statement;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const store = new MemoryStore(instrumented);
      writeFileSync(readyFile, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(goFile)) Atomics.wait(wait, 0, 0, 10);
      const out = proposeMemoryRecord(store, {
        tenantId: 'host', subject: 'owner', subjectKind: 'person',
        predicate: 'accountant', object: 'Mario', producer: 'owner-stated',
        sourceEpisodeIds: [Number(episodeId)], contextTier: 3,
        content: 'ricorda che il mio commercialista è Mario', confidence: 0.95,
      });
      writeFileSync(doneFile, JSON.stringify(out));
      db.close();
    `;
    const reconcile = spawn(
      'node',
      ['--import', 'tsx', '--input-type=module', '-e', reconcileScript, file, String(proposalId), reconcileReady, reconcileGo, reconcileDone],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let reconcileError = '';
    reconcile.stderr.on('data', (chunk) => (reconcileError += String(chunk)));
    const stage = spawn(
      'node',
      ['--import', 'tsx', '--input-type=module', '-e', stageScript, file, String(sourceEpisode), stageReady, stageGo, stagePaused, stageRelease, stageDone],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stageError = '';
    stage.stderr.on('data', (chunk) => (stageError += String(chunk)));
    const waitForFile = async (path: string): Promise<string> => {
      const deadline = Date.now() + 8_000;
      while (!existsSync(path) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
      return readFileSync(path, 'utf8');
    };
    const waitForClose = (child: ReturnType<typeof spawn>): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => child.once('close', () => resolve()));
    };
    try {
      await Promise.all([waitForFile(reconcileReady), waitForFile(stageReady)]);
      writeFileSync(stageGo, 'go');
      await waitForFile(stagePaused);

      // Pause the duplicate call after its INSERT. An autocommit implementation
      // lets reconciliation finish here; an IMMEDIATE transaction keeps its
      // writer slot until the pending-only tier promotion also commits.
      writeFileSync(reconcileGo, 'go');
      const firstReconcile = JSON.parse(await waitForFile(reconcileDone)) as {
        kind: string;
        code?: string;
        status?: string;
      };
      writeFileSync(stageRelease, 'release');
      await waitForFile(stageDone);
      await Promise.all([waitForClose(reconcile), waitForClose(stage)]);
      expect(reconcileError).toBe('');
      expect(stageError).toBe('');
      expect(firstReconcile.kind).toBe('busy');

      const out = await reconcileProposal(deps, HOST, proposalId, { at: NOW() });
      expect(out.status).toBe('accepted');
      const proposal = store.proposalById(HOST, proposalId)!;
      const fact = store.factById(HOST, out.factIds[0]!)!;
      expect(proposal.trustTier).toBe(3);
      expect(fact.trustTier).toBe(3);
    } finally {
      if (!existsSync(reconcileGo)) writeFileSync(reconcileGo, 'go');
      if (!existsSync(stageGo)) writeFileSync(stageGo, 'go');
      if (!existsSync(stageRelease)) writeFileSync(stageRelease, 'release');
      await Promise.all([waitForClose(reconcile), waitForClose(stage)]);
      db.close();
    }
  }, 20_000);

  it('does not raise a proposal after its terminal outcome has committed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-proposal-terminal-tier-'));
    const file = join(dir, 'muffin.db');
    const firstDb = new DatabaseCtor(file);
    const first = new MemoryStore(firstDb);
    const sourceEpisode = episode(first, 'ricorda che il mio commercialista è Mario');
    const { id: proposalId } = proposeOwner(first, { episodeId: sourceEpisode });
    const home = mkdtempSync(join(tmpdir(), 'muffin-proposal-terminal-traces-'));
    const out = await reconcileProposal(
      {
        store: first,
        provider: new Scripted([]),
        model: 'test-light',
        tracer: new SimpleTracer(new JsonlExporter(home)),
        now: NOW,
      },
      HOST,
      proposalId,
      { at: NOW() },
    );
    expect(out.status).toBe('accepted');

    const secondDb = new DatabaseCtor(file);
    const second = new MemoryStore(secondDb);
    const replay = proposeMemoryRecord(second, {
      tenantId: HOST,
      subject: 'owner',
      subjectKind: 'person',
      predicate: 'accountant',
      object: 'Mario',
      producer: 'owner-stated',
      sourceEpisodeIds: [sourceEpisode],
      contextTier: 3,
      content: 'ricorda che il mio commercialista è Mario',
      confidence: 0.95,
    });
    expect(replay).toEqual({ id: proposalId, duplicate: true });
    expect(second.proposalById(HOST, proposalId)?.trustTier).toBe(0);
    expect(second.factById(HOST, out.factIds[0]!)?.trustTier).toBe(0);
    secondDb.close();
    firstDb.close();
  });
});
