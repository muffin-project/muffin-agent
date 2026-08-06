import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { MemoryStore } from '../memory/store.js';
import type { VectorIndex } from '../memory/vectors.js';
import type { TrustTier } from '../policy/types.js';
import { chunkDocument } from './chunk.js';

/**
 * The vault: notes, documents, imports.
 *
 * **The files are the source.** The index — episodes, FTS rows, vectors — is
 * derived and can be thrown away and rebuilt from the directory at any time.
 * That is not a slogan: it decides what happens when the two disagree. If a
 * file changes, the index is wrong and gets rebuilt. There is no path where the
 * index wins, and therefore no path where the system quietly holds a version of
 * your notes that you cannot find on disk and edit.
 *
 * Every indexed chunk is an `episodes` row with `kind='document'` and its
 * `vault_path`, which means it inherits the whole evidence plane for free: the
 * same provenance, the same trust tier, the same recall, the same `why`. A PDF
 * pulled off the web is tier 3 and stays tier 3 — including through a reindex,
 * which is the one place a naive implementation would launder it back to tier 0.
 *
 * What it does not do, deliberately: documents are indexed for **recall**, never
 * mined for facts. A downloaded paper full of confident claims is not a source
 * of beliefs about the owner's life, and the cheapest way to guarantee that is
 * to never let a document reach the extraction pipeline. If something in a note
 * should become a belief, the owner says it in conversation and it arrives as
 * evidence with a speaker attached.
 */

/** Files above this are skipped with a reason rather than read into memory. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', '__pycache__']);

/**
 * Names that are never notes, whatever directory they are sitting in.
 *
 * This list exists because the previous rule skipped hidden *directories* and
 * not hidden files, so a `.env` dropped in the vault became episodes, went into
 * full-text search, was sent to the embedder, and would have been recalled into
 * a prompt. Dotfiles are excluded wholesale — a note whose name starts with a
 * dot is not a use case worth the exposure — and these are the ones that do not
 * start with a dot.
 */
const NEVER_CONTENT = new Set([
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials', 'credentials.json',
  'secrets.json', 'service-account.json', 'keyfile.json', 'authorized_keys',
]);

/**
 * Applied to the **resolved** path, not the name in the directory listing: a
 * symlink called `appunti` pointing at `~/.ssh` would otherwise walk straight
 * past a filter that only looks at what it is called here.
 */
export function skipReason(relPath: string, realPath: string): string | null {
  const segments = [...relPath.split('/'), ...realPath.split(sep)];
  for (const segment of segments) {
    if (segment.startsWith('.') && segment !== '.' && segment !== '..') {
      return 'nascosto: i dotfile non sono note e a volte sono chiavi';
    }
    if (NEVER_CONTENT.has(segment.toLowerCase())) return 'nome che non è mai contenuto';
  }
  return null;
}

export type VaultFile = {
  /** Relative to the vault root, with forward slashes: it goes in the database. */
  path: string;
  bytes: number;
  /** Set when the entry was reached through a symlink, so a report can say so. */
  linkedTo?: string;
};

export type VaultReport = {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  chunks: number;
  indexed: number;
  skipped: { path: string; why: string }[];
};

export type ReindexOptions = {
  /** Applied to files not already known. Existing tiers are never raised. */
  defaultTier?: TrustTier;
  now?: () => Date;
  vectors?: VectorIndex | undefined;
};

export class Vault {
  constructor(
    private readonly store: MemoryStore,
    private readonly root: string,
  ) {}

