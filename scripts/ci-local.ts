#!/usr/bin/env node
/**
 * A local replacement for GitHub Actions, while the billing gate keeps it off.
 *
 * The owner's constraint decides the whole design: this file must **derive**
 * its steps from `.github/workflows/*.yml`, never repeat them. Two definitions
 * of the same CI that can drift apart is exactly the failure this repository
 * keeps re-learning (a rule in prose next to one in code, and the code wins
 * silently) — see AGENTS.md's closing section. So there is no hand-written
 * list of "run npm ci, then tsc, then vitest" anywhere below: every `run:`
 * command executed here comes from parsing the workflow file at run time, and
 * every `uses:` step this runner does not know how to emulate stops the whole
 * thing, naming it, instead of being skipped.
 *
 * ## What gets emulated, and what does not
 *
 * `uses: actions/checkout@*` and `uses: actions/setup-node@*` have no `run:`
 * to execute — GitHub's hosted runner performs them natively. Locally they
 * become: copy the repository into the container (`checkout`), install the
 * requested Node version from NodeSource (`setup-node`). Any other `uses:`
 * step is unknown and makes {@link loadJobs} throw, naming the action.
 *
 * `${{ runner.temp }}` is the only GitHub Actions expression these workflows
 * use inside a `run:` or step `env:` (verified 2026-09-04 by grep). It
 * resolves to a real directory created inside the container before the job
 * runs. Any other `${{ ... }}` expression left in a `run:`/`env:` string is a
 * bug in this runner, not something to hand to a shell unresolved — it makes
 * {@link resolveExpressions} throw, naming the expression and where it was
 * found.
 *
 * ## The hard part: bwrap inside Docker on macOS
 *
 * Both jobs of `ci.yml` install an AppArmor profile on the runner so
 * `bwrap` can create a user namespace. That step cannot succeed inside *any*
 * Docker container — there is no kernel AppArmor interface to write to
 * (`/etc/apparmor.d` exists, `apparmor_parser` has nothing to talk to) —
 * measured here on 2026-09-04 with `--privileged` too: `apparmor_parser -r`
 * still exits 1 ("Cache read/write disabled: interface file missing"). This is
 * not the containment guarantee those two jobs actually depend on, so its
 * failure does not fail the job: {@link buildJobScript} recognizes any step
 * whose script mentions `apparmor_parser` and reports its exit status loudly
 * without setting `JOB_FAILED`. What *does* decide containment is whether
 * `bwrap` can mount `/proc` inside a nested namespace, and that is a Docker
 * privilege question, not a workflow step:
 *
 *   bwrap --unshare-all --dev-bind / / true                OK, everywhere
 *   bwrap --unshare-all --proc /proc --dev-bind / / true   needs --privileged
 *                                                           on Docker Desktop
 *
 * measured 2026-09-04, root and non-root alike. `chooseDockerPrivileges`
 * reuses that exact probe — the same lesson `evals/acceptance/gate-linux.sh`
 * applied for its own Linux leg in PR #389 (read there, not copied: that
 * script is bash, this is an independent TypeScript implementation of the
 * same idea, named here rather than silently duplicated — see this file's PR
 * description for whether the two are worth unifying behind one shared
 * probe). It tries with no extra privileges first (what the GitHub runner
 * actually has), then `--privileged`, and if neither lets `bwrap` mount
 * `/proc`, the job is reported NOT EXECUTABLE — never green, and never a red
 * that blames Muffin's code for a Docker limitation.
 *
 * Jobs that never install `bubblewrap` (`collegamenti`, `strumenti`) skip this
 * probe entirely — they do not pay for `--privileged` or the wait, per the
 * brief.
 *
 * ## Usage
 *
 *   npm run ci:local
 *   MUFFIN_CI_LOCAL_KEEP=1 npm run ci:local     # keep the scratch clone
 *   MUFFIN_CI_LOCAL_ONLY=collegamenti npm run ci:local   # run one job by id
 *
 * Every command below is `git rev-parse HEAD`'s committed state, copied into
 * the container — like `actions/checkout`, uncommitted changes do not run.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import { cpus, homedir, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepSpec {
  readonly name: string;
  /** Present for a `uses:` step; mutually exclusive with `run`. */
  readonly uses?: string;
  readonly usesWith?: Readonly<Record<string, string>>;
  /** Present for a `run:` step. */
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Only `'always()'` is understood; anything else makes derivation throw. */
  readonly if?: string;
}

export interface JobSpec {
  readonly workflowFile: string;
  readonly jobId: string;
  readonly runsOn: string;
  readonly timeoutMinutes: number | null;
  readonly steps: readonly StepSpec[];
}

export interface PrivilegeChoice {
  readonly dockerArgs: readonly string[];
  readonly mode: string;
}

export interface PrivilegeUnavailable {
  readonly unavailable: true;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// `${{ ... }}` resolution — see the header note on why an unresolved
// expression must throw instead of reaching a shell.
// ---------------------------------------------------------------------------

const EXPRESSION = /\$\{\{\s*([^}]+?)\s*\}\}/g;

