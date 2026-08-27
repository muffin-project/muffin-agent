import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { JsonlExporter, SimpleTracer } from '../tracing/tracer.js';
import { EmbedderUnavailable, type Embedder } from './embed.js';
import { formatConsolidationLines, IngestFailed, ingestPending, type IngestReport } from './ingest.js';
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
    // And it counts as **no progress**, which is what stops the drain from
    // buying this page again every twenty seconds for ever. `episodes` reads 1
    // here — the extractor did attempt it — so a drain keyed on that number
    // would loop; `marked` is the marker itself and reads 0.
    expect(report.episodes).toBe(1);
    expect(report.marked).toBe(0);
  });

  /**
   * The two numbers the backlog drain is decided on, asserted against a page
   * that mixes every reason an episode can leave the queue.
   *
   * `fetched` is what `pendingEpisodes` returned, so `fetched < limit` means
   * nothing is behind this page. `marked` is how many markers advanced, so
   * `marked > 0` means the head moved. Counted here rather than re-derived by
   * the caller from the skip counters, which is what `cli/memory.ts` used to do
   * and what could not see a permanently failing head at all.
   */
  it('reports the page it read and the markers it advanced', async () => {
    const { store, deps } = harness([facts(fact('Giusto', 'lives_in', 'Cagliari')), 'non è JSON']);
    const mk = (content: string, role: 'user' | 'agent', createdAt: string) =>
      store.addEpisode({
        tenantId: HOST, connector: 'cli', threadKey: 't', role, kind: 'message',
        content, trustTier: 0, createdAt,
      });
    mk('abito a Cagliari', 'user', '2026-08-04T11:00:00Z');
    mk('capito', 'agent', '2026-08-04T11:01:00Z');
    mk('', 'user', '2026-08-04T11:02:00Z');
    mk('e poi qualcosa che non si estrae', 'user', '2026-08-04T11:03:00Z');

    const report = await ingestPending(deps, HOST, 4);

    expect(report.fetched).toBe(4);
    // Mined + agent output + empty. The fourth failed extraction is not marked.
    expect(report.marked).toBe(3);
    expect(store.pendingEpisodes(HOST, 1)).toHaveLength(1);
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
    // Kept apart from `errors` — see `IngestReport.judgeUnavailable` — so a
    // reader can fold it by (subject, predicate) instead of printing one
    // line per candidate.
    expect(report.judgeUnavailable).toEqual([{ subject: 'owner', predicate: 'accountant', reason: 'non-json' }]);
    expect(report.errors.join(' ')).not.toContain('giudice non disponibile');
  });

  describe('why the judge could not answer, and what it said', () => {
    // 2026-08-16, real install: the REPL printed "giudice non disponibile su
    // owner/interest: tengo entrambi i valori" three times running, and
    // `muffin memory review` showed nothing to tell the three apart — no
    // reason, no trace of what the model actually sent back. These three
    // cases are the ones `judge.ts` can now name, and each has to leave the
    // model's own words on the durable row, not just the fact that it failed.
    const scenarios: { name: string; reply: string; reason: string; rawResponse: string }[] = [
      { name: 'an empty response', reply: '', reason: 'vuota', rawResponse: '' },
      {
        name: 'prose with no JSON at all',
        reply: 'mi dispiace, non riesco a decidere su questo caso',
        reason: 'non-json',
        rawResponse: 'mi dispiace, non riesco a decidere su questo caso',
      },
      {
        name: 'JSON with an unrecognised verdict',
        reply: JSON.stringify({ reasoning: 'boh', verdict: 'chissà', confidence: 0.9 }),
        reason: 'schema: verdict',
        rawResponse: JSON.stringify({ reasoning: 'boh', verdict: 'chissà', confidence: 0.9 }),
      },
    ];

    it.each(scenarios)('$name → typed reason and the raw response, both on the durable row', async ({ reply, reason, rawResponse }) => {
      const { store, deps } = harness([
        facts(fact('owner', 'interest', 'vela')),
        facts(fact('owner', 'interest', 'windsurf')),
        reply,
      ]);
      episode(store, 'mi piace la vela');
      episode(store, 'mi piace anche il windsurf');
      const report = await ingestPending(deps, HOST);

      expect(report.judgeUnavailable).toHaveLength(1);
      // `reason` is a prefix match for the schema case: the full label also
      // carries zod's own message, which this test does not pin to wording.
      expect(report.judgeUnavailable[0]?.reason.startsWith(reason)).toBe(true);

      const persisted = store.pendingReview(HOST);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.kind).toBe('error');
      expect(persisted[0]?.subject).toBe('owner');
      expect(persisted[0]?.predicate).toBe('interest');
      // Mutation this kills: removing the raw-response line from `detail`.
      // Without it the row says only "tengo entrambi i valori" — the exact
      // sentence the owner could not get an explanation from on 2026-08-16.
      expect(persisted[0]?.detail).toContain(rawResponse === '' ? '(vuota)' : rawResponse);
      expect(persisted[0]?.detail).toContain(`[${reason}`);
    });
  });

  describe('the judge tolerates innocuous formatting instead of failing on it', () => {
    // Measured against real light-model output shapes, not hypothetical ones:
    // a quoted confidence, a Title-Cased key, a verdict with stray whitespace
    // or the wrong case. None of these says less than a correctly-formatted
    // answer — throwing them away read as "giudice non disponibile" for a
    // judge that had, in fact, answered.
    it('accepts confidence sent as a numeric string', async () => {
      const { store, deps } = harness([
        facts(fact('Giusto', 'accountant', 'Marco')),
        facts(fact('Giusto', 'accountant', 'Lucia')),
        JSON.stringify({ reasoning: 'cambio dichiarato', verdict: 'supersede', confidence: '0.95' }),
      ]);
      episode(store, 'Marco è il mio commercialista');
      episode(store, 'ho cambiato commercialista, ora è Lucia');
      const report = await ingestPending(deps, HOST);

      expect(report.judgeUnavailable).toEqual([]);
      expect(report.superseded).toBe(1);
    });

    it('accepts Title-Cased keys, including the verdict itself', async () => {
      const { store, deps } = harness([
        facts(fact('Giusto', 'interest', 'fotografia')),
        facts(fact('Giusto', 'interest', 'vela')),
        JSON.stringify({ Reasoning: 'due interessi non si escludono', Verdict: 'COEXIST', Confidence: 0.9 }),
      ]);
      episode(store, 'mi piace la fotografia');
      episode(store, 'mi piace anche la vela');
      const report = await ingestPending(deps, HOST);

      expect(report.judgeUnavailable).toEqual([]);
      const me = store.findEntity(HOST, 'Giusto')!;
      expect(store.activeFacts(HOST, me, 'interest').map((f) => f.objectValue).sort()).toEqual([
        'fotografia',
        'vela',
      ]);
    });

    it('accepts a verdict with surrounding spaces and mixed case', async () => {
      const { store, deps } = harness([
        facts(fact('Giusto', 'accountant', 'Marco')),
        facts(fact('Giusto', 'accountant', 'Lucia')),
        JSON.stringify({ reasoning: 'cambio dichiarato', verdict: '  Supersede  ', confidence: 0.9 }),
      ]);
      episode(store, 'Marco è il mio commercialista');
      episode(store, 'ho cambiato commercialista, ora è Lucia');
      const report = await ingestPending(deps, HOST);

      expect(report.judgeUnavailable).toEqual([]);
      expect(report.superseded).toBe(1);
    });

    it('still refuses an unrecognised verdict — tolerance is not permissiveness', async () => {
      const { store, deps } = harness([
        facts(fact('owner', 'interest', 'vela')),
        facts(fact('owner', 'interest', 'windsurf')),
        JSON.stringify({ reasoning: 'boh', verdict: 'chissà cosa', confidence: 0.9 }),
      ]);
      episode(store, 'mi piace la vela');
      episode(store, 'mi piace anche il windsurf');
      const report = await ingestPending(deps, HOST);

      expect(report.judgeUnavailable).toHaveLength(1);
      expect(report.judgeUnavailable[0]?.reason.startsWith('schema: verdict')).toBe(true);
      const me = store.findEntity(HOST, 'owner')!;
      expect(store.activeFacts(HOST, me, 'interest')).toHaveLength(2);
    });
  });

  describe('the raw response reaching a terminal, safely', () => {
    it('truncates a very long raw response instead of storing it whole', async () => {
      const huge = 'x'.repeat(2000);
      const { store, deps } = harness([
        facts(fact('owner', 'interest', 'vela')),
        facts(fact('owner', 'interest', 'windsurf')),
        `prosa senza json: ${huge}`,
      ]);
      episode(store, 'mi piace la vela');
      episode(store, 'mi piace anche il windsurf');
      await ingestPending(deps, HOST);

      const detail = store.pendingReview(HOST)[0]?.detail ?? '';
      expect(detail.length).toBeLessThan(huge.length);
      expect(detail).toContain('…');
    });

    it('strips control characters instead of letting them reach a terminal', async () => {
      // A stray ANSI escape or a NUL in a model's answer would otherwise ride
      // along into `muffin memory review --verbose` output verbatim.
      const withControlChars = 'ok\x1b[31mrosso\x1b[0m\x00fine\rsovrascritto';
      const { store, deps } = harness([
        facts(fact('owner', 'interest', 'vela')),
        facts(fact('owner', 'interest', 'windsurf')),
        `prosa senza json ${withControlChars}`,
      ]);
      episode(store, 'mi piace la vela');
      episode(store, 'mi piace anche il windsurf');
      await ingestPending(deps, HOST);

      const detail = store.pendingReview(HOST)[0]?.detail ?? '';
      // eslint-disable-next-line no-control-regex -- asserting these are gone
      expect(/[\x00-\x08\x0B-\x1F\x7F]/.test(detail)).toBe(false);
      expect(detail).toContain('rosso');
      expect(detail).toContain('fine');
      expect(detail).toContain('sovrascritto');
    });
  });

  it('does not double-write a review row when a valid verdict happens to carry confidence 0', async () => {
    // The pre-existing ambiguity `verdict.failure` retires: the old condition
    // was `confidence === 0 && downgraded`, true both for an unreadable
    // answer and for a syntactically valid, self-contradictory
    // `{verdict:"supersede",confidence:0}` below the threshold — which used
    // to run this block *and* the `case 'review'` branch for the same call.
    const { store, deps } = harness([
      facts(fact('Giusto', 'date_of_birth', '1997-04-02')),
      facts(fact('Giusto', 'date_of_birth', '1998-04-02')),
      JSON.stringify({ reasoning: 'non sono sicuro di niente', verdict: 'supersede', confidence: 0 }),
    ]);
    episode(store, 'sono del 1997');
    episode(store, 'forse sono del 1998');
    const report = await ingestPending(deps, HOST);

    expect(report.judgeUnavailable).toEqual([]);
    expect(report.needsReview).toHaveLength(1);
    expect(store.pendingReview(HOST)).toHaveLength(1);
    expect(store.pendingReview(HOST)[0]?.kind).toBe('contradiction');
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

  it('reports a judge that could not be reached, instead of absorbing it as silent coexist', async () => {
    // The twin of "reports a judge that could not answer" above, but for the
    // other failure shape: `judgeContradiction` doesn't answer badly, it
    // throws — network, auth, a 5xx on the light provider. `reconcile`'s catch
    // around that call inserted the fact and returned 'added' with nothing in
    // `report.errors`, so this outcome was indistinguishable from an ordinary,
    // considered 'coexist' — which is exactly what the comment beside the
    // sibling branch (eight lines below the catch) says must not happen: "non
    // è una decisione, e lasciare che ne sembri una...".
    class ThrowsOnJudge extends Scripted {
      override async chat(request?: ChatCall): Promise<ChatResult> {
        const isJudgeCall = (request?.messages ?? []).some((m) =>
          m.content.some((c) => c.type === 'text' && c.text.startsWith('Soggetto:')),
        );
        if (isJudgeCall) throw new Error('502 Bad Gateway');
        return super.chat(request);
      }
    }
    const store = new MemoryStore(new DatabaseCtor(':memory:'));
    const home = mkdtempSync(join(tmpdir(), 'muffin-ingest-judge-throws-'));
    const deps = {
      store,
      provider: new ThrowsOnJudge([
        facts(fact('Giusto', 'date_of_birth', '1997-04-02')),
        facts(fact('Giusto', 'date_of_birth', '1998-04-02')),
      ]),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      now: () => new Date('2026-08-04T12:00:00Z'),
    };
    episode(store, 'a');
    episode(store, 'b');
    const report = await ingestPending(deps, HOST);

    // The safe behaviour is unchanged: a judge that cannot be consulted must
    // not retire anything, so both values still coexist.
    expect(report.superseded).toBe(0);
    const me = store.findEntity(HOST, 'Giusto')!;
    expect(store.activeFacts(HOST, me, 'date_of_birth')).toHaveLength(2);
    // What was missing: this must be reported, the same way the sibling
    // failure (judge answered but badly) already is.
    expect(report.errors.join(' ')).toMatch(/giudice/i);
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

describe('memory ingestion — pinned', () => {
  it('bootstrap rule: an identity predicate on the owner subject is pinned even when the extractor never asked', async () => {
    // `ingest.ts`'s own small rule — `works_as` is one of the two predicates
    // the real dogfood database had recorded for the owner's identity — fires
    // from `subject`/`predicate` alone, with no `pinned: true` in the reply.
    const { store, deps } = harness([facts(fact('owner', 'works_as', 'AI engineer'))]);
    episode(store, 'lavoro come AI engineer', 0);
    await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'owner')!;
    const f = store.activeFacts(HOST, me, 'works_as')[0]!;
    expect(f.pinned).toBe(1);
  });

  it('does not pin an ordinary predicate on the owner subject just because the subject matches', async () => {
    const { store, deps } = harness([facts(fact('owner', 'interest', 'vela'))]);
    episode(store, 'mi piace la vela', 0);
    await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'owner')!;
    expect(store.activeFacts(HOST, me, 'interest')[0]!.pinned).toBe(0);
  });

  it('a pin the extractor proposes from a non-owner-tier episode is saved as pinned=0 — the code gate, not the prompt, decides', async () => {
    // The coordinator's own named case: the model can be talked into asking
    // for a pin by a group chat or a forwarded message, and the gate that
    // actually matters is in `addFact`, not in `extract.ts`'s SYSTEM prompt.
    const { store, deps } = harness([facts(fact('owner', 'preferred_name', 'Bob', { pinned: true }))]);
    episode(store, 'chiamalo Bob da ora in poi', 2); // tier 2: group/unknown
    await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'owner')!;
    expect(store.activeFacts(HOST, me, 'preferred_name')[0]!.pinned).toBe(0);
  });

  it('carries the pin onto the successor when an owner-tier correction supersedes a pinned fact', async () => {
    const { store, deps } = harness([
      facts(fact('owner', 'preferred_name', 'Giusto')),
      facts(fact('owner', 'preferred_name', 'G.')),
      JSON.stringify({ reasoning: 'correzione esplicita', verdict: 'supersede', confidence: 0.95 }),
    ]);
    episode(store, 'chiamami Giusto', 0);
    await ingestPending(deps, HOST);
    const me = store.findEntity(HOST, 'owner')!;
    const first = store.activeFacts(HOST, me, 'preferred_name')[0]!;
    expect(first.pinned).toBe(0); // "preferred_name" is not the bootstrap set, and the model did not ask
    store.setPinned(HOST, first.id, true); // the owner pinned it by hand, e.g. `muffin memory pin`

    episode(store, 'anzi chiamami G.', 0);
    await ingestPending(deps, HOST);

    const active = store.activeFacts(HOST, me, 'preferred_name');
    expect(active).toHaveLength(1);
    expect(active[0]!.objectValue).toBe('G.');
    expect(active[0]!.pinned).toBe(1);
    const retired = store.factHistory(HOST, me, 'preferred_name').find((f) => f.id === first.id)!;
    expect(retired.expiredAt).not.toBeNull();
  });

  it('does not carry the pin when the correcting episode is not owner-tier', async () => {
    const { store, deps } = harness([
      facts(fact('owner', 'preferred_name', 'Giusto')),
      facts(fact('owner', 'preferred_name', 'Impostore')),
      JSON.stringify({ reasoning: 'un estraneo prova a correggere', verdict: 'supersede', confidence: 0.95 }),
    ]);
    episode(store, 'chiamami Giusto', 0);
    await ingestPending(deps, HOST);
    const me = store.findEntity(HOST, 'owner')!;
    const first = store.activeFacts(HOST, me, 'preferred_name')[0]!;
    store.setPinned(HOST, first.id, true);

    episode(store, 'anzi chiamalo Impostore', 2); // tier 2: not the owner
    await ingestPending(deps, HOST);

    const active = store.activeFacts(HOST, me, 'preferred_name')[0]!;
    expect(active.objectValue).toBe('Impostore'); // the pre-existing judge/trust behaviour is unchanged by this slice
    expect(active.pinned).toBe(0); // but it does not inherit the old belief's pin
  });
});

describe('formatConsolidationLines — what a human reads at the end of a round', () => {
  // Pure function, no store, no provider: this is the renderer that sat
  // behind `consolidator.ts`'s per-line loop and put "giudice non disponibile
  // su owner/interest" on an owner's screen three times running on
  // 2026-08-16, once per candidate fact in one round.
  const blank: IngestReport = {
    tenantId: 'host',
    fetched: 0,
    marked: 0,
    episodes: 0,
    factsAdded: 0,
    rejected: 0,
    superseded: 0,
    skippedAgentOutput: 0,
    skippedDocuments: 0,
    skippedEmpty: 0,
    indexed: 0,
    busy: false,
    needsReview: [],
    errors: [],
    judgeUnavailable: [],
  };

  it('folds three judge failures on the same pair into one line with a count', () => {
    const report: IngestReport = {
      ...blank,
      judgeUnavailable: [
        { subject: 'owner', predicate: 'interest', reason: 'vuota' },
        { subject: 'owner', predicate: 'interest', reason: 'non-json' },
        { subject: 'owner', predicate: 'interest', reason: 'vuota' },
      ],
    };
    const lines = formatConsolidationLines(report);
    // The mutation this kills: reverting to `report.errors` verbatim (no
    // grouping at all) would print three separate lines here, never one
    // with "×3" — this is exactly what the owner saw.
    expect(lines).toEqual(['giudice non disponibile su owner/interest ×3 — vedi muffin memory review']);
  });

  it('keeps two different pairs apart, and omits the multiplier for a singleton', () => {
    const report: IngestReport = {
      ...blank,
      judgeUnavailable: [
        { subject: 'owner', predicate: 'interest', reason: 'vuota' },
        { subject: 'owner', predicate: 'asked_to', reason: 'non-json' },
      ],
    };
    const lines = formatConsolidationLines(report);
    expect(lines).toHaveLength(2);
    expect(lines).toContain('giudice non disponibile su owner/interest — vedi muffin memory review');
    expect(lines).toContain('giudice non disponibile su owner/asked_to — vedi muffin memory review');
  });

  it('passes every other error through unchanged, after the grouped judge lines', () => {
    const report: IngestReport = {
      ...blank,
      judgeUnavailable: [{ subject: 'owner', predicate: 'interest', reason: 'vuota' }],
      errors: ['estrazione fallita su episodio 7: risposta non parsabile', 'indice vettoriale: connessione rifiutata'],
    };
    const lines = formatConsolidationLines(report);
    expect(lines).toEqual([
      'giudice non disponibile su owner/interest — vedi muffin memory review',
      'estrazione fallita su episodio 7: risposta non parsabile',
      'indice vettoriale: connessione rifiutata',
    ]);
  });

  it('says nothing extra on a clean round', () => {
    expect(formatConsolidationLines(blank)).toEqual([]);
  });
});

describe('lo span del giudice dice quanto è costato', () => {
  /**
   * Il difetto: lo span del giudice si chiama `muffin.chat_call` — lo stesso
   * nome che porta una chiamata contata del loop — ed era l'unico dei due a
   * non riportare token. Su una vista per step quello si legge come
   * **gratis**, non come **non registrato**, che è la peggiore delle due
   * letture: la spesa è sempre stata fatturata (`light-lane.ts` avvolge questo
   * provider), invisibile era solo dove fosse andata.
   */
  class Costoso extends Scripted {
    override async chat(request?: ChatCall): Promise<ChatResult> {
      const base = await super.chat(request);
      return { ...base, usage: { inputTokens: 137, outputTokens: 42, cacheReadTokens: 9, cacheWriteTokens: 0 } };
    }
  }

  /** Gli span del giudice scritti sotto questa home, in ordine. */
  function judgeSpans(home: string): { attributes: Record<string, unknown> }[] {
    const dir = join(home, 'traces');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'))
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { name: string; attributes: Record<string, unknown> })
      .filter((s) => s.name === 'muffin.chat_call' && s.attributes['gen_ai.operation.name'] === 'memory.judge');
  }

  async function judged(replies: string[]): Promise<{ attributes: Record<string, unknown> }[]> {
    const store = new MemoryStore(new DatabaseCtor(':memory:'));
    const home = mkdtempSync(join(tmpdir(), 'muffin-judge-usage-'));
    const deps = {
      store,
      provider: new Costoso(replies),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      now: () => new Date('2026-08-04T12:00:00Z'),
    };
    episode(store, 'Marco è il mio commercialista');
    episode(store, 'ho cambiato commercialista: ora è Lucia');
    await ingestPending(deps, HOST);
    return judgeSpans(home);
  }

  it('porta i token della chiamata, non un posto vuoto', async () => {
    const spans = await judged([
      facts(fact('owner', 'accountant', 'Marco')),
      facts(fact('owner', 'accountant', 'Lucia')),
      JSON.stringify({ reasoning: 'cambio dichiarato', verdict: 'supersede', confidence: 0.95 }),
    ]);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 137,
      'gen_ai.usage.output_tokens': 42,
      'muffin.usage.cache_read_tokens': 9,
      'muffin.memory.verdict': 'supersede',
    });
  });

  it('li porta anche quando la risposta era illeggibile — una chiamata non parsabile è costata lo stesso', async () => {
    const spans = await judged([
      facts(fact('owner', 'accountant', 'Marco')),
      facts(fact('owner', 'accountant', 'Lucia')),
      'questa non è affatto JSON',
    ]);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 137,
      'gen_ai.usage.output_tokens': 42,
      // Il verdetto di ripiego non cambia il fatto che la chiamata è avvenuta.
      'muffin.memory.verdict': 'coexist',
    });
  });
});


