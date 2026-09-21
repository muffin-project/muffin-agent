import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sha256 } from '../rot/verify.js';
import { paths } from './config.js';
import { ensurePrivateDir, tightenPrivateFile } from './private-fs.js';

/**
 * Drift between what `muffin init` copied into `~/.muffin` and what HEAD
 * ships in `defaults/` — the gap `muffin update` never closes on purpose
 * (`agent/context/assemble.ts`: `defaults/` exists to be edited by the
 * owner). See docs/evidence/deriva-defaults-2026-08-26.md, the
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

type RegistryEntry = { path: string; sha256: string };

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
  return readRegistryPartitioned(home)?.registry ?? null;
}

/**
 * The same read, keeping the entries the filter below throws away.
 *
 * Only `recordCopied` wants them, and only so it can write them back
 * untouched: dropping an entry from a report is reversible the moment the
 * file becomes readable again, dropping it from the file on disk is not.
 */
function readRegistryPartitioned(home: string): { registry: DefaultsRegistry; unparsed: unknown[] } | null {
  const file = paths(home).defaultsManifest;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DefaultsRegistry>;
    if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(parsed.files)) return null;
    // Each entry, not just the array around them — a `files` holding a `null`
    // (partial corruption, an interrupted write, a hand edit) used to pass
    // this check and throw three functions later on `null.path`.
    //
    // **Filtered, not rejected**, and the difference is the whole safety
    // property of this module. Returning `null` for the whole registry over
    // one bad entry pushes every *other* tracked file off rule 1 — an exact
    // hash recorded at copy time, deterministic — and down onto rule 2, which
    // searches history and carries the known limitation that content matching
    // an old commit reads as adoptable. A file the owner had deliberately
    // reverted to an old shipped text would then flip from `owner-modified`
    // (safe, no command offered) to `adoptable`, with a ready `cp` that
    // destroys their edit — the exact false positive this slice exists to
    // prevent, reachable through an entry that has nothing to do with that
    // file. Found by the fresh judge on the repair itself.
    //
    // A survivor list keeps every entry that can still be trusted and drops
    // only the ones that cannot. Per-path lookups behave identically whether
    // this returns `null` or an empty `files`.
    const isEntry = (f: unknown): f is RegistryEntry =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as RegistryEntry).path === 'string' &&
      typeof (f as RegistryEntry).sha256 === 'string';
    const files = parsed.files.filter(isEntry);
    const unparsed = (parsed.files as unknown[]).filter((f) => !isEntry(f));
    return { registry: { ...(parsed as DefaultsRegistry), files }, unparsed };
  } catch {
    return null;
  }
}

/**
 * Records what just actually got written to disk, and only with the files
 * that run copied (never the ones found already present and left alone: those
 * may already carry the owner's edits, and stamping them now would relabel
 * that edit as "shipped, never touched" forever).
 *
 * **Chi copia registra.** Due chiamanti, ed è la stessa regola: `cli/init.ts`
 * alla prima installazione, `cli/adopt.ts` quando adotta una versione nuova.
 * `muffin rot reseal` NON copia e infatti non registra — timbrare dopo una
 * modifica a mano riclassificherebbe quella modifica come "spedita, mai
 * toccata", che è esattamente il falso positivo che questo registro esiste per
 * impedire. Un `cp` incollato a mano ha lo stesso difetto: copia senza
 * registrare, e al giro dopo il file risulta `owner-modified` per sempre. Merges into whatever the registry already had, so a
 * resumed `init` (one file copied this run, its siblings copied by an
 * earlier, interrupted run) does not lose the earlier entries.
 *
 * A no-op on an empty list — a resumed `init` where every file was already
 * present must not touch the registry's `installedAt` or rewrite a file that
 * needed no change.
 */
export function recordCopied(home: string, entries: { path: string; content: Buffer }[]): void {
  if (entries.length === 0) return;
  const read = readRegistryPartitioned(home);
  const byPath = new Map(read?.registry.files.map((f) => [f.path, f] as const));
  for (const e of entries) byPath.set(e.path, { path: e.path, sha256: sha256(e.content) });
  // Entries this module could not parse are written back exactly as they
  // were found, at the end so the sorted part stays deterministic.
  //
  // Reading past them is safe and already proven; *deleting* them is not the
  // same act. It happens on a routine `init`, needs no corruption of its own,
  // leaves no trace, and cannot be undone — while whatever wrote them (a hand
  // edit, an interrupted write, a future schema) is precisely the thing
  // somebody would want to look at afterwards. A reader that ignores what it
  // does not understand is careful; a writer that erases it is not.
  const registry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    installedAt: read?.registry.installedAt ?? new Date().toISOString(),
    files: [...[...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)), ...(read?.unparsed ?? [])],
  };
  const file = paths(home).defaultsManifest;
  ensurePrivateDir(home);
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  tightenPrivateFile(file);
}

