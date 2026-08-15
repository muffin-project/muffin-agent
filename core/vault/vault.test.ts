import DatabaseCtor from 'better-sqlite3';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPdf, pagesWithoutText } from '../documents/fixtures/pdf.js';
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
    expect(await f.vault.audit(HOST)).toMatchObject({ files: 1, indexed: 1, missing: [], stale: [], orphaned: [] });

    // Three ways an index goes wrong, all silent without this check.
    write(f.root, 'b.md', '# B\n\nmai indicizzato\n');           // never indexed
    write(f.root, 'a.md', '# A\n\ncambiato fuori da Muffin\n');  // changed behind our back
    const audit = await f.vault.audit(HOST);
    expect(audit.missing).toEqual(['b.md']);
    expect(audit.stale).toEqual(['a.md']);

    rmSync(join(f.root, 'a.md'));
    rmSync(join(f.root, 'b.md'));
    expect((await f.vault.audit(HOST)).orphaned).toEqual(['a.md']);
  });

  it('never indexes a dotfile, and says it did not', async () => {
    // The previous rule skipped hidden *directories* only, so a `.env` became
    // episodes, entered full-text search, and was sent to the embedder.
    const f = fixture();
    write(f.root, '.env', 'OPENAI_API_KEY=sk-live-VERA\nDB_PASSWORD=hunter2\n');
    write(f.root, 'id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    write(f.root, 'nota.md', '# Nota\n\ntesto legittimo\n');
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.scanned).toBe(1);
    expect(f.store.searchEpisodes(HOST, 'sk')).toHaveLength(0);
    expect(report.skipped.map((s) => s.path).sort()).toEqual(['.env', 'id_rsa']);
  });

  it('does not index a secret hiding behind an innocent symlink name', async () => {
    // The filter runs on the resolved path, so what the link is *called* here
    // buys the attacker nothing.
    const f = fixture();
    mkdirSync(join(f.root, '..', 'altrove', '.ssh'), { recursive: true });
    writeFileSync(join(f.root, '..', 'altrove', '.ssh', 'id_ed25519'), 'CHIAVE PRIVATA\n');
    symlinkSync(join(f.root, '..', 'altrove', '.ssh'), join(f.root, 'appunti'));
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.scanned).toBe(0);
    expect(f.store.searchEpisodes(HOST, 'CHIAVE')).toHaveLength(0);
    expect(report.skipped.find((s) => s.path === 'appunti')?.why).toContain('nascosto');
  });

  it('follows a symlinked note — the ordinary setup, not an edge case', async () => {
    // A vault whose notes live elsewhere and are linked in is how people use
    // this. `Dirent.isFile()` is false for a link, so the previous version
    // dropped them without a word — and `audit()` shared the blind spot,
    // reporting "aligned" over a vault it could not see.
    const f = fixture();
    mkdirSync(join(f.root, '..', 'obsidian'), { recursive: true });
    writeFileSync(join(f.root, '..', 'obsidian', 'diario.md'), '# Diario\n\nil ritrovo è al porto\n');
    symlinkSync(join(f.root, '..', 'obsidian', 'diario.md'), join(f.root, 'diario.md'));

    const report = await f.vault.reindex(HOST, { now: NOW });
    expect(report.scanned).toBe(1);
    expect(f.store.searchEpisodes(HOST, 'porto')).toHaveLength(1);
    // And the audit agrees with the reindex, because both enumerate the same way.
    expect(await f.vault.audit(HOST)).toMatchObject({ files: 1, indexed: 1, missing: [], stale: [] });
  });

  it('does not launder the tier when a file is renamed', async () => {
    // Trust followed the path, so `mv` was a laundering operation: the new path
    // was unknown, the default applied, and a downloaded paper became something
    // the owner had said.
    const f = fixture();
    write(f.root, 'import/paper.md', '# Paper\n\nafferma cose\n');
    await f.vault.reindex(HOST, { defaultTier: 3, now: NOW });

    renameSync(join(f.root, 'import', 'paper.md'), join(f.root, 'paper-v2.md'));
    await f.vault.reindex(HOST, { defaultTier: 0, now: NOW });

    const rows = f.store.episodesForVaultPath(HOST, 'paper-v2.md');
    expect(rows.length).toBeGreaterThan(0);
    expect(f.store.episodeById(HOST, rows[0]!.id)?.trustTier).toBe(3);
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

/**
 * M5-bis C7. Until this, a PDF dropped in the vault was recorded as *"non è
 * testo — serve un estrattore"*: the bytes were kept and not one word of them
 * was ever recallable. These are the properties that make the row `READY`
 * rather than merely "there is a parser now".
 */
describe('a PDF in the vault', () => {
  const CONTRATTO = buildPdf({
    title: 'Contratto',
    pages: [
      ['Contratto di locazione', 'Le parti convengono quanto segue.'],
      ['Canone mensile 850 euro'],
      ['Recesso con preavviso di tre mesi'],
    ],
  });

  it('goes in whole — the last page is recallable, not just the first', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'contratto.pdf'), CONTRATTO);
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.added).toBe(1);
    // Page three, the one a truncating intake loses without a word.
    expect(f.store.searchEpisodes(HOST, 'preavviso')).toHaveLength(1);
    expect(f.store.searchEpisodes(HOST, 'Canone')).toHaveLength(1);
    expect(report.documents).toMatchObject([{ path: 'contratto.pdf', format: 'pdf', parts: 3 }]);
  });

  it('gives every chunk the page it came from, so a citation can be checked', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'contratto.pdf'), CONTRATTO);
    await f.vault.reindex(HOST, { now: NOW });

    const hit = f.store.searchEpisodes(HOST, 'preavviso')[0]!;
    expect(f.store.episodeById(HOST, hit.id)?.content).toContain('p. 3');
    expect(f.store.episodeById(HOST, hit.id)?.content).toContain('Contratto');
  });

  it('carries the compact view on the report, for the surface that announces it', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'contratto.pdf'), CONTRATTO);
    const report = await f.vault.reindex(HOST, { now: NOW });

    const outline = report.documents[0]!.outline;
    expect(outline).toContain('3 pagine');
    expect(outline).toContain('document_read');
  });

  it('refuses a scan out loud, and does not index it as an empty document', async () => {
    // The failure that looks like success: pages exist, characters do not. An
    // extractor that returned "" here would file the document as read.
    const f = fixture();
    writeFileSync(join(f.root, 'scansione.pdf'), pagesWithoutText(3));
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.added).toBe(0);
    expect(f.store.episodesForVaultPath(HOST, 'scansione.pdf')).toHaveLength(0);
    const why = report.skipped.find((s) => s.path === 'scansione.pdf')?.why ?? '';
    expect(why).toContain('OCR');
    expect(why).toContain('3 pagine');
  });

  it('does not re-parse an unchanged document, and does not call it drift', async () => {
    // Every Telegram attachment reindexes the whole vault. If "has this changed"
    // cost a PDF parse, a vault with fifty documents would parse fifty of them
    // on every message.
    const f = fixture();
    writeFileSync(join(f.root, 'contratto.pdf'), CONTRATTO);
    await f.vault.reindex(HOST, { now: NOW });

    const second = await f.vault.reindex(HOST, { now: NOW });
    expect(second).toMatchObject({ unchanged: 1, added: 0, updated: 0, chunks: 0 });
    expect(second.documents).toHaveLength(0);
    expect(await f.vault.audit(HOST)).toMatchObject({ missing: [], stale: [], orphaned: [] });
  });

  it('does not report a scan as drift for ever', async () => {
    // A hash cannot tell "nobody indexed this" from "there is nothing here to
    // index". Reporting the second as drift would give `doctor` a permanent
    // complaint whose stated remedy — reindex — cannot fix it.
    const f = fixture();
    writeFileSync(join(f.root, 'scansione.pdf'), pagesWithoutText(2));
    await f.vault.reindex(HOST, { now: NOW });
    expect(await f.vault.audit(HOST)).toMatchObject({ missing: [], stale: [] });
  });

  it('reindexes a document whose bytes changed', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'contratto.pdf'), CONTRATTO);
    await f.vault.reindex(HOST, { now: NOW });

    writeFileSync(join(f.root, 'contratto.pdf'), buildPdf({ pages: [['Canone mensile 900 euro']] }));
    expect(await f.vault.audit(HOST)).toMatchObject({ stale: ['contratto.pdf'] });
    const report = await f.vault.reindex(HOST, { now: NOW });
    expect(report.updated).toBe(1);
    expect(f.store.searchEpisodes(HOST, '900')).toHaveLength(1);
    // Nothing is deleted: "what did that document say in May" stays answerable.
    expect(f.store.searchEpisodes(HOST, '850')).toHaveLength(0);
  });
});