/**
 * Il passo che costa di più era il solo che non si vedeva.
 *
 * Misurato sull'installazione dell'owner il 27/08: un giro idle ha speso 129
 * secondi contro il modello su quattordici episodi e ha prodotto zero fatti —
 * e il file di tracce di quel giorno conteneva span `memory.recall` e
 * `memory.ingest` e nemmeno uno per le chiamate che avevano bruciato il tempo.
 * Il giudice aveva già ricevuto questo span in #141; l'estrazione è la metà
 * più grande ed era ancora scoperta.
 */
describe("l'estrazione ha il suo span, come il giudice", () => {
  class Contato extends Scripted {
    readonly requests: ChatCall[] = [];
    override async chat(request: ChatCall): Promise<ChatResult> {
      this.requests.push(request);
      const base = await super.chat(request);
      return { ...base, usage: { inputTokens: 611, outputTokens: 73, cacheReadTokens: 4, cacheWriteTokens: 0 } };
    }
  }

  type Span = { name: string; attributes: Record<string, unknown>; status?: string };

  async function ingest(replies: string[], contenuti: string[]): Promise<{ spans: Span[]; provider: Contato }> {
    const store = new MemoryStore(new DatabaseCtor(':memory:'));
    const home = mkdtempSync(join(tmpdir(), 'muffin-extract-span-'));
    const provider = new Contato(replies);
    for (const c of contenuti) episode(store, c);
    await ingestPending(
      {
        store,
        provider,
        model: 'test-light',
        tracer: new SimpleTracer(new JsonlExporter(home)),
        now: () => new Date('2026-08-04T12:00:00Z'),
      },
      HOST,
    );
    const spans = readdirSync(join(home, 'traces'))
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(home, 'traces', f), 'utf8').trim().split('\n'))
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Span)
      .filter((s) => s.attributes['gen_ai.operation.name'] === 'memory.extract');
    return { spans, provider };
  }

  it('porta i token di una estrazione riuscita', async () => {
    const { spans } = await ingest([facts(fact('owner', 'works_as', 'freelancer'))], ['faccio il freelance']);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 611,
      'gen_ai.usage.output_tokens': 73,
      'muffin.usage.cache_read_tokens': 4,
      'muffin.memory.facts': 1,
    });
  });

  it('lo span si chiude in errore quando il modello risponde qualcosa di inservibile', async () => {
    // `extractFacts` non lancia: torna normalmente con `error` valorizzato.
    // Senza il ramo esplicito lo span si chiudeva verde proprio sui giri che
    // non producevano niente.
    const { spans } = await ingest(['questo non è JSON'], ['qualcosa']);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).not.toBe('ok');
  });

  it('chiede al modello un tetto che lascia spazio al reasoning, su entrambe le chiamate della corsia', async () => {
    // Senza margine sono 1500 per l'estrazione e 500 per il giudice: su un
    // modello che ragiona la prima torna `stop=max_tokens` a 1502 token in
    // uscita e la risposta grezza del secondo nel registro è `[vuota]`.
    // Nessun test teneva questi due numeri, quindi potevano tornare indietro
    // restando verdi.
    const { provider } = await ingest(
      [
        facts(fact('owner', 'accountant', 'Marco')),
        facts(fact('owner', 'accountant', 'Lucia')),
        JSON.stringify({ reasoning: 'cambio', verdict: 'supersede', confidence: 0.95 }),
      ],
      ['Marco è il mio commercialista', 'ora è Lucia'],
    );
    expect(provider.requests.length).toBeGreaterThanOrEqual(3);
    for (const r of provider.requests) expect(r.maxOutputTokens).toBeGreaterThan(1500);
  });
});

