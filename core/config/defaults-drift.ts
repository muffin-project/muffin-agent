import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sha256 } from '../rot/verify.js';
import { paths } from './config.js';

/**
 * Drift between what `muffin init` copied into `~/.muffin` and what HEAD
 * ships in `defaults/` — the gap `muffin update` never closes on purpose
 * (`agent/context/assemble.ts`: `defaults/` exists to be edited by the
 * owner). See docs/blueprint/research/deriva-defaults-2026-08-26.md, the
 * reperto that measured this on the owner's own machine: `persona.md`,
 * `voice.md` and `rot/identity.md` sat at their `init`-day content for
 * weeks, unnoticed, because nothing ever looked.
 *
 * `muffin doctor` is the reader (`cli/doctor.ts`). This module only answers
 * the question, and — same shape as `core/rot/harden.ts` — never writes
 * anything: no file this module touches is copied, adopted or resealed by
 * running it.
 *
 * Two states look identical from the outside (an installed file that no
 * longer matches HEAD) and demand opposite treatment:
 *
 *  - never touched since `init` copied it → safe to adopt, nothing of the
 *    owner's to lose.
 *  - edited by the owner → HEAD moving on is not a defect to fix; touching
 *    it would destroy their work.
 *
 * The discriminant, in order (the research doc's own §"Cosa serve"):
 *
 *  1. **The hash `init` registered at copy time** (`recordCopied` below,
 *     called only from `cli/init.ts`, never updated afterwards by anything
 *     else — not even `muffin rot reseal`, which is exactly the case that
 *     would poison it: resealing after a hand-edit must not relabel that
 *     edit as "untouched"). Current hash equals the registered one → never
 *     touched. Needs no Git and holds on any installation.
 *  2. **Git history**, for installations that predate the registry (the
 *     owner's own, measured in the research doc): the installed content is
 *     searched for among every version `defaults/<path>` has ever had on
 *     this checkout's own HEAD ancestry. A hit is the same verdict as rule 1
 *     reaches when it has data; this is only ever consulted when rule 1 has
 *     none.
 *  3. Neither is possible (no registry entry AND no readable checkout) →
 *     "I cannot tell", declared rather than guessed (ADR-0008: degrade
 *     declared, never in silence).
 */

export type RegistryEntry = { path: string; sha256: string };

export type DefaultsRegistry = {
  schemaVersion: 1;
  /** When this registry was first created — frozen, like `RotManifest.installedAt`. */
  installedAt: string;
  files: RegistryEntry[];
};

const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Reads the registry `recordCopied` writes. `null` covers both "never
 * written" (installations older than this feature, or a fresh home before
 * `muffin init` has run) and "unreadable" — both degrade to rule 2, never to
 * a thrown error.
 */
export function readDefaultsRegistry(home: string): DefaultsRegistry | null {
  const file = paths(home).defaultsManifest;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DefaultsRegistry>;
    if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(parsed.files)) return null;
    // Each entry, not just the array around them. A file that is valid JSON,
    // carries the right schema version and holds a `null` in `files` — partial
    // corruption, an interrupted write, a hand edit — used to pass this check
    // and throw three functions later on `null.path`, taking the whole report
    // with it. `null` is this module's established "cannot trust this, ignore
    // it" answer and it already degrades safely to rule 2.
    const wellFormed = parsed.files.every(
      (f) => typeof f === 'object' && f !== null && typeof f.path === 'string' && typeof f.sha256 === 'string',
    );
    if (!wellFormed) return null;
    return parsed as DefaultsRegistry;
  } catch {
    return null;
  }
}

/**
 * Records what `muffin init` just actually wrote to disk — called only from
 * `cli/init.ts`, and only with the files it just copied (never the ones it
 * found already present and left alone: those may already carry the owner's
 * edits, and stamping them now would relabel that edit as "shipped, never
 * touched" forever). Merges into whatever the registry already had, so a
 * resumed `init` (one file copied this run, its siblings copied by an
 * earlier, interrupted run) does not lose the earlier entries.
 *
 * A no-op on an empty list — a resumed `init` where every file was already
 * present must not touch the registry's `installedAt` or rewrite a file that
 * needed no change.
 */
