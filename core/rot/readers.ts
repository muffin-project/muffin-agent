import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RotManifest } from './verify.js';

/**
 * Every file inside the seal has a reader, or says why it has none.
 *
 * This invariant exists because *nothing failed*. `rot/policy.json` declared
 * itself binding, was hashed at every boot, and no line of production code ever
 * opened it — for months, through five slices, with a green suite the whole
 * time. `rot/budgets.json` spent a stretch in the same state. The seal proves a
 * file has not changed; it says nothing about whether anyone is listening, and
 * "sealed" reads exactly like "enforced" to anyone who does not go looking.
 *
 * So the two cases get separated by hand, once, in `ROT_READERS` below: a file
 * is either mapped to the production module that reads it, or declared
 * unread-by-design with a reason. A sealed file in neither column is an error.
 *
 * The check verifies the mapping against the code rather than believing it —
 * an entry naming a module that no longer mentions its file is the same defect
 * one step later, and bookkeeping nobody audits is what got us here. Plain
 * filesystem reads: no model, no network, no database, cheap enough for
 * `doctor` to run on every invocation (the shape `core/memory/invariants.ts`
 * established; the report types are re-stated here rather than imported,
 * because the root of trust must not take a dependency on the memory feature to
 * borrow a three-field type).
 */

export type RotSeverity = 'error' | 'warning';

export type RotViolation = {
  id: 'sealed_file_unread' | 'reader_gone' | 'allowlist_stale';
  severity: RotSeverity;
  /** What this protects, in the terms of the thing that goes wrong without it. */
  what: string;
  count: number;
  sample: string[];
};

export type RotReadersResult = {
  violations: RotViolation[];
  /**
   * Checks that could not run, and why. Never folded into a pass: a check that
   * did not run is not a check that passed, and this whole file exists because
   * silence read as success.
   */
  skipped: { id: string; why: string }[];
  /** Sealed files examined. Zero with a skip is a different fact from zero clean. */
  fileCount: number;
};

/** Where a sealed file is opened, in production. `file:function`, verified below. */
export type RotReaderRef = {
  /** Repo-relative path of the module, e.g. `core/net/egress.ts`. */
  module: string;
  /** The function inside it that does the reading. */
  fn: string;
  /** What that reader does with the file — one line, for whoever audits next. */
  why: string;
};

export type RotEntry = {
  /** Path inside `rot/`, or a `dir/` prefix covering everything beneath it. */
  file: string;
  readers?: RotReaderRef[];
  /** Set instead of `readers` when nothing at runtime is supposed to open it. */
  unreadByDesign?: string;
};

/**
 * The allowlist. One entry per file the seal ships, and the reason each line is
 * true is written next to it — not "it is read somewhere" but where.
 *
 * Adding a file to `defaults/rot/` without adding it here turns
 * `core/rot/readers.test.ts` red on the next run. That is the whole mechanism.
 */
export const ROT_READERS: RotEntry[] = [
  {
    file: 'policy.json',
    readers: [
      {
        module: 'core/policy/matrix.ts',
        fn: 'loadPolicyMatrix',
        why: 'the permission matrix the kernel decides on — read once where the kernel context is built (agent/runtime.ts), never per decision',
      },
    ],
  },
  {
    file: 'egress.json',
    readers: [
      {
        module: 'core/net/egress.ts',
        fn: 'loadEgress',
        why: 'the egress allowlist, handed to the kernel as `egressAllowed` and checked again for the search endpoint',
      },
    ],
  },
  {
    file: 'budgets.json',
    readers: [
      {
        module: 'cli/observe.ts',
        fn: 'ownerQuietHours',
        why: 'quiet hours: the window in which proactive delivery stays silent',
      },
      {
        module: 'cli/jobs.ts',
        fn: 'ownerTimezone',
        why: 'quietHours.timezone, so a cron written as "8am" means the owner\'s 8am',
      },
    ],
    // Honest about the half that is still decorative: `monthlyUsd` and
    // `perTenantDailyUsd` are declared here and NOT read — `BudgetEngine` is
    // built from `config.budget` in config.json, which is outside the seal. The
    // file therefore has a reader (this invariant passes) while two of its
    // fields do not have one, which is the same defect at field granularity and
    // is not this slice's to close. Recorded so the next reader finds it
    // written down instead of discovering it.
  },
  {
    file: 'identity.md',
    readers: [
      {
        module: 'agent/context/assemble.ts',
        fn: 'buildSystemPrompts',
        why: "the owner's conduct pact, concatenated into every system prompt after persona and before the voice",
      },
    ],
  },
  {
    file: 'evals/',
    unreadByDesign:
      'the ratchet\'s reference suite. It is sealed so a self-modifying agent cannot grade itself against a test set it rewrote, and it is read by `evals/` — a harness the owner runs, not the runtime. A production reader here would be the bug.',
  },
];

/**
 * Root of the tree this module was loaded from: the repo in dev and test, `dist`
 * in an installed package. Both layouts keep the same relative paths, so the
 * allowlist does not need to know which one it is in.
 */
const SOURCE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The compiled twin of a `.ts` entry, for the installed case. */
function moduleSource(module: string): string | null {
  for (const candidate of [module, module.replace(/\.ts$/, '.js')]) {
    const full = join(SOURCE_ROOT, candidate);
    if (existsSync(full)) return code(readFileSync(full, 'utf8'));
  }
  return null;
}