describe('reading a document back', () => {
  it('hands over the file text, not a reassembly of chunks', async () => {
    const f = fixture();
    writeFileSync(f.root + '/relazione.pdf', buildPdf({ pages: [['prima'], ['seconda']] }));
    await f.vault.reindex(HOST, { now: NOW });

    const doc = await f.vault.document(HOST, 'relazione.pdf');
    expect(doc?.pages).toHaveLength(2);
    // The stored chunks carry a context line the document does not contain.
    // Reading through the file is what keeps that out of a quoted portion.
    expect(doc?.text).not.toContain('relazione.pdf');
    expect(doc?.pages[1]).toContain('seconda');
  });

  it('answers nothing for a tenant that does not have it', async () => {
    // The whole tenant check for the drill-down tool. A group turn naming a host
    // document must not be able to open it.
    const f = fixture();
    writeFileSync(f.root + '/privato.pdf', buildPdf({ pages: [['riservato']] }));
    await f.vault.reindex(HOST, { now: NOW });

    expect(await f.vault.document('group:telegram:-100', 'privato.pdf')).toBeNull();
  });

  it('refuses a path that climbs out of the vault', async () => {
    const f = fixture();
    writeFileSync(join(f.root, '..', 'segreto.md'), '# fuori dal vault\n\nchiave\n');
    expect(await f.vault.document(HOST, '../segreto.md')).toBeNull();
  });
});