export function recordCopied(home: string, entries: { path: string; content: Buffer }[]): void {
  if (entries.length === 0) return;
  const existing = readDefaultsRegistry(home);
  const byPath = new Map(existing?.files.map((f) => [f.path, f] as const));
  for (const e of entries) byPath.set(e.path, { path: e.path, sha256: sha256(e.content) });
  const registry: DefaultsRegistry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    installedAt: existing?.installedAt ?? new Date().toISOString(),
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(paths(home).defaultsManifest, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

/** Relative, `/`-separated paths under `defaultsDir`, deterministic order — same shape as verify.ts's `listRotFiles`. */
function listDefaultsTree(defaultsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(defaultsDir, '');
  return out;
}

function installedPathOf(home: string, relPath: string): string {
  return join(home, ...relPath.split('/'));
}

function shippedPathOf(checkoutRoot: string, relPath: string): string {
  return join(checkoutRoot, 'defaults', ...relPath.split('/'));
}

export type DriftStatus = 'up-to-date' | 'adoptable' | 'owner-modified' | 'missing' | 'unknown';

export type DefaultDrift = {
  /** `/`-separated, relative to both `defaults/` and `~/.muffin` — e.g. `"persona.md"`, `"rot/identity.md"`. */
  path: string;
  /** Under `rot/` — adopting it needs `muffin rot reseal` afterwards (ADR-0003). */
  sealed: boolean;
  status: DriftStatus;
  /** Italian prose, ready for `cli/doctor.ts`'s `detail` field. */
  detail: string;
  /** Only ever set for `'adoptable'` — the literal command, never executed by this module. */
  adoptCommand?: string;
};

export type GitLogResult = { ok: true; commits: { sha: string; date: string }[] } | { ok: false; why: string };

/** The two git operations this module needs — injectable so a test can break "git itself" without a broken repo. */
export type Git = {
  log(cwd: string, relPath: string): GitLogResult;
  /**
   * True when this checkout carries only part of its own history.
   *
   * Measured by the judge on #142: in a `--depth 1` clone, `git log -- <path>`
   * exits **0** and returns the tip commit alone. Rule 2 then searched a
   * fraction of the history while the message still said "no shipped version
   * matches" — a sentence about the whole history, produced from a sliver of
   * it. The direction is safe (an under-search only ever pushes toward
   * "modified by the owner, do not touch"), which is exactly why it would
   * never have been noticed. Declared, not guessed: ADR-0008.
   */
  isShallow(cwd: string): boolean;
  /** Raw bytes, `null` if `relPath` did not exist at `rev` (e.g. it was added later, or deleted by then). */
  show(cwd: string, rev: string, relPath: string): Buffer | null;
};

export const REAL_GIT: Git = {
  isShallow(cwd) {
    const r = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8' });
    // A git that cannot answer is not a reason to claim depth we cannot see.
    return r.status !== 0 || r.stdout.trim() !== 'false';
  },
  log(cwd, relPath) {
    const r = spawnSync('git', ['log', '--format=%H^%ad', '--date=short', '--', relPath], { cwd, encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, why: r.stderr.trim() || `git log fallito (exit ${String(r.status)})` };
    const commits = r.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, date] = line.split('^');
        return { sha: sha ?? '', date: date ?? '' };
      })
      .filter((c) => c.sha.length > 0);
    return { ok: true, commits };
  },
  show(cwd, rev, relPath) {
    // No `encoding` on purpose: this has to see the exact bytes stored in the
    // object database, the same bytes `sha256(readFileSync(...))` sees for
    // the installed copy. A text-decoded stdout would risk a re-encoding
    // that makes two byte-identical files hash differently.
    const r = spawnSync('git', ['show', `${rev}:${relPath}`], { cwd });
    if (r.status !== 0) return null;
    return r.stdout;
  },
};

/** Every commit on this checkout's own HEAD ancestry that ever gave `defaults/<relPath>` this exact content — first match wins, `git log` is newest-first. */
function findInHistory(checkoutRoot: string, relPath: string, wantHash: string, git: Git): { sha: string; date: string } | null | 'error' {
  const shippedRelPath = `defaults/${relPath}`;
  // Before searching: a shallow checkout cannot answer this question, and
  // answering it anyway from the sliver it has is the failure this guard exists
  // for — same 'error' branch a broken `git log` already takes.
  if (git.isShallow(checkoutRoot)) return 'error';
  const log = git.log(checkoutRoot, shippedRelPath);
  if (!log.ok) return 'error';
  for (const commit of log.commits) {
    const content = git.show(checkoutRoot, commit.sha, shippedRelPath);
    if (content !== null && sha256(content) === wantHash) return commit;
  }
  return null;
}