  /**
   * Every file under the vault root that could be content, plus the ones that
   * could not and why.
   *
   * **Symlinks are followed.** A vault whose notes live somewhere else and are
   * linked in is the ordinary setup, not an edge case, and the previous version
   * dropped them silently: `Dirent.isFile()` is false for a link, so a linked
   * note was invisible — and `audit()` built its "disk" side from this same
   * function, which meant the two sides that exist to disagree shared a blind
   * spot. Following them means the filter has to run on the resolved path, which
   * it does.
   *
   * `audit()` and `reindex()` both go through here on purpose: one enumeration,
   * so they cannot drift.
   */
  list(): { files: VaultFile[]; skipped: { path: string; why: string }[] } {
    const files: VaultFile[] = [];
    const skipped: { path: string; why: string }[] = [];
    const visited = new Set<string>();

    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // an unreadable directory is not an error worth aborting a scan for
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        const rel = relative(this.root, full).split(sep).join('/');

        let real: string;
        let stat;
        try {
          real = realpathSync(full);
          stat = statSync(full); // follows the link, which is the point
        } catch {
          skipped.push({ path: rel, why: 'link rotto o file illeggibile' });
          continue;
        }

        const reason = skipReason(rel, real);
        if (reason !== null) {
          skipped.push({ path: rel, why: reason });
          continue;
        }

        // A link back into the tree, or a cycle, would otherwise walk for ever.
        if (visited.has(real)) {
          skipped.push({ path: rel, why: `già indicizzato come altro percorso` });
          continue;
        }
        visited.add(real);

        if (stat.isDirectory()) walk(full);
        else if (stat.isFile()) {
          files.push({
            path: rel,
            bytes: stat.size,
            ...(real !== full ? { linkedTo: real } : {}),
          });
        }
      }
    };
    walk(this.root);
    return { files, skipped };
  }

  /**
   * Brings the index in line with the directory.
   *
   * Unchanged files cost one hash. Changed files retire their old chunks and
   * write new ones. Files that disappeared retire theirs. Nothing is deleted
   * from the evidence plane — "what did that note say in May" stays answerable.
   */
  async reindex(tenantId: string, options: ReindexOptions = {}): Promise<VaultReport> {
    const now = (options.now ?? (() => new Date()))().toISOString();
    const defaultTier = options.defaultTier ?? 0;
    const report: VaultReport = {
      scanned: 0, added: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0, indexed: 0, skipped: [],
    };

    const scan = this.list();
    report.skipped.push(...scan.skipped);
    const seen = new Set<string>();
    const retired: number[] = [];

    for (const file of scan.files) {
      report.scanned += 1;
      seen.add(file.path);

      if (file.bytes > MAX_FILE_BYTES) {
        report.skipped.push({ path: file.path, why: `${(file.bytes / 1e6).toFixed(1)}MB, oltre il limite` });
        continue;
      }

      const text = readText(join(this.root, file.path));
      if (text === null) {
        // Binary, for now. Media handling is a separate pipeline (ADR-0023) and
        // saying so beats indexing an empty document that looks handled.
        report.skipped.push({ path: file.path, why: 'non è testo — serve un estrattore' });
        continue;
      }
      if (text.trim() === '') {
        report.skipped.push({ path: file.path, why: 'vuoto' });
        continue;
      }

      const hash = hashOf(text);
      const existing = this.store.episodesForVaultPath(tenantId, file.path);
      const existingHash = existing.length > 0 ? metaOf(existing[0]!.mediaMeta).hash : undefined;

      if (existingHash === hash) {
        report.unchanged += 1;
        continue;
      }

      // Trust never rises on reindex, and it follows the **content** rather than
      // the path: inheriting by `vault_path` meant renaming a tier-3 import
      // laundered it to the caller's default, because the new path was unknown.
      // The bytes are the same bytes whatever they are called.
      const inheritedTier =
        (existing.length > 0 ? metaOf(existing[0]!.mediaMeta).tier : undefined) ??
        this.store.maxTierForContent(tenantId, hash) ??
        undefined;
      const tier = (inheritedTier ?? defaultTier) as TrustTier;

      if (existing.length > 0) {
        retired.push(...existing.map((e) => e.id));
        report.updated += 1;
      } else {
        report.added += 1;
      }

      const chunks = chunkDocument(text, { source: file.path });
      for (const [i, chunk] of chunks.entries()) {
        this.store.addEpisode({
          tenantId,
          connector: 'vault',
          threadKey: file.path,
          role: 'user',
          kind: 'document',
          // The context line is part of the stored text, not decoration added at
          // read time: it has to be there when the embedder sees it, when FTS
          // indexes it, and when the reranker reads the candidate.
          content: chunk.text,
          vaultPath: file.path,
          mediaMeta: {
            hash,
            tier,
            chunk: i + 1,
            of: chunks.length,
            ...(chunk.headings.length > 0 ? { headings: chunk.headings } : {}),
          },
          trustTier: tier,
          createdAt: now,
        });
        report.chunks += 1;
      }
    }

    // Files that are no longer on disk: the source is gone, so the index must
    // stop answering from it.
    for (const known of this.store.vaultPaths(tenantId)) {
      if (seen.has(known.vaultPath)) continue;
      const stale = this.store.episodesForVaultPath(tenantId, known.vaultPath);
      retired.push(...stale.map((e) => e.id));
      report.removed += 1;
    }

    if (retired.length > 0) {
      this.store.supersedeEpisodes(retired, now);
      // The vectors are derived, so dropping them is not deletion of evidence —
      // and leaving them would keep retired text winning searches.
      options.vectors?.forget(tenantId, 'episode', retired);
    }

    if (options.vectors) {
      const backlog = options.vectors.indexBacklog(tenantId);
      if (backlog.length > 0) report.indexed = await options.vectors.index(tenantId, backlog, now);
    }

    return report;
  }

  /**
   * Compares the directory against the index and reports every disagreement.
   *
   * This exists because "the change detection works" and "the index converged"
   * are different claims, and the second one is the one that matters. Three
   * systems examined for this design have the same open failure: Khoj logs
   * "hash calculations complete normally" and then stops without indexing
   * (khoj#1105); Reor's file watcher updates the UI and carries a literal
   * `// TODO: add logic to update vector db`, and users report edits that never
   * reindex (reor#118); and this project's own predecessor kept empty vector
   * tables for weeks behind a silent catch.
   *
   * In all three the detection mechanism was present and looked healthy. What
   * was missing was anything that ever compared the two sides. So: this does,
   * and it is cheap enough to run in `doctor`.
   */
  audit(tenantId: string): VaultAudit {
    const missing: string[] = [];
    const stale: string[] = [];
    const orphaned: string[] = [];
    const onDisk = new Map<string, string>();

    // The same enumeration `reindex` uses, including the symlink handling and
    // the filter. Two sides of a comparison that disagree about what exists are
    // not a comparison.
    for (const file of this.list().files) {
      if (file.bytes > MAX_FILE_BYTES) continue;
      const text = readText(join(this.root, file.path));
      // Unreadable files are skipped by reindex too, so their absence from the
      // index is correct rather than drift.
      if (text === null || text.trim() === '') continue;
      onDisk.set(file.path, hashOf(text));
    }

    const indexed = new Map(this.store.vaultPaths(tenantId).map((v) => [v.vaultPath, v]));

    for (const [path, hash] of onDisk) {
      const rows = this.store.episodesForVaultPath(tenantId, path);
      if (rows.length === 0) {
        missing.push(path);
        continue;
      }
      if (metaOf(rows[0]!.mediaMeta).hash !== hash) stale.push(path);
    }

    for (const path of indexed.keys()) {
      if (!onDisk.has(path)) orphaned.push(path);
    }

    return { files: onDisk.size, indexed: indexed.size, missing, stale, orphaned };
  }
}

export type VaultAudit = {
  files: number;
  indexed: number;
  /** On disk, absent from the index. */
  missing: string[];
  /** Indexed, but the file has changed since. */
  stale: string[];
  /** In the index, gone from disk. */
  orphaned: string[];
};

/** utf-8 or nothing. A NUL byte in the first block is the practical test for binary. */
function readText(path: string): string | null {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return null;
  }
  if (buffer.subarray(0, 8192).includes(0)) return null;
  const text = buffer.toString('utf8');
  // A lossy decode leaves replacement characters; a handful in a long file is
  // normal, a field of them means this was never text.
  const replacements = (text.match(/�/g) ?? []).length;
  if (replacements > Math.max(4, text.length / 1000)) return null;
  return text;
}

/** Content identity. Short because it is compared, never used as a secret. */
export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function metaOf(raw: string | null): { hash?: string; tier?: TrustTier } {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as { hash?: string; tier?: TrustTier };
  } catch {
    return {};
  }
}
