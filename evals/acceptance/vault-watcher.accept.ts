import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../core/memory/store.js';
import { Vault } from '../../core/vault/vault.js';
import { startVaultWatcher, VAULT_WATCH_ENV, watchVault } from '../../core/vault/watcher.js';

/**
 * Injected watch callbacks keep these filesystem/index integration checks
 * deterministic. Native `fs.watch` event delivery is an OS best effort, so
 * it is not used as the test clock or as a convergence guarantee.
 *
 * A delivered hand-edit event must reach the index without an explicit reindex.
 *
 * The vault root is single and shared — tenants differ only in index rows —
 * so one watcher covers every tenant, and attribution comes from
 * `tenantsForVaultPath` at flush time. A path nobody references (a brand-new
 * file) has no correct tenant and is left to `audit()`: that limit is load-
 * bearing, and the second test below locks it.
 */

const HOST = 'host';
const STANZA = 'group:telegram:-100950';
const fixtureCleanups: Array<() => void> = [];
const watcherErrors: string[] = [];

function recordWatcherError(error: unknown): void {
  watcherErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

function fixture() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'muffin-vault-watch-'));
  const root = join(tempRoot, '.muffin', 'vault');
  mkdirSync(root, { recursive: true });
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const vault = new Vault(store, root);
  fixtureCleanups.push(() => {
    try {
      db.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
  return { root, db, store, vault };
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function controlledWatch() {
  type Listener = (eventType: string, filename: string | Buffer | null) => void;
  const listeners = new Map<string, Listener>();
  const watchDirectory = ((dir: string, listener: Listener) => {
    listeners.set(dir, listener);
    const handle = new EventEmitter() as unknown as FSWatcher;
    handle.close = () => {
      listeners.delete(dir);
    };
    handle.ref = () => handle;
    handle.unref = () => handle;
    return handle;
  }) as typeof import('node:fs').watch;

  return {
    watchDirectory,
    emit(dir: string, filename: string | Buffer | null) {
      listeners.get(dir)?.('change', filename);
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) {
      const detail = watcherErrors.length > 0 ? `; watcherErrors=${watcherErrors.join('; ')}` : '';
      throw new Error(`timeout aspettando: ${what}${detail}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
  watcherErrors.length = 0;
  vi.unstubAllEnvs();
});

describe('vault watcher', () => {
  it('reindexes a hand-edited file for the tenant that references it', async () => {
    const f = fixture();
    write(f.root, 'a.md', '# A\n\nprima\n');
    await f.vault.reindex(HOST);

    const fakeWatch = controlledWatch();
    const seen: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      watchDirectory: fakeWatch.watchDirectory,
      onReindexed: (info) => seen.push(info),
      onError: recordWatcherError,
    });
    try {
      expect(w.watched).toBeGreaterThanOrEqual(1);
      expect(w.pending).toBe(0);

      write(f.root, 'a.md', '# A\n\nseconda\n');
      fakeWatch.emit(f.root, 'a.md');
      await waitFor(() => seen.length > 0, 5000, 'reindex di a.md');

      expect(seen).toContainEqual({ tenant: HOST, path: 'a.md' });
      // E il nuovo testo risponde davvero al recall.
      expect(f.store.searchEpisodes(HOST, 'seconda')).toHaveLength(1);
    } finally {
      w.stop();
    }
  });

  it('rescans the directory when the host omits the changed filename', async () => {
    const f = fixture();
    write(f.root, 'a.md', '# A\n\nprima\n');
    await f.vault.reindex(HOST);

    const fakeWatch = controlledWatch();
    const seen: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      watchDirectory: fakeWatch.watchDirectory,
      onReindexed: (info) => seen.push(info),
      onError: recordWatcherError,
    });
    try {
      write(f.root, 'a.md', '# A\n\ndopo\n');
      fakeWatch.emit(f.root, null);
      await waitFor(() => seen.length > 0, 1000, 'reindex after filename omitted');

      expect(seen).toContainEqual({ tenant: HOST, path: 'a.md' });
      expect(f.store.searchEpisodes(HOST, 'dopo')).toHaveLength(1);
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

    const fakeWatch = controlledWatch();
    const seen: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      watchDirectory: fakeWatch.watchDirectory,
      onReindexed: (info) => seen.push(info),
      onError: recordWatcherError,
    });
    try {
      write(f.root, 'condiviso.md', '# C\n\ndue\n');
      fakeWatch.emit(f.root, 'condiviso.md');
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

    const fakeWatch = controlledWatch();
    const calls: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: async (t, p) => {
        calls.push({ tenant: t, path: p });
      },
      debounceMs: 50,
      watchDirectory: fakeWatch.watchDirectory,
      onError: recordWatcherError,
    });
    try {
      write(f.root, 'nuova.md', '# N\n\nappena creata\n');
      fakeWatch.emit(f.root, 'nuova.md');
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

    const fakeWatch = controlledWatch();
    const seen: { tenant: string; path: string }[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      watchDirectory: fakeWatch.watchDirectory,
      onReindexed: (info) => seen.push(info),
      onError: recordWatcherError,
    });
    try {
      expect(w.watched).toBeGreaterThanOrEqual(2);
      write(f.root, 'sub/nota.md', '# S\n\ndue\n');
      fakeWatch.emit(join(f.root, 'sub'), 'nota.md');
      await waitFor(() => seen.length > 0, 5000, 'reindex di sub/nota.md');
      expect(seen).toContainEqual({ tenant: HOST, path: 'sub/nota.md' });
    } finally {
      w.stop();
    }
  });

  /**
   * All 20 delivered events must survive batching and reach the real vault
   * store. Native OS delivery is deliberately outside this deterministic test.
   */
  it('reindexes all 20 delivered edits in one batch', async () => {
    const f = fixture();
    const N = 20;
    for (let i = 0; i < N; i++) write(f.root, `f${i}.md`, `# F${i}\n\nv1\n`);
    await f.vault.reindex(HOST);

    const seen = new Set<string>();
    const fakeWatch = controlledWatch();
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      watchDirectory: fakeWatch.watchDirectory,
      onReindexed: (info) => seen.add(`${info.tenant}:${info.path}`),
      onError: recordWatcherError,
    });
    try {
      for (let i = 0; i < N; i++) {
        write(f.root, `f${i}.md`, `# F${i}\n\nv2-${i}\n`);
        fakeWatch.emit(f.root, `f${i}.md`);
      }
      await waitFor(() => seen.size === N, 5000, 'tutti i 20 path');
      expect(seen.size).toBe(N);
    } finally {
      w.stop();
    }
  }, 7000);

  it('a deleted file does not throw — its rows retire on the next full reindex', async () => {
    const f = fixture();
    write(f.root, 'via.md', '# V\n\ntesto\n');
    await f.vault.reindex(HOST);

    const errors: unknown[] = [];
    const fakeWatch = controlledWatch();
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      watchDirectory: fakeWatch.watchDirectory,
      onError: (e) => {
        errors.push(e);
        recordWatcherError(e);
      },
    });
    try {
      const { rmSync } = await import('node:fs');
      rmSync(join(f.root, 'via.md'));
      fakeWatch.emit(f.root, 'via.md');
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

    const fakeWatch = controlledWatch();
    const seen: { tenant: string; path: string }[] = [];
    const w = startVaultWatcher({
      vault: f.vault,
      store: f.store,
      root: f.root,
      debounceMs: 50,
      watchDirectory: fakeWatch.watchDirectory,
      onReindexed: (info) => seen.push(info),
      onError: recordWatcherError,
    });
    try {
      write(f.root, 'a.md', '# A\n\ndopo\n');
      fakeWatch.emit(f.root, 'a.md');
      try {
        await waitFor(() => seen.length > 0, 5000, 'reindex via seam');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message}; watched=${w.watched}; watcherErrors=${watcherErrors.join('; ') || 'none'}`,
          { cause: error },
        );
      }
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
