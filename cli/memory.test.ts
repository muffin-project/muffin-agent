import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../core/config/config.js';
import { MemoryStore } from '../core/memory/store.js';
import { cmdMemoryReview, cmdMemoryReviewKeep, cmdMemoryStats } from './memory.js';

/**
 * `cmdMemoryStats` and `cmdMemoryReview`: `cmdMemoryExtract`'s fix (the batch
 * progress break condition) is proven at the `ingestPending` level in
 * `core/memory/ingest.test.ts`, which is what a scheduler actually calls — this
 * file does not re-derive that through `buildRuntime` and a model.
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

/** A home holding one open contradiction: two current beliefs, one question. */
function homeWithContradiction(): { home: string; existing: number; incoming: number } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-memory-review-'));
  const db = new DatabaseCtor(paths(home).db);
  const store = new MemoryStore(db);
  const episodeId = store.addEpisode({
    tenantId: 'host',
    connector: 'cli',
    threadKey: 't',
    role: 'user',
    kind: 'message',
    content: 'il commercialista ora è Lucia',
    trustTier: 0,
    createdAt: '2026-08-13T10:00:00Z',
  });
  const subjectId = store.upsertEntity('host', 'owner', 'person', '2026-08-13T10:00:00Z');
  const believe = (object: string, at: string) =>
    store.addFact({
      tenantId: 'host',
      subjectId,
      predicate: 'accountant',
      objectValue: object,
      episodeId,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: at,
    });
  const existing = believe('Marco', '2026-06-01T10:00:00Z');
  const incoming = believe('Lucia', '2026-08-13T10:00:00Z');
  store.recordReview({
    tenantId: 'host',
    kind: 'contradiction',
    subject: 'owner',
    predicate: 'accountant',
    existingFactId: existing,
    incomingFactId: incoming,
    detail: 'nessuna delle due frasi dice quando',
    createdAt: '2026-08-13T10:00:01Z',
  });
  db.close();
  return { home, existing, incoming };
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

describe('muffin memory stats', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the durable review count, not just facts and episodes', () => {
    // Defect #5's other half: recording is only half the fix if nothing reads
    // it back. Without this line the count is exactly as invisible as the
    // stderr line it replaced, just in a different table.
    const home = homeWithReview();
    const { out } = capture();

    expect(cmdMemoryStats(home)).toBe(0);
    expect(out.join('')).toContain('da rivedere');
    // And it says *what*: a bare total on an append-only register only ever
    // grows, which is how a number stops being read within a week.
    expect(out.join('')).toContain('problemi ricorrenti');
  });

  it('counts what is open, which falls when the question is settled', () => {
    const { home, existing, incoming } = homeWithContradiction();
    const first = capture();
    expect(cmdMemoryStats(home)).toBe(0);
    expect(first.out.join('')).toContain('1 da decidere');
    vi.restoreAllMocks();

    const db = new DatabaseCtor(paths(home).db);
    new MemoryStore(db).supersede('host', existing, incoming, '2026-08-14T10:00:00Z');
    db.close();

    const second = capture();
    expect(cmdMemoryStats(home)).toBe(0);
    expect(second.out.join('')).toContain('niente da decidere');
  });
});

describe('muffin memory review', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * The read side the register never had. `store.pendingReview` was called by
   * tests and by nothing in production, so the judge's deliberate *"a human
   * should decide"* outcome accumulated rows nobody could see — which matters
   * more now than when it was written, because the lane that produces them runs
   * unattended.
   */
  it('shows both beliefs with their ids, the judge’s reason, and the command to answer', () => {
    const { home, existing, incoming } = homeWithContradiction();
    const { out } = capture();

    expect(cmdMemoryReview(home)).toBe(1);
    const text = out.join('');
    expect(text).toContain(`#${existing}`);
    expect(text).toContain(`#${incoming}`);
    expect(text).toContain('Marco');
    expect(text).toContain('Lucia');
    expect(text).toContain('nessuna delle due frasi dice quando');
    // A question printed with no way to answer it is not a read side.
    expect(text).toContain(`muffin memory review keep ${incoming}`);
  });

  it('answers one by keeping a side — and never deletes the other', () => {
    const { home, existing, incoming } = homeWithContradiction();
    const { out } = capture();

    expect(cmdMemoryReviewKeep(home, incoming)).toBe(0);
    expect(out.join('')).toContain(`ritiro #${existing}`);

    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    const retired = store.factById('host', existing);
    expect(retired).not.toBeNull();
    expect(retired?.supersededBy).toBe(incoming);
    expect(store.factById('host', incoming)?.expiredAt).toBeNull();
    // The register row stays too: append-only, so what the judge asked survives
    // the question being settled.
    expect(store.pendingReview('host')).toHaveLength(1);
    db.close();

    vi.restoreAllMocks();
    const after = capture();
    // And the question is gone from the list, without a status column anywhere:
    // "open" is a join over the two facts.
    expect(cmdMemoryReview(home)).toBe(0);
    expect(after.out.join('')).toContain('niente da decidere');
  });

  it('refuses an id that is not one of the two, instead of reporting success', () => {
    const { home } = homeWithContradiction();
    const { err } = capture();
    expect(cmdMemoryReviewKeep(home, 9999)).toBe(1);
    expect(err.join('')).toContain('contraddizione aperta');
  });

  it('tells an empty register apart from one whose questions are all answered', () => {
    const empty = mkdtempSync(join(tmpdir(), 'muffin-memory-empty-'));
    const db = new DatabaseCtor(paths(empty).db);
    new MemoryStore(db);
    db.close();

    const { out } = capture();
    expect(cmdMemoryReview(empty)).toBe(0);
    expect(out.join('')).toContain('non ha mai dovuto chiedere');
  });

  it('folds a repeating pipeline failure instead of printing it once per fire', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-memory-errors-'));
    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    for (const day of ['11', '12', '13']) {
      store.recordReview({
        tenantId: 'host',
        kind: 'error',
        detail: 'estrazione fallita su episodio 7: risposta non parsabile',
        createdAt: `2026-08-${day}T10:00:00Z`,
      });
    }
    db.close();

    const { out } = capture();
    expect(cmdMemoryReview(home)).toBe(0);
    const text = out.join('');
    // One line, with the count and the span — an episode that fails extraction
    // permanently is retried on every fire and would otherwise bury the
    // contradictions this register exists for.
    expect(text.split('estrazione fallita')).toHaveLength(2);
    expect(text).toContain('3×');
  });
});