/**
 * Una perdita parziale che nessuno vede è una perdita silenziosa.
 *
 * Da quando i candidati si validano uno per uno (`extract.ts`), un episodio può
 * essere marcato come fatto **avendo scartato** qualche fatto per strada. È il
 * miglioramento che si porta dietro il proprio rischio: prima l'episodio
 * tornava per sempre e almeno si vedeva; adesso passa, e se la riga non lo dice
 * la differenza fra «tre fatti» e «tre fatti su cinque» non esiste da nessuna
 * parte.
 */
describe('un episodio marcato dice anche cosa ha perso per strada', () => {
  it('registra i candidati fuori schema, col campo, e tiene gli altri', async () => {
    const { store, deps } = harness([
      JSON.stringify({
        facts: [
          fact('owner', 'works_as', 'freelancer'),
          { subject: 'x', predicate: 'y' },
          fact('owner', 'lives_in', 'Roma'),
        ],
      }),
    ]);
    episode(store, 'faccio il freelance a Roma');
    const report: IngestReport = await ingestPending(deps, HOST);

    expect(report.factsAdded).toBe(2);
    const line = report.errors.find((e) => e.includes('fuori schema'));
    expect(line).toBeDefined();
    expect(line).toContain('1 candidati fuori schema');
    // E l'episodio è marcato: due fatti sono passati, quindi non deve tornare.
    expect((await ingestPending(deps, HOST)).episodes).toBe(0);
  });
});