const KNOWN_EXPRESSIONS: Readonly<Record<string, string>> = {
  'runner.temp': '/runner-temp',
};

export function resolveExpressions(text: string, where: string): string {
  return text.replace(EXPRESSION, (_whole, rawKey: string) => {
    const key = rawKey.trim();
    const value = KNOWN_EXPRESSIONS[key];
    if (value === undefined) {
      throw new Error(
        `unresolved GitHub Actions expression '\${{ ${key} }}' in ${where}. ` +
          `This runner only knows: ${Object.keys(KNOWN_EXPRESSIONS).join(', ')}. ` +
          `Teach resolveExpressions() about it instead of letting it reach a shell unresolved.`,
      );
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// Deriving jobs from the workflow files
// ---------------------------------------------------------------------------

const KNOWN_USES = [/^actions\/checkout@/, /^actions\/setup-node@/];

interface RawStep {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  run?: string;
  env?: Record<string, string>;
  if?: string;
}

interface RawJob {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  steps?: RawStep[];
}

interface RawWorkflow {
  jobs?: Record<string, RawJob>;
}

function stepLabel(raw: RawStep): string {
  if (raw.name) return raw.name;
  if (raw.uses) return raw.uses;
  const firstLine = raw.run?.split('\n')[0]?.trim();
  return firstLine || '(unnamed step)';
}

/** Turns one job of one parsed workflow into the ordered steps this runner will execute. */
export function deriveJob(workflowFile: string, jobId: string, raw: RawJob): JobSpec {
  const steps: StepSpec[] = [];
  for (const rawStep of raw.steps ?? []) {
    const name = stepLabel(rawStep);
    const where = `${workflowFile}#${jobId} → ${name}`;

    if (rawStep.uses) {
      const known = KNOWN_USES.some((re) => re.test(rawStep.uses as string));
      if (!known) {
        throw new Error(
          `${where}: 'uses: ${rawStep.uses}' is not an action this runner knows how to emulate ` +
            `(known: actions/checkout, actions/setup-node). Stopping instead of skipping it silently.`,
        );
      }
      steps.push({ name, uses: rawStep.uses, usesWith: rawStep.with ?? {} });
      continue;
    }

    if (rawStep.run !== undefined) {
      if (rawStep.if !== undefined && rawStep.if !== 'always()') {
        throw new Error(
          `${where}: 'if: ${rawStep.if}' is not understood — only 'always()' is. ` +
            `Stopping instead of guessing what the condition means.`,
        );
      }
      const run = resolveExpressions(rawStep.run, where);
      const env: Record<string, string> = {};
      for (const [key, rawValue] of Object.entries(rawStep.env ?? {})) {
        env[key] = resolveExpressions(String(rawValue), `${where} (env ${key})`);
      }
      steps.push({ name, run, env, ...(rawStep.if ? { if: rawStep.if } : {}) });
      continue;
    }

    throw new Error(`${where}: step has neither 'run' nor 'uses': ${JSON.stringify(rawStep)}`);
  }

  return {
    workflowFile,
    jobId,
    runsOn: raw['runs-on'] ?? '(unspecified)',
    timeoutMinutes: raw['timeout-minutes'] ?? null,
    steps,
  };
}

/** Reads every `.github/workflows/*.yml` and derives every job in each. */
export function loadJobs(workflowsDir: string): JobSpec[] {
  const jobs: JobSpec[] = [];
  const files = readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
  for (const file of files) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    const doc = yamlLoad(text) as RawWorkflow;
    for (const [jobId, rawJob] of Object.entries(doc.jobs ?? {})) {
      jobs.push(deriveJob(file, jobId, rawJob));
    }
  }
  return jobs;
}

/** A job needs the sandbox probe iff one of its own steps installs bubblewrap. */
export function needsSandboxProbe(job: JobSpec): boolean {
  return job.steps.some((s) => s.run !== undefined && /\bbwrap\b|bubblewrap/.test(s.run));
}

/** The Node version `actions/setup-node` was asked to install, derived from the job's own step. */
export function requestedNodeVersion(job: JobSpec): string {
  const step = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
  const version = step?.usesWith?.['node-version'];
  if (!version) {
    throw new Error(`${job.workflowFile}#${job.jobId}: no 'actions/setup-node' step with a 'node-version' found.`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// Building the in-container script — pure text generation, no I/O, so it is
// testable without Docker. Every dynamic string (step names, messages) is
// base64-encoded before being embedded, so nothing a workflow author writes
// in a step `name:` can break the generated shell.
// ---------------------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** `printf '%s\n' "$(echo <b64> | base64 -d)"` — prints arbitrary text without quoting hazards. */
function echoLine(text: string): string {
  return `printf '%s\\n' "$(printf '%s' '${b64(text)}' | base64 -d)"`;
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const APPARMOR_NOTE =
  'note: this step failed inside Docker — expected. Loading an AppArmor profile requires a kernel ' +
  'interface no container has (see the header comment of scripts/ci-local.ts). The real containment ' +
  'guarantee is decided below by the bwrap /proc-mount probe, not by this step; it does not fail the job.';

/**
 * Builds the bash script that runs one job's `run:` steps, in order, inside
 * the already-bootstrapped container (repository at `/app`, Node and sudo
 * installed). Mirrors GitHub's own step semantics closely enough for these
 * four workflows: a failed step fails the job and skips the steps after it,
 * except steps marked `if: always()`, which run regardless.
 */
export function buildJobScript(job: JobSpec, opts: { runnerTemp: string; appDir?: string }): string {
  const appDir = opts.appDir ?? '/app';
  const lines: string[] = [];
  lines.push('set +e');
  lines.push('JOB_FAILED=0');
  lines.push(`mkdir -p ${shSingleQuote(opts.runnerTemp)}`);
  lines.push(`cd ${shSingleQuote(appDir)}`);

  for (const step of job.steps) {
    if (step.uses) {
      lines.push(echoLine(`--- uses: ${step.uses} (${step.name}) — emulated during bootstrap, not re-run here ---`));
      continue;
    }
    const run = step.run ?? '';
    const isAlways = step.if === 'always()';
    const tolerant = /apparmor_parser/.test(run);

    lines.push(`if [ "$JOB_FAILED" = "1" ] && [ ${isAlways ? 1 : 0} -ne 1 ]; then`);
    lines.push(`  ${echoLine(`--- SKIPPED (a previous step failed): ${step.name} ---`)}`);
    lines.push('else');
    lines.push(`  ${echoLine(`--- STEP: ${step.name} ---`)}`);
    lines.push(`  printf '%s' '${b64(run)}' | base64 -d > /tmp/muffin-step.sh`);
    for (const [key, value] of Object.entries(step.env ?? {})) {
      lines.push(`  export ${key}=${shSingleQuote(value)}`);
    }
    lines.push('  ( bash -eo pipefail /tmp/muffin-step.sh )');
    lines.push('  RC=$?');
    if (tolerant) {
      lines.push('  if [ "$RC" != "0" ]; then');
      lines.push(`    ${echoLine(`${step.name}: exited non-zero. ${APPARMOR_NOTE}`)} >&2`);
      lines.push('    echo "    exit=$RC" >&2');
      lines.push('  fi');
    } else {
      lines.push('  if [ "$RC" != "0" ]; then');
      lines.push(`    ${echoLine(`!!! STEP FAILED: ${step.name}`)} >&2`);
      lines.push('    echo "    exit=$RC" >&2');
      lines.push('    JOB_FAILED=1');
      lines.push('  fi');
    }
    lines.push('fi');
  }

  lines.push('echo "===JOB_EXIT=$JOB_FAILED==="');
  lines.push('exit "$JOB_FAILED"');
  return lines.join('\n');
}

/**
 * The non-root user the workflow's own steps run as. GitHub's hosted runner
 * never executes a job as root — it runs as `runner`, with passwordless sudo
 * for the steps that need it (`sudo apt-get …`). This matters for more than
 * fidelity: `core/sandbox/probe.ts` *refuses* to report the sandbox available
 * when called as root ("root bypasses the userns restriction, so the result
 * would be a false positive" — its own message), so a container that ran
 * everything as root would make `MUFFIN_REQUIRE_SANDBOX=1` fail for a reason
 * that has nothing to do with Muffin's code. Measured 2026-09-04: exactly this
 * failure, on the first version of this runner, before it dropped privileges.
 */
export const CI_USER = 'ci-runner';

/**
 * The bootstrap that stands in for the `uses:` steps: install the requested
 * Node version into its own directory (`actions/setup-node`), unpack the
 * repository tarball into `/app` (`actions/checkout`), and create
 * {@link CI_USER} with passwordless sudo — the user the job's own steps
 * actually run as (see that constant's comment for why). Runs as root, before
 * {@link buildJobScript}'s output, which runs as `ci-runner`. It is *sourced*
 * (`. bootstrap.sh`, not `bash bootstrap.sh`) by its caller so the `PATH`
 * export below survives into the `runuser` invocation that follows it.
 *
 * Node is installed from the official tarball into `/opt/node`, not via
 * `apt-get install nodejs` — deliberately: `apt`'s NodeSource package puts the
 * binary at `/usr/bin/node`, and `cli/gateway.test.ts`'s "sceglie la
 * directory stabile del PATH" makes assertions about *which* directory a
 * discovered interpreter lives in, against a fixed, generic fallback PATH
 * list that already contains `/usr/bin`. `/usr/bin` from `apt` collided with
 * that fallback and made the test fail for a reason that has nothing to do
 * with the code under test — measured 2026-09-04, this exact test, this exact
 * cause. `/opt/node/bin` cannot collide, and it is also what
 * `actions/setup-node` itself does on the real runner (a dedicated
 * tool-cache directory, never a system path).
 *
 * `curl`, `ca-certificates`, `xz-utils`, `sudo`, `git` and `systemd` are not
 * things any `run:` step asks for — they are declared, not-silent
 * compensation for `ubuntu:24.04`'s Docker image being far thinner than the
 * real `ubuntu-latest` VM. `systemd` is specifically for `systemd-analyze`,
 * which `core/gateway/unit.test.ts` needs under `MUFFIN_REQUIRE_SYSTEMD=1` and
 * which a real GitHub runner ships preinstalled; `evals/acceptance/gate-linux.sh`
 * installs the same package for the identical reason (read there, not
 * copied).
 *
 * `/npm-cache` is the host's persistent npm cache, mounted per job (see
 * NPM_CACHE_DIR): without it every workflow-derived job re-downloads the
 * same ~143 packages from the registry. The cache is content-addressed, so a
 * warm cache changes timing, never resolution — `npm ci` still verifies
 * integrity against the lockfile. No `prefer-offline`: on a cache miss the
 * behaviour must stay identical to a cold runner.
 */
export function buildBootstrapScript(nodeVersion: string, opts: { runnerTemp: string }): string {
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    echoLine(
      '=== bootstrap: emulating uses: actions/checkout + actions/setup-node, plus base-image gap-fill (curl/xz-utils/sudo/git/systemd — see header comment) ===',
    ),
    'apt-get update -qq >/dev/null',
    'apt-get install -y -qq curl ca-certificates xz-utils sudo git systemd >/dev/null',
    echoLine(`node-version requested by actions/setup-node: ${nodeVersion} (installed into /opt/node, not /usr/bin)`),
    'NODE_ARCH="$(uname -m)"',
    'case "$NODE_ARCH" in aarch64) NODE_ARCH=arm64 ;; x86_64) NODE_ARCH=x64 ;; ' +
      '*) echo "unsupported architecture for the Node tarball: $NODE_ARCH" >&2; exit 1 ;; esac',
    `NODE_LISTING="$(curl -fsSL https://nodejs.org/dist/latest-v${nodeVersion}.x/)"`,
    `NODE_FILE="$(echo "$NODE_LISTING" | grep -oE 'node-v${nodeVersion}\\.[0-9]+\\.[0-9]+-linux-'"$NODE_ARCH"'\\.tar\\.xz' | head -1)"`,
    '[ -n "$NODE_FILE" ] || { echo "could not find a linux-$NODE_ARCH tarball for Node ' +
      `${nodeVersion}.x on nodejs.org" >&2; exit 1; }`,
    `curl -fsSL "https://nodejs.org/dist/latest-v${nodeVersion}.x/$NODE_FILE" -o /tmp/node.tar.xz`,
    'mkdir -p /opt/node && tar xJf /tmp/node.tar.xz -C /opt/node --strip-components=1',
    'export PATH="/opt/node/bin:$PATH"',
    'node --version',
    'mkdir -p /app && tar xf /repo.tar -C /app',
    `mkdir -p ${shSingleQuote(opts.runnerTemp)}`,
    echoLine(`creating non-root user '${CI_USER}' with passwordless sudo (matches the GitHub runner user)`),
    `useradd -m -s /bin/bash ${CI_USER}`,
    `echo '${CI_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${CI_USER}`,
    `chmod 0440 /etc/sudoers.d/${CI_USER}`,
    `chown -R ${CI_USER}:${CI_USER} /app ${shSingleQuote(opts.runnerTemp)}`,
    // The npm cache mount (see NPM_CACHE_DIR): a dedicated host directory,
    // so chowning it to the in-container user is harmless — it holds nothing
    // but content-addressed tarballs.
    'mkdir -p /npm-cache',
    `chown ${CI_USER}:${CI_USER} /npm-cache`,
    echoLine('=== bootstrap done — the workflow-derived steps run below, as a non-root user ==='),
    'echo "===BOOTSTRAP_OK==="',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Docker privilege probing — see the header comment for the measurement this
// reuses from evals/acceptance/gate-linux.sh (PR #389).
// ---------------------------------------------------------------------------

const SECURITY_OPTS = ['--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined'];

export function chooseDockerPrivileges(
  probe: (dockerArgs: readonly string[]) => boolean,
): PrivilegeChoice | PrivilegeUnavailable {
  if (probe(SECURITY_OPTS)) {
    return { dockerArgs: SECURITY_OPTS, mode: 'without extra privileges (matches the GitHub runner)' };
  }
  const privileged = ['--privileged', ...SECURITY_OPTS];
  if (probe(privileged)) {
    return {
      dockerArgs: privileged,
      mode:
        'WITH --privileged: this Docker host refuses to mount /proc inside a nested namespace without it ' +
        '(measured 2026-09-04; see evals/acceptance/gate-linux.sh, PR #389)',
    };
  }
  return {
    unavailable: true,
    reason: 'bwrap cannot mount /proc inside a namespace on this Docker host, even with --privileged.',
  };
}

/** The real probe: does `bwrap` mount `/proc` in a nested namespace with these extra `docker run` args? */
function realDockerProbe(image: string): (dockerArgs: readonly string[]) => boolean {
  return (dockerArgs) => {
    const result = spawnSyncCapture('docker', [
      'run',
      '--rm',
      ...dockerArgs,
      image,
      'bash',
      '-c',
      'command -v bwrap >/dev/null 2>&1 || (apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap >/dev/null); ' +
        'bwrap --unshare-all --proc /proc --dev-bind / / true',
    ]);
    return result.status === 0;
  };
}

// ---------------------------------------------------------------------------
// I/O plumbing — process spawning, tarball, container orchestration. Not
// unit-tested (it is Docker and the filesystem); the pure functions above
// carry the derivation logic the brief requires proof for.
// ---------------------------------------------------------------------------

function spawnSyncCapture(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface RunResult {
  readonly status: number | null;
  readonly timedOut: boolean;
  readonly failedStep: string | null;
}

/**
 * Quale passo del job e' caduto, letto dallo stderr del container mentre scorre.
 *
 * Sta qui, isolato e senza I/O, per una ragione precisa: `runContainer` apre
 * processi e scrive su `process.stderr`, quindi una regola scritta la' dentro
 * si puo' solo leggere, mai far fallire. E questa regola ha gia' un modo ovvio
 * di sbagliare in silenzio — il marcatore arriva a pezzi, perche' `data` non
 * taglia sui confini di riga: un chunk puo' finire a meta' di
 * `!!! STEP FA` e il resto arrivare nel successivo. Cercare dentro il singolo
 * chunk perde quel caso e non lo dice; il verdetto tornerebbe a essere un
 * numero senza che nessun test cambi colore.
 *
 * Quindi: si accumula fino a `\n`, si guarda solo le righe intere, e si tiene
 * **l'ultima** — un job puo' avere piu' passi rossi, e quello che ha fermato
 * il job e' l'ultimo che ha parlato.
 */
export function creaScannerPassi(): { consuma: (testo: string) => void; passoCaduto: () => string | null } {
  const MARCATORE = /^.*!!! STEP FAILED: (.+?)\s*$/;
  let resto = '';
  let ultimo: string | null = null;
  return {
    consuma(testo: string): void {
      resto += testo;
      const righe = resto.split('\n');
      resto = righe.pop() ?? '';
      for (const riga of righe) {
        const m = MARCATORE.exec(riga);
        if (m?.[1] !== undefined) ultimo = m[1];
      }
    },
    passoCaduto(): string | null {
      // La riga finale puo' non avere il newline: il container e' morto li'.
      const m = MARCATORE.exec(resto);
      return m?.[1] !== undefined ? m[1] : ultimo;
    },
  };
}

/** Un campione di quanto e' occupato l'host, preso a un certo punto del giro. */
export type CampioneDiCarico = { quando: string; load1: number; cpu: number; altriVitest: number };

/**
 * Un verdetto preso su un host conteso non e' un verdetto.
 *
 * Misurato il 04/09/2026: `verifica FAIL` su un commit la cui suite era verde
 * sulla stessa macchina pochi minuti prima, e di nuovo verde nel container
 * successivo. In quella finestra girava anche una suite di accettazione
 * sull'host, e la suite unitaria ci ha messo 170s invece di 55. La causa
 * probabile e' la contesa — `lessons.md`, «rosso da contesa» — e la prima
 * spiegazione accettata era sbagliata (un cambio di ramo sotto il giro, che
 * qui e' impossibile: lo SHA e' pinnato e il clone e' uno).
 *
 * Quindi il giro registra il carico all'inizio e alla fine, e se in uno dei
 * due campioni l'host era conteso — load medio sopra il numero di CPU, o un
 * altro `vitest` in esecuzione fuori dai container — un FAIL viene
 * **scartato**, non interpretato. Un PASS resta un PASS: la contesa rende le
 * cose piu' lente e piu' rosse, mai verdi per sbaglio.
 *
 * Pura: riceve i campioni, non li prende.
 */
/**
 * Il container ha le risorse di `ubuntu-latest` (4 vCPU), non quelle del Mac.
 *
 * Senza il tetto, quattro job in parallelo si contendono tutti i core
 * dell'host e vitest, che dimensiona i worker su `os.cpus()` (10 qui, dentro
 * il container come fuori), ne lancia 10 per container: 40 worker su 10
 * core. Il 05/09/2026 il job `verifica` e' caduto due volte su `dev` pulito
 * con `[vitest-worker]: Timeout calling "onTaskUpdate"` — l'RPC fra worker e
 * runner scaduto, non un test rosso — e 30 test su 3582 mai riportati.
 * `--cpus` limita la CPU ma non cambia `os.cpus()`, quindi i worker vanno
 * detti a vitest a parte (`VITEST_MAX_THREADS`/`VITEST_MAX_FORKS`).
 */
export const RISORSE_DEL_RUNNER: readonly string[] = [
  '--cpus=4',
  '-e',
  'VITEST_MAX_THREADS=4',
  '-e',
  'VITEST_MAX_FORKS=4',
];

export function contesa(campioni: readonly CampioneDiCarico[]): string | null {
  const ragioni: string[] = [];
  for (const c of campioni) {
    if (c.altriVitest > 0) ragioni.push(`${c.quando}: ${c.altriVitest} altro/i vitest sull'host`);
    // Il load conta solo **prima** dei container: a fine corsa e' il nostro —
    // quattro job in parallelo su una VM Docker portano un Mac a 10 cpu sopra
    // 11 da soli (misurato il 05/09/2026, due giri scartati senza nessun
    // altro processo sull'host). Un vitest estraneo resta contesa in ogni
    // momento, perche' non e' nostro.
    if (c.quando === 'inizio' && c.cpu > 0 && c.load1 > c.cpu) ragioni.push(`${c.quando}: load ${c.load1.toFixed(1)} su ${c.cpu} cpu`);
  }
  return ragioni.length === 0 ? null : ragioni.join('; ');
}

/** Il campione vero. `pgrep` e' sola lettura: qui si conta, non si tocca. */
function campionaCarico(quando: string): CampioneDiCarico {
  let altriVitest = 0;
  try {
    const out = spawnSync('pgrep', ['-f', 'vitest run'], { encoding: 'utf8' }).stdout ?? '';
    altriVitest = out.split('\n').filter((l) => l.trim() !== '').length;
  } catch {
    // Senza pgrep si misura solo il load: meglio un campione parziale che nessuno.
  }
  return { quando, load1: loadavg()[0] ?? 0, cpu: cpus().length, altriVitest };
}

export function runContainer(opts: {
  image: string;
  dockerArgs: readonly string[];
  containerName: string;
  repoTar: string;
  bootstrapFile: string;
  jobScriptFile: string;
  timeoutMs: number | null;
  /**
   * Host directory mounted at `/npm-cache` with `npm_config_cache` pointing
   * at it (see the `buildBootstrapScript` note). Dedicated to this runner —
   * never the user's real `~/.npm`, so in-container chown cannot surprise
   * anything outside these runs.
   */
  npmCacheDir: string;
}): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    // Bootstrap runs as root (it needs to be: creating a user, apt-get,
    // /etc/sudoers) and is *sourced*, not executed as a subprocess, so its
    // `export PATH=/opt/node/bin:$PATH` (see buildBootstrapScript) survives
    // into the `env PATH="$PATH"` below. The workflow-derived job steps then
    // run as CI_USER — see that constant's comment for why this is not
    // optional.
    const launcher =
      `set -e; . /bootstrap.sh; ` +
      `exec runuser -u ${CI_USER} -- env HOME=/home/${CI_USER} PATH="$PATH" npm_config_cache=/npm-cache bash /job.sh`;
    const args = [
      'run',
      '--rm',
      '--name',
      opts.containerName,
      ...RISORSE_DEL_RUNNER,
      ...opts.dockerArgs,
      '-v',
      `${opts.repoTar}:/repo.tar:ro`,
      '-v',
      `${opts.bootstrapFile}:/bootstrap.sh:ro`,
      '-v',
      `${opts.jobScriptFile}:/job.sh:ro`,
      '-v',
      `${opts.npmCacheDir}:/npm-cache`,
      opts.image,
      'bash',
      '-c',
      launcher,
    ];
    // stderr passa da `inherit` a `pipe` per una ragione sola: il verdetto deve
    // poter dire **quale passo** e' caduto. `buildJobScript` stampa gia
    // `!!! STEP FAILED: <nome>` la' dentro (vedi `echoLine` sopra); senza
    // leggerlo la riga finale resta «container exited 1», e chi la legge deve
    // rifare la corsa per sapere cos'e' successo. Ritrasmesso a valle intatto:
    // chi guardava la corsa scorrere continua a vederla identica.
    const scanner = creaScannerPassi();
    const child = spawn('docker', args, { stdio: ['ignore', 'inherit', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      scanner.consuma(chunk.toString('utf8'));
    });
    let timedOut = false;
    const timer =
      opts.timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            try {
              execFileSync('docker', ['kill', opts.containerName], { stdio: 'ignore' });
            } catch {
              // The container may already have exited on its own; nothing to kill.
            }
          }, opts.timeoutMs);
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ status: code, timedOut, failedStep: scanner.passoCaduto() });
    });
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolvePromise({ status: -1, timedOut, failedStep: scanner.passoCaduto() });
    });
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const IMAGE = 'ubuntu:24.04';
const RUNNER_TEMP = '/runner-temp';
/** Host-side persistent npm cache shared by every job container (see above). */
const NPM_CACHE_DIR = join(homedir(), '.cache', 'muffin-ci-local', 'npm');

type JobVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'fail'; readonly reason: string }
  | { readonly kind: 'not-executable'; readonly reason: string };

/**
 * L'architettura su cui gira il container, e perche' il verdetto deve dirla.
 *
 * `ubuntu-latest` su GitHub e' **x86_64**, e la VPS di Muffin pure. Su Apple
 * Silicon Docker tira l'immagine arm64 e i job passano — con `bubblewrap` e
 * `socat` arm64, un altro allocatore, altre syscall, un altro compilatore per
 * gli addon nativi che `npm ci` costruisce. Un verde qui **non** e' un verde
 * la'. E' esattamente il difetto che questo runner esiste per non ripetere in
 * un'altra forma: un banco che assomiglia alla produzione senza esserlo, e che
 * non lo dice.
 *
 * Non lo aggiustiamo emulando (`--platform linux/amd64` sotto qemu triplica i
 * tempi e cambia proprio le primitive del sandbox che qui contano): lo
 * dichiariamo, in testa e nel verdetto, cosi' chi legge sa cosa ha in mano.
 */
function architetturaDelContainer(): { arch: string; comeGitHub: boolean } {
  try {
    const arch = execFileSync('docker', ['version', '--format', '{{.Server.Arch}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return { arch, comeGitHub: arch === 'amd64' || arch === 'x86_64' };
  } catch {
    return { arch: 'sconosciuta', comeGitHub: false };
  }
}

async function main(): Promise<void> {
  const only = process.env['MUFFIN_CI_LOCAL_ONLY'];
  const sha = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']).toString().trim();
  console.log(`muffin ci:local — replaces GitHub Actions while billing is off\n`);
  console.log(`commit:       ${sha}  (uncommitted changes are not run, like actions/checkout)`);
  console.log(`distribution: ubuntu-latest → ${IMAGE} (ubuntu-latest's current distribution; update here if it changes)`);
  const architettura = architetturaDelContainer();
  console.log(
    `architecture: ${architettura.arch}${
      architettura.comeGitHub
        ? ' (same as ubuntu-latest)'
        : " — ubuntu-latest is x86_64, and so is the VPS: a green here is NOT a green there for anything arch-sensitive (native addons, bwrap/socat, allocator)"
    }`,
  );

  const campioni: CampioneDiCarico[] = [campionaCarico('inizio')];
  console.log(`host load:    ${campioni[0]!.load1.toFixed(1)} on ${campioni[0]!.cpu} cpu, ${campioni[0]!.altriVitest} other vitest`);
  mkdirSync(NPM_CACHE_DIR, { recursive: true });
  console.log(`npm cache:    ${NPM_CACHE_DIR} (persistent across jobs, content-addressed only)`);

  const scratch = mkdtempSync(join(tmpdir(), 'muffin-ci-local-'));
  const keep = process.env['MUFFIN_CI_LOCAL_KEEP'] === '1';
  try {
    console.log('=== cloning HEAD (committed state only) ===');
    const cloneDir = join(scratch, 'src');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', `file://${REPO_ROOT}`, cloneDir]);
    execFileSync('git', ['-C', cloneDir, 'checkout', '--quiet', sha]);
    const repoTar = join(scratch, 'repo.tar');
    execFileSync('bash', ['-c', `COPYFILE_DISABLE=1 tar cf ${shSingleQuote(repoTar)} -C ${shSingleQuote(cloneDir)} .`]);
    console.log(`repo.tar written: ${repoTar}`);

    /**
     * I job si leggono **dal clone**, non dall'albero di lavoro.
     *
     * Sembra un dettaglio e non lo e': il container riceve il tarball di HEAD,
     * quindi leggere i workflow da `REPO_ROOT` fa girare passi che nel tarball
     * non esistono. Il 04/09/2026 e' successo davvero — un workflow giocattolo
     * non tracciato e' finito nell'elenco dei job sotto l'intestazione
     * «cloning HEAD (committed state only)», che diceva l'esatto contrario di
     * cio' che il runner stava facendo. Nell'altro verso e' peggio: modifichi
     * un workflow senza committare e il runner deriva i passi dalla modifica e
     * il codice da HEAD — una combinazione che non esiste da nessuna parte, ne'
     * su GitHub ne' sul tuo disco.
     */
    const allJobs = loadJobs(join(cloneDir, '.github', 'workflows'));
    const jobs = only ? allJobs.filter((j) => j.jobId === only) : allJobs;
    if (only && jobs.length === 0) {
      throw new Error(
        `MUFFIN_CI_LOCAL_ONLY='${only}' matches no job. Known jobs: ${allJobs.map((j) => j.jobId).join(', ')}`,
      );
    }
    console.log(`jobs found:   ${jobs.map((j) => `${j.jobId} (${j.workflowFile})`).join(', ')}\n`);

    let privilegeChoice: PrivilegeChoice | PrivilegeUnavailable | null = null;

    const verdicts: { job: JobSpec; verdict: JobVerdict }[] = [];

    for (const job of jobs) {
      console.log(`\n########## job: ${job.jobId}  (${job.workflowFile}) ##########`);

      if (job.runsOn !== 'ubuntu-latest') {
        const reason = `runs-on '${job.runsOn}' — this runner only emulates ubuntu-latest`;
        console.log(`NOT EXECUTABLE: ${reason}`);
        verdicts.push({ job, verdict: { kind: 'not-executable', reason } });
        continue;
      }

      let dockerArgs: readonly string[] = [];
      if (needsSandboxProbe(job)) {
        if (privilegeChoice === null) {
          console.log('probing this Docker host: can bwrap mount /proc in a nested namespace?');
          privilegeChoice = chooseDockerPrivileges(realDockerProbe(IMAGE));
        }
        if ('unavailable' in privilegeChoice) {
          console.log(`NOT EXECUTABLE: ${privilegeChoice.reason}`);
          verdicts.push({ job, verdict: { kind: 'not-executable', reason: privilegeChoice.reason } });
          continue;
        }
        console.log(`privilege mode: ${privilegeChoice.mode}`);
        dockerArgs = privilegeChoice.dockerArgs;
      } else {
        console.log('privilege mode: none needed (no bubblewrap in this job — no --privileged, no probe wait)');
      }

      const nodeVersion = requestedNodeVersion(job);
      console.log(`node version:   ${nodeVersion} (from actions/setup-node)`);
      if (job.timeoutMinutes !== null) console.log(`timeout:        ${job.timeoutMinutes} minutes (respected)`);

      const bootstrapFile = join(scratch, `${job.jobId}.bootstrap.sh`);
      const jobScriptFile = join(scratch, `${job.jobId}.job.sh`);
      writeFileSync(bootstrapFile, buildBootstrapScript(nodeVersion, { runnerTemp: RUNNER_TEMP }));
      writeFileSync(jobScriptFile, buildJobScript(job, { runnerTemp: RUNNER_TEMP }));
      chmodSync(bootstrapFile, 0o755);
      chmodSync(jobScriptFile, 0o755);

      const containerName = `muffin-ci-local-${job.jobId}-${Date.now()}`;
      const timeoutMs = job.timeoutMinutes === null ? null : job.timeoutMinutes * 60_000;
      const result = await runContainer({
        image: IMAGE,
        dockerArgs,
        containerName,
        repoTar,
        bootstrapFile,
        jobScriptFile,
        timeoutMs,
        npmCacheDir: NPM_CACHE_DIR,
      });

      if (result.timedOut) {
        const reason = `exceeded timeout-minutes: ${job.timeoutMinutes}`;
        console.log(`\nFAIL (${job.jobId}): ${reason}`);
        verdicts.push({ job, verdict: { kind: 'fail', reason } });
      } else if (result.status === 0) {
        console.log(`\nPASS (${job.jobId})`);
        verdicts.push({ job, verdict: { kind: 'pass' } });
      } else {
        const reason =
          result.failedStep === null
            ? `container exited ${result.status}`
            : `step "${result.failedStep}" failed (container exited ${result.status})`;
        console.log(`\nFAIL (${job.jobId}): ${reason}`);
        verdicts.push({ job, verdict: { kind: 'fail', reason } });
      }
    }

    console.log('\n============================================================');
    console.log(`CI-LOCAL verdict @ ${sha}`);
    console.log(
      `distribution=${IMAGE} arch=${architettura.arch}${architettura.comeGitHub ? '' : ' (NOT ubuntu-latest\'s x86_64)'} node=(per job, see above)`,
    );
    for (const { job, verdict } of verdicts) {
      const label = verdict.kind === 'pass' ? 'PASS' : verdict.kind === 'fail' ? 'FAIL' : 'NOT EXECUTABLE';
      const detail = verdict.kind === 'pass' ? '' : ` — ${verdict.reason}`;
      console.log(`  ${label.padEnd(15)} ${job.jobId} (${job.workflowFile})${detail}`);
    }
    const allPass = verdicts.every((v) => v.verdict.kind === 'pass');
    campioni.push(campionaCarico('fine'));
    const contesaRilevata = contesa(campioni);
    if (contesaRilevata !== null) console.log(`CONTENTION: ${contesaRilevata}`);
    console.log('============================================================');
    if (allPass) {
      console.log(`CI-LOCAL PASS @ ${sha}  (${IMAGE}, ${verdicts.length} jobs, see privilege mode per job above)`);
      process.exitCode = 0;
    } else if (contesaRilevata !== null) {
      // Non e' un verdetto: e' un giro da rifare da solo. Exit 2, distinto
      // dall'1 di un FAIL vero, cosi' chi lo legge da uno script non lo
      // scambia per un rosso del codice.
      console.log(`CI-LOCAL DISCARDED @ ${sha}  — red under contention is not a verdict; rerun alone (see CONTENTION above)`);
      process.exitCode = 2;
    } else {
      console.log(`CI-LOCAL FAIL @ ${sha}  — not every job is green (a NOT EXECUTABLE job counts as not green)`);
      process.exitCode = 1;
    }
  } finally {
    if (keep) {
      console.log(`\nMUFFIN_CI_LOCAL_KEEP=1: leaving scratch dir at ${scratch}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  });
}
