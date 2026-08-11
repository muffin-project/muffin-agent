import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { paths } from '../core/config/config.js';
import { GatewayLock } from '../core/gateway/lock.js';
import { runInit } from './init.js';

/**
 * The wiring, from the command line the owner actually types.
 *
 * `docs/JUDGE.md`: *"parti dal punto d'ingresso di produzione e prova a
 * raggiungere il meccanismo. Se non riesci a dimostrare il percorso, la
 * garanzia è non provata."* Every test here spawns the real `cli/main.ts` — the
 * unit tests already prove the lock refuses a second holder, and none of them
 * would notice if `cli/repl.ts` stopped consulting it.
 *
 * The child is a real process for a second reason: the property under test is
 * "two schedulers must never run", and a live holder needs a pid that is really
 * alive. The test runner's own pid is the honest one to use.
 */

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-gw-cli-'));
  homes.push(dir);
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

/** Pretend a gateway is up, held by this very process — a pid that is alive. */
function holdGateway(dir: string, status = 'in attesa'): void {
  const db = new DatabaseCtor(paths(dir).db);
  const outcome = new GatewayLock(db).claim(new Date(), status, process.pid);
  if (!('release' in outcome)) throw new Error('la fixture non è riuscita a prendere il lock');
  db.close();
}

function muffin(dir: string, args: string[], stdin = ''): { code: number; out: string; err: string } {
  const result = spawnSync('node', ['--import', 'tsx', join(process.cwd(), 'cli/main.ts'), ...args], {
    // HOME and XDG_CONFIG_HOME are redirected into the temp home so `install
    // --write` can never put a real service unit in the owner's `~/Library` or
    // `~/.config`. It did exactly that once, and the file outlived the run
    // because the cleanup was after a failing assertion.
    env: { ...process.env, MUFFIN_HOME: dir, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), NO_COLOR: '1' },
    input: stdin,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

describe('muffin gateway status', () => {
  it('says nothing is running, and exits non-zero, on a fresh home', () => {
    const r = muffin(home(), ['gateway', 'status']);
    expect(r.out).toContain('nessun gateway attivo');
    // Scriptable "is it up", the shape `systemctl is-active` has. Zero here
    // would make a dead gateway succeed in a shell conditional.
    expect(r.code).toBe(1);
  });

  it('reports the pid, since when, and what it is doing', () => {
    const dir = home();
    holdGateway(dir, 'job in corso');
    const r = muffin(dir, ['gateway', 'status']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`pid ${process.pid}`);
    expect(r.out).toContain('job in corso');
    expect(r.out).toMatch(/dal \d/);
  });
});

describe('two schedulers must never run', () => {
  it('the REPL keeps the ticker when nothing else owns it', () => {
    // The control. Without it the next test passes on a REPL that never
    // schedules anything at all, which would be the opposite failure.
    const r = muffin(home(), ['repl'], '/exit\n');
    expect(r.err).toContain('scheduler: in questa sessione');
  });

  it('the REPL hands the scheduler to a running gateway and stays interactive', () => {
    // The wiring assertion of this whole slice. `cli/repl.ts` derives this line
    // from the timer it actually created, so it cannot say one thing while the
    // ticker does another.
    const dir = home();
    holdGateway(dir);
    const r = muffin(dir, ['repl'], '/exit\n');

    expect(r.err).toContain(`scheduler: del gateway (pid ${process.pid})`);
    expect(r.err).not.toContain('scheduler: in questa sessione');
    // Still a REPL: the session ran and exited cleanly, it did not refuse to
    // start because something else was up.
    expect(r.err).toContain('ciao.');
    expect(r.code).toBe(0);
  });

  it('a second gateway refuses with EX_TEMPFAIL and names the first', () => {
    const dir = home();
    holdGateway(dir);
    const r = muffin(dir, ['gateway', 'run']);
    expect(r.err).toContain(`pid ${process.pid}`);
    // 75, not a generic failure: the supervisor should retry this one, which is
    // the opposite of what it must do for a bad API key.
    expect(r.code).toBe(75);
  });
});

describe('muffin gateway install', () => {
  it('prints a unit anchored to the data home, and puts it on stdout', () => {
    const dir = home();
    const r = muffin(dir, ['gateway', 'install']);
    // stdout is the result, so `muffin gateway install > file` is the one-liner.
    expect(r.out).toContain(dir);
    expect(r.out).not.toContain('poi, per attivarla');
    expect(r.err).toContain('poi, per attivarla');
    // Anchored to ~/.muffin and not to the checkout — Hermes' scar, ADR-0035.
    const anchor = process.platform === 'darwin' ? '<key>WorkingDirectory</key>' : `WorkingDirectory=${dir}`;
    expect(r.out).toContain(anchor);
  });

  it('writes nothing unless asked, then writes exactly what it printed', () => {
    const dir = home();
    const printed = muffin(dir, ['gateway', 'install']).out;

    const written = muffin(dir, ['gateway', 'install', '--write']);
    const path = /scritto (.+)/.exec(written.err)?.[1];
    expect(path).toBeTruthy();
    expect(readFileSync(path!, 'utf8')).toBe(printed);
  });

  it('refuses to clobber a unit the owner has edited', () => {
    // These are meant to be hand-tuned (a different WatchdogSec, an extra
    // Environment line). Regenerating over the top would eat the edit silently
    // and the owner would find out at the next restart.
    const dir = home();
    const path = /scritto (.+)/.exec(muffin(dir, ['gateway', 'install', '--write']).err)?.[1];
    expect(path).toBeTruthy();
    writeFileSync(path!, '# mio\n');

    const again = muffin(dir, ['gateway', 'install', '--write']);
    // 2, the "I did not do it" code — distinct from the 1 the command returns
    // when it wrote the unit but had a caveat about ExecStart.
    expect(again.code).toBe(2);
    expect(readFileSync(path!, 'utf8')).toBe('# mio\n');

    const forced = muffin(dir, ['gateway', 'install', '--write', '--force']);
    expect(forced.code).not.toBe(2);
    expect(readFileSync(path!, 'utf8')).not.toBe('# mio\n');
  });
});

describe('muffin doctor reports the gateway', () => {
  it('warns when nothing is running, and says what that costs', () => {
    const r = muffin(home(), ['doctor']);
    expect(r.out).toMatch(/gateway.*nessun processo attivo/s);
    expect(r.out).toContain('muffin gateway install');
  });

  it('reports it as ok, with the pid, when one is up', () => {
    const dir = home();
    holdGateway(dir);
    const r = muffin(dir, ['doctor']);
    expect(r.out).toMatch(new RegExp(`gateway\\s+attivo · pid ${process.pid}`));
  });
});

describe('muffin init offers the gateway', () => {
  it('off a terminal it installs nothing and prints the command instead', () => {
    // `promptLine` returns undefined on a pipe. An installer that wrote a
    // service unit during a scripted run would be doing precisely what ADR-0035
    // forbids — and every test in this file runs off a pipe.
    const dir = mkdtempSync(join(tmpdir(), 'muffin-gw-init-'));
    homes.push(dir);
    const r = muffin(dir, ['init', '--api-key', 'sk-never-called']);

    expect(r.err).toContain('muffin gateway install');
    const unit =
      process.platform === 'darwin'
        ? join(dir, 'Library/LaunchAgents/ai.muffin.gateway.plist')
        : join(dir, '.config/systemd/user/muffin-gateway.service');
    expect(existsSync(unit)).toBe(false);
  });
});
