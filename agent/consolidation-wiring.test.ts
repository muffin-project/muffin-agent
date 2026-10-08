import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import { BudgetEngine } from '../core/budget/budget.js';
import { costUsd } from '../core/budget/pricing.js';
import {
  Consolidator,
  CONSOLIDATION_CAPABILITY,
  CONSOLIDATION_DRAIN_MS,
  CONSOLIDATION_IDLE_MS,
  readConsolidation,
} from '../core/memory/consolidator.js';
import { EXTRACTION_VERSION } from '../core/memory/schema.js';
import { ingestPending } from '../core/memory/ingest.js';
import { sweepDuplicates } from '../core/memory/maintenance.js';
import type { RecallDeps } from '../core/memory/recall.js';
import { proposeMemoryRecord } from '../core/memory/proposals.js';
import { MemoryStore } from '../core/memory/store.js';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import { lightLane } from './providers/light-lane.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';

/**
 * The join this slice exists to make: **a turn ends and, with nobody typing
 * anything, facts appear.**
 *
 * `ingestPending` has been correct since `6ddba7c` and had one caller — a person
 * typing `muffin memory extract`. Every piece downstream of that caller had
 * tests; the thing that had no test was that production ever reached it, which
 * is this repository's signature defect (`AGENTS.md`: four defences with correct
 * logic and no caller). So the assertion here is deliberately end-to-end and
 * deliberately not about extraction quality: run a real turn through the real
 * loop, wait, and look in the real `facts` table.
 *
 * Verified to fail without the wiring: removing `announceEnd` from
 * `agent/loop.ts`'s `finish` turns "il consolidamento parte da solo" red and
 * leaves the rest of the suite green.
 */

/** A model that answers the turn, then answers the extractor. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly calls: ChatCall[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: ChatCall): Promise<ChatResult> {
    this.calls.push(call);
    return (
      this.script[this.i++] ?? {
        text: '{"facts":[]}',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        // A model the price table knows, so `costUsd` is not silently zero and
        // the spend assertion below is about the wiring rather than the table.
        model: 'claude-haiku-4-5-20251001',
      }
    );
  }
}

const reply = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 40, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'claude-haiku-4-5-20251001',
});

const extraction = (facts: unknown[]): ChatResult => ({
  ...reply(JSON.stringify({ facts })),
});

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const member: Principal = {
  kind: 'member',
  connector: 'telegram',
  tenantId: 'group:telegram:42',
  externalId: 'u1',
};

/**
 * The production assembly, minus the network.
 *
 * Everything the runtime binds together is bound the same way here — the same
 * `lightLane` wrapper, the same `ingestPending` closure, the same `onTurnEnd`
 * seam — so what this exercises is the arrangement, not a rehearsal of it.
 */
function harness(script: ChatResult[], model = 'light', baseUrl?: string) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-consolidation-'));
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const recall: RecallDeps = { store };
  const provider = new Scripted(script);
  const budget = new BudgetEngine(db, { monthlyUsd: 10, perTenantDailyUsd: 5 });

  const light = lightLane(provider, {
    profile: CONSERVATIVE,
    record: (entry) =>
      budget.record({
        ...entry,
        tenant: 'host',
        capability: CONSOLIDATION_CAPABILITY,
        usd: costUsd(entry.model, entry, baseUrl, entry.requestedModel),
      }),
  });
  const tracer = new SimpleTracer(new JsonlExporter(home));

  const consolidation = new Consolidator({
    db,
    budgetExhausted: () => budget.exhausted(),
    ingest: (limit) => ingestPending({ store, provider: light, model, tracer }, 'host', limit),
    sweep: (at) => sweepDuplicates(store, 'host', at),
  });

  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'main',
    tools: [],
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(),
      budgetExhausted: () => budget.exhausted(),
      hardened: true,
    }),
    capabilities: new Map(),
    tracer,
    sessions: new SessionStore(home),
    turns: new TurnStore(db),
    todos: new TodoStore(db),
    budgetExhausted: () => budget.exhausted(),
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    memory: { store, recall },
    onTurnEnd: ({ tenant }) => consolidation.notify(tenant),
  };

  const speak = (text: string, principal: Principal = owner) =>
    runTurn(deps, {
      principal,
      tenant: principal.kind === 'member' ? principal.tenantId : 'host',
      surface: 'cli',
      session: deps.sessions.open('s1'),
      text,
    });

  const activeFacts = () =>
    db.prepare(`SELECT count(*) AS n FROM facts WHERE expired_at IS NULL`).get() as { n: number };

  return { db, store, provider, budget, consolidation, deps, speak, activeFacts };
}

