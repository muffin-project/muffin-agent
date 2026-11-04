import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * Scope gate for the `strumenti` job.
 *
 * The job proves `.claude/` session tooling: full-repo `tsc` plus
 * `vitest run .claude`. It can only falsify a change touching what those
 * tests observe:
 * - `.claude/**` itself (hooks, deleghe, skills, rules, loop);
 * - `docs/**` and root prose (`.claude/procedure.test.ts` resolves skill and
 *   rule links against live docs);
 * - shared type/test config (`tsconfig*`, `vitest*`, `package.json`,
 *   `package-lock.json`) and the job definition itself.
 *
 * A pure-runtime change (`agent/`, `cli/`, `core/`, `connectors/`, evals,
 * install evals, other scripts) cannot break a `.claude` test: none of them
 * imports runtime (only fixture strings naming runtime paths), and the
 * duplicate full-repo typecheck is already covered by the always-running
 * `verifica` job. Those PRs get a truthful no-op success (~40s saved).
 *
 * Fail-safe: unknown files, unknown ranges, non-PR events and any error
 * resolve to `run=true` (run too much, never too little).
 */

const SKIP_PREFIXES = [
  'agent/',
  'cli/',
  'core/',
  'connectors/',
  'defaults/',
  'evals/',
  'contrib/docker/',
  '.opencode/',
  '.agents/',
  'scripts/',
];

const SKIP_EXACT = new Set([
  'biome.json',
  'knip.json',
  'install.sh',
  'bootstrap.sh',
  '.github/workflows/ci.yml',
  '.github/workflows/install.yml',
  '.github/workflows/collegamenti.yml',
  '.github/workflows/opencode.yml',
]);

export function isStrumentiRelevant(file) {
  if (!file || typeof file !== 'string') return true;
  const f = file.replace(/^\.\//, '');
  // `.claude` tests observe themselves: changing one re-proves the job.
  if (f.startsWith('.claude/')) return true;
  // Other unit tests are never observed by `.claude` tests
  // (`vitest run .claude` matches only that tree).
  if (f.endsWith('.test.ts')) return false;
  // The gate and job definition themselves always re-prove the job.
  if (f === 'scripts/ci/strumenti-scope.mjs') return true;
  if (f === '.github/workflows/strumenti.yml') return true;
  for (const prefix of SKIP_PREFIXES) {
    if (f.startsWith(prefix)) return false;
  }
  if (SKIP_EXACT.has(f)) return false;
  return true;
}

export function shouldRunStrumenti(files) {
  if (!Array.isArray(files) || files.length === 0) return true;
  return files.some(isStrumentiRelevant);
}

function emit(run, reason) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  process.stdout.write(`run=${run} (${reason})\n`);
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.findIndex((a) => a === `--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const event = get('event') || process.env.EVENT || process.env.GITHUB_EVENT_NAME || '';
  const base = get('base') || process.env.BASE_SHA || '';
  const head = get('head') || process.env.HEAD_SHA || '';
  const filesArg = get('files');

  if (event && event !== 'pull_request') {
    emit(true, 'non-PR event always runs strumenti');
  } else if (filesArg !== undefined) {
    const files = filesArg.split('\n').map((s) => s.trim()).filter(Boolean);
    emit(shouldRunStrumenti(files), `${files.length} changed files`);
  } else if (base && head) {
    let files;
    try {
      const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`, '--'], {
        encoding: 'utf8',
      });
      files = out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      emit(true, 'undeterminable range, fail-safe');
      process.exit(0);
    }
    emit(shouldRunStrumenti(files), `${files.length} changed files`);
  } else {
    emit(true, 'no base/head, fail-safe');
  }
}
