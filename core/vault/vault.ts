import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  extractDocument,
  readableText,
  sniffFormat,
  type DocumentFormat,
  type ExtractedDocument,
} from '../documents/extract.js';
import { outlineOf, partsOf } from '../documents/outline.js';
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
 *
 * **What counts as text is decided by `core/documents`, not here** (M5-bis C7).
 * Until that module existed this file read utf-8 or nothing, so a PDF landing in
 * the vault was recorded as *"non è testo — serve un estrattore"* and never
 * indexed: the owner sent a document, Muffin kept the bytes, and no word of it
 * was ever recallable. The whole extracted text is chunked and stored — not a
 * summary, not the first page — because a document truncated on the way in
 * cannot be un-truncated later, and nothing downstream can even tell.
 */

/**
 * Files above this are skipped with a reason rather than read into memory.
 *
 * Raised from 5 MB when PDFs became indexable: the one path that puts files
 * here automatically is a Telegram attachment, and the public Bot API stops at
 * 20 MB (`connectors/telegram/media.ts`). At 5 MB the system accepted a file it
 * would then refuse to index — the owner sends an 8 MB scan of a contract, gets
 * "received", and the document is nowhere. The cost that actually matters is
 * the *extracted* text, which is bounded by what a document contains rather
 * than by how many megabytes of images it carries.
 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

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

/** The refusal reason for an entry whose resolved path leaves the vault root. */
const WHY_OUTSIDE =
  'link esterno al vault: non indicizzato perché document_read non può rileggere una fonte mutabile';

/**
 * Is `real` the vault root, or below it — **by path segments**, never by string
 * prefix.
 *
 * `startsWith(rootReal)` would answer yes for `/a/vault-evil` against `/a/vault`,
 * which is a whole sibling directory smuggled inside the boundary by nothing
 * more than sharing six characters. Comparing `${rootReal}${sep}` is what makes
 * the question "is this path under that directory" instead of "does this string
 * begin with those bytes".
 */
function insideRoot(rootReal: string, real: string): boolean {
  return real === rootReal || real.startsWith(`${rootReal}${sep}`);
}

/**
 * Applied to the path **relative to the vault root**, on both the name in the
 * listing and the resolved target — never to an absolute path.
 *
 * It used to split the resolved *absolute* path too, so that a symlink called
 * `appunti` pointing at `~/.ssh` could not walk past a filter that only looked
 * at what it was called here. That reasoning was right about symlinks and wrong
 * about where the answer lives: escaping the vault is a **containment**
 * question, and `insideRoot` above answers it with a better message. Inspecting
 * the absolute path meanwhile made the filter depend on where the vault happens
 * to sit — and the Muffin home is `~/.muffin`, so on the owner's real
 * installation the segment `.muffin` matched and *every file ever sent* was
 * refused as «nascosto». Measured 2026-09-03: three files in the vault, zero
 * `kind='document'` episodes, and a green test suite whose temp homes had no
 * dot segment in them.
 *
 * The reason names the segment that actually triggered it, because "nascosto:
 * i dotfile non sono note" printed over `inbox/cv.pdf` is a sentence the owner
 * can neither believe nor act on.
 */
function skipReason(relPath: string, relReal: string): string | null {
  const segments = [...relPath.split('/'), ...relReal.split(sep)];
  for (const segment of segments) {
    if (segment.startsWith('.') && segment !== '.' && segment !== '..') {
      return `nascosto: «${segment}» inizia con un punto — i dotfile non sono note e a volte sono chiavi`;
    }
    if (NEVER_CONTENT.has(segment.toLowerCase())) {
      return `«${segment}» è un nome che non è mai contenuto`;
    }
  }
  return null;
}

type VaultFile = {
  /** Relative to the vault root, with forward slashes: it goes in the database. */
  path: string;
  bytes: number;
  /** Set when the entry was reached through a symlink, so a report can say so. */
  linkedTo?: string;
};

/**
 * A document this run put into memory, and the compact view of it.
 *
 * Carried on the report rather than left for the caller to rebuild, because the
 * caller that needs it is a connector: the Telegram surface has to tell the
 * model what just arrived, and a connector that re-opened the file to work it
 * out would be the second place that knows how to read a PDF.
 */