/**
 * Source with comments removed — and this is not tidiness, it is the check.
 *
 * The first version of this file matched against raw text, and a mutation walked
 * straight through it: `matrix.ts` was rewritten to build the filename by
 * joining an array, so no line of code named `policy.json` any more, and the
 * check stayed green because the module's *docstring* said "the first real
 * reader of rot/policy.json". Prose asserting what the code does not do is the
 * exact defect this whole file exists to end, and the check was accepting it as
 * evidence.
 *
 * A hand-rolled scanner rather than a regex because `//` inside a string (a URL)
 * and a quote inside a comment (an apostrophe) each break the one-line version,
 * in opposite directions. The two failure modes are not symmetric: eating real
 * code costs a false red, which is loud and gets fixed, while keeping comment
 * text costs a false green, which is what we just watched happen. The suite runs
 * this against every real reader, so a scanner that got it wrong turns
 * `a freshly installed root of trust is fully accounted for` red immediately.
 */
function code(source: string): string {
  let out = '';
  let mode: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; i++; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i++; continue; }
      if (c === "'" || c === '"' || c === '`') mode = c;
      out += c;
      continue;
    }
    if (mode === 'line') {
      // The newline survives, so nothing on the next line joins this one.
      if (c === '\n') { mode = 'code'; out += c; }
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i++; }
      continue;
    }
    // Inside a string: an escaped quote does not end it.
    if (c === '\\') { out += source.slice(i, i + 2); i++; continue; }
    if (c === mode) mode = 'code';
    out += c;
  }
  return out;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function matches(entry: RotEntry, path: string): boolean {
  return entry.file.endsWith('/') ? path.startsWith(entry.file) : path === entry.file;
}

export function checkRotReaders(home: string, allowlist: RotEntry[] = ROT_READERS): RotReadersResult {
  const manifestPath = join(home, 'rot', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      violations: [],
      skipped: [{ id: 'rot_readers', why: `nessun manifest in ${manifestPath}: il RoT non è sigillato` }],
      fileCount: 0,
    };
  }
  let manifest: RotManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RotManifest;
    if (!Array.isArray(manifest.files)) throw new Error('files assente');
  } catch (error) {
    return {
      violations: [],
      skipped: [
        { id: 'rot_readers', why: `manifest illeggibile: ${error instanceof Error ? error.message : String(error)}` },
      ],
      fileCount: 0,
    };
  }

  const sealed = manifest.files.map((f) => f.path);
  const violations: RotViolation[] = [];
  const unread: string[] = [];
  const broken: string[] = [];
  const stale: string[] = [];

  for (const path of sealed) {
    if (!allowlist.some((entry) => matches(entry, path))) unread.push(path);
  }

  for (const entry of allowlist) {
    const covered = sealed.filter((path) => matches(entry, path));
    if (covered.length === 0) {
      stale.push(entry.file);
      continue;
    }
    // Only matched entries are audited: an entry for a file this home does not
    // have yet is already reported as stale, and checking its readers would
    // report the same fact twice under a scarier name.
    for (const reader of entry.readers ?? []) {
      const source = moduleSource(reader.module);
      if (source === null) {
        broken.push(`${entry.file} → ${reader.module} non esiste`);
        continue;
      }
      // Two claims, both checkable: that the module still opens this file, and
      // that the named function is still the one to look at.
      const wanted = entry.file.endsWith('/') ? entry.file : basename(entry.file);
      if (!source.includes(wanted)) {
        broken.push(`${entry.file} → ${reader.module} non nomina più "${wanted}"`);
      } else if (!source.includes(reader.fn)) {
        broken.push(`${entry.file} → ${reader.module} non ha più ${reader.fn}()`);
      }
    }
  }

  if (unread.length > 0) {
    violations.push({
      id: 'sealed_file_unread',
      severity: 'error',
      what: 'un file dentro il sigillo che nessun modulo di produzione legge: sembra vincolante e non lo è',
      count: unread.length,
      sample: unread,
    });
  }
  if (broken.length > 0) {
    violations.push({
      id: 'reader_gone',
      severity: 'error',
      what: 'l\'allowlist dichiara un lettore che non legge più quel file: la mappa mente',
      count: broken.length,
      sample: broken,
    });
  }
  if (stale.length > 0) {
    violations.push({
      id: 'allowlist_stale',
      // Warning, not error: an old home legitimately predates a file the
      // allowlist already knows about. It is drift to look at, not damage.
      severity: 'warning',
      what: 'l\'allowlist elenca un file che questo sigillo non contiene',
      count: stale.length,
      sample: stale,
    });
  }

  return { violations, skipped: [], fileCount: sealed.length };
}

/** Human-readable, in the register `muffin memory check` already uses. */
export function formatRotReaders(result: RotReadersResult): string {
  const parts: string[] = [];
  if (result.violations.length === 0 && result.skipped.length === 0) {
    parts.push(`${result.fileCount} file sigillati, ognuno con un lettore dichiarato`);
  }
  for (const v of result.violations) {
    const head = `${v.severity === 'error' ? '✗' : '!'} ${v.id} (${v.count})\n  ${v.what}`;
    parts.push(`${head}\n${v.sample.map((s) => `    ${s}`).join('\n')}`);
  }
  for (const s of result.skipped) parts.push(`? ${s.id} NON verificato — ${s.why}`);
  return parts.join('\n');
}
