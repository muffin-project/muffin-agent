import DatabaseCtor from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Embedder } from '../memory/embed.js';
import { MemoryStore } from '../memory/store.js';
import { VectorIndex } from '../memory/vectors.js';
import { Vault } from './vault.js';

/**
 * The properties tested here are the ones the field gets wrong.
 *
 * Every comparable system examined for ADR-0024 has an open issue where change
 * detection reports success and the index never converges — so "reindex updates
 * a changed file" is not a formality, it is the single most commonly broken
 * behaviour in this class of software.
 */

class FakeEmbedder implements Embedder {
  readonly id = 'fake:v1';
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => Float32Array.from({ length: 8 }, (_, i) => ((t.charCodeAt(i) || 1) % 9) / 9));
  }
}

const HOST = 'host';
const NOW = () => new Date('2026-08-05T10:00:00Z');

function fixture(withVectors = false) {
  const root = mkdtempSync(join(tmpdir(), 'muffin-vault-'));
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const vectors = withVectors ? new VectorIndex(db, new FakeEmbedder()) : undefined;
  return { root, db, store, vectors, vault: new Vault(store, root) };
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('vault', () => {
  it('indexes a note and gives every chunk the same provenance', async () => {
    const f = fixture();
    write(f.root, 'note/clienti.md', '# Clienti\n\nUno.\n\n## Acme\n\nDue.\n');
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report).toMatchObject({ scanned: 1, added: 1, chunks: 2 });
    const rows = f.store.episodesForVaultPath(HOST, 'note/clienti.md');
    expect(rows).toHaveLength(2);
    const episode = f.store.episodeById(HOST, rows[0]!.id)!;
    expect(episode.kind).toBe('document');
    expect(episode.vaultPath).toBe('note/clienti.md');
    expect(episode.trustTier).toBe(0);
  });

  it('does nothing on a second run — the expensive half must be idempotent', async () => {
    const f = fixture();
    write(f.root, 'a.md', '# A\n\ntesto\n');
    await f.vault.reindex(HOST, { now: NOW });
    const second = await f.vault.reindex(HOST, { now: NOW });
    expect(second).toMatchObject({ unchanged: 1, added: 0, updated: 0, chunks: 0 });
  });

  it('actually reindexes a changed file — the failure every comparable system has', async () => {
    const f = fixture();
    write(f.root, 'a.md', '# A\n\nprima versione\n');
    await f.vault.reindex(HOST, { now: NOW });

    write(f.root, 'a.md', '# A\n\nseconda versione\n');
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.updated).toBe(1);
    const live = f.store.episodesForVaultPath(HOST, 'a.md');
    expect(live).toHaveLength(1);
    expect(f.store.episodeById(HOST, live[0]!.id)?.content).toContain('seconda versione');
    // And the old text stops answering searches without being deleted.
    expect(f.store.searchEpisodes(HOST, 'prima')).toHaveLength(0);
    const all = f.db.prepare(`SELECT count(*) AS n FROM episodes WHERE vault_path = 'a.md'`).get() as { n: number };
    expect(all.n).toBe(2);
  });

  it('retires a file that disappeared, and keeps it on record', async () => {
    const f = fixture();
    write(f.root, 'a.md', '# A\n\ntesto\n');
    await f.vault.reindex(HOST, { now: NOW });
    rmSync(join(f.root, 'a.md'));

    const report = await f.vault.reindex(HOST, { now: NOW });
    expect(report.removed).toBe(1);
    expect(f.store.episodesForVaultPath(HOST, 'a.md')).toHaveLength(0);
    expect(f.store.searchEpisodes(HOST, 'testo')).toHaveLength(0);
  });

  it('never raises the trust of a file across a reindex', async () => {
    // A tier-3 import re-scanned with a tier-0 default would be laundered into
    // owner-grade evidence by a command that looks like maintenance.
    const f = fixture();
    write(f.root, 'import/paper.md', '# Paper\n\nafferma cose\n');
    await f.vault.reindex(HOST, { defaultTier: 3, now: NOW });

    write(f.root, 'import/paper.md', '# Paper\n\nafferma altre cose\n');
    await f.vault.reindex(HOST, { defaultTier: 0, now: NOW });

    const rows = f.store.episodesForVaultPath(HOST, 'import/paper.md');
    expect(f.store.episodeById(HOST, rows[0]!.id)?.trustTier).toBe(3);
  });

  it('skips binaries and says why instead of indexing nothing quietly', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'foto.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    write(f.root, 'vuoto.md', '   \n\n');
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.chunks).toBe(0);
    expect(report.skipped.map((s) => s.path).sort()).toEqual(['foto.bin', 'vuoto.md']);
    expect(report.skipped.find((s) => s.path === 'foto.bin')?.why).toContain('estrattore');
  });

  it('drops the vectors of retired chunks so old text stops winning searches', async () => {
    const f = fixture(true);
    write(f.root, 'a.md', '# A\n\nprima versione\n');
    await f.vault.reindex(HOST, { now: NOW, vectors: f.vectors });
    expect(f.vectors!.indexedCount()).toBe(1);

    write(f.root, 'a.md', '# A\n\nseconda versione\n');
    await f.vault.reindex(HOST, { now: NOW, vectors: f.vectors });

    // One chunk in, one chunk out: the retired one left the index with it.
    expect(f.vectors!.indexedCount()).toBe(1);
    expect(f.vectors!.indexBacklog(HOST)).toHaveLength(0);
  });

  it('audits disk against index and finds drift the hash alone would not', async () => {
    const f = fixture();
    write(f.root, 'a.md', '# A\n\ntesto\n');
    await f.vault.reindex(HOST, { now: NOW });
    expect(f.vault.audit(HOST)).toMatchObject({ files: 1, indexed: 1, missing: [], stale: [], orphaned: [] });

    // Three ways an index goes wrong, all silent without this check.
    write(f.root, 'b.md', '# B\n\nmai indicizzato\n');           // never indexed
    write(f.root, 'a.md', '# A\n\ncambiato fuori da Muffin\n');  // changed behind our back
    const audit = f.vault.audit(HOST);
    expect(audit.missing).toEqual(['b.md']);
    expect(audit.stale).toEqual(['a.md']);

    rmSync(join(f.root, 'a.md'));
    rmSync(join(f.root, 'b.md'));
    expect(f.vault.audit(HOST).orphaned).toEqual(['a.md']);
  });

  it('ignores the directories that are never content', async () => {
    const f = fixture();
    write(f.root, '.git/config', 'roba');
    write(f.root, 'node_modules/pkg/readme.md', '# no');
    write(f.root, 'vero.md', '# sì\n\ntesto\n');
    const report = await f.vault.reindex(HOST, { now: NOW });
    expect(report.scanned).toBe(1);
  });
});