/**
 * Spazzatura del sistema operativo o dell'editor che si trova **dentro**
 * `defaults/` senza essere un default.
 *
 * Misurato sul checkout dell'owner il 27/08: un `.DS_Store` da 6148 byte in
 * `defaults/`, non tracciato da Git, creato dal Finder mesi prima. Non è
 * innocuo per due ragioni distinte, e le porte da chiudere sono due.
 *
 * 1. **`muffin doctor` lo diagnostica come un default mancante** e stampa
 *    `default .DS_Store … non esiste` con il rimedio «`muffin init` lo
 *    ricrea». È una riga che non vuol dire niente, permanente, in mezzo a
 *    quelle che contano — cioè esattamente il modo in cui si smette di
 *    leggere `doctor`.
 * 2. **`installTree` (cli/init.ts) lo copierebbe.** Il walk copia tutto ciò
 *    che trova, e uno dei tre alberi che copia è `defaults/rot/`, che è
 *    l'albero **sigillato**. Un `.DS_Store` finito lì dentro viene sigillato
 *    da `seal()` insieme al resto (`listRotFiles` cammina su tutto tranne il
 *    manifest), e il Finder lo riscrive appena qualcuno apre quella cartella:
 *    l'hash diverge e l'installazione va in safe mode per un file che nessuno
 *    legge.
 *
 * **Il sigillo non viene toccato.** `listRotFiles` continua a camminare su
 * tutto: esentare un nome di file *dentro* il confine di sicurezza sarebbe un
 * buco con un nome noto. Un `.DS_Store` già dentro un sigillo esistente va
 * tolto e risigillato, non perdonato. Qui si chiude la porta da cui entra.
 *
 * Elenco esplicito e non un'euristica sui punti iniziali: `defaults/` ha tutto
 * il diritto di spedire un file che comincia per punto, e una regola larga che
 * ne salta uno vero fallirebbe in silenzio — nella direzione peggiore, perché
 * un default che non arriva non lo nota nessuno.
 */
const SPAZZATURA = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

/** `false` per la spazzatura descritta sopra, in qualunque punto dell'albero stia. */
export function isShippedDefault(relPath: string): boolean {
  const nome = relPath.split('/').pop() ?? relPath;
  return !SPAZZATURA.has(nome) && !nome.endsWith('~') && !nome.endsWith('.swp');
}

/**
 * One thing to diagnose. Either a file we found, or a place we could not
 * look — never a place that silently is not there.
 */
type TreeEntry = { path: string; failure: string | null };

/**
 * Relative, `/`-separated paths under `defaultsDir`, deterministic order —
 * same shape as verify.ts's `listRotFiles`.
 *
 * The walk contains its own failures instead of throwing them, and it
 * contains them **where they happen**: a subdirectory that cannot be read
 * costs that subdirectory, not the siblings already found beside it. It
 * throwing used to be caught one level up, which cost the whole tree — six
 * files became one, and the five that vanished were perfectly readable.
 *
 * The failure keeps the position it would have had, so the report reads in
 * the same order whether or not anything failed, and the hole is visible
 * next to what surrounds it rather than appended somewhere at the end.
 *
 * `statSync` follows symlinks, so a dangling one under `defaults/` throws
 * here rather than at read time: that is one of the two ways this fires
 * without anyone touching a permission bit. The other is a checkout being
 * written while `doctor` reads it — a state `cli/update.ts` names in its
 * own comments as real.
 */
