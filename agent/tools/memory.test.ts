import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { RecallDeps } from '../../core/memory/recall.js';
import { MemoryStore } from '../../core/memory/store.js';
import { memorySearchSpec, searchMemory } from './memory.js';

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
