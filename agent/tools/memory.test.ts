import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { RecallDeps } from '../../core/memory/recall.js';
import { MemoryStore } from '../../core/memory/store.js';
import { memorySearchSpec, memoryWhySpec, searchMemory, whyMemory } from './memory.js';

/**
 * D3: the schema at `memorySearchSpec.inputSchema` is the only door the model
 * has into `as_of`/`history`/`surface`/`since`/`until`/`around` — nothing else
 * tells it those arguments exist. Nothing proved that door stays open. Removing
 * a key here does not fail a single functional test elsewhere: `searchMemory`
 * still reads `raw.as_of` regardless of what the schema declares, because the
 * schema is prompt-facing, not a runtime guard. Only `docs/derived/architecture-map`'s
 * anchor check noticed — a markdown file staying in sync, not a guarantee about
 * behaviour.
 */

const HOST = 'host';

describe('memorySearchSpec', () => {
  it('declares every temporal and navigation argument the model can set', () => {
    // `inputSchema` is `Record<string, unknown>` at the type level (it is
    // handed to three different provider SDKs, each with its own JSON-schema
    // shape) — the cast is on our own authored object, not on external data.
    const properties = (memorySearchSpec.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['as_of', 'history', 'surface', 'since', 'until', 'around']),
    );
  });
});

describe('searchMemory', () => {
  function seededDeps(): RecallDeps {
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const me = store.upsertEntity(HOST, 'Giusto', 'person', '2026-06-01T10:00:00Z');
    const ep = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'note sul commercialista', trustTier: 0, createdAt: '2026-06-01T10:00:00Z',
    });
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'accountant', episodeId: ep,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1,
    };
    const marco = store.addFact({ ...base, objectValue: 'Marco', recordedAt: '2026-06-01T10:00:00Z' });
    const lucia = store.addFact({ ...base, objectValue: 'Lucia', recordedAt: '2026-08-01T10:00:00Z' });
    store.supersede(HOST, marco, lucia, '2026-08-01T10:00:00Z');
    return { store };
  }

  it('threads as_of from a model-shaped JSON call through to recall, not just through the internal RecallOptions type', async () => {
    // The exact shape a model sends: a plain object decoded from a tool_use
    // block's JSON, string values only, never a TypeScript `RecallOptions`.
    // This is the boundary D3 says nothing exercised — the schema declares the
    // field, `agent/memory-loop.test.ts` proves it through the whole loop and a
    // scripted provider, but nothing proved `searchMemory` itself, called the
    // way a provider SDK actually calls a tool handler, reads this argument.
    const deps = seededDeps();
    const outcome = await searchMemory(deps, HOST, { query: 'Giusto commercialista', as_of: '2026-06-15' });
    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain('Marco');
    expect(outcome.content).toContain('sostituito da');
    // Lucia may only appear inside "↳ sostituito da: ..." — as her own bare
    // line she would be exactly the defect this slice was written to close.
    const withoutSuccessor = outcome.content.replace(/↳ sostituito da:[^\n]*/g, '');
    expect(withoutSuccessor).not.toContain('Lucia');
  });
});

/**
 * DAY-1 C5: the agent's own door to "why do you believe that". `whyMemory`
 * reads the same `describeProvenance` (`core/memory/provenance.ts`) the CLI's
 * `muffin memory why` calls — these tests are about the boundary specific to
 * the tool (a model-shaped JSON call, no fact id in hand, tenant scoping),
 * not about re-proving the renderer, which `cli/memory.test.ts` already does
 * through the CLI's own surface.
 */
describe('memoryWhySpec', () => {
  it('declares fact_id and query as the two ways to point at a belief', () => {
    const properties = (memoryWhySpec.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['fact_id', 'query']));
  });
});

describe('whyMemory', () => {
  function seededDeps(): { deps: RecallDeps; factId: number } {
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    // A capitalised subject on purpose — same reason `c-memory.accept.ts`'s C4
    // fixture uses one: a fact written straight through `addFact` is never
    // embedded, so the one-hop graph expansion (`extractCandidateNames` only
    // takes a capitalised word) is the only path that can reach it by text.
    const subjectId = store.upsertEntity(HOST, 'Ristorante preferito', 'concept', '2026-06-01T10:00:00Z');
    const episodeId = store.addEpisode({
      tenantId: HOST,
      connector: 'telegram',
      threadKey: 't',
      role: 'user',
      kind: 'message',
      content: 'il mio ristorante preferito è da Luigi',
      trustTier: 1,
      createdAt: '2026-06-01T10:00:00Z',
    });
    const factId = store.addFact({
      tenantId: HOST,
      subjectId,
      predicate: 'è',
      objectValue: 'da Luigi',
      episodeId,
      trustTier: 1,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: '2026-06-01T10:00:00Z',
    });
    return { deps: { store }, factId };
  }

  it('explains a fact by id: connector, tier and the original sentence come back', async () => {
    const { deps, factId } = seededDeps();
    const outcome = await whyMemory(deps, HOST, { fact_id: factId });
    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain('telegram');
    expect(outcome.content).toContain('tier 1');
    expect(outcome.content).toContain('il mio ristorante preferito è da Luigi');
    expect(outcome.tier).toBe(1);
  });

  it('finds the fact by text when there is no fact_id to pass — the ordinary path, since memory_search never prints one', async () => {
    const { deps } = seededDeps();
    const outcome = await whyMemory(deps, HOST, { query: 'Ristorante preferito' });
    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain('da Luigi');
    expect(outcome.content).toContain('telegram');
  });

  it('never crosses tenants: a real fact_id under a different tenant reads as not found, never fetched', async () => {
    const { deps, factId } = seededDeps();
    const outcome = await whyMemory(deps, 'some-other-tenant', { fact_id: factId });
    expect(outcome.content).toContain(`Nessun fatto #${factId}`);
    expect(outcome.content).not.toContain('da Luigi');
  });

  it('rejects a call with neither fact_id nor a usable query, instead of guessing', async () => {
    const { deps } = seededDeps();
    const empty = await whyMemory(deps, HOST, {});
    expect(empty.isError).toBe(true);
    const blank = await whyMemory(deps, HOST, { query: '   ' });
    expect(blank.isError).toBe(true);
  });

  it('rejects a non-numeric fact_id instead of coercing it', async () => {
    const { deps } = seededDeps();
    const outcome = await whyMemory(deps, HOST, { fact_id: '3' });
    expect(outcome.isError).toBe(true);
  });

  it('says plainly when nothing matches a query, rather than returning empty content', async () => {
    const { deps } = seededDeps();
    const outcome = await whyMemory(deps, HOST, { query: 'Qualcosa che non esiste' });
    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain('Nessun fatto trovato');
  });
});
