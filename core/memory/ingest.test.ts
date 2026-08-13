import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { JsonlExporter, SimpleTracer } from '../tracing/tracer.js';
import { EmbedderUnavailable, type Embedder } from './embed.js';
import { ingestPending } from './ingest.js';
import { SUPERSEDE_THRESHOLD } from './judge.js';
import { MemoryStore } from './store.js';
import { VectorIndex } from './vectors.js';

/** Replays scripted model answers so the pipeline is tested, not the model. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async chat(_request?: ChatCall): Promise<ChatResult> {
    const text = this.replies[this.i++] ?? '{"facts":[]}';
    return {
      text,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

/** Enough of an embedder to write real rows; the vectors themselves do not matter here. */
class CountingEmbedder implements Embedder {
  readonly id = 'counting:v1';
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => Float32Array.from({ length: 8 }, (_, i) => ((t.charCodeAt(i) || 0) % 7) / 7));
  }
}

class BrokenEmbedder implements Embedder {
  readonly id = 'broken:v1';
  readonly dimensions = 8;
  async embed(): Promise<Float32Array[]> {
    throw new EmbedderUnavailable(this.id, 'connessione rifiutata');
  }
}

const HOST = 'host';

function harness(replies: string[]) {
  const store = new MemoryStore(new DatabaseCtor(':memory:'));
  const home = mkdtempSync(join(tmpdir(), 'muffin-ingest-'));
  return {
    store,
    deps: {
      store,
      provider: new Scripted(replies),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      now: () => new Date('2026-08-04T12:00:00Z'),
    },
  };
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

const facts = (...items: Record<string, unknown>[]) => JSON.stringify({ facts: items });
const fact = (subject: string, predicate: string, object: string, extra: Record<string, unknown> = {}) => ({
  subject,
  predicate,
  object,
  subjectKind: 'person',
  validFrom: null,
  confidence: 0.9,
  // The unremarkable default, so a test that says nothing about importance gets
  // the routine level rather than accidentally asserting a charged one.
  matters: false,
  charged: false,
  ...extra,
});

describe('memory ingestion', () => {
  it('carries the two forced-choice answers all the way into the row', async () => {
    // The wiring test: importance is decided at extraction and has to survive
    // the whole pipeline. Both answers yes → charged; matters alone → notable;
    // neither → routine. Asserted in the stored row, not in the report, because
    // the row is what recall will read months from now.
    const { store, deps } = harness([
      facts(
        fact('Giusto', 'diagnosis', 'infarto a marzo', { matters: true, charged: true }),
        fact('Giusto', 'accountant', 'Marco', { matters: true, charged: false }),
        fact('Giusto', 'ate', 'una piadina', { matters: false, charged: false }),
      ),
    ]);
    episode(store, 'a marzo ho avuto un infarto; il commercialista è Marco; oggi ho mangiato una piadina');
    await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'Giusto')!;
    const by = (p: string) => store.activeFacts(HOST, me, p)[0]!;
    expect(by('diagnosis').importance).toBe(2);
    expect(by('accountant').importance).toBe(1);
    expect(by('ate').importance).toBe(0);
    // Intensity is not evidence: the charged fact is no more trusted, and no
    // more confident, than the routine one it sits beside.
    expect(by('diagnosis').trustTier).toBe(by('ate').trustTier);
    expect(by('diagnosis').confidence).toBe(by('ate').confidence);
    // Nothing this pipeline produces is an inference.
    expect(by('diagnosis').origin).toBe('said');
  });

  it('judges against the most recent belief, not the most important one', async () => {
    // The contradiction candidate must be what this fact might be replacing —
    // the latest. It used to be `existing[0]`, which was safe only while
    // activeFacts happened to order by recency; the moment importance entered
    // that ORDER BY, the judge started comparing against the most *charged*
    // belief instead. A revert to `existing[0]` is invisible without this.
    const { store, deps } = harness([
      facts(fact('Giusto', 'accountant', 'Lucia')),
      JSON.stringify({ reasoning: 'cambio dichiarato', verdict: 'supersede', confidence: 0.95 }),
    ]);
    const me = store.upsertEntity(HOST, 'Giusto', 'person', '2026-05-01T10:00:00Z');
    const ep = episode(store, 'vecchia nota');
    const base = { tenantId: HOST, subjectId: me, predicate: 'accountant', episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1 };
    // The charged one is OLDER; the plain one is the current belief.
    store.addFact({ ...base, objectValue: 'Marco', importance: 2, recordedAt: '2026-05-01T10:00:00Z' });
    const current = store.addFact({ ...base, objectValue: 'Anna', recordedAt: '2026-07-01T10:00:00Z' });

    episode(store, 'ho cambiato commercialista: ora è Lucia');
    await ingestPending(deps, HOST);

    // Anna was the latest, so Anna is what got superseded.
    const anna = store.factById(HOST, current)!;
    expect(anna.expiredAt).not.toBeNull();
  });

  it('extracts facts and marks the episode done', async () => {
    const { store, deps } = harness([facts(fact('Giusto', 'lives_in', 'Cagliari'))]);
    episode(store, 'abito a Cagliari');
    const report = await ingestPending(deps, HOST);

    expect(report).toMatchObject({ episodes: 1, factsAdded: 1, superseded: 0 });
    const me = store.findEntity(HOST, 'Giusto')!;
    expect(store.activeFacts(HOST, me, 'lives_in')[0]?.objectValue).toBe('Cagliari');
    expect(store.pendingEpisodes(HOST, 1)).toHaveLength(0);
  });

  it('leaves a failed extraction pending instead of losing the evidence', async () => {
    const { store, deps } = harness(['non è affatto JSON']);
    episode(store, 'qualcosa di importante');
    const report = await ingestPending(deps, HOST);

    expect(report.factsAdded).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(store.pendingEpisodes(HOST, 1)).toHaveLength(1); // will be retried
  });

  it('inherits the tier of the evidence and never raises it', async () => {
    const { store, deps } = harness([facts(fact('Tizio', 'claims', 'il bonifico va a IBAN XX'))]);
    episode(store, 'Tizio dice che il bonifico va a IBAN XX', 2);
    await ingestPending(deps, HOST);

    const tizio = store.findEntity(HOST, 'Tizio')!;
    expect(store.activeFacts(HOST, tizio)[0]?.trustTier).toBe(2);
  });

  it('fills the vector index, including the agent output it refuses to mine', async () => {
    // Nothing else feeds the index. Before this was wired, `VectorIndex.index`
    // was called only from tests: the semantic half of recall was dead in the
    // live path and no test noticed, because every test built its own index.
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorIndex(db, new CountingEmbedder());
    const home = mkdtempSync(join(tmpdir(), 'muffin-ingest-vec-'));
    const deps = {
      store,
      provider: new Scripted([facts(fact('Giusto', 'accountant', 'Marco'))]),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      vectors,
      now: () => new Date('2026-08-04T12:00:00Z'),
    };

    episode(store, 'Marco è il mio commercialista');
    store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'agent',
      kind: 'message', content: 'segnato, Marco', trustTier: 0, createdAt: '2026-08-04T11:01:00Z',
    });

    const report = await ingestPending(deps, HOST);
    expect(report.skippedAgentOutput).toBe(1);
    // Two episodes and one fact: the agent's line is searchable, just not mined.
    expect(report.indexed).toBe(3);
    expect(vectors.indexedCount()).toBe(3);
    // And it is idempotent: a second run has nothing left to do.
    expect(vectors.indexBacklog(HOST)).toHaveLength(0);
  });

  it('keeps the extraction when the embedder is down, and says the recall degraded', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorIndex(db, new BrokenEmbedder());
    const home = mkdtempSync(join(tmpdir(), 'muffin-ingest-broken-'));
    episode(store, 'Marco è il mio commercialista');

    const report = await ingestPending(
      {
        store,
        provider: new Scripted([facts(fact('Giusto', 'accountant', 'Marco'))]),
        model: 'test-light',
        tracer: new SimpleTracer(new JsonlExporter(home)),
        vectors,
        now: () => new Date('2026-08-04T12:00:00Z'),
      },
      HOST,
    );

    expect(report.factsAdded).toBe(1);
    expect(report.indexed).toBe(0);
    expect(report.errors.join(' ')).toContain('recall resta testuale');
    // The work is not lost: the backlog is still there for the next run.
    expect(vectors.indexBacklog(HOST).length).toBeGreaterThan(0);
  });

  it('shows the judge the sentences, not just the two values', async () => {
    // Without them the judge is comparing "Marco" with "Lucia" and nothing
    // else. Measured on the real light model: 0/4 useful verdicts before,
    // 4/4 after — "ho cambiato commercialista" is the whole signal.
    const seen: string[] = [];
    class Capturing extends Scripted {
      override async chat(request?: ChatCall): Promise<ChatResult> {
        for (const m of request?.messages ?? []) {
          for (const c of m.content) if (c.type === 'text') seen.push(c.text);
        }
        return super.chat(request);
      }
    }
    const store = new MemoryStore(new DatabaseCtor(':memory:'));
    const home = mkdtempSync(join(tmpdir(), 'muffin-ingest-ev-'));
    const deps = {
      store,
      provider: new Capturing([
        facts(fact('owner', 'accountant', 'Marco')),
        facts(fact('owner', 'accountant', 'Lucia')),
        JSON.stringify({ reasoning: 'cambio dichiarato', verdict: 'supersede', confidence: 0.95 }),
      ]),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      now: () => new Date('2026-08-04T12:00:00Z'),
    };
    episode(store, 'Marco è il mio commercialista');
    episode(store, 'ho cambiato commercialista: ora è Lucia');
    await ingestPending(deps, HOST);

    const judgePrompt = seen.find((t) => t.startsWith('Soggetto:'));
    expect(judgePrompt).toBeDefined();
    expect(judgePrompt).toContain('ho cambiato commercialista');
    expect(judgePrompt).toContain('Marco è il mio commercialista');
    // Delimited as observed data, the same way the extractor does it.
    expect(judgePrompt).toContain('<<<FRASE');
  });

  it('reports a judge that could not answer instead of passing it off as coexist', async () => {
    const { store, deps } = harness([
      facts(fact('owner', 'accountant', 'Marco')),
      facts(fact('owner', 'accountant', 'Lucia')),
      'non è JSON e non lo sarà mai',
    ]);
    episode(store, 'Marco è il mio commercialista');
    episode(store, 'ora è Lucia');
    const report = await ingestPending(deps, HOST);

    expect(report.superseded).toBe(0);
    expect(report.errors.join(' ')).toContain('giudice non disponibile');
  });

  it('keeps both values when the judge says two things can be true at once', async () => {
    const { store, deps } = harness([
      facts(fact('Giusto', 'interest', 'fotografia')),
      facts(fact('Giusto', 'interest', 'vela')),
      JSON.stringify({
        reasoning: 'due interessi non si escludono',
        verdict: 'coexist',
        confidence: 0.95,
      }),
    ]);
    episode(store, 'mi piace la fotografia');
    episode(store, 'mi piace anche la vela');
    const report = await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'Giusto')!;
    // The old system's regression: the second interest must not retire the first.
    expect(report.superseded).toBe(0);
    expect(store.activeFacts(HOST, me, 'interest').map((f) => f.objectValue).sort()).toEqual([
      'fotografia',
      'vela',
    ]);
  });

  it('retires a set-valued predicate too, when the judge is sure it was a change', async () => {
    // `accountant` is on nobody's list of functional predicates, and it is
    // exactly the kind of thing a person changes. Gating supersede on a
    // hardcoded list meant Marco and Lucia both stayed current forever.
    const { store, deps } = harness([
      facts(fact('Giusto', 'accountant', 'Marco')),
      facts(fact('Giusto', 'accountant', 'Lucia')),
      JSON.stringify({
        reasoning: '"ho cambiato commercialista" dice che il precedente non lo è più',
        verdict: 'supersede',
        confidence: 0.92,
      }),
    ]);
    episode(store, 'Marco è il mio commercialista');
    episode(store, 'ho cambiato commercialista, ora è Lucia');
    const report = await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'Giusto')!;
    expect(store.isFunctional('accountant')).toBe(false);
    expect(report.superseded).toBe(1);
    expect(store.activeFacts(HOST, me, 'accountant').map((f) => f.objectValue)).toEqual(['Lucia']);
    // And May stays answerable: the retired belief is on record with its successor.
    const history = store.factHistory(HOST, me, 'accountant');
    expect(history).toHaveLength(2);
    expect(history[0]?.supersededBy).toBe(history[1]?.id);
  });

  it('retires a functional predicate when the judge is confident', async () => {
    const { store, deps } = harness([
      facts(fact('Giusto', 'date_of_birth', '1997-04-02')),
      facts(fact('Giusto', 'date_of_birth', '1997-04-03')),
      JSON.stringify({
        reasoning: 'una persona ha una sola data di nascita: la seconda corregge la prima',
        verdict: 'supersede',
        confidence: 0.95,
      }),
    ]);
    episode(store, 'sono nato il 2 aprile 1997');
    episode(store, 'correzione: sono nato il 3 aprile');
    const report = await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'Giusto')!;
    expect(report.superseded).toBe(1);
    expect(store.activeFacts(HOST, me, 'date_of_birth').map((f) => f.objectValue)).toEqual(['1997-04-03']);
    // The retired belief is still on record, not deleted.
    expect(store.factHistory(HOST, me, 'date_of_birth')).toHaveLength(2);
  });

  it('refuses to retire anything when the judge is unsure, and says so', async () => {
    const { store, deps } = harness([
      facts(fact('Giusto', 'date_of_birth', '1997-04-02')),
      facts(fact('Giusto', 'date_of_birth', '1998-04-02')),
      JSON.stringify({
        reasoning: 'potrebbe essere un refuso ma non ne sono certo',
        verdict: 'supersede',
        confidence: SUPERSEDE_THRESHOLD - 0.1,
      }),
    ]);
    episode(store, 'sono del 1997');
    episode(store, 'forse sono del 1998');
    const report = await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'Giusto')!;
    // Below the threshold the verdict is downgraded: both survive and the owner
    // is told. A wrongly retired belief is invisible; two coexisting ones are not.
    expect(report.superseded).toBe(0);
    expect(report.needsReview).toHaveLength(1);
    expect(store.activeFacts(HOST, me, 'date_of_birth')).toHaveLength(2);
  });

  it('keeps both when the judge itself is broken', async () => {
    const { store, deps } = harness([
      facts(fact('Giusto', 'date_of_birth', '1997-04-02')),
      facts(fact('Giusto', 'date_of_birth', '1998-04-02')),
      'il giudice risponde una cosa senza senso',
    ]);
    episode(store, 'a');
    episode(store, 'b');
    const report = await ingestPending(deps, HOST);

    expect(report.superseded).toBe(0);
    const me = store.findEntity(HOST, 'Giusto')!;
    expect(store.activeFacts(HOST, me, 'date_of_birth')).toHaveLength(2);
  });

  it('does not re-add something already known', async () => {
    const { store, deps } = harness([
      facts(fact('Giusto', 'lives_in', 'Cagliari')),
      facts(fact('Giusto', 'lives_in', 'Cagliari')),
    ]);
    episode(store, 'abito a Cagliari');
    episode(store, 'vivo a Cagliari');
    const report = await ingestPending(deps, HOST);
    expect(report.factsAdded).toBe(1);
  });

  it('marks an empty-content episode instead of leaving it pending forever', async () => {
    // Defect #1: `pendingEpisodes` filters `content IS NOT NULL`, which an
    // empty STRING satisfies. The old code did a bare `continue` on it, never
    // marking it — so it came back on every future run, forever.
    const { store, deps } = harness([]);
    const empty = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: '', trustTier: 0, createdAt: '2026-08-04T11:00:00Z',
    });
    const report = await ingestPending(deps, HOST);

    expect(report.skippedEmpty).toBe(1);
    expect(report.episodes).toBe(0);
    expect(store.pendingEpisodes(HOST, 1).map((e) => e.id)).not.toContain(empty);
    expect(store.pendingEpisodes(HOST, 1)).toHaveLength(0);
  });

  it('makes progress past a page of empty-content episodes instead of looping on them forever', async () => {
    // Defect #1, through a batch: if `limit` empty rows sit at the head of
    // `ORDER BY created_at`, a scheduler calling this on every tick with the
    // same small limit must not re-fetch the same stuck page every time —
    // that is the "infinite no-op loop that looks healthy" the roadmap names.
    const { store, deps } = harness([facts(fact('Giusto', 'lives_in', 'Cagliari'))]);
    const mk = (content: string, createdAt: string) =>
      store.addEpisode({
        tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
        content, trustTier: 0, createdAt,
      });
    mk('', '2026-08-04T11:00:00Z');
    mk('', '2026-08-04T11:01:00Z');
    const real = mk('abito a Cagliari', '2026-08-04T11:02:00Z');

    // Tick one: batch of 2, both empty. No episode "mined", but not stuck.
    const first = await ingestPending(deps, HOST, 2);
    expect(first.skippedEmpty).toBe(2);
    expect(first.episodes).toBe(0);
    expect(store.pendingEpisodes(HOST, 1).map((e) => e.id)).toEqual([real]);

    // Tick two: same limit, and the batch has moved past the empty page.
    const second = await ingestPending(deps, HOST, 2);
    expect(second.episodes).toBe(1);
    expect(second.factsAdded).toBe(1);
    expect(store.pendingEpisodes(HOST, 1)).toHaveLength(0);
  });

  it('marks each episode as it finishes, so a crash mid-batch only replays what was in flight', async () => {
    // Defect #2: the old code accumulated ids in `processed`/
    // `processedNonExtractable` and called `markExtracted` ONCE after the
    // whole loop. A crash partway through the loop meant the call never
    // happened at all — so even an episode that fully succeeded, fact
    // already written, came back as pending after the crash. A thrown error
    // partway through stands in for the crash: whatever was durably written
    // to sqlite before the throw stays written regardless of what the JS
    // process does next.
    class ThrowsOnSecondCall implements Provider {
      readonly kind = 'openai-compat' as const;
      private i = 0;
      constructor(private readonly replies: string[]) {}
      async chat(): Promise<ChatResult> {
        this.i += 1;
        if (this.i === 2) throw new Error('provider caduto a metà batch');
        return {
          text: this.replies[this.i - 1] ?? '{"facts":[]}',
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'test',
        };
      }
    }
    const store = new MemoryStore(new DatabaseCtor(':memory:'));
    const home = mkdtempSync(join(tmpdir(), 'muffin-ingest-crash-'));
    const deps = {
      store,
      provider: new ThrowsOnSecondCall([facts(fact('Giusto', 'lives_in', 'Cagliari'))]),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      now: () => new Date('2026-08-04T12:00:00Z'),
    };
    const e1 = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: 'abito a Cagliari', trustTier: 0, createdAt: '2026-08-04T11:00:00Z',
    });
    const e2 = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: 'sto lavorando al progetto', trustTier: 0, createdAt: '2026-08-04T11:01:00Z',
    });

    await expect(ingestPending(deps, HOST)).rejects.toThrow('provider caduto a metà batch');

    // e1 finished (its fact is written) before the crash on e2's extraction —
    // it must already be marked, not waiting on a batch-end marker that never
    // ran because the batch never finished.
    expect(store.pendingEpisodes(HOST, 1).map((e) => e.id)).toEqual([e2]);
    const me = store.findEntity(HOST, 'Giusto');
    expect(me).not.toBeNull();
    expect(store.activeFacts(HOST, me!, 'lives_in')[0]?.objectValue).toBe('Cagliari');
  });

  it('lets a correction that repeats an older active value still reach the judge', async () => {
    // The duplicate-check fix named in the task's "constraints" section: a new
    // value that exactly matches an OLDER active fact — not the current one —
    // used to return 'skipped' on the spot, before the judge ever ran. Two
    // active facts for one (subject, predicate) is exactly what an earlier
    // judge `coexist` mistake (or the crash window fixed above) can produce.
    const { store, deps } = harness([
      facts(fact('Giusto', 'accountant', 'Marco')),
      JSON.stringify({
        reasoning: 'Marco torna commercialista, Lucia non lo è più',
        verdict: 'supersede',
        confidence: 0.9,
      }),
    ]);
    const me = store.upsertEntity(HOST, 'Giusto', 'person', '2026-01-01T10:00:00Z');
    const ep0 = episode(store, 'nota storica');
    store.markExtracted(HOST, [ep0], 1); // already-processed backstory, not part of this run
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'accountant', episodeId: ep0,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1,
    };
    // Marco is the OLDER active fact; Lucia is the CURRENT belief.
    store.addFact({ ...base, objectValue: 'Marco', recordedAt: '2026-01-01T10:00:00Z' });
    store.addFact({ ...base, objectValue: 'Lucia', recordedAt: '2026-03-01T10:00:00Z' });

    episode(store, 'sono tornato da Marco per la contabilità');
    const report = await ingestPending(deps, HOST);

    expect(report.superseded).toBe(1);
    const active = store.activeFacts(HOST, me, 'accountant');
    expect(active.find((f) => f.objectValue === 'Lucia')).toBeUndefined();
  });

  it('does not let a re-guessed entity kind duplicate a fact with no judge call', async () => {
    // Defect #4: `upsertEntity` used to fork on `kind`, a per-mention guess
    // from the extractor. Two forks means two subjectIds, and fact dedup is
    // scoped to one subjectId — so the second mention duplicated the fact
    // with the judge never even consulted (existing was empty for the fork).
    const { store, deps } = harness([
      facts(fact('Giusto', 'accountant', 'Marco', { subjectKind: 'person' })),
      facts(fact('Giusto', 'accountant', 'Marco', { subjectKind: 'thing' })),
    ]);
    const mk = (content: string, createdAt: string) =>
      store.addEpisode({
        tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
        content, trustTier: 0, createdAt,
      });
    mk('Marco è il mio commercialista', '2026-08-04T11:00:00Z');
    mk('ancora Marco, il commercialista', '2026-08-04T11:01:00Z');

    const report = await ingestPending(deps, HOST);

    expect(store.entitiesByName(HOST, 'Giusto')).toHaveLength(1);
    expect(report.factsAdded).toBe(1);
  });

  it('persists the judge review verdict durably, not just in the returned report', async () => {
    // Defect #5: `report.needsReview` used to go only to `cli/memory.ts`'s
    // stderr. Once a scheduler is the caller, nothing reads it.
    const { store, deps } = harness([
      facts(fact('Giusto', 'date_of_birth', '1997-04-02')),
      facts(fact('Giusto', 'date_of_birth', '1998-04-02')),
      JSON.stringify({
        reasoning: 'potrebbe essere un refuso ma non ne sono certo',
        verdict: 'supersede',
        confidence: SUPERSEDE_THRESHOLD - 0.1,
      }),
    ]);
    episode(store, 'sono del 1997');
    episode(store, 'forse sono del 1998');
    const report = await ingestPending(deps, HOST);

    expect(report.needsReview).toHaveLength(1);
    const persisted = store.pendingReview(HOST);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.kind).toBe('contradiction');
    expect(persisted[0]?.subject).toBe('Giusto');
    expect(persisted[0]?.predicate).toBe('date_of_birth');
    expect(persisted[0]?.detail).toContain('refuso');
  });

  it('persists a failed extraction as a review item too', async () => {
    const { store, deps } = harness(['non è affatto JSON']);
    episode(store, 'qualcosa di importante');
    const report = await ingestPending(deps, HOST);

    expect(report.errors).toHaveLength(1);
    const persisted = store.pendingReview(HOST);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.kind).toBe('error');
  });
});

