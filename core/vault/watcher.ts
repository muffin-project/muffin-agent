import { type Dirent, type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { VectorIndex } from '../memory/vectors.js';
import type { TrustTier } from '../policy/types.js';
import type { Vault, VaultStore } from './vault.js';

/**
 * Hand edits, noticed.
 *
 * `reindex()` converges the index and `audit()` proves it converged, but both
 * only run when someone asks — a note edited by hand sits stale until the next
 * explicit `muffin vault reindex`. This watches the vault root and attempts to
 * reindex changed files for every tenant that references them. `fs.watch` is a
 * best-effort OS notification and can omit events, so this is an opportunistic
 * refresh, not a convergence guarantee; callers must retain explicit reindex
 * and audit paths.
 *
 * What it deliberately does **not** do, and where that case surfaces instead:
 *
 * - a brand-new file has no tenant to index it under (`tenantsForVaultPath`
 *   is empty), so it is left alone — `audit()` reports it as `missing` and
 *   `doctor` names the remedy. Guessing `host` would write one tenant's index
 *   row for bytes nobody attributed, which is a policy decision, not an
 *   optimisation;
 * - a deleted file's rows stay live until a full `reindex` retires them
 *   (`reindexPath` never retires) — `audit()` reports them as `orphaned`;
 * - symlinked directories are not followed: the watcher walks real
 *   directories only, mirroring `list()`'s containment without reimplementing
 *   its link resolution. Edits through a symlinked path rely on `audit()`.
 *
 * Recursion is manual (`watch` per directory) rather than `{ recursive: true }`,
 * which Node only honours on macOS and Windows — the production host is Linux,
 * and a watcher that silently watches only the top level there is worse than
 * none. New subdirectories picked up on `rename` events are walked at once, so
 * files that arrive together with their directory are enqueued too.
 *
 * NOT wired into any long-lived process by this slice (DT-09): `startVaultWatcher`
 * below is the tested seam the gateway would call after winning its claim and
 * stop in its `close()`. Until then the convergence path stays explicit
 * (`muffin vault reindex`) with `doctor` as the stale label.
 *
 * A root that does not exist reports through `onError` and watches nothing —
 * creating directories is a caller's decision, never a watcher's side effect.
 */

/** Quiet period before a batch of filesystem events becomes a reindex. */
export const VAULT_WATCH_DEBOUNCE_MS = 1000;

/** `MUFFIN_VAULT_WATCH=0` leaves the vault unwatched (explicit reindex only). */
export const VAULT_WATCH_ENV = 'MUFFIN_VAULT_WATCH';

export type VaultWatchEvent = {
  /** After one tenant's path was processed — including a no-op reindex of an
   * unchanged file, or a skipped one for a path that is gone (its rows retire
   * on the next full `reindex`, and `audit()` reports them meanwhile). */
  onReindexed?: (info: { tenant: string; path: string }) => void;
  onError?: (error: unknown) => void;
};

export type VaultWatcher = {
  /** Stop watching. Safe to call twice. */
  stop(): void;
  /** Paths collected since the last flush — for tests, not for display. */
  readonly pending: number;
  /** Directories currently watched — for tests, not for display. */
  readonly watched: number;
};

export type WatchVaultDeps = VaultWatchEvent & {
  root: string;
  tenantsFor: (vaultPath: string) => string[];
  reindexPath: (tenantId: string, vaultPath: string) => Promise<unknown>;
  debounceMs?: number;
  /** Native watcher override for deterministic event-path tests. */
  watchDirectory?: typeof watch;
};

export function watchVault(deps: WatchVaultDeps): VaultWatcher {
  const root = deps.root;
  const debounceMs = deps.debounceMs ?? VAULT_WATCH_DEBOUNCE_MS;
  const watchers = new Map<string, FSWatcher>();
  const pending = new Set<string>();
  const watchDirectory = deps.watchDirectory ?? watch;
  let timer: NodeJS.Timeout | undefined;
  let flushing = false;
  let stopped = false;

  const toVaultPath = (full: string): string | null => {
    const rel = relative(root, full).split(sep).join('/');
    if (rel === '' || rel === '..' || rel.startsWith('../')) return null;
    return rel;
  };

  const enqueue = (vaultPath: string): void => {
    if (stopped) return;
    pending.add(vaultPath);
    if (timer === undefined) {
      timer = setTimeout(() => void flush(), debounceMs);
      timer.unref();
    }
  };

  const flush = async (): Promise<void> => {
    timer = undefined;
    if (stopped || flushing || pending.size === 0) return;
    flushing = true;
    try {
      const batch = [...pending];
      pending.clear();
      for (const vaultPath of batch) {
        let tenants: string[];
        try {
          tenants = deps.tenantsFor(vaultPath);
        } catch (error) {
          deps.onError?.(error);
          continue;
        }
        for (const tenant of tenants) {
          if (stopped) return;
          try {
            await deps.reindexPath(tenant, vaultPath);
            deps.onReindexed?.({ tenant, path: vaultPath });
          } catch (error) {
            deps.onError?.(error);
          }
        }
      }
    } finally {
      flushing = false;
      // Events that arrived mid-flush wait for the next quiet period rather
      // than being reindexed half-applied alongside this batch.
      if (!stopped && pending.size > 0 && timer === undefined) {
        timer = setTimeout(() => void flush(), debounceMs);
        timer.unref();
      }
    }
  };

  /** Files already under a directory, so a copied-in tree is not half-seen. */
  const adoptDir = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        addDir(full);
        adoptDir(full);
      } else if (entry.isFile()) {
        const rel = toVaultPath(full);
        if (rel !== null) enqueue(rel);
      }
    }
  };

  /** Watchers over what is already there, without enqueueing: boot convergence
   * is an explicit `reindex`'s job, not a side effect of starting to watch. */
  const watchExisting = (dir: string): void => {
    addDir(dir);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      watchExisting(join(dir, entry.name));
    }
  };

  const addDir = (dir: string): void => {
    if (stopped || watchers.has(dir)) return;
    let watcher: FSWatcher;
    try {
      watcher = watchDirectory(dir, (_event, filename) => {
        if (stopped) return;
        // Node does not guarantee a filename for every fs.watch event. When
        // it is absent, reconcile this subtree instead of losing the change.
        const name = Buffer.isBuffer(filename) ? filename.toString() : filename;
        if (typeof name !== 'string' || name === '') {
          adoptDir(dir);
          return;
        }
        const full = join(dir, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          // Gone between event and stat: a deletion. Its rows retire on the
          // next full reindex; audit() reports them as orphaned meanwhile.
          // Still enqueue: if the path is re-created, tenantsFor may know it.
          const rel = toVaultPath(full);
          if (rel !== null) enqueue(rel);
          return;
        }
        if (isDir) {
          addDir(full);
          adoptDir(full);
          return;
        }
        const rel = toVaultPath(full);
        if (rel !== null) enqueue(rel);
      });
      watcher.on('error', (error) => deps.onError?.(error));
      watcher.unref();
    } catch (error) {
      deps.onError?.(error);
      return;
    }
    watchers.set(dir, watcher);
  };

  watchExisting(root);

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const w of watchers.values()) w.close();
      watchers.clear();
      pending.clear();
    },
    get pending() {
      return pending.size;
    },
    get watched() {
      return watchers.size;
    },
  };
}

