import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { Provider } from '../../agent/providers/types.js';
import { JsonlExporter, SimpleTracer } from '../tracing/tracer.js';
import { ingestPending, retireBeliefs } from './ingest.js';
import { MemoryStore } from './store.js';

it('keeps a withdrawn source in history without sending it to extraction', async () => {
  const db = new Database(':memory:');
  const home = mkdtempSync(join(tmpdir(), 'muffin-retired-extraction-'));
  const tenant = 'host';
  const now = new Date('2026-11-24T12:00:00Z');
  const removed = 'Il nome del progetto è Faro Indaco.';
  const retained = 'Il mio commercialista è Carla.';
  try {
    const store = new MemoryStore(db);
    const add = (content: string): number =>
      store.addEpisode({
        tenantId: tenant,
        connector: 'cli',
        threadKey: 'fixture',
        role: 'user',
        kind: 'message',
        content,
        trustTier: 0,
        createdAt: now.toISOString(),
      });
    const oldEpisode = add(removed);
    const currentEpisode = add(retained);
    const retirement = retireBeliefs(store, tenant, {
      episodeIds: [oldEpisode],
      factIds: [],
      at: now,
      reason: 'fixture withdrawal',
    });
    expect(retirement.episodes).toEqual([oldEpisode]);
    const pendingBefore = store.stats(tenant).pending;
    const inputs: string[] = [];
    const provider: Provider = {
      kind: 'openai-compat',
      async chat(request) {
        const input = JSON.stringify(request.messages);
        inputs.push(input);
        const fact = input.includes(removed)
          ? { subject: 'Progetto', predicate: 'label', object: 'Faro Indaco' }
          : { subject: 'owner', predicate: 'accountant', object: 'Carla' };
        return {
          text: JSON.stringify({
            facts: [{ ...fact, subjectKind: 'person', validFrom: null, confidence: 0.95 }],
          }),
          stopReason: 'end',
          toolCalls: [],
          model: 'fixture',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };

    const result = await ingestPending(
      { store, model: 'fixture', provider, tracer: new SimpleTracer(new JsonlExporter(home)) },
      tenant,
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain(retained);
    expect(inputs[0]).not.toContain(removed);
    expect(result.fetched).toBe(pendingBefore);
    expect(result.factsAdded).toBe(1);
    expect(store.factsFromEpisode(tenant, currentEpisode).map((row) => row.objectValue)).toEqual([
      'Carla',
    ]);
    expect(store.factsFromEpisode(tenant, oldEpisode)).toEqual([]);
    expect(store.episodeById(tenant, oldEpisode)?.content).toBe(removed);
    expect(store.stats(tenant).pending).toBe(0);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