const CAGLIARI = [
  {
    subject: 'owner',
    subjectKind: 'person',
    predicate: 'lives_in',
    object: 'Cagliari',
    validFrom: null,
    confidence: 0.9,
  },
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('consolidation starts by itself', () => {
  it('turns a turn into a fact, with nobody typing anything', async () => {
    const h = harness([reply('ok'), extraction(CAGLIARI)]);

    await h.speak('mi sono trasferito a Cagliari');
    // The reply is out and nothing has been extracted: the owner did not wait
    // for the memory lane, which is the first half of the contract.
    expect(h.activeFacts().n).toBe(0);

    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidation.settled();

    // And the second half: it happened anyway.
    expect(h.activeFacts().n).toBe(1);
    const fact = h.db.prepare(`SELECT predicate, object_value AS v FROM facts`).get() as {
      predicate: string;
      v: string;
    };
    expect(fact).toEqual({ predicate: 'lives_in', v: 'Cagliari' });
  });

  it('drains proposals past one bounded page when the episode page is short', async () => {
    const h = harness([reply('ok')]);
    const evidenceIds = Array.from({ length: 21 }, (_, i) =>
      h.store.addEpisode({
        tenantId: 'host',
        connector: 'cli',
        threadKey: 't',
        role: 'user',
        kind: 'message',
        content: `evidence ${i}`,
        trustTier: 0,
        createdAt: `2026-08-01T10:${String(i).padStart(2, '0')}:00Z`,
      }),
    );
    h.store.markExtracted('host', evidenceIds, EXTRACTION_VERSION);
    evidenceIds.forEach((episodeId, i) =>
      proposeMemoryRecord(h.store, {
        tenantId: 'host',
        subject: 'owner',
        subjectKind: 'person',
        predicate: `note_${i}`,
        object: `value_${i}`,
        producer: 'agent-inference',
        sourceEpisodeIds: [episodeId],
        content: `inference ${i}`,
        confidence: 0.9,
      }),
    );

    // The production turn-end seam arms consolidation. Its one ingress episode
    // is a short page; the 21 already-evidenced proposals cross their own page
    // boundary only after the real `ingestPending` consumer runs.
    await h.speak('ciao');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidation.settled();
    expect(h.store.pendingProposals('host')).toHaveLength(1);
    expect(h.consolidation.isArmed()).toBe(true);

    await vi.advanceTimersByTimeAsync(CONSOLIDATION_DRAIN_MS);
    await h.consolidation.settled();

    expect(h.store.pendingProposals('host')).toHaveLength(0);
    expect(h.activeFacts().n).toBe(21);
    const triggers = (
      h.db.prepare(`SELECT trigger FROM consolidation_runs ORDER BY id`).all() as { trigger: string }[]
    ).map((r) => r.trigger);
    expect(triggers).toEqual(['idle', 'drain']);
    expect(h.consolidation.isArmed()).toBe(false);
  });

  it('keeps a review resolvable when the post-ingest sweep finds equal-time duplicates', async () => {
    const h = harness([
      reply('{"reasoning":"le due versioni restano aperte","verdict":"review","confidence":0.5}'),
    ]);
    const evidence = h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: 'il commercialista ora è Lucia', trustTier: 0, createdAt: '2026-08-01T12:00:00Z',
    });
    const priorEvidence = h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: 'il commercialista è Marco', trustTier: 0, createdAt: '2026-08-01T11:00:00Z',
    });
    const ownerId = h.store.upsertEntity('host', 'owner', 'person', '2026-08-01T11:00:00Z');
    const addMarco = () => h.store.addFact({
      tenantId: 'host', subjectId: ownerId, predicate: 'accountant', objectValue: 'Marco',
      episodeId: priorEvidence, trustTier: 0, confidence: 0.9, extractionV: 1,
      recordedAt: '2026-08-01T11:00:00Z',
    });
    const olderDuplicate = addMarco();
    const sweepKeeper = addMarco();
    h.store.markExtracted('host', [evidence, priorEvidence], EXTRACTION_VERSION);
    proposeMemoryRecord(h.store, {
      tenantId: 'host', subject: 'owner', subjectKind: 'person', predicate: 'accountant',
      object: 'Lucia', producer: 'owner-stated', sourceEpisodeIds: [evidence],
      content: 'il commercialista ora è Lucia', confidence: 0.95,
    });

    const result = await h.consolidation.runNow('manual');

    expect(result.report?.needsReview).toHaveLength(1);
    expect(h.store.factById('host', olderDuplicate)?.expiredAt).not.toBeNull();
    expect(h.store.factById('host', sweepKeeper)?.expiredAt).toBeNull();
    expect(h.store.openContradictions('host')).toMatchObject([
      { existingFactId: sweepKeeper },
    ]);
  });

  it('embeds the episode too — the half of recall nothing else feeds', async () => {
    // `indexBacklog`/`index` are called from `ingest.ts` and the vault, and by
    // nothing else: until this trigger existed, an install that never ran the
    // hand-typed command had a permanently empty vector index and a recall that
    // was keyword-only for its whole life. Asserted as the report's own number
    // because a real embedder is not available in a unit test.
    const h = harness([reply('ok'), extraction([])]);
    const report = await h.consolidation.runNow('manual');
    expect(report.report?.indexed).toBe(0);
    // The point is that the path is reached at all: with no VectorIndex
    // configured the count is zero and no error is raised, which is the
    // degraded-but-honest state `doctor` reports.
    expect(report.run.outcome).toBe('ran');
  });

  it('marks the episode, so the next batch does not pay for it again', async () => {
    const h = harness([reply('ok'), extraction(CAGLIARI)]);
    await h.speak('mi sono trasferito a Cagliari');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidation.settled();

    const callsAfterFirst = h.provider.calls.length;
    await h.consolidation.runNow('manual');
    expect(h.provider.calls.length).toBe(callsAfterFirst);
  });
});