type IndexedDocument = {
  path: string;
  format: DocumentFormat;
  /** Pages for a PDF, blocks otherwise — the unit `document_read` takes. */
  parts: number;
  chars: number;
  title: string | null;
  /** The index plus the way back in. See `core/documents/outline.ts`. */
  outline: string;
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
  documents: IndexedDocument[];
  /**
   * Something went wrong that did not stop the indexing — today, an embedder
   * that is not answering.
   *
   * It exists because the alternative was letting that throw out of `reindex`,
   * and the caller on the real path is the Telegram connector: an owner with no
   * embedder running sent a PDF, the text was chunked and written, and the
   * answer was *"allegato NON ricevuto"*. The document was in memory and the
   * only person who could not find it was the one who sent it. Same decision
   * `ingestPending` already takes for the same reason — the backlog is
   * idempotent, so a down embedder costs a retry, never the extraction.
   */
  errors: string[];
};

export type ReindexOptions = {
  /** Applied to files not already known. Existing tiers are never raised. */
  defaultTier?: TrustTier;
  now?: () => Date;
  vectors?: VectorIndex | undefined;
};

type VaultScan = {
  files: VaultFile[];
  skipped: { path: string; why: string }[];
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
   * Symlinks are followed only when their target remains inside the vault.
   * External targets used to be indexed but could never be reopened by
   * `document_read`; allowing the later read would instead create a TOCTOU path
   * where retargeting the link changes the source after indexing. The honest
   * boundary is therefore visible refusal until external material is imported
   * into immutable storage inside the vault.
   *
   * `audit()` and `reindex()` both go through here on purpose: one enumeration,
   * so they cannot drift.
   */
  list(): VaultScan {
    const files: VaultFile[] = [];
    const skipped: { path: string; why: string }[] = [];
    const visited = new Set<string>();
    const rootReal = realpathSync(this.root);

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

        // Containment first, and the name filter only afterwards, on paths that
        // are already known to live under the root. The order is the fix: it is
        // what keeps the dot rule from ever seeing the directory the vault is
        // installed in.
        if (!insideRoot(rootReal, real)) {
          skipped.push({ path: rel, why: WHY_OUTSIDE });
          continue;
        }

        const reason = skipReason(rel, relative(rootReal, real));
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
    return this.indexScan(tenantId, this.list(), options, true);
  }

  /**
   * Indexes exactly one file already inside the vault.
   *
   * An attachment arrival is not a request to grant its tenant visibility over
   * every other file in the shared vault. The old connector called `reindex`
   * here: the tenant was correct, but the scan copied private owner notes into a
   * group tenant and made every attachment O(vault size). Keep the full scan for
   * explicit maintenance commands; ingress paths must name the bytes they own.
   */
  async reindexPath(
    tenantId: string,
    vaultPath: string,
    options: ReindexOptions = {},
  ): Promise<VaultReport> {
    return this.indexScan(tenantId, this.scanPath(vaultPath), options, false);
  }

  private scanPath(vaultPath: string): VaultScan {
    const skipped = (why: string): VaultScan => ({ files: [], skipped: [{ path: vaultPath, why }] });
    const root = resolve(this.root);
    const full = resolve(root, vaultPath);
    const normalized = relative(root, full).split(sep).join('/');

    // A vault path is a durable identifier as well as a filesystem location.
    // Accepting aliases such as `a/../b` would let the index and document_read
    // disagree about which identifier owns the bytes.
    if (normalized === '' || normalized === '..' || normalized.startsWith('../') || normalized !== vaultPath) {
      return skipped('percorso fuori dal vault o non canonico');
    }

    let real: string;
    let stat;
    try {
      real = realpathSync(full);
      stat = statSync(full);
    } catch {
      return skipped('file illeggibile o inesistente');
    }

    const rootReal = realpathSync(this.root);
    if (!insideRoot(rootReal, real)) return skipped(WHY_OUTSIDE);
    const reason = skipReason(normalized, relative(rootReal, real));
    if (reason !== null) return skipped(reason);
    if (!stat.isFile()) return skipped('non è un file');

    return {
      files: [{ path: normalized, bytes: stat.size, ...(real !== full ? { linkedTo: real } : {}) }],
      skipped: [],
    };
  }

  private async indexScan(
    tenantId: string,
    scan: VaultScan,
    options: ReindexOptions,
    retireMissing: boolean,
  ): Promise<VaultReport> {
    const now = (options.now ?? (() => new Date()))().toISOString();
    const defaultTier = options.defaultTier ?? 0;
    const report: VaultReport = {
      scanned: 0, added: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0, indexed: 0,
      skipped: [], documents: [], errors: [],
    };

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

      const identity = identityOf(join(this.root, file.path));
      if (identity === null) {
        // No extractor for these bytes — an image, an archive, a binary. Media
        // handling is a separate pipeline (ADR-0023) and saying so beats
        // indexing an empty document that looks handled.
        report.skipped.push({ path: file.path, why: 'non è testo né PDF né DOCX — serve un estrattore' });
        continue;
      }

      const existing = this.store.episodesForVaultPath(tenantId, file.path);
      const existingHash = existing.length > 0 ? metaOf(existing[0]!.mediaMeta).hash : undefined;

      // Before extraction, not after: this is what keeps a maintenance reindex
      // cheap now that a document can cost a PDF parse. An unchanged PDF must
      // cost one read and one hash — never a re-parse to discover it had not
      // changed.
      if (existingHash === identity.hash) {
        report.unchanged += 1;
        continue;
      }

      const extraction = await extractDocument(readFileSync(join(this.root, file.path)));
      if (!extraction.ok) {
        // The extractor's own words. A scanned PDF says it is a scan and that
        // there is no OCR here; an empty note says it is empty. What must never
        // happen is the middle case — indexing the empty string a scan returns,
        // which records the document as read.
        report.skipped.push({ path: file.path, why: extraction.why });
        continue;
      }
      const document = extraction.document;
      const hash = identity.hash;

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

      // Chunked part by part rather than over the whole text, so no chunk ever
      // straddles a page boundary and every one carries the page it came from.
      // A recalled fragment that says `p. 12` can be checked by opening the
      // file; one that says only the filename cannot, and an eighty-page PDF
      // indexed as one flat string is exactly that.
      const parts = partsOf(document);
      const chunks = parts.flatMap((part) =>
        chunkDocument(part.text, {
          source: file.path,
          ...(document.title === null ? {} : { title: document.title }),
          ...(parts.length > 1 ? { headings: [part.label] } : {}),
        }).map((chunk) => ({ ...chunk, part: part.n })),
      );

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
            format: document.format,
            ...(parts.length > 1 ? { part: chunk.part } : {}),
            ...(chunk.headings.length > 0 ? { headings: chunk.headings } : {}),
          },
          trustTier: tier,
          createdAt: now,
        });
        report.chunks += 1;
      }

      report.documents.push({
        path: file.path,
        format: document.format,
        parts: parts.length,
        chars: document.chars,
        title: document.title,
        outline: outlineOf(document, file.path),
      });
    }

    // Files that are no longer on disk: the source is gone, so the index must
    // stop answering from it.
    if (retireMissing) {
      for (const known of this.store.vaultPaths(tenantId)) {
        if (seen.has(known.vaultPath)) continue;
        const stale = this.store.episodesForVaultPath(tenantId, known.vaultPath);
        retired.push(...stale.map((e) => e.id));
        report.removed += 1;
      }
    }

    if (retired.length > 0) {
      this.store.supersedeEpisodes(tenantId, retired, now);
      // The vectors are derived, so dropping them is not deletion of evidence —
      // and leaving them would keep retired text winning searches.
      options.vectors?.forget(tenantId, 'episode', retired);
    }

    if (options.vectors) {
      // After the writes and separately from them. The chunks are already in the
      // evidence plane at this point, so an embedder that is down degrades recall
      // to keyword search for these rows until the next run picks up the backlog
      // — it does not undo the indexing, and above all it does not make the
      // caller report that the document never arrived.
      try {
        const backlog = options.vectors.indexBacklog(tenantId);
        if (backlog.length > 0) report.indexed = await options.vectors.index(tenantId, backlog, now);
      } catch (error) {
        report.errors.push(
          `indice vettoriale: ${error instanceof Error ? error.message : String(error)} — ` +
            'il recall su questi documenti resta testuale finché non riparte',
        );
      }
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
   *
   * Cheap **because of the order it asks questions in**, which is the same order
   * `reindex` uses: identity first (a hash of the bytes, or of the text for a
   * note), extraction only where the answer depends on it. A converged vault
   * therefore never parses a PDF here; only a document that is on disk and
   * absent from the index does, and only to settle the one thing a hash cannot
   * say — whether it is missing or is a scan that legitimately has nothing to
   * index. Without that step `doctor` would report every scanned PDF as drift,
   * for ever, with a remedy (`muffin vault reindex`) that cannot fix it.
   */
  async audit(tenantId: string): Promise<VaultAudit> {
    const missing: string[] = [];
    const stale: string[] = [];
    const orphaned: string[] = [];
    const onDisk = new Map<string, string>();

    // The same enumeration `reindex` uses, including the symlink handling and
    // the filter. Two sides of a comparison that disagree about what exists are
    // not a comparison.
    for (const file of this.list().files) {
      if (file.bytes > MAX_FILE_BYTES) continue;
      const identity = identityOf(join(this.root, file.path));
      // Bytes no extractor handles are skipped by reindex too, so their absence
      // from the index is correct rather than drift.
      if (identity === null) continue;
      onDisk.set(file.path, identity.hash);
    }

    const indexed = new Map(this.store.vaultPaths(tenantId).map((v) => [v.vaultPath, v]));

    for (const [path, hash] of onDisk) {
      const rows = this.store.episodesForVaultPath(tenantId, path);
      if (rows.length === 0) {
        const extraction = await extractDocument(readFileSync(join(this.root, path)));
        if (extraction.ok) missing.push(path);
        continue;
      }
      if (metaOf(rows[0]!.mediaMeta).hash !== hash) stale.push(path);
    }

    for (const path of indexed.keys()) {
      if (!onDisk.has(path)) orphaned.push(path);
    }

    return { files: onDisk.size, indexed: indexed.size, missing, stale, orphaned };
  }

  /**
   * The whole text of one indexed document, re-read from the file.
   *
   * The drill-down's source, and it is the *file* on purpose. This module's
   * first sentence is that the files are the source and the index is derived —
   * so a portion the model asks for comes from the document, never from a
   * reassembly of chunks that each carry a context line the document does not
   * contain. `null` when the path is not a live document of this tenant, which
   * is also the tenant check: a group's turn cannot name a host document into
   * existence.
   */
  async document(tenantId: string, vaultPath: string): Promise<ExtractedDocument | null> {
    const rows = this.store.episodesForVaultPath(tenantId, vaultPath);
    if (rows.length === 0) return null;
    // Resolved before it is opened. The path arrives from a model, and the only
    // thing standing between `../../.ssh/id_rsa` and a read is that it also has
    // to be indexed — belt and braces, because the two conditions fail for
    // different reasons and a future caller may only have one of them.
    const full = join(this.root, vaultPath);
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      return null;
    }
    if (!insideRoot(realpathSync(this.root), real)) return null;
    const extraction = await extractDocument(readFileSync(real));
    return extraction.ok ? extraction.document : null;
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

/**
 * What this file is, and what identifies it — without extracting it.
 *
 * `null` means no extractor handles these bytes, which is the same answer
 * `reindex` and `audit` both need before they do anything else.
 *
 * The hash is over **the text for a note and over the bytes for everything
 * else**, and that asymmetry is deliberate rather than an oversight. A note's
 * identity has always been its text and changing it now would mark every
 * already-indexed note stale for no gain. A PDF cannot use the same rule: its
 * text is only knowable by parsing it, so hashing the text would mean parsing
 * every document in the vault on every reindex — and a reindex runs each time
 * an attachment lands. Hashing the bytes answers "did this change" for the
 * price of a read, which is what makes the extraction-only-when-changed path
 * above possible at all.
 *
 * An empty note is `null` too: it is what `reindex` skips as `vuoto`, and the
 * two sides of the audit have to agree on that or a blank file reads as drift.
 */
function identityOf(path: string): { format: DocumentFormat; hash: string } | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  const format = sniffFormat(bytes);
  if (format === null) return null;
  if (format === 'text') {
    const text = readableText(bytes);
    if (text === null || text.trim() === '') return null;
    return { format, hash: hashOf(text) };
  }
  return { format, hash: hashOf(bytes) };
}

/** Content identity. Short because it is compared, never used as a secret. */
function hashOf(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function metaOf(raw: string | null): { hash?: string; tier?: TrustTier } {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as { hash?: string; tier?: TrustTier };
  } catch {
    return {};
  }
}