function listDefaultsTree(defaultsDir: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch (error) {
      // `defaults/` itself: there is a better answer one level up (the
      // registry still names the files `init` copied), so this one keeps
      // travelling. Every level below it stops here, because above it there
      // is nothing better — only the siblings this would otherwise erase.
      if (prefix === '') throw error;
      out.push({ path: `${prefix}/`, failure: `non ho potuto elencarla: ${(error as Error).message}` });
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      try {
        if (statSync(full).isDirectory()) walk(full, rel);
        else if (isShippedDefault(rel)) out.push({ path: rel, failure: null });
      } catch (error) {
        out.push({ path: rel, failure: `non ho potuto guardarla: ${(error as Error).message}` });
      }
    }
  };
  walk(defaultsDir, '');
  return out;
}

/**
 * The single place where a caught failure becomes a report entry.
 *
 * Three consecutive reviews of this module found the same shape of defect in
 * three different places: a local accident — one unreadable file, one
 * malformed registry entry, one unreadable subdirectory — erasing more state
 * than the accident justified, and usually in silence. Each round repaired
 * its own site; none of them closed the shape.
 *
 * So the shape gets one home. Every path that catches something routes
 * through here, and this function can only ever produce **one** entry, which
 * is always declared (ADR-0008: degrade declared, never in silence). It is
 * structurally unable to drop a sibling, blank a list, or return a confident
 * status for something nobody managed to look at.
 */
function undiagnosable(relPath: string, reason: string): DefaultDrift {
  return {
    path: relPath,
    sealed: relPath.startsWith('rot/'),
    status: 'unknown',
    detail: reason,
  };
}

/**
 * Dove sta il file installato, e dove sta quello spedito.
 *
 * Esportate perché `cli/adopt.ts` deve *copiare* esattamente i due percorsi che
 * `adoptCommand` nomina, e riparsare quella stringa (`cp <src> <dst>`, spezzata
 * sugli spazi) si romperebbe sul primo home con uno spazio nel nome. Due
 * funzioni condivise dicono la stessa cosa senza poterla dire diversamente.
 */
export function installedPathOf(home: string, relPath: string): string {
  return join(home, ...relPath.split('/'));
}

export function shippedPathOf(checkoutRoot: string, relPath: string): string {
  return join(checkoutRoot, 'defaults', ...relPath.split('/'));
}

type DriftStatus = 'up-to-date' | 'adoptable' | 'owner-modified' | 'missing' | 'unknown';

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

type GitLogResult = { ok: true; commits: { sha: string; date: string }[] } | { ok: false; why: string };

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
  const fromRegistry = (): TreeEntry[] => (registry?.files ?? []).map((f) => ({ path: f.path, failure: null }));

  // What to diagnose. The checkout is the real answer; the registry is a
  // fallback that only knows the files `init` happened to copy.
  //
  // `listDefaultsTree` now contains a failure inside the subtree that caused
  // it, so the only thing still arriving here is `defaults/` itself being
  // unlistable — the one case where falling back to the registry is genuinely
  // better than what the walk could return.
  //
  // But it is not free: the fallback silently narrows the report to an older,
  // shorter list, and a shorter list of confident-looking lines is exactly how
  // this module lied before it existed. So the fallback says so.
  let entries: TreeEntry[];
  let listingFailure: DefaultDrift | null = null;
  try {
    entries =
      checkoutRoot !== null && existsSync(join(checkoutRoot, 'defaults')) ? listDefaultsTree(join(checkoutRoot, 'defaults')) : fromRegistry();
  } catch (error) {
    entries = fromRegistry();
    listingFailure = undiagnosable(
      'defaults/',
      `non ho potuto elencare il checkout (${(error as Error).message}) — sotto c'è solo ciò che il registro d'installazione già conosceva`,
    );
  }

  // One file's accident costs one line, never the report.
  //
  // `diagnoseOne` reads from disk, and a read can fail for reasons that have
  // nothing to do with drift — a permission bit, a file that vanished between
  // the listing and the read. Uncaught, that took `doctor` down with it: every
  // check queued *after* this block (budget, database, schema, gateway,
  // sandbox, traces) never ran, and the owner got a stack trace precisely when
  // the machine was already in the state that made them run `doctor`.
  const diagnosed = entries.map((entry) => {
    if (entry.failure !== null) return undiagnosable(entry.path, entry.failure);
    try {
      return diagnoseOne(home, checkoutRoot, registry, entry.path, git);
    } catch (error) {
      return undiagnosable(entry.path, `non ho potuto leggerla: ${(error as Error).message}`);
    }
  });
  return listingFailure === null ? diagnosed : [listingFailure, ...diagnosed];
}