function diagnoseOne(home: string, checkoutRoot: string | null, registry: DefaultsRegistry | null, relPath: string, git: Git): DefaultDrift {
  const sealed = relPath.startsWith('rot/');
  const installedPath = installedPathOf(home, relPath);

  if (!existsSync(installedPath)) {
    return {
      path: relPath,
      sealed,
      status: 'missing',
      detail: `${installedPath} non esiste — assente o cancellata`,
    };
  }
  const installedHash = sha256(readFileSync(installedPath));

  const shippedPath = checkoutRoot !== null ? shippedPathOf(checkoutRoot, relPath) : null;
  const shippedHash = shippedPath !== null && existsSync(shippedPath) ? sha256(readFileSync(shippedPath)) : null;

  if (shippedHash !== null && installedHash === shippedHash) {
    return { path: relPath, sealed, status: 'up-to-date', detail: 'allineato a HEAD' };
  }

  const registryHash = registry?.files.find((f) => f.path === relPath)?.sha256 ?? null;
  if (registryHash !== null) {
    if (installedHash !== registryHash) {
      return {
        path: relPath,
        sealed,
        status: 'owner-modified',
        detail: "diverge dall'hash registrato da `muffin init` alla copia — modificato dall'owner, non toccato",
      };
    }
    // Unchanged since the copy `init` made (rule 1). Whether that copy is
    // now stale is a second, independent question — answerable only with a
    // checkout to compare against.
    if (shippedPath === null) {
      return {
        path: relPath,
        sealed,
        status: 'unknown',
        detail: "invariato dalla copia di `muffin init`, ma nessun checkout Git leggibile per sapere se HEAD è andato avanti da allora",
      };
    }
    return {
      path: relPath,
      sealed,
      status: 'adoptable',
      detail: "invariato dalla copia di `muffin init` — HEAD è andato avanti da allora (hash registrato alla copia, rule 1)",
      adoptCommand: `cp ${shippedPath} ${installedPath}`,
    };
  }

  // Rule 2: no registered hash for this path (an installation older than
  // this registry, like the owner's own measured in the research doc). Only
  // reachable with a checkout — without one there is no history to search.
  if (checkoutRoot !== null && shippedPath !== null) {
    const found = findInHistory(checkoutRoot, relPath, installedHash, git);
    if (found === 'error') {
      return {
        path: relPath,
        sealed,
        status: 'unknown',
        detail: "nessun registro d'installazione e la storia Git non è leggibile — non so dire se è stato modificato dall'owner",
      };
    }
    if (found !== null) {
      return {
        path: relPath,
        sealed,
        status: 'adoptable',
        detail: `corrisponde alla versione spedita in ${found.sha.slice(0, 7)} (${found.date}), non a HEAD — nessuna versione mai spedita coincide con un edit dell'owner (rule 2, storia Git)`,
        adoptCommand: `cp ${shippedPath} ${installedPath}`,
      };
    }
    return {
      path: relPath,
      sealed,
      status: 'owner-modified',
      detail: "non corrisponde a nessuna versione mai spedita in defaults/ — modificato dall'owner, non toccato",
    };
  }

  return {
    path: relPath,
    sealed,
    status: 'unknown',
    detail: "nessun registro d'installazione e nessun checkout Git leggibile — non so dire se è stato modificato dall'owner",
  };
}

/**
 * One entry per file `muffin init` copies from `defaults/`, discovered
 * generically (never a hand-maintained list — a new file under `defaults/`
 * is covered automatically). Discovery prefers the real checkout
 * (`checkoutRoot`, `cli/update.ts`'s `findCheckoutRoot`, passed in rather
 * than resolved here — this module stays a pure reader, no `cli/` import in
 * `core/`); when that is unavailable it falls back to whatever the registry
 * already names. Both absent → an empty list, and the caller (`cli/doctor.ts`)
 * is the one that turns that into a single declared "I cannot tell" line
 * rather than N silent ones.
 */
export function diagnoseDefaultsDrift(home: string, checkoutRoot: string | null, git: Git = REAL_GIT): DefaultDrift[] {
  const registry = readDefaultsRegistry(home);
  const trackedPaths =
    checkoutRoot !== null && existsSync(join(checkoutRoot, 'defaults'))
      ? listDefaultsTree(join(checkoutRoot, 'defaults'))
      : (registry?.files.map((f) => f.path) ?? []);

  // One file's accident costs one line, never the report.
  //
  // `diagnoseOne` reads from disk, and a read can fail for reasons that have
  // nothing to do with drift — a permission bit, a file that vanished between
  // the listing and the read. Uncaught, that took `doctor` down with it: every
  // check queued *after* this block (budget, database, schema, gateway,
  // sandbox, traces) never ran, and the owner got a stack trace precisely when
  // the machine was already in the state that made them run `doctor`.
  //
  // The degraded status is declared, not guessed (ADR-0008) — the same posture
  // this module already takes when `git log` cannot answer.
  return trackedPaths.map((relPath) => {
    try {
      return diagnoseOne(home, checkoutRoot, registry, relPath, git);
    } catch (error) {
      return {
        path: relPath,
        sealed: relPath.startsWith('rot/'),
        status: 'unknown' as const,
        detail: `non ho potuto leggerla: ${(error as Error).message}`,
      };
    }
  });
}
