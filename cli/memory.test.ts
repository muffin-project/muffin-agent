import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../core/config/config.js';
import { MemoryStore } from '../core/memory/store.js';
import { cmdMemoryStats } from './memory.js';

/**
 * `cmdMemoryStats` only, and only the new line: `cmdMemoryExtract`'s fix
 * (the batch-progress break condition) is proven at the `ingestPending` level
 * in `core/memory/ingest.test.ts`, which is what a scheduler actually calls —
 * this file does not re-derive that through `buildRuntime` and a model.
 *
 * No `runInit`: `openStore` only needs a directory and a sqlite file: config,
 * secrets and the RoT are irrelevant to `MemoryStore`.
 */

function homeWithReview(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-memory-cli-'));
  const db = new DatabaseCtor(paths(home).db);
  const store = new MemoryStore(db);
  store.recordReview({
    tenantId: 'host',
    kind: 'error',
    detail: 'giudice non disponibile',
    createdAt: '2026-08-13T10:00:00Z',
  });
  db.close();
  return home;
}

describe('muffin memory stats', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the durable review count, not just facts and episodes', () => {
    // Defect #5's other half: recording is only half the fix if nothing reads
    // it back. Without this line the count is exactly as invisible as the
    // stderr line it replaced, just in a different table.
    const home = homeWithReview();
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    expect(cmdMemoryStats(home)).toBe(0);
    expect(lines.join('')).toContain('da rivedere    1');
  });
});