describe('the ingest lock', () => {
  it('refuses to run while another extraction already holds the lane', async () => {
    // Defect #3: two whole-batch invocations of `ingestPending` — a
    // hand-typed `muffin memory extract` and a scheduler tick — used to both
    // read the same pending set and both extract it.
    const { store, deps } = harness([facts(fact('Giusto', 'lives_in', 'Cagliari'))]);
    episode(store, 'abito a Cagliari');

    const held = store.acquireIngestLock(new Date('2026-08-04T12:00:00Z'));
    expect('release' in held).toBe(true); // sanity: we really hold it

    const report = await ingestPending(deps, HOST);

    expect(report.episodes).toBe(0);
    expect(report.factsAdded).toBe(0);
    expect(report.errors.join(' ')).toContain("un'altra estrazione è già in corso");
    expect(store.pendingEpisodes(HOST, 1)).toHaveLength(1);

    store.releaseIngestLock();
    const second = await ingestPending(deps, HOST);
    expect(second.factsAdded).toBe(1);
  });
});

describe('what the agent said is evidence, not proof', () => {
  it('stores its own replies but never mines facts from them', async () => {
    // 68% of the corpus being migrated is Muffin talking. Mining it means the
    // system turns its own inferences into facts about the owner, then recalls
    // them as things it knows.
    const { store, deps } = harness([facts(fact('Giusto', 'mood', 'sotto pressione per il lancio'))]);
    store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'agent',
      kind: 'message', content: 'mi sembri sotto pressione per il lancio',
      trustTier: 0, createdAt: '2026-08-04T11:00:00Z',
    });

    const report = await ingestPending(deps, HOST);

    expect(report.skippedAgentOutput).toBe(1);
    expect(report.factsAdded).toBe(0);
    expect(store.findEntity(HOST, 'Giusto')).toBeNull();
    // Still searchable: "cosa mi avevi detto" has to keep working.
    expect(store.searchEpisodes(HOST, 'pressione').length).toBe(1);
    // And it does not come back as pending on every future run.
    expect(store.pendingEpisodes(HOST, 1)).toHaveLength(0);
  });

  it('still mines what the owner said in the same batch', async () => {
    const { store, deps } = harness([facts(fact('Giusto', 'works_on', 'il lancio di maggio'))]);
    store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'agent',
      kind: 'message', content: 'come va il lancio?', trustTier: 0, createdAt: '2026-08-04T11:00:00Z',
    });
    episode(store, 'sto lavorando al lancio di maggio');

    const report = await ingestPending(deps, HOST);
    expect(report.skippedAgentOutput).toBe(1);
    expect(report.factsAdded).toBe(1);
  });
});
