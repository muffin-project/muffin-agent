import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * Scope gate for the `accettazione` job.
 *
 * Answers one question: can this change break an owner-visible/runtime
 * acceptance journey? If no, the full acceptance suite (~11min) cannot
 * falsify the claim and the job materializes a truthful no-op success
 * instead of paying the suite.
 *
 * Fail-safe: unknown files, unknown ranges, non-PR events and any error
 * resolve to `run=true` (run too much, never too little).
 *
 * Evidence for the SKIP set:
 * - `.claude/**`: no product source references it (only claude.com URLs in
 *   comments); acceptance spawns `node --import tsx cli/main.ts`, never the harness.
 * - `.opencode/**`, `.agents/**`: harness adapters, no runtime imports.
 * - `*.test.ts`: unit tests run in the `verifica` project, never in
 *   `vitest.acceptance.config.ts` (which includes only `*.accept.ts`).
 * - `evals/install/**`, `contrib/docker/**`, `install.sh`, `bootstrap.sh`:
 *   install/docker paths are exercised by the `install` workflow; acceptance
 *   scenarios never reference them (verified by grep, no matches).
 * - `docs/**` except `docs/status/**`: prose that acceptance never reads.
 *   `docs/status/day1/requirements-status.md` is read live by
 *   `evals/acceptance/report.ts`, so the whole `docs/status/` tree stays RUN.
 * - Other workflows (`install.yml`, `strumenti.yml`, `collegamenti.yml`):
 *   they do not define the `accettazione` job; only `ci.yml` itself stays RUN.
 * - Maintainer-only scripts (`scripts/agent/`, `igiene.mjs`, DCO checker,
 *   license checker, local gate): never imported by runtime or acceptance.
 */

const SKIP_EXACT = new Set([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'WORKFLOW.md',
  'biome.json',
  'knip.json',
  'install.sh',
  'bootstrap.sh',
  'scripts/igiene.mjs',
  'scripts/check-dco.ts',
  'scripts/check-dep-licenses.mjs',
  'scripts/local-gate.sh',
  '.github/workflows/install.yml',
  '.github/workflows/strumenti.yml',
  '.github/workflows/collegamenti.yml',
  '.github/workflows/opencode.yml',
]);

const SKIP_PREFIXES = [
  'docs/', // narrowed below: docs/status/ stays RUN
  '.claude/',
  '.opencode/',
  '.agents/',
  'scripts/agent/',
  'evals/install/',
  'evals/e2e/',
  'contrib/docker/',
];

export function isSkippableFile(file) {
  if (!file || typeof file !== 'string') return false;
  const f = file.replace(/^\.\//, '');
  // Unit tests never run in the acceptance project (only *.accept.ts does).
  if (f.endsWith('.test.ts')) return true;
  // The DAY-1 ledger is read live by the acceptance report gate.
  if (f.startsWith('docs/status/')) return false;
  for (const prefix of SKIP_PREFIXES) {
    if (f.startsWith(prefix)) return true;
  }
  if (SKIP_EXACT.has(f)) return true;
  // Other workflow files do not define the accettazione job.
  if (f.startsWith('.github/workflows/') && f !== '.github/workflows/ci.yml') return true;
  return false;
}

export function shouldRunAcceptance(files) {
  if (!Array.isArray(files) || files.length === 0) return true;
  return !files.every(isSkippableFile);
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
    emit(true, 'non-PR event always runs acceptance');
  } else if (filesArg !== undefined) {
    const files = filesArg.split('\n').map((s) => s.trim()).filter(Boolean);
    emit(shouldRunAcceptance(files), `${files.length} changed files`);
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
    emit(shouldRunAcceptance(files), `${files.length} changed files`);
  } else {
    emit(true, 'no base/head, fail-safe');
  }
}
