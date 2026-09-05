import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RISORSE_DEL_RUNNER, contesa,
  buildJobScript,
  chooseDockerPrivileges,
  creaScannerPassi,
  deriveJob,
  loadJobs,
  needsSandboxProbe,
  requestedNodeVersion,
  resolveExpressions,
  type JobSpec,
} from './ci-local.js';

// ---------------------------------------------------------------------------
// resolveExpressions
// ---------------------------------------------------------------------------

describe('resolveExpressions', () => {
  it('resolves ${{ runner.temp }} to a real directory', () => {
    expect(resolveExpressions('${{ runner.temp }}/out.json', 'test')).toBe('/runner-temp/out.json');
  });

  it('resolves the expression regardless of internal spacing', () => {
    expect(resolveExpressions('${{runner.temp}}/x', 'test')).toBe('/runner-temp/x');
  });

  it('throws, naming the expression and where it was found, for anything it does not know', () => {
    expect(() => resolveExpressions('${{ secrets.TOKEN }}', 'ci.yml#verifica → deploy')).toThrow(
      /secrets\.TOKEN.*ci\.yml#verifica → deploy/s,
    );
  });

  it('leaves text with no expression untouched', () => {
    expect(resolveExpressions('npx tsc --noEmit', 'test')).toBe('npx tsc --noEmit');
  });
});

// ---------------------------------------------------------------------------
// deriveJob — the derivation the whole runner depends on
// ---------------------------------------------------------------------------

describe('deriveJob', () => {
  it('turns a run: step into a StepSpec carrying that exact command', () => {
    const job = deriveJob('fake.yml', 'build', {
      'runs-on': 'ubuntu-latest',
      steps: [{ name: 'say hi', run: 'echo hello-from-the-workflow-file' }],
    });
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0]?.run).toBe('echo hello-from-the-workflow-file');
  });

  it('accepts the two known uses: actions and records their `with:`', () => {
    const job = deriveJob('fake.yml', 'build', {
      'runs-on': 'ubuntu-latest',
      steps: [
        { uses: 'actions/checkout@v4' },
        { uses: 'actions/setup-node@v4', with: { 'node-version': '22' } },
      ],
    });
    expect(job.steps[0]?.uses).toBe('actions/checkout@v4');
    expect(job.steps[1]?.usesWith?.['node-version']).toBe('22');
  });

  it('stops on an unknown uses:, naming the action instead of skipping it', () => {
    expect(() =>
      deriveJob('fake.yml', 'build', {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'actions/upload-artifact@v4', name: 'upload it' }],
      }),
    ).toThrow(/actions\/upload-artifact@v4/);
  });

  it('stops on an if: condition it does not understand', () => {
    expect(() =>
      deriveJob('fake.yml', 'build', {
        'runs-on': 'ubuntu-latest',
        steps: [{ name: 'weird', run: 'echo x', if: "success() && env.FOO == 'bar'" }],
      }),
    ).toThrow(/if: success/);
  });

  it('accepts if: always()', () => {
    const job = deriveJob('fake.yml', 'build', {
      'runs-on': 'ubuntu-latest',
      steps: [{ name: 'report', run: 'echo x', if: 'always()' }],
    });
    expect(job.steps[0]?.if).toBe('always()');
  });

  it('resolves ${{ runner.temp }} inside both run: and step env:', () => {
    const job = deriveJob('fake.yml', 'build', {
      'runs-on': 'ubuntu-latest',
      steps: [
        {
          name: 'report',
          run: 'npx tsx report.ts --out=${{ runner.temp }}/out.json',
          env: { RESULTS: '${{ runner.temp }}/out.json' },
        },
      ],
    });
    expect(job.steps[0]?.run).toContain('/runner-temp/out.json');
    expect(job.steps[0]?.env?.['RESULTS']).toBe('/runner-temp/out.json');
  });
});

// ---------------------------------------------------------------------------
// loadJobs — reading real files from disk
// ---------------------------------------------------------------------------

