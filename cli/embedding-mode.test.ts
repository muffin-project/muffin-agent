import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildRuntime } from '../agent/runtime.js';
import { loadConfig, saveConfig, writeSecret } from '../core/config/config.js';
import { recall } from '../core/memory/recall.js';
import { EXTRACTION_VERSION } from '../core/memory/schema.js';
import { runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { cmdMemoryStats } from './memory.js';
import { cmdModel } from './model.js';

it('does not initialize a vector store in a fresh Home with embeddings paused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-embedding-mode-'));
  const home = join(root, 'home');
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  try {
    runInit({ home, apiKey: 'sk-fixture' });
    expect(await cmdModel(home, ['embed', 'off'], { out: () => {} })).toBe(0);
    const runtime = buildRuntime(home, root);
    try {
      const vectorTable = runtime.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_vec'")
        .get();
      expect(vectorTable).toBeUndefined();
    } finally {
      runtime.close();
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves existing vectors and recalls new text while embeddings are paused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-embedding-mode-'));
  const home = join(root, 'home');
  const endpoint = 'http://embedding-fixture.invalid/v1';
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    expect(url).toBe(`${endpoint}/embeddings`);
    const request = JSON.parse(init.body) as { input: string[] };
    return Response.json({ data: request.input.map(() => ({ embedding: [1, 0, 0, 0] })) });
  });
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubGlobal('fetch', fetch);

  let runtime: ReturnType<typeof buildRuntime> | undefined;
  try {
    runInit({ home, apiKey: 'sk-fixture' });
    writeSecret('embedding_fixture', 'sk-fixture', home);
    saveConfig(
      {
        ...loadConfig(home),
        embedder: {
          kind: 'openai-compat',
          baseUrl: endpoint,
          apiKeyRef: 'secret://embedding_fixture',
          model: 'embedding-fixture',
          dimensions: 4,
        },
      },
      home,
    );
    const createdAt = new Date().toISOString();
    const append = (rt: ReturnType<typeof buildRuntime>, content: string): number => {
      const { store } = rt.memory;
      const id = store.addEpisode({
        tenantId: 'host',
        connector: 'cli',
        threadKey: 'fixture',
        role: 'user',
        kind: 'message',
        content,
        trustTier: 0,
        createdAt,
      });
      store.markExtracted('host', [id], EXTRACTION_VERSION);
      return id;
    };

    runtime = buildRuntime(home, root);
    const first = append(runtime, 'The expedition log is in the blue binder.');
    expect((await runtime.consolidation.runNow()).report?.indexed).toBe(1);
    expect(runtime.memory.recall.vectors?.indexedCount('host')).toBe(1);
    const chunks = runtime.db.prepare('SELECT * FROM chunks').all();
    runtime.close();
    runtime = undefined;
    fetch.mockClear();

    const out = () => {};
    expect(await cmdModel(home, ['embed', 'off'], { out })).toBe(0);
    runtime = buildRuntime(home, root);
    expect(runtime.memory.recall.vectors).toBeUndefined();
    const note = 'The field telescope takes a replacement eyepiece.';
    const second = append(runtime, note);
    expect((await runtime.consolidation.runNow()).report?.indexed).toBe(0);
    const result = await recall(runtime.memory.recall, 'host', 'eyepiece');
    expect(result.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: second, text: note })]),
    );
    expect(result.strategies).toContain('fts');
    expect(runtime.db.prepare('SELECT * FROM chunks').all()).toEqual(chunks);
    expect(runtime.memory.store.episodeById('host', first)).not.toBeNull();

    const embedderProbe = vi.fn(async () => {});
    const diagnostic = await runDoctor(home, { embedderProbe, checkoutRoot: null });
    expect(diagnostic.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'vector index',
          level: 'ok',
          detail: expect.stringContaining('disattivati'),
        }),
      ]),
    );
    expect(embedderProbe).not.toHaveBeenCalled();
    const stats = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(cmdMemoryStats(home)).toBe(0);
      expect(stats).toHaveBeenCalledWith(expect.stringContaining('embedding disattivati'));
    } finally {
      stats.mockRestore();
    }
    expect(fetch).not.toHaveBeenCalled();
    runtime.close();
    runtime = undefined;

    expect(await cmdModel(home, ['embed', 'on'], { out })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    runtime = buildRuntime(home, root);
    expect(runtime.memory.recall.vectors?.indexedCount('host')).toBe(1);
    expect((await runtime.consolidation.runNow()).report?.indexed).toBe(1);
    expect(runtime.memory.recall.vectors?.indexedCount('host')).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    runtime?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
