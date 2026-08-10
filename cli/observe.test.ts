import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntime } from '../agent/runtime.js';
import { paths } from '../core/config/config.js';
import { MemoryStore } from '../core/memory/store.js';
import { FireLog } from '../core/scheduler/firelog.js';
import type { ChatResult, Provider } from '../agent/providers/types.js';
import { runInit } from './init.js';
import { cmdObserve } from './observe.js';

/**
 * `muffin observe`, end to end on a real home.
 *
 * The point is the path, not the arithmetic: a home that has never run
 * `observe` has no fires table, so if the schema were declared and never
 * executed — the defect this slice was sent to fix — the first command would
 * die on "no such table" instead of quietly doing nothing. And the default
 * command must reach the gate while touching neither the model nor a channel:
 * that is the whole reason it exists before `--send` does.
 */

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-05T11:00:00Z'); // midday in Europe/Rome, outside quiet hours
const at = (days: number): string => new Date(T0 + days * DAY).toISOString();
const NOW = new Date(T0 + 120 * DAY);

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly script: string[]) {}
  async chat(): Promise<ChatResult> {
    return {
      text: this.script[this.i++] ?? 'fine',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 't',
    };
  }
}

/** A home whose memory holds one entity mentioned three times, then silent. */
function homeWithSilence(name = 'la tesi'): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-observe-cli-'));
  runInit({ home, apiKey: 'sk-never-called' });
  const db = new DatabaseCtor(paths(home).db);
  const store = new MemoryStore(db);
  for (const day of [0, 10, 20]) {
    const when = at(day);
    const entityId = store.upsertEntity('host', name, 'thing', when);
    const episodeId = store.addEpisode({
      tenantId: 'host',
      connector: 'cli',
      threadKey: 't1',
      role: 'user',
      kind: 'message',
      content: `qualcosa su ${name}`,
      trustTier: 0,
      createdAt: when,
    });
    store.addFact({
      tenantId: 'host',
      subjectId: entityId,
      predicate: 'menzionato',
      objectValue: 'x',
      episodeId,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: when,
    });
  }
  db.close();
  return home;
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

function firedAnchors(home: string): string[] {
  const db = new DatabaseCtor(paths(home).db);
  try {
    new FireLog(db); // ensures the table exists even if nothing ever wrote
    return (db.prepare(`SELECT anchor FROM proactive_fires`).all() as { anchor: string }[]).map((r) => r.anchor);
  } finally {
    db.close();
  }
}

describe('muffin observe', () => {
  afterEach(() => vi.restoreAllMocks());

  it('detects the silence, shows the gate decision and the numbers, and speaks to nobody', async () => {
    const home = homeWithSilence();
    const { out } = capture();
    const delivered: string[] = [];

    // No `deps`: if this path touched the model it could not even build a turn.
    const code = await cmdObserve(home, [], { now: NOW, deliver: async (_c, t) => void delivered.push(t) });

    const text = out.join('');
    expect(code).toBe(0);
    expect(text).toContain('la tesi');
    expect(text).toContain('3 occasioni');
    expect(text).toContain('100'); // giorni di silenzio
    expect(text).toMatch(/p 0\.0/);
    expect(delivered).toEqual([]);
    // Nothing is burned by looking: the anchor is still available to fire.
    expect(firedAnchors(home)).toEqual([]);
  });

  it('--send composes through the loop, delivers once, and records the anchor', async () => {
    const home = homeWithSilence();
    const { out } = capture();
    const delivered: string[] = [];
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-observe-ws-')));
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW,
        deps: { ...runtime.deps, provider: new Scripted(['da quanto non tocchi la tesi?']) },
        deliver: async (_c, t) => void delivered.push(t),
      });
      expect(code).toBe(0);
      expect(delivered).toEqual(['da quanto non tocchi la tesi?']);
      expect(firedAnchors(home)).toHaveLength(1);
      expect(out.join('')).toContain('inviato');
    } finally {
      runtime.close();
    }
  });

  it('the second run skips the anchor it already fired — the old repetition, structurally', async () => {
    const home = homeWithSilence();
    capture();
    const delivered: string[] = [];
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-observe-ws-')));
    try {
      const send = async () =>
        cmdObserve(home, ['--send'], {
          now: NOW,
          deps: { ...runtime.deps, provider: new Scripted(['primo', 'secondo']) },
          deliver: async (_c, t) => void delivered.push(t),
        });
      await send();
      await send();
      expect(delivered).toEqual(['primo']);
      expect(firedAnchors(home)).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it('a delivery that fails leaves the anchor open, and the exit code says so', async () => {
    const home = homeWithSilence();
    const { out } = capture();
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-observe-ws-')));
    try {
      const code = await cmdObserve(home, ['--send'], {
        now: NOW,
        deps: { ...runtime.deps, provider: new Scripted(['da quanto non tocchi la tesi?']) },
        deliver: async () => {
          throw new Error('canale giù');
        },
      });
      expect(code).toBe(1);
      // Recording before the message is out would silence this entity forever
      // on the strength of one bad run.
      expect(firedAnchors(home)).toEqual([]);
      expect(out.join('')).toContain('non inviato');
    } finally {
      runtime.close();
    }
  });

  it('an empty memory is not an error, and says so', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-observe-empty-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const { out, err } = capture();

    expect(await cmdObserve(home, [], { now: NOW })).toBe(0);
    expect(`${out.join('')}${err.join('')}`).toContain('nessun silenzio');
  });
});