describe('loadJobs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muffin-ci-local-workflows-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads every *.yml file and every job inside it', () => {
    writeFileSync(
      join(dir, 'a.yml'),
      'jobs:\n  one:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo a\n',
    );
    writeFileSync(
      join(dir, 'b.yml'),
      'jobs:\n  two:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo b\n',
    );
    const jobs = loadJobs(dir);
    expect(jobs.map((j) => j.jobId).sort()).toEqual(['one', 'two']);
  });

  /**
   * This is the test the brief demands as proof there is no second,
   * hand-written definition of the CI steps: a workflow with a `run:` this
   * suite has never seen must make the runner execute *that* command.
   */
  it('the runner executes what the workflow file says, not a hardcoded command', () => {
    const marker = `muffin-derived-${Math.random().toString(36).slice(2)}`;
    writeFileSync(
      join(dir, 'fake-real.yml'),
      ['jobs:', '  probe:', '    runs-on: ubuntu-latest', '    steps:', `      - run: echo ${marker} > out.txt`].join(
        '\n',
      ),
    );
    const [job] = loadJobs(dir);
    expect(job).toBeDefined();

    const appDir = mkdtempSync(join(tmpdir(), 'muffin-ci-local-app-'));
    const runnerTemp = mkdtempSync(join(tmpdir(), 'muffin-ci-local-temp-'));
    try {
      const script = buildJobScript(job as JobSpec, { runnerTemp, appDir });
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(readFileSync(join(appDir, 'out.txt'), 'utf8').trim()).toBe(marker);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// needsSandboxProbe / requestedNodeVersion
// ---------------------------------------------------------------------------

describe('needsSandboxProbe', () => {
  it('is true only for a job that installs bubblewrap', () => {
    const withSandbox = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'sudo apt-get install -y bubblewrap socat ripgrep' }],
    });
    const without = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'npx vitest run docs/collegamenti' }],
    });
    expect(needsSandboxProbe(withSandbox)).toBe(true);
    expect(needsSandboxProbe(without)).toBe(false);
  });
});

describe('requestedNodeVersion', () => {
  it('reads node-version from the actions/setup-node step', () => {
    const job = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [{ uses: 'actions/setup-node@v4', with: { 'node-version': '22' } }],
    });
    expect(requestedNodeVersion(job)).toBe('22');
  });

  it('throws when there is no setup-node step', () => {
    const job = deriveJob('fake.yml', 'j', { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo x' }] });
    expect(() => requestedNodeVersion(job)).toThrow(/setup-node/);
  });
});

// ---------------------------------------------------------------------------
// buildJobScript — step semantics, executed for real (no Docker needed)
// ---------------------------------------------------------------------------

describe('buildJobScript', () => {
  let appDir: string;
  let runnerTemp: string;

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), 'muffin-ci-local-app-'));
    runnerTemp = mkdtempSync(join(tmpdir(), 'muffin-ci-local-temp-'));
  });

  afterEach(() => {
    rmSync(appDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  });

  function run(job: JobSpec): { status: number | null; stdout: string; stderr: string } {
    const script = buildJobScript(job, { runnerTemp, appDir });
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('a failing step fails the job and skips the steps after it', () => {
    const job = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [{ name: 'boom', run: 'exit 1' }, { name: 'never', run: 'echo should-not-run > never.txt' }],
    });
    const { status, stdout } = run(job);
    expect(status).not.toBe(0);
    expect(stdout).toContain('SKIPPED');
    expect(stdout).toContain('never');
  });

  it('a step with if: always() runs even after an earlier step failed', () => {
    const job = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [
        { name: 'boom', run: 'exit 1' },
        { name: 'report', run: 'echo ran > report.txt', if: 'always()' },
      ],
    });
    const { status } = run(job);
    // The job is still failed overall (boom failed)...
    expect(status).not.toBe(0);
    // ...but the always() step still executed.
    expect(readFileSync(join(appDir, 'report.txt'), 'utf8').trim()).toBe('ran');
  });

  it('a step whose script mentions apparmor_parser does not fail the job when it exits non-zero', () => {
    const job = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [
        { name: 'apparmor profile', run: 'apparmor_parser -r /does/not/exist; exit 1' },
        { name: 'still runs', run: 'echo ok > ok.txt' },
      ],
    });
    const { status } = run(job);
    expect(status).toBe(0);
    expect(readFileSync(join(appDir, 'ok.txt'), 'utf8').trim()).toBe('ok');
  });

  it('a normal step that is not about apparmor_parser still fails the job on a non-zero exit', () => {
    const job = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [{ name: 'not apparmor', run: 'exit 3' }],
    });
    const { status } = run(job);
    expect(status).not.toBe(0);
  });

  it('a passing job exits 0', () => {
    const job = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [{ name: 'ok', run: 'echo fine' }],
    });
    expect(run(job).status).toBe(0);
  });

  it('exports step env: variables before running the step', () => {
    const job = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [{ name: 'env', run: 'echo "$FOO" > env.txt', env: { FOO: 'bar-baz' } }],
    });
    run(job);
    expect(readFileSync(join(appDir, 'env.txt'), 'utf8').trim()).toBe('bar-baz');
  });

  it('a step name containing shell-hostile characters does not break the generated script', () => {
    const job = deriveJob('fake.yml', 'j', {
      'runs-on': 'ubuntu-latest',
      steps: [{ name: `it's a "tricky" $(name) \`here\``, run: 'echo survived > survived.txt' }],
    });
    expect(run(job).status).toBe(0);
    expect(readFileSync(join(appDir, 'survived.txt'), 'utf8').trim()).toBe('survived');
  });
});

// ---------------------------------------------------------------------------
// chooseDockerPrivileges — the PR #389 lesson, reused with an injected probe
// so this needs neither Docker nor a real bwrap.
// ---------------------------------------------------------------------------