describe('a backlog drains itself', () => {
  /**
   * The half of M5-bis row 1 ADR-0038 left open, end to end through the real
   * `ingestPending`.
   *
   * Under a backlog the trailing edge loses its whole point: `pendingEpisodes`
   * is `ORDER BY created_at`, so a fire spends its bounded page on the *oldest*
   * episodes and the message that just armed it is not in the batch — the fact
   * does not land before the next message, and nothing says so. Backlogs are
   * ordinary here: `muffin run` headless leaves its episodes pending by design,
   * a gateway that was down accumulates, a migration starts owing the whole
   * corpus.
   *
   * Agent-role episodes, deliberately: extraction skips them without a model
   * call, so this asserts the paging and the stop condition with no provider
   * involved at all.
   */
  it('keeps taking pages on its own until the queue is shorter than one', async () => {
    const h = harness([reply('ok')]);
    for (let i = 0; i < 25; i += 1) {
      h.store.addEpisode({
        tenantId: 'host',
        connector: 'cli',
        threadKey: 't',
        role: 'agent',
        kind: 'message',
        content: `risposta ${i}`,
        trustTier: 0,
        createdAt: `2026-08-01T10:${String(i).padStart(2, '0')}:00Z`,
      });
    }
    // One turn arms one trailing edge. Before the drain, that is all the lane
    // ever got: one page of twenty, and five episodes left owed until the owner
    // happened to speak again.
    await h.speak('ciao');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidation.settled();
    expect(h.store.stats('host').pending).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidation.settled();

    expect(h.store.stats('host').pending).toBe(0);
    const triggers = (
      h.db.prepare(`SELECT trigger FROM consolidation_runs ORDER BY id`).all() as { trigger: string }[]
    ).map((r) => r.trigger);
    expect(triggers).toEqual(['idle', 'drain']);
    // And it stops: nothing is behind the short page, so re-arming would be a
    // timer with no work — and a timer with no work on a lane that calls a model
    // is the shape that spends a month's budget on an empty queue.
    expect(h.consolidation.isArmed()).toBe(false);
  });
});