export type StartVaultWatcherDeps = VaultWatchEvent & {
  vault: Pick<Vault, 'reindexPath'>;
  store: Pick<VaultStore, 'tenantsForVaultPath'>;
  /** `paths(home).vault` — the single shared root, so one watcher covers every tenant. */
  root: string;
  vectors?: VectorIndex | undefined;
  defaultTier?: TrustTier | undefined;
  debounceMs?: number;
  /** Native watcher override for deterministic event-path tests. */
  watchDirectory?: typeof watch;
};

/**
 * The seam the gateway (or any long-lived process) calls: real `Vault` and
 * real store, one watcher over the shared root.
 *
 * The vault root is single and shared — tenants differ only in index rows —
 * so there is exactly one thing to watch, and tenant attribution comes from
 * `tenantsForVaultPath` at flush time, never from the path. A `Vault` built
 * per tenant over a different root would need one watcher each; that shape
 * does not exist (`runtime.ts` and `cli/vault.ts` both build one `Vault` over
 * `paths(home).vault`), and this function does not pretend otherwise.
 */
export function startVaultWatcher(deps: StartVaultWatcherDeps): VaultWatcher {
  if (process.env[VAULT_WATCH_ENV] === '0') {
    return {
      stop() {},
      get pending() {
        return 0;
      },
      get watched() {
        return 0;
      },
    };
  }
  return watchVault({
    root: deps.root,
    tenantsFor: (vaultPath) => deps.store.tenantsForVaultPath(vaultPath),
    reindexPath: (tenantId, vaultPath) =>
      deps.vault.reindexPath(tenantId, vaultPath, {
        ...(deps.defaultTier === undefined ? {} : { defaultTier: deps.defaultTier }),
        ...(deps.vectors === undefined ? {} : { vectors: deps.vectors }),
      }),
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
    ...(deps.onReindexed === undefined ? {} : { onReindexed: deps.onReindexed }),
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    ...(deps.watchDirectory === undefined ? {} : { watchDirectory: deps.watchDirectory }),
  });
}