describe('chooseDockerPrivileges', () => {
  it('does not ask for --privileged when the host mounts /proc without it', () => {
    const result = chooseDockerPrivileges((args) => !args.includes('--privileged'));
    expect('unavailable' in result).toBe(false);
    if (!('unavailable' in result)) {
      expect(result.dockerArgs).not.toContain('--privileged');
      expect(result.mode).toContain('without extra privileges');
    }
  });

  it('falls back to --privileged, and says so, when only that mounts /proc', () => {
    const result = chooseDockerPrivileges((args) => args.includes('--privileged'));
    expect('unavailable' in result).toBe(false);
    if (!('unavailable' in result)) {
      expect(result.dockerArgs).toContain('--privileged');
      expect(result.mode).toContain('--privileged');
    }
  });

  it('reports NOT EXECUTABLE, naming the reason, when neither mode mounts /proc', () => {
    const result = chooseDockerPrivileges(() => false);
    expect('unavailable' in result).toBe(true);
    if ('unavailable' in result) {
      expect(result.reason).toMatch(/proc/);
    }
  });
});

/**
 * Il 04/09/2026 il verdetto di questo runner diceva «container exited 1» e
 * basta: un numero, non una causa. Il nome del passo caduto lo stampava già
 * `buildJobScript`, dentro il container — nessuno lo leggeva.
 */
describe('lo scanner dei passi caduti', () => {
  it('legge il marcatore da una riga intera', () => {
    const s = creaScannerPassi();
    s.consuma('qualcosa\n!!! STEP FAILED: npm test\naltro\n');
    expect(s.passoCaduto()).toBe('npm test');
  });

  it('tiene l\'ultimo: è quello che ha fermato il job', () => {
    const s = creaScannerPassi();
    s.consuma('!!! STEP FAILED: primo\n!!! STEP FAILED: secondo\n');
    expect(s.passoCaduto()).toBe('secondo');
  });

  it('regge il marcatore spezzato fra due chunk — `data` non taglia sulle righe', () => {
    const s = creaScannerPassi();
    s.consuma('rumore\n!!! STEP FA');
    s.consuma('ILED: typecheck\n');
    expect(s.passoCaduto()).toBe('typecheck');
  });

  it("legge l'ultima riga anche senza newline: il container può morire lì", () => {
    const s = creaScannerPassi();
    s.consuma('!!! STEP FAILED: build');
    expect(s.passoCaduto()).toBe('build');
  });

  it('senza marcatore non inventa niente', () => {
    const s = creaScannerPassi();
    s.consuma('npm ERR! something\nexit 1\n');
    expect(s.passoCaduto()).toBeNull();
  });

  it('non si fa ingannare da un prefisso della riga', () => {
    const s = creaScannerPassi();
    s.consuma('2026-09-04T12:00:00Z  !!! STEP FAILED: vitest run   \n');
    expect(s.passoCaduto()).toBe('vitest run');
  });
});

describe('un verdetto su host conteso non e\' un verdetto', () => {
  const cpu = 8;
  it('host libero: nessuna contesa', () => {
    expect(contesa([{ quando: 'inizio', load1: 2.1, cpu, altriVitest: 0 }, { quando: 'fine', load1: 3.0, cpu, altriVitest: 0 }])).toBeNull();
  });
  it('un altro vitest sull\'host, anche solo alla fine, e\' contesa', () => {
    const r = contesa([{ quando: 'inizio', load1: 1, cpu, altriVitest: 0 }, { quando: 'fine', load1: 1, cpu, altriVitest: 1 }]);
    expect(r).toContain('fine');
    expect(r).toContain('vitest');
  });
  it('load sopra il numero di cpu e\' contesa', () => {
    expect(contesa([{ quando: 'inizio', load1: 9.4, cpu, altriVitest: 0 }])).toContain('load 9.4 su 8');
  });
  it("il load a fine corsa e' il nostro (quattro container), non contesa", () => {
    // 05/09/2026: due giri scartati con «fine: load 11.8 su 10 cpu» e nessun
    // altro processo sull'host — il campione di fine misurava ci:local stesso.
    expect(contesa([{ quando: 'inizio', load1: 2.0, cpu, altriVitest: 0 }, { quando: 'fine', load1: 11.8, cpu, altriVitest: 0 }])).toBeNull();
  });
  it('senza cpu note non inventa una soglia', () => {
    expect(contesa([{ quando: 'inizio', load1: 99, cpu: 0, altriVitest: 0 }])).toBeNull();
  });
});

describe('il container ha le risorse del runner, non del Mac', () => {
  it('quattro cpu e quattro worker vitest, come ubuntu-latest', () => {
    expect(RISORSE_DEL_RUNNER).toContain('--cpus=4');
    expect(RISORSE_DEL_RUNNER).toContain('VITEST_MAX_THREADS=4');
    expect(RISORSE_DEL_RUNNER).toContain('VITEST_MAX_FORKS=4');
  });
});
