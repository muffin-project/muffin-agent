import DatabaseCtor from 'better-sqlite3';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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

/**
 * Un vault della **forma di produzione**: `<tmp>/.muffin/vault`.
 *
 * La home di Muffin è `~/.muffin`, quindi ogni percorso assoluto del vault
 * reale contiene il segmento `.muffin`. Finché il fixture creava la radice
 * direttamente in `tmpdir()` questa suite provava una macchina che non esiste:
 * il filtro dei dotfile girava anche sul percorso assoluto risolto e in
 * produzione rifiutava *ogni* file come «nascosto», mentre qui restava verde.
 */
function fixture(withVectors = false) {
  const root = join(mkdtempSync(join(tmpdir(), 'muffin-vault-')), '.muffin', 'vault');
  mkdirSync(root, { recursive: true });
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

  it('indexes one named path without granting that tenant the rest of the vault', async () => {
    const f = fixture();
    write(f.root, 'private.md', '# Private\n\nOWNERONLY\n');
    write(f.root, 'existing.md', '# Existing\n\nSTILLTHERE\n');
    write(f.root, 'incoming.md', '# Incoming\n\nGROUPONLY\n');
    await f.vault.reindexPath('group:telegram:7', 'existing.md', { now: NOW });

    const report = await f.vault.reindexPath('group:telegram:7', 'incoming.md', { now: NOW });

    expect(report).toMatchObject({ scanned: 1, added: 1, removed: 0 });
    expect(f.store.searchEpisodes('group:telegram:7', 'GROUPONLY')).toHaveLength(1);
    expect(f.store.searchEpisodes('group:telegram:7', 'STILLTHERE')).toHaveLength(1);
    expect(f.store.searchEpisodes('group:telegram:7', 'OWNERONLY')).toHaveLength(0);
    expect(await f.vault.reindexPath('group:telegram:7', '../private.md', { now: NOW }))
      .toMatchObject({ scanned: 0, added: 0, skipped: [{ path: '../private.md' }] });
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
    // Il difetto che questo test isola dagli altri due: un file vuoto non è
    // "un formato che non sappiamo leggere" — il testo del `why` deve
    // distinguerli, o un binario e una nota vuota sembrano lo stesso guasto.
    expect(report.skipped.find((s) => s.path === 'vuoto.md')?.why).toBe('vuoto');
  });

  it('un file diventato illeggibile non è "serve un estrattore": reindex dice perché non può leggerlo', async () => {
    // `identityOf` collassava permessi tolti, formato non supportato e nota
    // vuota nello stesso `null`, e questo era l'unico ramo che li leggeva: un
    // file leggibile scritto e poi reso illeggibile (permessi, un errore di
    // I/O) veniva riportato come "non è testo né PDF né DOCX — serve un
    // estrattore" — falso, e senza rimedio possibile, perché il vero problema
    // non è il formato.
    const f = fixture();
    write(f.root, 'segreto.txt', 'contenuto vero, che varrebbe la pena indicizzare.');
    chmodSync(join(f.root, 'segreto.txt'), 0o000);
    try {
      const report = await f.vault.reindex(HOST, { now: NOW });
      expect(report.added).toBe(0);
      const skip = report.skipped.find((s) => s.path === 'segreto.txt');
      expect(skip?.why).toContain('illeggibile');
      expect(skip?.why).not.toContain('estrattore');
    } finally {
      chmodSync(join(f.root, 'segreto.txt'), 0o600); // altrimenti il cleanup del tmpdir fallisce
    }
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

  it('un documento illeggibile non torna "indice allineato": audit lo nomina, non lo cancella dal conto', async () => {
    // `muffin vault check` esiste, per parole sue, perché "il meccanismo che
    // funziona non è la stessa cosa dell'indice giusto". Prima di questo test
    // un vault con un solo file senza permesso di lettura passava quel check
    // pulito: `identityOf` tornava `null`, `audit()` lo escludeva da `onDisk`
    // senza lasciare traccia in nessuno dei tre array, e il comando stampava
    // "0 file leggibili sul disco · 0 indicizzati" seguito da "indice
    // allineato", exit 0 — lo stesso guasto, "indicizzazione a zero e verde
    // ovunque", di cui il modulo cita Khoj e Reor nel proprio commento di
    // testa, qui prodotto da un bit di permesso invece che da un bug di path.
    const f = fixture();
    write(f.root, 'segreto.txt', 'contenuto vero, mai indicizzato perché illeggibile.');
    chmodSync(join(f.root, 'segreto.txt'), 0o000);
    try {
      const audit = await f.vault.audit(HOST);
      expect(audit.unreadable).toEqual(['segreto.txt']);
      expect(audit.missing).toEqual([]); // non è "assente dall'indice": un reindex non lo risolverebbe
      expect(audit.orphaned).toEqual([]); // non è "sparito dal disco": il file c'è
      expect(audit.files).toBe(0); // "leggibili sul disco" — questo non lo è
    } finally {
      chmodSync(join(f.root, 'segreto.txt'), 0o600);
    }
  });

  it('un file indicizzato che poi diventa illeggibile non è "orphaned": il file non è sparito', async () => {
    const f = fixture();
    write(f.root, 'nota.md', '# Nota\n\ncontenuto indicizzato mentre era ancora leggibile.\n');
    await f.vault.reindex(HOST, { now: NOW });
    expect((await f.vault.audit(HOST)).indexed).toBe(1);

    chmodSync(join(f.root, 'nota.md'), 0o000);
    try {
      const audit = await f.vault.audit(HOST);
      expect(audit.unreadable).toEqual(['nota.md']);
      // Prima della guardia in `audit()`, questo stesso caso finiva ANCHE in
      // `orphaned` — "indicizzato, file sparito" — che è falso: il file esiste,
      // è solo illeggibile ora.
      expect(audit.orphaned).toEqual([]);
    } finally {
      chmodSync(join(f.root, 'nota.md'), 0o600);
    }
  });

  it('indicizza un documento in una home che è essa stessa una dotdir', async () => {
    // Il difetto misurato il 2026-09-03 sull'installazione dell'owner: la home
    // è `~/.muffin`, il filtro dei dotfile girava sul percorso assoluto
    // risolto, e quindi *ogni* file mai inviato è stato rifiutato come
    // «nascosto». Tre file nel vault, zero episodi `document` nel database.
    const f = fixture();
    expect(f.root).toContain(`${sep}.muffin${sep}`);
    write(f.root, 'inbox/cv.md', '# CV\n\nParola RARISSIMA nel curriculum.\n');

    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.skipped).toEqual([]);
    expect(report).toMatchObject({ scanned: 1, added: 1 });
    const rows = f.store.episodesForVaultPath(HOST, 'inbox/cv.md');
    expect(rows.length).toBeGreaterThan(0);
    expect(f.store.episodeById(HOST, rows[0]!.id)!.kind).toBe('document');
    expect(f.store.searchEpisodes(HOST, 'RARISSIMA').length).toBeGreaterThan(0);
  });

  it('non conta come «dentro il vault» una directory sorella con lo stesso prefisso', async () => {
    // `/a/vault-evil` non è dentro `/a/vault`: un `startsWith` sulla stringa
    // direbbe di sì. Il confronto deve essere per segmenti di percorso.
    const f = fixture();
    mkdirSync(`${f.root}-evil`, { recursive: true });
    writeFileSync(join(`${f.root}-evil`, 'segreti.md'), '# Segreti\n\nPAROLADORDINE\n');
    symlinkSync(join(`${f.root}-evil`, 'segreti.md'), join(f.root, 'innocuo.md'));

    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.scanned).toBe(0);
    expect(report.skipped.find((s) => s.path === 'innocuo.md')?.why).toContain('link esterno');
    expect(f.store.searchEpisodes(HOST, 'PAROLADORDINE')).toHaveLength(0);
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
    // Il link è *fuori* dal vault, quindi a fermarlo è il contenimento — un
    // rifiuto migliore di «nascosto», perché nomina la ragione vera.
    const f = fixture();
    mkdirSync(join(f.root, '..', 'altrove', '.ssh'), { recursive: true });
    writeFileSync(join(f.root, '..', 'altrove', '.ssh', 'id_ed25519'), 'CHIAVE PRIVATA\n');
    symlinkSync(join(f.root, '..', 'altrove', '.ssh'), join(f.root, 'appunti'));
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.scanned).toBe(0);
    expect(f.store.searchEpisodes(HOST, 'CHIAVE')).toHaveLength(0);
    expect(report.skipped.find((s) => s.path === 'appunti')?.why).toContain('link esterno');
  });

  it('guarda il percorso risolto: un link interno a una dotdir resta nascosto', async () => {
    // Questa è la proprietà per cui il filtro girava sul percorso risolto:
    // ciò che il link è *chiamato* qui non compra nulla. Vale ancora, ma sul
    // percorso relativo alla radice — non su quello assoluto.
    const f = fixture();
    mkdirSync(join(f.root, '.ssh'), { recursive: true });
    writeFileSync(join(f.root, '.ssh', 'id_ed25519'), 'CHIAVE INTERNA\n');
    symlinkSync(join(f.root, '.ssh'), join(f.root, 'appunti'));
    const report = await f.vault.reindex(HOST, { now: NOW });

    expect(report.scanned).toBe(0);
    expect(f.store.searchEpisodes(HOST, 'CHIAVE')).toHaveLength(0);
    const why = report.skipped.find((s) => s.path === 'appunti')?.why;
    expect(why).toContain('nascosto');
    // Il motivo nomina il segmento vero, non una frase generica sui dotfile.
    expect(why).toContain('.ssh');
  });

  it('rifiuta i nomi che non sono mai contenuto anche via reindexPath', async () => {
    const f = fixture();
    write(f.root, 'credentials.json', '{"token":"SEGRETISSIMO"}\n');
    const report = await f.vault.reindexPath(HOST, 'credentials.json', { now: NOW });

    expect(report.scanned).toBe(0);
    expect(report.skipped[0]!.why).toContain('credentials.json');
    expect(f.store.searchEpisodes(HOST, 'SEGRETISSIMO')).toHaveLength(0);
  });

  it('refuses an external symlink instead of indexing a source document_read cannot reopen', async () => {
    // Indexing this used to advertise a working way back into the note while
    // Vault.document correctly refused the external realpath. Following it at
    // read time would be worse: the link can be retargeted after indexing.
    const f = fixture();
    mkdirSync(join(f.root, '..', 'obsidian'), { recursive: true });
    writeFileSync(join(f.root, '..', 'obsidian', 'diario.md'), '# Diario\n\nil ritrovo è al porto\n');
    symlinkSync(join(f.root, '..', 'obsidian', 'diario.md'), join(f.root, 'diario.md'));

    const report = await f.vault.reindex(HOST, { now: NOW });
    expect(report.scanned).toBe(0);
    expect(report.skipped.find((s) => s.path === 'diario.md')?.why).toContain('link esterno');
    expect(f.store.searchEpisodes(HOST, 'porto')).toHaveLength(0);
    expect(await f.vault.document(HOST, 'diario.md')).toBeNull();
    expect(await f.vault.audit(HOST)).toMatchObject({ files: 0, indexed: 0, missing: [], stale: [] });
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
    // Full maintenance scans still need to make "has this changed" cheap. File
    // arrivals use reindexPath and never enumerate the other forty-nine.
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