describe('the memory lane is inside the budget', () => {
  /**
   * The mutation this kills: `runtime.light.provider` handed out unwrapped.
   * `recordSpend` is a `LoopDeps` field called only from the loop, so before
   * this slice extraction, the judge and the reranker billed nothing at all —
   * `/spend`, the monthly cap and the kernel's `budget_exhausted` branch read
   * zero from a lane that now runs unattended and repeatedly.
   */
  it('bills every extraction call, under the consolidation lane', async () => {
    const h = harness([reply('ok'), extraction(CAGLIARI)]);
    await h.speak('mi sono trasferito a Cagliari');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidation.settled();

    const rows = h.db
      .prepare(`SELECT capability, count(*) AS n FROM spend GROUP BY capability`)
      .all() as { capability: string; n: number }[];
    expect(rows).toEqual([{ capability: CONSOLIDATION_CAPABILITY, n: 1 }]);
    expect(h.budget.monthToDateUsd()).toBeGreaterThan(0);
  });

  it('bills $0 for a memory-lane call requested through openrouter/free, keeping the served model on the row (#499)', async () => {
    const served: ChatResult = {
      ...extraction(CAGLIARI),
      model: 'qwen/qwen3.8-27b',
      usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const h = harness([reply('ok'), served], 'openrouter/free', 'https://openrouter.ai/api/v1');
    await h.speak('mi sono trasferito a Cagliari');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidation.settled();

    expect(h.budget.monthToDateUsd()).toBe(0);
    const rows = h.db.prepare(`SELECT model, usd FROM spend`).all() as { model: string; usd: number }[];
    expect(rows).toEqual([{ model: 'qwen/qwen3.8-27b', usd: 0 }]);
  });

  it('stops consolidating when the month is spent, instead of spending past it', async () => {
    const h = harness([reply('ok'), extraction(CAGLIARI)]);
    h.budget.record({
      tenant: 'host',
      capability: 'llm.chat',
      model: 'main',
      inputTokens: 0,
      outputTokens: 0,
      usd: 999,
    });
    await h.speak('mi sono trasferito a Cagliari');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidation.settled();

    expect(h.activeFacts().n).toBe(0);
    expect(readConsolidation(h.db)?.last.outcome).toBe('budget');
  });
});

describe('the tenant seam, refused', () => {
  /**
   * `agent/context/assemble.ts` records that the group persona's *"non sto
   * costruendo il ritratto di nessuno"* is true today **only because**
   * extraction is never pointed at a group tenant. Scheduling ingestion is
   * exactly the change that would have made it false — `extractFacts` derives
   * `speakerName` from `role`, so a member's claim would be mined under the
   * label "owner". This is the test that keeps the sentence true.
   */
  it('a group turn does not arm consolidation, and mines nothing', async () => {
    const h = harness([reply('ok'), extraction(CAGLIARI)]);
    await h.speak('io vivo a Cagliari', member);

    expect(h.consolidation.isArmed()).toBe(false);
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS * 3);
    await h.consolidation.settled();
    expect(h.activeFacts().n).toBe(0);
    expect(readConsolidation(h.db)).toBeNull();
  });
});

/**
 * And the half the harness above cannot prove: that `buildRuntime` — the
 * production assembly, not this file's imitation of it — actually connects the
 * loop to a consolidator. Same reasoning as `runtime-wiring.test.ts`: when two
 * components each defer to the other, the test has to span the join.
 */