/**
 * Il lato produttore della stessa cucitura.
 *
 * `consolidator.test.ts` prova che una riga di giro porta il parziale — ma lo
 * fa costruendo `IngestFailed` a mano nel finto. Con solo quel test,
 * `ingestPending` può smettere di produrlo e la suite resta verde: la mutazione
 * «rilancia l'errore nudo» è sopravvissuta al primo giro, ed è esattamente il
 * difetto che questa slice ripara, girato dall'altra parte.
 */
describe('un lotto che muore a metà lancia quello che aveva già fatto', () => {
  class Esplode extends Scripted {
    constructor(
      replies: string[],
      private readonly boomAt: number,
    ) {
      super(replies);
    }
    private seen = 0;
    override async chat(request: ChatCall): Promise<ChatResult> {
      this.seen += 1;
      if (this.seen === this.boomAt) throw new Error('terminated');
      return super.chat(request);
    }
  }

  it('porta gli episodi e i fatti già passati, e conserva la causa', async () => {
    const store = new MemoryStore(new DatabaseCtor(':memory:'));
    const home = mkdtempSync(join(tmpdir(), 'muffin-ingest-boom-'));
    episode(store, 'faccio il freelance');
    episode(store, 'e vivo a Roma');
    const deps = {
      store,
      provider: new Esplode([facts(fact('owner', 'works_as', 'freelancer'))], 2),
      model: 'test-light',
      tracer: new SimpleTracer(new JsonlExporter(home)),
      now: () => new Date('2026-08-04T12:00:00Z'),
    };

    await expect(ingestPending(deps, HOST)).rejects.toThrow(IngestFailed);
    try {
      await ingestPending(deps, HOST);
    } catch (error) {
      const failed = error as IngestFailed;
      // Il primo episodio è passato davvero: il fatto è scritto e l'episodio
      // marcato, quindi il parziale non può essere una riga di zeri.
      expect(failed.partial.factsAdded).toBeGreaterThanOrEqual(1);
      expect(failed.partial.episodes).toBeGreaterThanOrEqual(1);
      // E l'errore vero resta raggiungibile, non sostituito.
      expect((failed.cause as Error).message).toBe('terminated');
    }
    rmSync(home, { recursive: true, force: true });
  });
});
