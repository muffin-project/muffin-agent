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

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout aspettando: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// NOTA — warmup della sottoscrizione OS (nessun helper: deve girare sul
// watcher vero, non su una seconda sottoscrizione che non proverebbe nulla
// sulla prima).
//
// `fs.watch` stabilisce la sottoscrizione in modo asincrono: una scrittura
// subito dopo `watchVault()` può atterrare prima che l'OS ascolti, l'evento
// non nasce mai e il test fallisce al `waitFor` per una ragione che non è il
// meccanismo — misurato come flake il 18/09/2026 (verde a macchina calma,
// rosso sotto carico di suite). Perciò ogni test che scrive subito dopo aver
// costruito il watcher prima riscrive un file già indicizzato con gli stessi
// byte (mtime nuovo, contenuto cercato invariato), ne aspetta il reindex e
// svuota il collettore: l'istituzione diventa un fatto osservato. Il warmup
// non conta nel misurato.

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

      // Warmup della sottoscrizione (vedi NOTA sopra): stessi byte, mtime nuovo.
      write(f.root, 'a.md', '# A\n\nprima\n');
      await waitFor(() => seen.length > 0, 10_000, 'istituzione della sottoscrizione OS');
      seen.length = 0;

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
      // Warmup della sottoscrizione (vedi NOTA sopra).
      write(f.root, 'condiviso.md', '# C\n\nuno\n');
      await waitFor(() => seen.length >= 2, 10_000, 'istituzione della sottoscrizione OS');
      seen.length = 0;

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
      // Warmup su un file attribuito: senza, questo test passerebbe anche a
      // sottoscrizione morta (assenza non osservata). Con la sottoscrizione
      // provata viva, "nessuna chiamata per nuova.md" è un fatto e non un vuoto.
      write(f.root, 'vecchia.md', '# V\n\ntesto\n');
      await waitFor(() => calls.length > 0, 10_000, 'istituzione della sottoscrizione OS');
      calls.length = 0;

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
      // Warmup della sottoscrizione (vedi NOTA sopra).
      write(f.root, 'sub/nota.md', '# S\n\nuno\n');
      await waitFor(() => seen.length > 0, 10_000, 'istituzione della sottoscrizione OS');
      seen.length = 0;

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
      // Warmup della sottoscrizione (vedi NOTA sopra): senza, parte della
      // raffica da 20 potrebbe atterrare prima che l'OS ascolti e il conteggio
      // misurerebbe l'istituzione invece del drenaggio. La soglia 18/60s resta
      // intatta — se cade, non si cabla il watcher.
      write(f.root, 'f0.md', '# F0\n\nv1\n');
      await waitFor(() => seen.size > 0, 10_000, 'istituzione della sottoscrizione OS');
      seen.clear();

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
    const seen: string[] = [];
    const w = watchVault({
      root: f.root,
      tenantsFor: (p) => f.store.tenantsForVaultPath(p),
      reindexPath: (t, p) => f.vault.reindexPath(t, p),
      debounceMs: 50,
      onError: (e) => errors.push(e),
      onReindexed: (info) => seen.push(`${info.tenant}:${info.path}`),
    });
    try {
      const { rmSync } = await import('node:fs');
      // Warmup della sottoscrizione (vedi NOTA sopra).
      write(f.root, 'via.md', '# V\n\ntesto\n');
      await waitFor(() => seen.length > 0, 10_000, 'istituzione della sottoscrizione OS');
      seen.length = 0;
      rmSync(join(f.root, 'via.md'));
      // L'attesa fissa da 400ms è diventata un'attesa sull'esito: sotto carico
      // l'evento di cancellazione arriva tardi e il test misurava il carico,
      // non il meccanismo. L'assenza di errori resta un'asserzione secca.
      await waitFor(
        async () => (await f.vault.audit(HOST)).orphaned.includes('via.md'),
        10_000,
        'via.md orfano in audit',
      );
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
      // Warmup della sottoscrizione (vedi NOTA sopra).
      write(f.root, 'a.md', '# A\n\nprima\n');
      await waitFor(() => seen.length > 0, 10_000, 'istituzione della sottoscrizione OS');
      seen.length = 0;

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