describe('buildRuntime wires it', () => {
  const freshHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-consolidation-rt-'));
    runInit({ home, apiKey: 'sk-never-called' });
    return home;
  };

  it('arms the real consolidator from a real turn on the real runtime', async () => {
    const runtime = buildRuntime(freshHome(), mkdtempSync(join(tmpdir(), 'muffin-cons-ws-')));
    try {
      expect(runtime.consolidation.isArmed()).toBe(false);
      await runTurn(
        { ...runtime.deps, provider: new Scripted([reply('ok')]) },
        {
          principal: owner,
          tenant: 'host',
          surface: 'cli',
          session: runtime.deps.sessions.open('s1'),
          text: 'ciao',
        },
      );
      // Nothing here mocked `onTurnEnd`: this is `buildRuntime`'s own line.
      expect(runtime.consolidation.isArmed()).toBe(true);
    } finally {
      runtime.close();
    }
  });

  it('a member turn on the real runtime leaves it disarmed', async () => {
    const runtime = buildRuntime(freshHome(), mkdtempSync(join(tmpdir(), 'muffin-cons-ws-')));
    try {
      await runTurn(
        { ...runtime.deps, provider: new Scripted([reply('ok')]) },
        {
          principal: member,
          tenant: member.tenantId,
          surface: 'telegram',
          session: runtime.deps.sessions.open('s2'),
          text: 'ciao',
        },
      );
      expect(runtime.consolidation.isArmed()).toBe(false);
    } finally {
      runtime.close();
    }
  });

  /**
   * The mutation this kills: `light: { provider, … }` — the raw provider handed
   * to extraction, the judge and the reranker, which is what the line said
   * before this slice and why the memory lane billed nothing at all.
   *
   * An identity assertion, and deliberately so: the defect *is* an identity —
   * one line returning the wrong object — and proving it behaviourally would
   * mean a real model call from a unit test. `light-lane.test.ts` owns the
   * behaviour; this owns the join. The second half is not decoration either: a
   * `deps.provider` that got wrapped too would bill every main-lane call twice,
   * once here and once in the loop.
   */
  it('hands the memory lane the metered provider, and the loop the raw one', () => {
    const runtime = buildRuntime(freshHome(), mkdtempSync(join(tmpdir(), 'muffin-cons-ws-')));
    try {
      expect(runtime.light.provider).not.toBe(runtime.deps.provider);
      expect(runtime.deps.recordSpend).toBeTypeOf('function');
    } finally {
      runtime.close();
    }
  });

  /**
   * The maintenance sweep, reached from the production assembly.
   *
   * Read out of the consolidator's deps and then *called*, which is what makes
   * this a wiring test rather than a shape test: invoking the bound closure
   * proves it points at `runtime.memory.store` and at the host tenant, and it
   * needs no model, because the sweep spends nothing by design.
   *
   * The mutation it kills is the one this repo keeps paying for: a `sweep` that
   * some caller wires and `buildRuntime` does not. `maintenance.test.ts` owns
   * the merge rules; this owns the join.
   */
  it('binds the duplicate sweep to its own store, on the host tenant', () => {
    const runtime = buildRuntime(freshHome(), mkdtempSync(join(tmpdir(), 'muffin-cons-ws-')));
    try {
      const store = runtime.memory.store;
      const episodeId = store.addEpisode({
        tenantId: 'host',
        connector: 'cli',
        threadKey: 't',
        role: 'user',
        kind: 'message',
        content: 'mi interessa la vela',
        trustTier: 0,
        createdAt: '2026-08-01T10:00:00Z',
      });
      const subjectId = store.upsertEntity('host', 'owner', 'person', '2026-08-01T10:00:00Z');
      const believe = (object: string, at: string) =>
        store.addFact({
          tenantId: 'host',
          subjectId,
          predicate: 'interested_in',
          objectValue: object,
          episodeId,
          trustTier: 0,
          confidence: 0.9,
          extractionV: 1,
          recordedAt: at,
        });
      const first = believe('vela', '2026-06-01T10:00:00Z');
      const again = believe('Vela.', '2026-08-01T10:00:00Z');

      const bound = (
        runtime.consolidation as unknown as {
          deps: { sweep?: (at: Date) => { merges: unknown[] } };
        }
      ).deps.sweep;
      expect(bound).toBeTypeOf('function');
      expect(bound!(new Date('2026-08-14T12:00:00Z')).merges).toHaveLength(1);

      expect(store.factById('host', again)?.expiredAt).toBeNull();
      // Retired, not removed — the rule that matters most in a pass that runs in
      // bulk with nobody watching.
      expect(store.factById('host', first)?.supersededBy).toBe(again);
    } finally {
      runtime.close();
    }
  });

  it("its batch reaches the runtime's own store, on the host tenant", async () => {
    const home = freshHome();
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-cons-ws-')));
    try {
      // An agent-role episode is skipped by extraction without a model call, so
      // this asserts the closure's *bindings* — the runtime's store, the host
      // tenant — with no network anywhere near it.
      runtime.memory.store.addEpisode({
        tenantId: 'host',
        connector: 'cli',
        threadKey: 't',
        role: 'agent',
        kind: 'message',
        content: 'una risposta',
        trustTier: 0,
        createdAt: new Date().toISOString(),
      });
      const outcome = await runtime.consolidation.runNow('manual');
      expect(outcome.report?.skippedAgentOutput).toBe(1);
      expect(readConsolidation(runtime.db)?.last.outcome).toBe('ran');
      expect(runtime.memory.store.stats('host').pending).toBe(0);
    } finally {
      runtime.close();
    }
  });
});
