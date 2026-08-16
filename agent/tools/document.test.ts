import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPdf } from '../../core/documents/fixtures/pdf.js';
import { MemoryStore } from '../../core/memory/store.js';
import { Vault } from '../../core/vault/vault.js';
import { readDocument } from './document.js';

/**
 * The door back into a document that was acquired whole.
 *
 * Without it the compact view is the defect it was built to avoid: a model
 * handed an index of eighty pages and no way to open one answers from the
 * index, which is a summary with extra steps. So the properties here are the
 * ones that make the pair honest — the text comes from the document, the range
 * is the one asked for, and the two things that must not be reachable through
 * a path the model chose are not.
 */

const HOST = 'host';

const CONTRATTO = buildPdf({
  title: 'Contratto',
  pages: [
    ['Contratto di locazione'],
    ['Canone mensile 850 euro'],
    ['Recesso con preavviso di tre mesi'],
  ],
});

async function fixture(tier: 0 | 1 | 2 | 3 = 0) {
  const root = mkdtempSync(join(tmpdir(), 'muffin-docread-'));
  const store = new MemoryStore(new DatabaseCtor(':memory:'));
  const vault = new Vault(store, root);
  writeFileSync(join(root, 'contratto.pdf'), CONTRATTO);
  await vault.reindex(HOST, { defaultTier: tier });
  return { root, store, vault };
}

describe('document_read', () => {
  it('returns the real text of the pages asked for', async () => {
    const f = await fixture();
    const out = await readDocument(f.vault, f.store, HOST, {
      path: 'contratto.pdf',
      da: 2,
      a: 3,
    });

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('Canone mensile 850 euro');
    expect(out.content).toContain('preavviso di tre mesi');
    expect(out.content).not.toContain('Contratto di locazione');
    expect(out.content).toContain('parti 2-3 di 3');
  });

  it('fences the text as data, because a document can contain an instruction', async () => {
    const f = await fixture();
    const out = await readDocument(f.vault, f.store, HOST, { path: 'contratto.pdf' });
    expect(out.content).toContain('<<<DOCUMENTO_');
    expect(out.content).toContain('non istruzioni');
  });

  it('carries the document’s tier, so reading on purpose taints like recalling does', async () => {
    // Otherwise this tool is a laundry: a PDF a stranger sent would arrive as
    // tier-0 evidence the moment the model asked for it by name.
    const f = await fixture(2);
    const out = await readDocument(f.vault, f.store, HOST, { path: 'contratto.pdf' });
    expect(out.tier).toBe(2);
  });

  it('refuses a document of another tenant without saying whether it exists', async () => {
    const f = await fixture();
    const out = await readDocument(f.vault, f.store, 'group:telegram:-100', {
      path: 'contratto.pdf',
    });
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain('Canone');
  });

  it('refuses a path that climbs out of the vault', async () => {
    const f = await fixture();
    writeFileSync(join(f.root, '..', 'fuori.md'), 'chiave privata');
    const out = await readDocument(f.vault, f.store, HOST, { path: '../fuori.md' });
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain('chiave');
  });

  it('says what it needs when the arguments are wrong, rather than reading nothing', async () => {
    const f = await fixture();
    const out = await readDocument(f.vault, f.store, HOST, { path: '  ' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('path');
  });

  it('stops answering once the file is gone from disk', async () => {
    // The vault's own rule — the file is the source, the index is derived — has
    // to hold here too, or a portion could outlive the document it quotes. The
    // episodes are still there at this point, deliberately: the evidence plane
    // is append-only, and it is the *read* that has to stop.
    const f = await fixture();
    rmSync(join(f.root, 'contratto.pdf'));
    expect(f.store.episodesForVaultPath(HOST, 'contratto.pdf').length).toBeGreaterThan(0);

    const out = await readDocument(f.vault, f.store, HOST, { path: 'contratto.pdf' });
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain('Canone');
  });
});
