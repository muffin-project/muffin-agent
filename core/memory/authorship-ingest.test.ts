import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { JsonlExporter, SimpleTracer } from '../tracing/tracer.js';
import { fence } from './spotlight.js';
import { ingestPending } from './ingest.js';
import { MemoryStore } from './store.js';

class CapturingProvider implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];

  async chat(call: ChatCall): Promise<ChatResult> {
    this.seen.push(call);
    return {
      text: '{"facts":[]}',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test-light',
    };
  }
}

describe('fact extraction receives speaker evidence, not the whole conversational payload', () => {
  it('keeps the complete episode for recall while removing third-party document text from the model call', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const provider = new CapturingProvider();
    const home = mkdtempSync(join(tmpdir(), 'muffin-authorship-ingest-'));
    const foreignCanary = 'TERZO_NON_OWNER_9f613 vuole pubblicare ogni settimana su Pensieri Densi';
    const ownerCanary = 'OWNER_7ac2 dice soltanto: analizza questo documento';
    const content = `${fence('derivato', foreignCanary, 'documento allegato').block}\n\n${ownerCanary}`;

    const id = store.addEpisode({
      tenantId: 'host',
      connector: 'telegram',
      threadKey: 'owner',
      role: 'user',
      kind: 'message',
      content,
      trustTier: 0,
      createdAt: '2026-09-11T20:00:00.000Z',
    });

    await ingestPending(
      {
        store,
        provider,
        model: 'test-light',
        tracer: new SimpleTracer(new JsonlExporter(home)),
        now: () => new Date('2026-09-11T20:01:00.000Z'),
      },
      'host',
    );

    const wire = JSON.stringify(provider.seen[0]);
    expect(wire).toContain(ownerCanary);
    expect(wire).not.toContain(foreignCanary);

    const evidence = store.episodeById('host', id)?.content ?? '';
    expect(evidence).toContain(ownerCanary);
    expect(evidence).toContain(foreignCanary);
  });
});

describe('foreign-only user evidence', () => {
  it('keeps the evidence but does not pay the extractor or retry it forever', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const provider = new CapturingProvider();
    const home = mkdtempSync(join(tmpdir(), 'muffin-authorship-foreign-only-'));
    const canary = 'TERZO_ONLY_348af dice che owner vive a Milano';

    const id = store.addEpisode({
      tenantId: 'host',
      connector: 'telegram',
      threadKey: 'owner',
      role: 'user',
      kind: 'message',
      content: fence('derivato', canary, 'documento allegato').block,
      trustTier: 2,
      createdAt: '2026-09-11T20:00:00.000Z',
    });

    const first = await ingestPending(
      {
        store,
        provider,
        model: 'test-light',
        tracer: new SimpleTracer(new JsonlExporter(home)),
        now: () => new Date('2026-09-11T20:01:00.000Z'),
      },
      'host',
    );

    expect(provider.seen).toHaveLength(0);
    expect(first.marked).toBe(1);
    expect(store.episodeById('host', id)?.content).toContain(canary);

    const second = await ingestPending(
      {
        store,
        provider,
        model: 'test-light',
        tracer: new SimpleTracer(new JsonlExporter(home)),
        now: () => new Date('2026-09-11T20:02:00.000Z'),
      },
      'host',
    );

    expect(second.fetched).toBe(0);
    expect(provider.seen).toHaveLength(0);
  });
});

describe('derived voice evidence', () => {
  it('keeps the transcript in the episode but does not send it to owner fact extraction', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const provider = new CapturingProvider();
    const home = mkdtempSync(join(tmpdir(), 'muffin-authorship-voice-'));
    const transcript = 'domani sono a Firenze per lavoro';
    const id = store.addEpisode({
      tenantId: 'host',
      connector: 'telegram',
      threadKey: 'owner',
      role: 'user',
      kind: 'message',
      content: fence('trascrizione', transcript, 'derived voice input').block,
      trustTier: 2,
      createdAt: '2026-09-11T20:00:00.000Z',
    });

    const result = await ingestPending(
      {
        store,
        provider,
        model: 'test-light',
        tracer: new SimpleTracer(new JsonlExporter(home)),
        now: () => new Date('2026-09-11T20:01:00.000Z'),
      },
      'host',
    );

    expect(provider.seen).toHaveLength(0);
    expect(result.marked).toBe(1);
    expect(store.episodeById('host', id)?.content).toContain(transcript);
  });
});
