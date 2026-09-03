import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { arrivalsSummary, atomicSymlink, channelLagNote, cmdUpdate, fetchFailureRemedy, findCheckoutRoot, findOwnedLaunchers, noteDopoLoSwing, offerGatewayRestart, restartVerdict, run, runUpdate, describeBuild } from './update.js';

/**
 * `muffin update` — release built alongside (git worktree), never in place;
 * an atomic launcher-symlink flip is the only thing a live gateway can see
 * change. The worktree/flip/prune mechanics are exercised against REAL git
 * repositories (cheap, and it is exactly the part worth not mocking); only
 * `npm ci`, the smoke test and "read the new schema version" — the three
 * seams that would otherwise shell out to a real `npm install` or spawn a
 * real node subprocess per test — are faked.
 */

type FakeResult = { status: number; stdout: string; stderr: string };
type FakeGit = (args: string[], cwd: string) => FakeResult;

const ok = (): FakeResult => ({ status: 0, stdout: '', stderr: '' });
const fail = (stderr: string): (() => FakeResult) => () => ({ status: 1, stdout: '', stderr });

function dir(prefix: string): string {
  // Resolved once, here: `runUpdate` realpath-resolves the checkout it finds
  // (so `findOwnedLaunchers`' identity check compares like with like), and a
  // test asserting exact paths back against a raw `mkdtempSync` result would
  // be one macOS `/tmp` → `/private/tmp` hop away from a spurious mismatch.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function sh(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} in ${cwd} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

function realGit(args: string[], cwd: string): FakeResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

type Fixture = { remote: string; seed: string; installed: string };

/**
 * **`-b main` non e' cosmetico: senza, questo fixture prova la macchina di chi
 * lo esegue.**
 *
 * `git init` prende il nome del primo ramo da `init.defaultBranch`, che e' una
 * config *globale*. Sulla macchina dell'owner vale `main`, quindi il bare
 * nasce con `HEAD -> refs/heads/main`, il clone lo trova e tutto funziona.
 * Ovunque quella config non sia impostata — un runner CI, un container, una
 * macchina nuova — il bare nasce con `HEAD -> refs/heads/master` mentre il
 * seed spinge `main`: `git clone` avverte «remote HEAD refers to nonexistent
 * ref, unable to checkout», lascia `installed` sul ramo `master` con il
 * **working tree vuoto**, e `runUpdate` non trova niente da aggiornare.
 *
 * Misurato l'1/09/2026: 13 dei test di questo file erano verdi solo perche'
 * chi li eseguiva aveva `init.defaultBranch=main`. Il ramo si dichiara qui, e
 * la config di chi esegue smette di essere un ingrediente.
 *
 * A bare "remote", a `seed` clone that pushes commits to it, and `installed` —
 * the clone `runUpdate` treats as the running checkout, already at the first
 * commit.
 */
function makeFixture(): Fixture {
  const remote = dir('muffin-update-remote-');
  sh('git', ['init', '-q', '-b', 'main', '--bare', remote], remote);
  const seed = dir('muffin-update-seed-');
  sh('git', ['init', '-q', '-b', 'main'], seed);
  sh('git', ['config', 'user.email', 't@t'], seed);
  sh('git', ['config', 'user.name', 't'], seed);
  writeFileSync(join(seed, 'version.txt'), 'v1\n');
  sh('git', ['add', '.'], seed);
  sh('git', ['commit', '-qm', 'v1'], seed);
  sh('git', ['remote', 'add', 'origin', remote], seed);
  sh('git', ['push', '-q', '-u', 'origin', 'main'], seed);

  const installed = dir('muffin-update-installed-');
  sh('git', ['clone', '-q', remote, installed], tmpdir());
  return { remote, seed, installed };
}

function pushNewVersion(f: Fixture, label: string): void {
  writeFileSync(join(f.seed, 'version.txt'), `${label}\n`);
  sh('git', ['commit', '-qam', label], f.seed);
  sh('git', ['push', '-q', 'origin', 'main'], f.seed);
}

/** A bootstrap launcher pointed straight at the main checkout's own build — exactly what `install.sh` leaves behind before any `muffin update` has ever run. */
function seedLauncher(installed: string): { bindir: string; entry0: string } {
  const entry0 = join(installed, 'dist', 'cli', 'main.js');
  mkdirSync(dirname(entry0), { recursive: true });
  writeFileSync(entry0, '// v1 build\n');
  const bindir = dir('muffin-update-bindir-');
  symlinkSync(entry0, join(bindir, 'muffin'));
  return { bindir, entry0 };
}

function releaseDirNames(installed: string): string[] {
  const releasesPath = join(installed, '.releases');
  if (!existsSync(releasesPath)) return [];
  return readdirSync(releasesPath, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('findCheckoutRoot', () => {
  it('resolves the git top-level from the checkout itself', () => {
    const f = makeFixture();
    expect(findCheckoutRoot(f.installed)).toBe(f.installed);
  });

  it('returns null outside any git repository', () => {
    expect(findCheckoutRoot(dir('muffin-update-notgit-'))).toBeNull();
  });
});

describe('findOwnedLaunchers / atomicSymlink', () => {
  it('finds a launcher resolving inside the checkout and ignores a foreign one', () => {
    const checkout = dir('muffin-update-checkout-');
    const inside = join(checkout, 'dist', 'cli', 'main.js');
    mkdirSync(dirname(inside), { recursive: true });
    writeFileSync(inside, '// ours');
    const foreign = dir('muffin-update-foreign-');
    writeFileSync(join(foreign, 'main.js'), '// someone else — e.g. Cinnamon on Linux Mint');

    const bindir = dir('muffin-update-bindir-');
    symlinkSync(inside, join(bindir, 'muffin'));
    symlinkSync(join(foreign, 'main.js'), join(bindir, 'muffin-agent'));

    expect(findOwnedLaunchers(checkout, [bindir])).toEqual([join(bindir, 'muffin')]);
  });

  it('still finds a launcher whose target does not exist yet, as long as the target path is inside the checkout', () => {
    // The realistic case: right after a flip to a release whose `dist/` a
    // real build has not finished writing (or, in every other test here,
    // where `npm ci`/the smoke test are faked and never write one at all).
    // `realpathSync` alone would call this "foreign" — wrongly, since the
    // path is plainly ours — which is the bug this helper exists to avoid.
    const checkout = dir('muffin-update-checkout2-');
    const bindir = dir('muffin-update-bindir2-');
    symlinkSync(join(checkout, 'dist', 'cli', 'main.js'), join(bindir, 'muffin')); // dangling, but inside checkout
    expect(findOwnedLaunchers(checkout, [bindir])).toEqual([join(bindir, 'muffin')]);
  });

  it('ignores a bindir entry that is not a symlink at all to us', () => {
    const checkout = dir('muffin-update-checkout3-');
    const bindir = dir('muffin-update-bindir3-');
    // No `muffin`/`muffin-agent` entry exists in this bindir at all.
    expect(findOwnedLaunchers(checkout, [bindir])).toEqual([]);
  });

  it('atomicSymlink replaces an existing link without leaving a tmp file behind', () => {
    const d = dir('muffin-update-swap-');
    const a = join(d, 'a.js');
    const b = join(d, 'b.js');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    const link = join(d, 'link');
    symlinkSync(a, link);

    atomicSymlink(b, link);

    expect(readlinkSync(link)).toBe(b);
    expect(readdirSync(d).some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('atomicSymlink creates a fresh link when none existed', () => {
    const d = dir('muffin-update-swap2-');
    const target = join(d, 't.js');
    writeFileSync(target, 't');
    const link = join(d, 'link');
    atomicSymlink(target, link);
    expect(readlinkSync(link)).toBe(target);
  });
});

describe('fetchFailureRemedy', () => {
  it('recognizes an auth failure and points at the deploy key/token', () => {
    expect(fetchFailureRemedy('fatal: Authentication failed for \'https://...\'')).toMatch(/deploy key|token/);
    expect(fetchFailureRemedy('fatal: Could not read from remote repository.')).toMatch(/deploy key|token/);
    expect(fetchFailureRemedy("remote: Invalid username or password.")).toMatch(/deploy key|token/);
  });

  it('falls back to a generic connectivity remedy for anything else', () => {
    expect(fetchFailureRemedy('fatal: unable to access: could not resolve host github.com')).toMatch(/deploy key|token/);
    expect(fetchFailureRemedy('fatal: some unrelated plumbing error')).not.toMatch(/deploy key/);
  });
});

describe('runUpdate — happy path (bootstrap: no prior release recorded)', () => {
  it('builds a release worktree alongside, backs up, and flips the launcher without touching the main worktree', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const { bindir, entry0 } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');

    const result = runUpdate({
      moduleDir: f.installed,
      home,
      bindirs: [bindir],
      npmCi: ok,
      smokeTest: ok,
      readNewSchemaVersion: () => 1,
    });

    expect(result.code).toBe(0);
    expect(result.steps.every((s) => s.done)).toBe(true);

    const names = releaseDirNames(f.installed);
    expect(names.length).toBe(1);
    const releaseDir = join(f.installed, '.releases', names[0]!);
    expect(readFileSync(join(releaseDir, 'version.txt'), 'utf8').trim()).toBe('v2');

    // the launcher now points at the new release's entry
    expect(readlinkSync(join(bindir, 'muffin'))).toBe(join(releaseDir, 'dist', 'cli', 'main.js'));
    // the main worktree is exactly as it was
    expect(readFileSync(join(f.installed, 'version.txt'), 'utf8').trim()).toBe('v1');
    expect(realGit(['status', '--porcelain', '--untracked-files=no'], f.installed).stdout.trim()).toBe('');

    const current = JSON.parse(readFileSync(join(f.installed, '.releases', 'current'), 'utf8')) as { sha: string; entry: string };
    expect(current.entry).toBe(join(releaseDir, 'dist', 'cli', 'main.js'));
    const previous = JSON.parse(readFileSync(join(f.installed, '.releases', 'previous'), 'utf8')) as { sha: string; entry: string };
    expect(previous.entry).toBe(entry0); // bootstrap: "previous" is the main worktree's own build
  });

  it('reports the backup scope and the migrations delta honestly', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const { bindir } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');
    mkdirSync(home, { recursive: true });
    const db = new DatabaseCtor(join(home, 'muffin.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    db.prepare(`INSERT INTO schema_version (version, description, applied_at) VALUES (1, 'baseline', ?)`).run(new Date().toISOString());
    db.close();

    const result = runUpdate({
      moduleDir: f.installed,
      home,
      bindirs: [bindir],
      npmCi: ok,
      smokeTest: ok,
      readNewSchemaVersion: () => 3,
    });

    expect(result.code).toBe(0);
    const backupStep = result.steps.find((s) => s.name === 'backup');
    expect(backupStep?.detail).toMatch(/memoria.*episodi.*job.*budget.*indice del vault|copre il database/);
    expect(backupStep?.detail).toMatch(/NON copre/);
    expect(backupStep?.detail).toContain(join(home, 'vault'));
    expect(backupStep?.detail).toContain(join(home, 'secrets'));
    expect(backupStep?.detail).toContain(join(home, 'rot'));

    const schemaStep = result.steps.find((s) => s.name === 'schema');
    expect(schemaStep?.detail).toMatch(/v1/);
    expect(schemaStep?.detail).toMatch(/v3/);
    expect(schemaStep?.detail).toMatch(/in sospeso/);
  });
});

/**
 * Le due conseguenze di un update riuscito che il comando taceva (misurate
 * sulla macchina dell'owner il 03/09/2026): il checkout resta indietro, e un
 * processo già avviato continua sul codice vecchio.
 */
describe('noteDopoLoSwing', () => {
  it('non dice niente del checkout quando è già sul commit della release', () => {
    const righe = noteDopoLoSwing({
      releaseSha: 'a'.repeat(40),
      checkoutSha: 'a'.repeat(40),
      behind: 0,
      checkoutRoot: '/home/o/muffin-agent',
    });
    expect(righe.some((r) => /checkout/.test(r))).toBe(false);
    expect(righe.some((r) => /git -C/.test(r))).toBe(false);
  });

  it('quando il checkout è indietro nomina di quanto e il comando che lo ripara', () => {
    const righe = noteDopoLoSwing({
      releaseSha: 'b'.repeat(40),
      checkoutSha: 'c'.repeat(40),
      behind: 7,
      checkoutRoot: '/home/o/muffin-agent',
    });
    const riga = righe.find((r) => /checkout/.test(r));
    expect(riga).toMatch(/indietro di 7 commit/);
    expect(riga).toContain('git -C /home/o/muffin-agent pull');
    expect(riga).toContain('ccccccc');
    expect(riga).toContain('bbbbbbb');
  });

  it('la riga sul riavvio c\'è sempre, e parla di sessioni in primo piano — non del gateway', () => {
    for (const args of [
      { releaseSha: 'a'.repeat(40), checkoutSha: 'a'.repeat(40), behind: 0, checkoutRoot: '/r' },
      { releaseSha: 'a'.repeat(40), checkoutSha: 'd'.repeat(40), behind: 2, checkoutRoot: '/r' },
      { releaseSha: 'a'.repeat(40), checkoutSha: null, behind: 0, checkoutRoot: '/r' },
    ]) {
      const righe = noteDopoLoSwing(args);
      const riavvio = righe.find((r) => /REPL/.test(r));
      expect(riavvio).toMatch(/già in esecuzione/);
      // `offerGatewayRestart` si occupa del gateway subito dopo: dirlo qui sarebbe falso.
      expect(riavvio).not.toMatch(/gateway/i);
    }
  });

  it('senza un HEAD leggibile non inventa una distanza', () => {
    const righe = noteDopoLoSwing({ releaseSha: 'a'.repeat(40), checkoutSha: null, behind: 0, checkoutRoot: '/r' });
    expect(righe.some((r) => /git -C/.test(r))).toBe(false);
  });
});

describe("runUpdate — le note dopo lo swing arrivano davvero in fondo all'update", () => {
  it('dice che il checkout è indietro, con il comando, e che i processi vivi vanno rilanciati', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const { bindir } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');

    const result = runUpdate({
      moduleDir: f.installed,
      home,
      bindirs: [bindir],
      npmCi: ok,
      smokeTest: ok,
      readNewSchemaVersion: () => 1,
    });

    expect(result.code).toBe(0);
    const note = result.steps.filter((s) => s.name === 'dopo').map((s) => s.detail);
    // il fixture lascia `installed` a v1 mentre la release è v2: esattamente il
    // caso dell'owner, e la distanza la conta il `gitRunner` reale.
    const checkout = note.find((d) => /checkout/.test(d));
    expect(checkout).toMatch(/indietro di 1 commit/);
    expect(checkout).toContain(`git -C ${f.installed} pull`);
    expect(note.some((d) => /già in esecuzione/.test(d))).toBe(true);
  });
});

describe('runUpdate — failures never touch the running tree', () => {
  it('deletes the release and leaves the launcher untouched when npm ci fails inside it', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const { bindir, entry0 } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');

    const result = runUpdate({
      moduleDir: f.installed,
      home,
      bindirs: [bindir],
      npmCi: fail('npm ERR! could not resolve dependency'),
    });

    expect(result.code).toBe(1);
    expect(result.steps.find((s) => s.name === 'npm ci')?.done).toBe(false);
    expect(releaseDirNames(f.installed)).toEqual([]);
    expect(readlinkSync(join(bindir, 'muffin'))).toBe(entry0);
    expect(existsSync(join(f.installed, '.releases', 'current'))).toBe(false);
    // no dangling worktree registration left behind either
    expect(realGit(['worktree', 'list'], f.installed).stdout.trim().split('\n').length).toBe(1);
  });

  it('deletes the release and leaves the launcher untouched when the smoke test fails', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const { bindir, entry0 } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');

    const result = runUpdate({
      moduleDir: f.installed,
      home,
      bindirs: [bindir],
      npmCi: ok,
      smokeTest: fail('Error: Cannot find module'),
    });

    expect(result.code).toBe(1);
    expect(result.steps.find((s) => s.name === 'smoke test')?.done).toBe(false);
    expect(releaseDirNames(f.installed)).toEqual([]);
    expect(readlinkSync(join(bindir, 'muffin'))).toBe(entry0);
  });

  it('stops honestly, with the auth remedy, when git fetch fails — and touches nothing', () => {
    const f = makeFixture();
    const { bindir, entry0 } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');
    const fakeGit: FakeGit = (args, cwd) => (args[0] === 'fetch' ? fail("fatal: Authentication failed for 'https://example/repo.git'")() : realGit(args, cwd));

    const result = runUpdate({ moduleDir: f.installed, home, bindirs: [bindir], git: fakeGit });

    expect(result.code).toBe(1);
    const step = result.steps.find((s) => s.name === 'fetch');
    expect(step?.done).toBe(false);
    expect(step?.detail).toMatch(/deploy key|token/);
    expect(releaseDirNames(f.installed)).toEqual([]);
    expect(readlinkSync(join(bindir, 'muffin'))).toBe(entry0);
  });

  it('refuses honestly when the running module is not inside a git checkout at all', () => {
    const result = runUpdate({ moduleDir: dir('muffin-update-notgit2-'), home: dir('muffin-update-home-') });
    expect(result.code).toBe(1);
    expect(result.steps[0]?.done).toBe(false);
    expect(result.steps[0]?.detail).toMatch(/non sembra un checkout git/);
  });
});

describe('runUpdate — dry-run and already-updated', () => {
  it('dry-run reports the distance and creates nothing', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const home = dir('muffin-update-home-');

    const result = runUpdate({ moduleDir: f.installed, home, dryRun: true });

    expect(result.code).toBe(0);
    expect(result.steps.find((s) => s.name === 'dry-run')?.detail).toMatch(/dietro di 1 commit/);
    expect(existsSync(join(f.installed, '.releases'))).toBe(false);
    expect(readFileSync(join(f.installed, 'version.txt'), 'utf8').trim()).toBe('v1');
  });

  it('reports already-updated and does nothing when there is nothing new on origin/main', () => {
    const f = makeFixture(); // never pushed a second commit
    const home = dir('muffin-update-home-');

    const result = runUpdate({ moduleDir: f.installed, home });

    expect(result.code).toBe(0);
    expect(result.steps.some((s) => /già aggiornato/.test(s.detail))).toBe(true);
    expect(existsSync(join(f.installed, '.releases'))).toBe(false);
  });
});

describe('runUpdate — release pruning across cycles', () => {
  it('keeps only current+previous, pruning anything older once a third release lands', () => {
    const f = makeFixture();
    const { bindir } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');
    const deps = { moduleDir: f.installed, home, bindirs: [bindir], npmCi: ok, smokeTest: ok, readNewSchemaVersion: () => 1 };

    pushNewVersion(f, 'v2');
    expect(runUpdate(deps).code).toBe(0);
    const afterFirst = releaseDirNames(f.installed);
    expect(afterFirst.length).toBe(1);
    const releaseA = afterFirst[0]!;

    pushNewVersion(f, 'v3');
    expect(runUpdate(deps).code).toBe(0);
    const afterSecond = releaseDirNames(f.installed);
    expect(afterSecond.length).toBe(2);
    expect(afterSecond).toContain(releaseA); // still kept, as "previous"
    const releaseB = afterSecond.find((n) => n !== releaseA)!;

    pushNewVersion(f, 'v4');
    const third = runUpdate(deps);
    expect(third.code).toBe(0);
    const afterThird = releaseDirNames(f.installed);
    expect(afterThird.length).toBe(2);
    expect(afterThird).toContain(releaseB); // now "previous"
    expect(afterThird).not.toContain(releaseA); // pruned: neither current nor previous anymore
    expect(third.steps.find((s) => s.name === 'pulizia')?.detail).toContain(releaseA);
  });
});

describe('runUpdate --rollback', () => {
  it('refuses when there is no previous release recorded', () => {
    const f = makeFixture();
    const result = runUpdate({ moduleDir: f.installed, home: dir('muffin-update-home-'), rollback: true });
    expect(result.code).toBe(1);
    expect(result.steps.find((s) => s.name === 'rollback')?.detail).toMatch(/nessuna release precedente/);
  });

  it('flips back to the previous release, and a second rollback toggles forward again', () => {
    const f = makeFixture();
    const { bindir, entry0 } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');
    const deps = { moduleDir: f.installed, home, bindirs: [bindir], npmCi: ok, smokeTest: ok, readNewSchemaVersion: () => 1 };

    pushNewVersion(f, 'v2');
    expect(runUpdate(deps).code).toBe(0);
    const releaseEntry = readlinkSync(join(bindir, 'muffin'));
    expect(releaseEntry).not.toBe(entry0);

    const rolledBack = runUpdate({ ...deps, rollback: true });
    expect(rolledBack.code).toBe(0);
    expect(readlinkSync(join(bindir, 'muffin'))).toBe(entry0);

    const toggledForward = runUpdate({ ...deps, rollback: true });
    expect(toggledForward.code).toBe(0);
    expect(readlinkSync(join(bindir, 'muffin'))).toBe(releaseEntry);
  });

  it('refuses when the database is already migrated past the release being restored', () => {
    const f = makeFixture();
    const { bindir, entry0 } = seedLauncher(f.installed);
    const home = dir('muffin-update-home-');

    pushNewVersion(f, 'v2');
    expect(
      runUpdate({ moduleDir: f.installed, home, bindirs: [bindir], npmCi: ok, smokeTest: ok, readNewSchemaVersion: () => 1 }).code,
    ).toBe(0);

    mkdirSync(home, { recursive: true });
    const db = new DatabaseCtor(join(home, 'muffin.db'));
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    db.prepare(`INSERT INTO schema_version (version, description, applied_at) VALUES (5, 'ahead', ?)`).run(new Date().toISOString());
    db.close();

    const rb = runUpdate({ moduleDir: f.installed, home, bindirs: [bindir], rollback: true, readNewSchemaVersion: () => 1 });

    expect(rb.code).toBe(1);
    const step = rb.steps.find((s) => s.name === 'rollback');
    expect(step?.done).toBe(false);
    expect(step?.detail).toMatch(/SchemaAheadError|si rifiuterà/);
    expect(readlinkSync(join(bindir, 'muffin'))).not.toBe(entry0); // nothing flipped
  });
});

/**
 * `run()` — the shared `spawnSync` wrapper `offerGatewayRestart`'s default
 * `restart` goes through — has to be tested at this level and not only
 * through `offerGatewayRestart`'s injected `restart` seam: that seam
 * *replaces* `run()` entirely, so a bug inside it (the one measured on the
 * owner's machine 03/09/2026 — see the docstring on `run`) is invisible from
 * outside. A real `sleep` with a timeout well under its own duration is the
 * only way to reach the actual `spawnSync` timeout path.
 */
describe('run — a spawnSync timeout must not swallow its own detail', () => {
  it('surfaces r.error.message when the child is killed for taking too long', () => {
    const r = run('sleep', ['2'], process.cwd(), 100);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toBe('');
    expect(r.stderr).toMatch(/ETIMEDOUT/);
  });
});

/**
 * The pure decision behind the three sentences the owner reads. Each case
 * gets its own assertion on the exact wording, so a regression back to
 * "trust the command's exit status" — which used to print the identical
 * consoling line in all three situations, measured 03/09/2026 — fails a
 * specific test instead of a vague one.
 */
describe('restartVerdict — three outcomes, three sentences', () => {
  it('restarted and verified: the state changed, the command also said ok', () => {
    const v = restartVerdict({ pidBefore: 88175, pidAfter: 65671, commandOk: true, commandDetail: '' });
    expect(v.restarted).toBe(true);
    expect(v.line).toMatch(/riavviato — verificato/);
    expect(v.line).toContain('88175');
    expect(v.line).toContain('65671');
  });

  it('the command failed but a new process is serving anyway (transient): nothing is wrong', () => {
    const v = restartVerdict({
      pidBefore: 88175,
      pidAfter: 65671,
      commandOk: false,
      commandDetail: 'launchctl: qualcosa di transitorio',
    });
    expect(v.restarted).toBe(true);
    expect(v.line).toMatch(/riavviato — verificato/);
    expect(v.line).toMatch(/scontro transitorio/);
    expect(v.line).toContain('launchctl: qualcosa di transitorio');
  });

  it('the command failed and nothing restarted: still the old build, the detail is in the line', () => {
    const v = restartVerdict({
      pidBefore: 88175,
      pidAfter: 88175,
      commandOk: false,
      commandDetail: 'Bootstrap failed: 5: Input/output error',
    });
    expect(v.restarted).toBe(false);
    expect(v.line).toMatch(/il riavvio non è avvenuto/);
    expect(v.line).toContain('Bootstrap failed: 5: Input/output error');
  });

  it('the command claimed success but the state disagrees: still "not restarted", said plainly', () => {
    const v = restartVerdict({ pidBefore: 88175, pidAfter: 88175, commandOk: true, commandDetail: '' });
    expect(v.restarted).toBe(false);
    expect(v.line).toMatch(/il riavvio non è avvenuto/);
    expect(v.line).toMatch(/uscito 0, ma nessun processo nuovo/);
  });
});

describe('offerGatewayRestart', () => {
  function captureErr(fn: () => Promise<void>): Promise<string> {
    let out = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    return fn().finally(() => spy.mockRestore()).then(() => out);
  }

  /** Instant in tests — nothing here should ever wait on a real timer. */
  const noSleep = async (): Promise<void> => {};

  /** Returns `seq[i]` on the i-th call, then repeats the last value forever. */
  function pidSequence(seq: (number | null)[]): () => number | null {
    let i = 0;
    return () => seq[Math.min(i++, seq.length - 1)] ?? null;
  }

  it('when nothing is supervised: says so, and that the new code lands at the next start anyway', async () => {
    const out = await captureErr(() =>
      offerGatewayRestart(dir('muffin-update-home-'), {
        yes: false,
        platform: 'linux',
        gatewayRunning: false,
        supervisorProbes: { unitFileExists: () => false },
      }),
    );
    expect(out).toMatch(/nessun gateway supervisionato/);
    expect(out).toMatch(/prossimo riavvio/);
  });

  it('on decline: still says the new code lands at the next restart, even an involuntary one', async () => {
    const out = await captureErr(() =>
      offerGatewayRestart(dir('muffin-update-home-'), {
        yes: false,
        platform: 'linux',
        gatewayRunning: false,
        supervisorProbes: { unitFileExists: () => true, systemdEnabled: () => true, systemdFailed: () => false, lingerEnabled: () => true },
        promptFn: async () => 'n',
      }),
    );
    expect(out).toMatch(/entra comunque al prossimo riavvio/);
    expect(out).toMatch(/crash/);
  });

  it('uses launchctl kickstart on darwin', async () => {
    let restarted: string[] | null = null;
    await captureErr(() =>
      offerGatewayRestart(dir('muffin-update-home-'), {
        yes: true,
        platform: 'darwin',
        gatewayRunning: false,
        supervisorProbes: { unitFileExists: () => true, launchdLoaded: () => true },
        restart: (argv) => {
          restarted = argv;
          return { status: 0, stdout: '', stderr: '' };
        },
        readGatewayPid: pidSequence([1111, 2222]),
        sleep: noSleep,
      }),
    );
    expect(restarted?.[0]).toBe('launchctl');
    expect(restarted?.[1]).toBe('kickstart');
    expect(restarted?.[2]).toBe('-k');
  });

  /**
   * The three cases the mandate asks for, driven end to end: fake supervisor
   * probes (so no real systemctl/launchctl is touched) and a fake `restart`
   * runner, asserting the exact sentence printed — not a substring that a
   * regression could still satisfy by accident.
   */
  describe('verifying the restart by state, not by exit code', () => {
    const engaged = {
      unitFileExists: () => true,
      systemdEnabled: () => true,
      systemdFailed: () => false,
      lingerEnabled: () => true,
    };

    it('1. restarted and verified — regardless of the command also saying 0', async () => {
      const out = await captureErr(() =>
        offerGatewayRestart(dir('muffin-update-home-'), {
          yes: true,
          platform: 'linux',
          gatewayRunning: true,
          supervisorProbes: engaged,
          restart: () => ({ status: 0, stdout: '', stderr: '' }),
          readGatewayPid: pidSequence([88175, 88175, 65671]),
          sleep: noSleep,
        }),
      );
      expect(out).toMatch(/gateway riavviato — verificato: pid 88175 → adesso serve pid 65671\./);
      // Case 1 never carries the "still on the old build" note.
      expect(out).not.toMatch(/prossimo riavvio/);
    });

    it('2. the command failed AND nothing restarted: the owner is still on the old build, and must act', async () => {
      const out = await captureErr(() =>
        offerGatewayRestart(dir('muffin-update-home-'), {
          yes: true,
          platform: 'linux',
          gatewayRunning: true,
          supervisorProbes: engaged,
          restart: () => ({ status: 1, stdout: '', stderr: 'Failed to restart muffin-gateway.service: Unit is masked.' }),
          readGatewayPid: pidSequence([88175]), // never changes
          sleep: noSleep,
          verifyAttempts: 2,
        }),
      );
      expect(out).toMatch(/il riavvio non è avvenuto: il gateway servito adesso è ancora lo stesso di prima \(pid 88175\)/);
      // Objective 3: the detail must reach the owner, never swallowed.
      expect(out).toContain('Failed to restart muffin-gateway.service: Unit is masked.');
      // Case 2 is the one that must still carry the "still lands eventually" note.
      expect(out).toMatch(/entra comunque al prossimo riavvio/);
    });

    it('3. the command failed but a new process is serving anyway (transient): nothing is wrong', async () => {
      const out = await captureErr(() =>
        offerGatewayRestart(dir('muffin-update-home-'), {
          yes: true,
          platform: 'linux',
          gatewayRunning: true,
          supervisorProbes: engaged,
          restart: () => ({ status: 1, stdout: '', stderr: '' }),
          readGatewayPid: pidSequence([88175, 88175, 65671]),
          sleep: noSleep,
        }),
      );
      expect(out).toMatch(/gateway riavviato — verificato: pid 88175 → adesso serve pid 65671\./);
      expect(out).toMatch(/scontro transitorio/);
      // Nothing failed from the owner's point of view — no "still on the old build" note.
      expect(out).not.toMatch(/prossimo riavvio/);
    });

    it("the failing command's stderr reaches the output verbatim — never dropped", async () => {
      const out = await captureErr(() =>
        offerGatewayRestart(dir('muffin-update-home-'), {
          yes: true,
          platform: 'linux',
          gatewayRunning: true,
          supervisorProbes: engaged,
          restart: () => ({ status: 1, stdout: '', stderr: 'una riga di dettaglio molto specifica 4f2a91' }),
          readGatewayPid: pidSequence([88175]),
          sleep: noSleep,
          verifyAttempts: 1,
        }),
      );
      expect(out).toContain('una riga di dettaglio molto specifica 4f2a91');
    });
  });
});

describe('cmdUpdate — argument parsing', () => {
  it('returns 78 on an unrecognized flag, before touching anything', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdUpdate(['--nonsense'])).toBe(78);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Quale build sto guardando.
 *
 * `package.json` dice `0.0.0` e non è sbagliato: è vuoto. Questo progetto non
 * si distribuisce per release numerate — `muffin update` costruisce
 * `.releases/<sha>` — quindi la cosa che identifica una build è il suo commit.
 *
 * Misurato il 27/08: per capire quale build fosse installata sulla macchina
 * dell'owner ho dovuto interrogare i sottocomandi (`muffin trace --help` senza
 * `turn`, `doctor` senza la riga `defaults`) e dedurre da lì che fosse
 * anteriore a #133 e #142. Una domanda a cui il binario dovrebbe rispondere.
 */
describe('describeBuild', () => {
  const runner =
    (map: Record<string, { status: number; stdout: string }>) =>
    (args: string[]): { status: number; stdout: string; stderr: string } => {
      const key = args.join(' ');
      const r = map[key] ?? { status: 1, stdout: '' };
      return { ...r, stderr: '' };
    };

  it('porta il commit e la sua data', () => {
    const b = describeBuild('/qualunque', runner({
      'log -1 --format=%H %cs': { status: 0, stdout: 'abc123def4567890 2026-08-27\n' },
      'status --porcelain': { status: 0, stdout: '' },
    }));
    expect(b).toEqual({ sha: 'abc123def4567890', date: '2026-08-27', dirty: false });
  });

  it('un checkout modificato non è quel commit, e lo dice', () => {
    const b = describeBuild('/qualunque', runner({
      'log -1 --format=%H %cs': { status: 0, stdout: 'abc123def4567890 2026-08-27\n' },
      'status --porcelain': { status: 0, stdout: ' M cli/main.ts\n' },
    }));
    expect(b?.dirty).toBe(true);
  });

  it('uno `status` che fallisce non rende la build pulita', () => {
    // Nel dubbio si dichiara toccata: l'errore che costa è il contrario.
    const b = describeBuild('/qualunque', runner({
      'log -1 --format=%H %cs': { status: 0, stdout: 'abc123def4567890 2026-08-27\n' },
    }));
    expect(b?.dirty).toBe(true);
  });

  it('fuori da un checkout Git dice `null`, non un SHA inventato', () => {
    expect(describeBuild('/qualunque', runner({}))).toBeNull();
  });

  it('una risposta senza data non è mezza valida', () => {
    const b = describeBuild('/qualunque', runner({
      'log -1 --format=%H %cs': { status: 0, stdout: 'abc123def4567890\n' },
    }));
    expect(b).toBeNull();
  });
});

/** Lo stesso setup dell'happy path sopra, impacchettato: qui interessa la sequenza degli eventi, non l'esito. */
function fakeDeps(): Parameters<typeof runUpdate>[0] {
  const f = makeFixture();
  pushNewVersion(f, 'v2');
  const { bindir } = seedLauncher(f.installed);
  return {
    moduleDir: f.installed,
    home: dir('muffin-update-ux-'),
    bindirs: [bindir],
    npmCi: ok,
    smokeTest: ok,
    readNewSchemaVersion: () => 1,
  };
}

/**
 * `npm ci` dentro la release nuova prende decine di secondi, e per tutto quel
 * tempo il comando non diceva niente: i passi si accumulavano in un array e si
 * stampavano tutti alla fine. Un aggiornamento che sembra bloccato è un
 * aggiornamento che qualcuno interrompe a metà — e questo comando scambia un
 * symlink.
 */
describe('update — i passi si vedono mentre succedono', () => {
  it('ogni passo arriva a `onStep` man mano, e resta anche nel riepilogo', () => {
    const vivi: string[] = [];
    const r = runUpdate({ ...fakeDeps(), onStep: (s) => void vivi.push(s.name) });
    // Gli stessi passi, nello stesso ordine: due consumatori dello stesso
    // evento, non due elenchi che possono divergere.
    expect(vivi).toEqual(r.steps.map((s) => s.name));
    expect(vivi.length).toBeGreaterThan(3);
  });

  it("`onBegin` apre l'attesa prima dell'operazione lenta, non dopo", () => {
    const eventi: string[] = [];
    runUpdate({
      ...fakeDeps(),
      onBegin: (n) => void eventi.push(`>${n}`),
      onStep: (s) => void eventi.push(`<${s.name}`),
    });
    // Il passo che da solo vale la slice: l'attesa si apre prima che `npm ci`
    // parta, e si chiude col suo esito.
    const apre = eventi.indexOf('>npm ci');
    const chiude = eventi.indexOf('<npm ci');
    expect(apre).toBeGreaterThanOrEqual(0);
    expect(chiude).toBeGreaterThan(apre);
  });

  it('un passo fallito arriva vivo come gli altri, non solo nel riepilogo', () => {
    const vivi: { name: string; done: boolean }[] = [];
    runUpdate({
      ...fakeDeps(),
      npmCi: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      onStep: (s) => void vivi.push({ name: s.name, done: s.done }),
    });
    expect(vivi.some((s) => s.name === 'npm ci' && !s.done)).toBe(true);
  });

  it('senza callback si comporta esattamente come prima', () => {
    expect(() => runUpdate(fakeDeps())).not.toThrow();
  });
});

/**
 * Le release si annidavano, e il difetto cresceva di un livello a ogni update.
 *
 * `rev-parse --show-toplevel` risponde con il worktree *corrente*, e una
 * release È un worktree collegato. Quindi dal secondo aggiornamento in poi il
 * processo gira dentro `.releases/<sha>`, la radice trovata è quella, e la
 * release nuova nasce dentro la vecchia. Misurato sulla macchina dell'owner
 * dopo tre update, come percorso vero del launcher:
 *
 *     .releases/9a98bbe/.releases/2c35425/.releases/9e1b5af/dist/cli/main.js
 *
 * Il test guarda la cosa che conta — dove finisce la seconda release — e non
 * come ci si arriva.
 */
describe('le release non si annidano', () => {
  it('il secondo update, lanciato da dentro la prima release, resta fratello e non figlio', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const { bindir } = seedLauncher(f.installed);
    const home = dir('muffin-nesting-');

    const primo = runUpdate({
      moduleDir: f.installed,
      home,
      bindirs: [bindir],
      npmCi: ok,
      smokeTest: ok,
      readNewSchemaVersion: () => 1,
    });
    expect(primo.code).toBe(0);
    const [releaseUno] = releaseDirNames(f.installed);
    expect(releaseUno).toBeDefined();
    const dentroLaPrima = join(f.installed, '.releases', releaseUno!);

    // Il secondo giro parte da dove il launcher punta adesso: dentro la release.
    pushNewVersion(f, 'v3');
    const secondo = runUpdate({
      moduleDir: dentroLaPrima,
      home,
      bindirs: [bindir],
      npmCi: ok,
      smokeTest: ok,
      readNewSchemaVersion: () => 1,
    });
    expect(secondo.code).toBe(0);

    // Nessun `.releases` dentro una release: e' esattamente la forma che
    // cresceva di un livello per volta.
    expect(existsSync(join(dentroLaPrima, '.releases'))).toBe(false);
    // E le due release stanno una accanto all'altra, dove il pruning e il
    // rollback sanno guardare.
    expect(releaseDirNames(f.installed).length).toBe(2);
  });

  it('e il launcher punta dentro il checkout vero, non dentro una release', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const { bindir } = seedLauncher(f.installed);
    const home = dir('muffin-nesting-');
    const deps = { home, bindirs: [bindir], npmCi: ok, smokeTest: ok, readNewSchemaVersion: () => 1 };

    runUpdate({ ...deps, moduleDir: f.installed });
    const dentro = join(f.installed, '.releases', releaseDirNames(f.installed)[0]!);
    pushNewVersion(f, 'v3');
    runUpdate({ ...deps, moduleDir: dentro });

    const puntaA = readlinkSync(join(bindir, 'muffin'));
    // Un solo `.releases` nel percorso: due vorrebbero dire annidato.
    expect(puntaA.split('.releases').length - 1).toBe(1);
    expect(puntaA.startsWith(join(f.installed, '.releases'))).toBe(true);
  });
});

/**
 * Il nome di uno script è una promessa, e questa il repo l'aveva già fatta.
 *
 * Dal mandato DAY-1: *«il naming degli script (`build` vs `compile`) non deve
 * permettere a una persona di credere di avere costruito `dist` quando non è
 * successo»*. Non era mai stato soddisfatto: `build` era `tsc --noEmit`, cioè
 * un controllo di tipi che non scrive un file, e usciva **zero**.
 *
 * Il 28/08/2026 mi è costato una conclusione sbagliata: ho lanciato
 * `npm run build`, ho letto «ok», ho pilotato il REPL vero dentro tmux e ho
 * concluso che l'input multilinea fosse rotto. Stavo guardando il binario di
 * ieri sera. Un comando che dice di aver costruito senza aver costruito non
 * produce un errore: produce una misura di qualcos'altro, che è peggio.
 *
 * Da qui in avanti `build` costruisce. Questo test è la promessa scritta dove
 * si rompe.
 */
describe('gli script fanno quello che dice il loro nome', () => {
  const scripts = (
    JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('`build` non è un controllo di tipi travestito', () => {
    expect(scripts.build).toBeDefined();
    expect(scripts.build).not.toContain('--noEmit');
  });

  /** E chi vuole solo i tipi ha un nome per chiederli, invece di prendersi `build`. */
  it('e chi vuole solo i tipi chiede `typecheck`', () => {
    expect(scripts.typecheck).toContain('--noEmit');
  });

  /**
   * `install.sh` e `muffin update` costruiscono con `compile`: è quello che
   * produce l'artefatto che finisce installato, e non deve sparire sotto di
   * loro perché qualcuno ha riordinato i nomi.
   */
  it('e `compile` resta, perché è quello che install.sh e update chiamano', () => {
    expect(scripts.compile).toContain('tsconfig.build.json');
  });
});

/**
 * Il canale, e la riga che il 03/09/2026 non c'era.
 *
 * Misurato quel giorno sulla macchina dell'owner: il launcher puntava a
 * `5c49f1e`, che **era** la testa di `origin/main`, quindi `muffin update`
 * usciva 0 e diceva «già aggiornato». Era vero. Nello stesso istante
 * `origin/dev` era avanti di sette commit non-merge, compresa la correzione
 * che l'owner stava aspettando, e nessuno aveva ancora aperto la PR di
 * promozione. Il comando stampava gli stessi byte per «non c'è niente di
 * nuovo» e per «c'è parecchio, nessuno l'ha promosso».
 *
 * Il `git` finto è la stessa forma già usata da `describeBuild` qui sopra —
 * una mappa `argomenti → risposta` — con una scelta in più: **una chiamata non
 * mappata esce 1**. Un fake permissivo direbbe «0 commit» a una domanda che
 * nessuno ha fatto, ed è precisamente la classe di bugia che questi test
 * esistono per impedire.
 */
describe('il canale dice sempre cosa c\'è sull\'altro ramo', () => {
  const MAIN = 'a'.repeat(40);

  const canaleRunner =
    (map: Record<string, { status: number; stdout: string }>, root: string): FakeGit =>
    (args: string[]): FakeResult => {
      const key = args.join(' ');
      const r = map[key];
      if (r) return { ...r, stderr: '' };
      if (key === 'worktree list --porcelain') return { status: 0, stdout: `worktree ${root}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: `git finto: nessuna risposta mappata per \`git ${key}\`` };
    };

  /** Il canale `main` non ha niente di nuovo, e `dev` è avanti di sette: il caso dell'owner. */
  const settePronti = (root: string): FakeGit =>
    canaleRunner(
      {
        'fetch origin +refs/heads/main:refs/remotes/origin/main': { status: 0, stdout: '' },
        'rev-parse refs/remotes/origin/main': { status: 0, stdout: `${MAIN}\n` },
        'rev-parse --short refs/remotes/origin/main': { status: 0, stdout: '5c49f1e\n' },
        'rev-parse HEAD': { status: 0, stdout: `${MAIN}\n` },
        [`rev-list --count ${MAIN}..${MAIN}`]: { status: 0, stdout: '0\n' },
        'fetch origin +refs/heads/dev:refs/remotes/origin/dev': { status: 0, stdout: '' },
        'rev-list --count refs/remotes/origin/main..refs/remotes/origin/dev': { status: 0, stdout: '7\n' },
      },
      root,
    );

  it('«già aggiornato» nomina quanti commit aspettano, e su quale ramo', () => {
    const root = dir('muffin-canale-');
    const result = runUpdate({ moduleDir: root, home: dir('muffin-canale-home-'), git: settePronti(root) });

    expect(result.code).toBe(0);
    expect(result.steps.some((s) => /già aggiornato/.test(s.detail))).toBe(true);

    // Il numero E il ramo: senza uno dei due la riga torna a essere il
    // silenzio con cui l'owner ha concluso la cosa sbagliata.
    const canale = result.steps.find((s) => s.name === 'canale');
    expect(canale, 'nessun passo `canale`: il silenzio del 03/09 è tornato').toBeDefined();
    expect(canale?.detail).toContain('7');
    expect(canale?.detail).toContain('origin/dev');
    expect(canale?.detail).toContain('muffin update --channel dev');
  });

  it('la riga arriva anche a chi legge i passi mentre succedono, non solo nel riepilogo', () => {
    const root = dir('muffin-canale-live-');
    const vivi: string[] = [];
    runUpdate({ moduleDir: root, home: dir('muffin-canale-home-'), git: settePronti(root), onStep: (s) => void vivi.push(s.name) });
    expect(vivi).toContain('canale');
  });

  it('se il ramo a monte non si legge, dichiara di non saperlo invece di stampare zero', () => {
    const root = dir('muffin-canale-cieco-');
    const result = runUpdate({
      moduleDir: root,
      home: dir('muffin-canale-home-'),
      git: canaleRunner(
        {
          'fetch origin +refs/heads/main:refs/remotes/origin/main': { status: 0, stdout: '' },
          'rev-parse refs/remotes/origin/main': { status: 0, stdout: `${MAIN}\n` },
          'rev-parse --short refs/remotes/origin/main': { status: 0, stdout: '5c49f1e\n' },
          'rev-parse HEAD': { status: 0, stdout: `${MAIN}\n` },
          [`rev-list --count ${MAIN}..${MAIN}`]: { status: 0, stdout: '0\n' },
          // il fetch di `dev` fallisce: rete, permessi, o il ramo non c'è.
          'fetch origin +refs/heads/dev:refs/remotes/origin/dev': { status: 1, stdout: '' },
        },
        root,
      ),
    });

    expect(result.code).toBe(0); // il canale letto è a posto: l'update non fallisce per l'altro
    const canale = result.steps.find((s) => s.name === 'canale');
    expect(canale?.detail).toMatch(/non riesco a leggere origin\/dev/);
    expect(canale?.detail).not.toMatch(/\d+ commit/); // nessun numero inventato
  });

  it('leggendo `dev` dice che non c\'è nessun canale più avanti', () => {
    const root = dir('muffin-canale-dev-');
    const result = runUpdate({
      moduleDir: root,
      home: dir('muffin-canale-home-'),
      channel: 'dev',
      git: canaleRunner(
        {
          'fetch origin +refs/heads/dev:refs/remotes/origin/dev': { status: 0, stdout: '' },
          'rev-parse refs/remotes/origin/dev': { status: 0, stdout: `${MAIN}\n` },
          'rev-parse --short refs/remotes/origin/dev': { status: 0, stdout: 'aaaaaaa\n' },
          'rev-parse HEAD': { status: 0, stdout: `${MAIN}\n` },
          [`rev-list --count ${MAIN}..${MAIN}`]: { status: 0, stdout: '0\n' },
        },
        root,
      ),
    });

    expect(result.code).toBe(0);
    expect(result.steps.find((s) => s.name === 'fetch')?.detail).toContain('origin/dev');
    expect(result.steps.find((s) => s.name === 'canale')?.detail).toMatch(/non c'è nessun canale più avanti/);
  });
});

describe('channelLagNote', () => {
  it('con lavoro in attesa porta numero, ramo e il comando che lo installa', () => {
    const t = channelLagNote({ channel: 'main', upstream: 'dev', ahead: 7 });
    expect(t).toContain('7');
    expect(t).toContain('origin/dev');
    expect(t).toContain('origin/main');
    expect(t).toContain('--channel dev');
  });

  it('quando non c\'è niente in attesa lo dice, invece di tacere', () => {
    expect(channelLagNote({ channel: 'main', upstream: 'dev', ahead: 0 })).toMatch(/niente in attesa/);
  });

  it('una distanza non misurata resta non misurata', () => {
    const t = channelLagNote({ channel: 'main', upstream: 'dev', ahead: null });
    expect(t).toMatch(/non riesco a leggere/);
    expect(t).not.toMatch(/\d/);
  });
});

/**
 * Cosa è appena stato installato.
 *
 * Fino al 03/09/2026 un aggiornamento riuscito diceva dove punta il symlink e
 * nient'altro: l'owner non imparava niente su ciò che aveva appena messo sulla
 * propria macchina. I soggetti stanno fra il marker vecchio e quello nuovo, e
 * il comando li aveva già entrambi in mano.
 */
describe('runUpdate — l\'elenco di cosa è arrivato', () => {
  it('porta i soggetti veri fra il marker vecchio e quello nuovo', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    pushNewVersion(f, 'v3');
    pushNewVersion(f, 'v4');
    const { bindir } = seedLauncher(f.installed);

    const result = runUpdate({
      moduleDir: f.installed,
      home: dir('muffin-novita-home-'),
      bindirs: [bindir],
      npmCi: ok,
      smokeTest: ok,
      readNewSchemaVersion: () => 1,
    });

    expect(result.code).toBe(0);
    const novita = result.steps.find((s) => s.name === 'novità');
    expect(novita?.detail).toContain('3 commit installati');
    // I soggetti veri, non un conteggio travestito da elenco.
    for (const label of ['v2', 'v3', 'v4']) expect(novita?.detail).toContain(label);
  });

  it('quando `git log` non risponde degrada al conteggio, e l\'update resta riuscito', () => {
    const f = makeFixture();
    pushNewVersion(f, 'v2');
    const { bindir, entry0 } = seedLauncher(f.installed);
    // Il caso vero: un marker che punta a un commit che non c'è più (potato,
    // o scritto da una release più vecchia). L'elenco manca; la release no.
    const senzaLog: FakeGit = (args, cwd) => (args[0] === 'log' ? { status: 1, stdout: '', stderr: 'fatal: bad revision' } : realGit(args, cwd));

    const result = runUpdate({
      moduleDir: f.installed,
      home: dir('muffin-novita-home-'),
      bindirs: [bindir],
      npmCi: ok,
      smokeTest: ok,
      readNewSchemaVersion: () => 1,
      git: senzaLog,
    });

    expect(result.code).toBe(0);
    const novita = result.steps.find((s) => s.name === 'novità');
    expect(novita?.done).toBe(true);
    expect(novita?.detail).toMatch(/1 commit installati/);
    expect(novita?.detail).toMatch(/non riesco a elencarli/);
    // e lo scambio è avvenuto lo stesso: l'elenco è un racconto, non un gate.
    expect(readlinkSync(join(bindir, 'muffin'))).not.toBe(entry0);
  });
});

describe('arrivalsSummary', () => {
  it('taglia a un numero sano e conta il resto', () => {
    const subjects = Array.from({ length: 25 }, (_, i) => `soggetto ${i + 1}`);
    const t = arrivalsSummary({ subjects, fallbackCount: 25, max: 10 });
    expect(t.split('\n').filter((l) => l.startsWith('  · ')).length).toBe(10);
    expect(t).toContain('… e altri 15');
  });

  it('senza elenco degrada al conteggio invece di saltare', () => {
    expect(() => arrivalsSummary({ subjects: null, fallbackCount: 4 })).not.toThrow();
    expect(arrivalsSummary({ subjects: null, fallbackCount: 4 })).toMatch(/4 commit/);
  });
});
