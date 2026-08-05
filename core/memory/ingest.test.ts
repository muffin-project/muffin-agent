import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatResult, Provider } from '../../agent/providers/types.js';
import { JsonlExporter, SimpleTracer } from '../tracing/tracer.js';
import { ingestPending } from './ingest.js';
import { SUPERSEDE_THRESHOLD } from './judge.js';
import { MemoryStore } from './store.js';

/** Replays scripted model answers so the pipeline is tested, not the model. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async chat(): Promise<ChatResult> {
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
  ...extra,
});

describe('memory ingestion', () => {
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

  it('keeps both values for a set-valued predicate without calling the judge', async () => {
    const { store, deps } = harness([
      facts(fact('Giusto', 'interest', 'fotografia')),
      facts(fact('Giusto', 'interest', 'vela')),
    ]);
    episode(store, 'mi piace la fotografia');
    episode(store, 'mi piace anche la vela');
    await ingestPending(deps, HOST);

    const me = store.findEntity(HOST, 'Giusto')!;
    // The old system's regression: the second interest must not retire the first.
    expect(store.activeFacts(HOST, me, 'interest').map((f) => f.objectValue).sort()).toEqual([
      'fotografia',
      'vela',
    ]);
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
