import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../memory/store.js';
import { Vault } from './vault.js';
import { startVaultWatcher, VAULT_WATCH_ENV, watchVault } from './watcher.js';

/**
 * DT-09: hand edits must reach the index without an explicit reindex.
 *
 * The vault root is single and shared — tenants differ only in index rows —
 * so one watcher covers every tenant, and attribution comes from
 * `tenantsForVaultPath` at flush time. A path nobody references (a brand-new
 * file) has no correct tenant and is left to `audit()`: that limit is load-
 * bearing, and the second test below locks it.
 */

const HOST = 'host';
const STANZA = 'group:telegram:-100950';

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'muffin-vault-watch-')), '.muffin', 'vault');
  mkdirSync(root, { recursive: true });
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const vault = new Vault(store, root);
  return { root, db, store, vault };
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout aspettando: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => vi.unstubAllEnvs());

describe('vault watcher', () => {
  it('reindexes a hand-edited file for the tenant that references it', async () => {
    const f = fixture();
    write(f.root, 'a.md', '# A\n\nprima\n');
    await f.vault.reindex(HOST);

    const seen: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      onReindexed: (info) => seen.push(info),
    });
    try {
      expect(w.watched).toBeGreaterThanOrEqual(1);
      expect(w.pending).toBe(0);

      write(f.root, 'a.md', '# A\n\nseconda\n');
      await waitFor(() => seen.length > 0, 5000, 'reindex di a.md');

      expect(seen).toContainEqual({ tenant: HOST, path: 'a.md' });
      // E il nuovo testo risponde davvero al recall.
      expect(f.store.searchEpisodes(HOST, 'seconda')).toHaveLength(1);
    } finally {
      w.stop();
    }
  });

  it('reindexes every tenant that references the same path — one root covers all', async () => {
    const f = fixture();
    write(f.root, 'condiviso.md', '# C\n\nuno\n');
    await f.vault.reindexPath(HOST, 'condiviso.md');
    await f.vault.reindexPath(STANZA, 'condiviso.md');
    expect(f.store.tenantsForVaultPath('condiviso.md').sort()).toEqual([HOST, STANZA].sort());

    const seen: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      onReindexed: (info) => seen.push(info),
    });
    try {
      write(f.root, 'condiviso.md', '# C\n\ndue\n');
      await waitFor(() => seen.length >= 2, 5000, 'reindex per entrambi i tenant');
      expect(seen).toContainEqual({ tenant: HOST, path: 'condiviso.md' });
      expect(seen).toContainEqual({ tenant: STANZA, path: 'condiviso.md' });
    } finally {
      w.stop();
    }
  });

  it('leaves a brand-new file alone — no tenant to attribute it to — and audit() names it', async () => {
    const f = fixture();
    write(f.root, 'vecchia.md', '# V\n\ntesto\n');
    await f.vault.reindex(HOST);

    const calls: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: async (t, p) => {
        calls.push({ tenant: t, path: p });
      },
      debounceMs: 50,
    });
    try {
      write(f.root, 'nuova.md', '# N\n\nappena creata\n');
      // Longer than the debounce: if the watcher wanted this file, it had time.
      await new Promise((r) => setTimeout(r, 400));
      expect(calls.filter((c) => c.path === 'nuova.md')).toEqual([]);

      // The surfacing path that owns this case instead.
      const audit = await f.vault.audit(HOST);
      expect(audit.missing).toContain('nuova.md');
    } finally {
      w.stop();
    }
  });

  it('sees edits inside a subdirectory that existed before watching started', async () => {
    const f = fixture();
    write(f.root, 'sub/nota.md', '# S\n\nuno\n');
    await f.vault.reindex(HOST);

    const seen: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      onReindexed: (info) => seen.push(info),
    });
    try {
      expect(w.watched).toBeGreaterThanOrEqual(2);
      write(f.root, 'sub/nota.md', '# S\n\ndue\n');
      await waitFor(() => seen.length > 0, 5000, 'reindex di sub/nota.md');
      expect(seen).toContainEqual({ tenant: HOST, path: 'sub/nota.md' });
    } finally {
      w.stop();
    }
  });

  /**
   * Il falsificatore della decisione (coordinatore, DT-09): 20 file editati a
   * mano, meno di 18 reindicizzati entro 60s → il watcher è inaffidabile e la
   * convergenza resta esplicita (`muffin vault reindex`) con `doctor` come
   * etichetta stale. Se questo test cade, la risposta non è alzarlo: è non
   * cablare il watcher.
   */
  it('falsifier: 20 hand edits → at least 18 reindexed within 60s', async () => {
    const f = fixture();
    const N = 20;
    for (let i = 0; i < N; i++) write(f.root, `f${i}.md`, `# F${i}\n\nv1\n`);
    await f.vault.reindex(HOST);

    const seen = new Set<string>();
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      onReindexed: (info) => seen.add(`${info.tenant}:${info.path}`),
    });
    try {
      for (let i = 0; i < N; i++) write(f.root, `f${i}.md`, `# F${i}\n\nv2-${i}\n`);
      await waitFor(() => seen.size >= 18, 60_000, 'almeno 18 reindex su 20');
      expect(seen.size).toBeGreaterThanOrEqual(18);
    } finally {
      w.stop();
    }
  }, 65_000);

  it('a deleted file does not throw — its rows retire on the next full reindex', async () => {
    const f = fixture();
    write(f.root, 'via.md', '# V\n\ntesto\n');
    await f.vault.reindex(HOST);

    const errors: unknown[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      onError: (e) => errors.push(e),
    });
    try {
      const { rmSync } = await import('node:fs');
      rmSync(join(f.root, 'via.md'));
      await new Promise((r) => setTimeout(r, 400));
      expect(errors).toEqual([]);
      const audit = await f.vault.audit(HOST);
      expect(audit.orphaned).toContain('via.md');
    } finally {
      w.stop();
    }
  });
});

describe('startVaultWatcher — the seam the gateway would call', () => {
  it('wires the real vault and store over the shared root', async () => {
    const f = fixture();
    write(f.root, 'a.md', '# A\n\nprima\n');
    await f.vault.reindex(HOST);

    const seen: { tenant: string; path: string }[] = [];
    const w = startVaultWatcher({
      vault: f.vault,
      store: f.store,
      root: f.root,
      debounceMs: 50,
      onReindexed: (info) => seen.push(info),
    });
    try {
      write(f.root, 'a.md', '# A\n\ndopo\n');
      await waitFor(() => seen.length > 0, 5000, 'reindex via seam');
      expect(seen).toContainEqual({ tenant: HOST, path: 'a.md' });
    } finally {
      w.stop();
    }
  });

  it('MUFFIN_VAULT_WATCH=0 watches nothing — explicit reindex stays the path', async () => {
    vi.stubEnv(VAULT_WATCH_ENV, '0');
    const f = fixture();
    write(f.root, 'a.md', '# A\n\nprima\n');
    await f.vault.reindex(HOST);

    let calls = 0;
    const w = startVaultWatcher({
      vault: f.vault,
      store: f.store,
      root: f.root,
      onReindexed: () => calls++,
    });
    try {
      expect(w.watched).toBe(0);
      write(f.root, 'a.md', '# A\n\ndopo\n');
      await new Promise((r) => setTimeout(r, 300));
      expect(calls).toBe(0);
      w.stop();
    } finally {
      w.stop();
    }
  });
});
