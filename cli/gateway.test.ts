import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { paths } from '../core/config/config.js';
import { GatewayLock, STALE_AFTER_MS } from '../core/gateway/lock.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { Scheduler, type SchedulerEvent } from '../core/scheduler/scheduler.js';
import { gatewayStandDown } from './repl.js';
import { stopCaveat } from './gateway.js';
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

/**
 * A job that came due while nothing was running — the catch-up case `markRan`
 * is written for, and the only way to have one: `JobStore.add` computes the
 * first fire from now, so no cron expression is ever already due. The fire time
 * is moved back by hand rather than the clock forward, because the process
 * under test is a real one and does not share a clock with us.
 */
function overdueJob(dir: string): string {
  const db = new DatabaseCtor(paths(dir).db);
  try {
    const job = new JobStore(db).add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    db.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), job.id);
    return job.id;
  } finally {
    db.close();
  }
}

function jobRow(dir: string, id: string): { last_run_at: string | null; next_fire_at: string } {
  const db = new DatabaseCtor(paths(dir).db, { readonly: true });
  try {
    return db.prepare(`SELECT last_run_at, next_fire_at FROM jobs WHERE id = ?`).get(id) as {
      last_run_at: string | null;
      next_fire_at: string;
    };
  } finally {
    db.close();
  }
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

  it('the REPL fires an overdue job when nobody owns the store', () => {
    // The control for the next test, and it has to come first: without it, "the
    // REPL did not fire it" passes on a REPL that fires nothing ever, which is
    // the opposite defect and indistinguishable from the fix.
    const dir = home();
    overdueJob(dir);
    const r = muffin(dir, ['repl'], '/exit\n');
    expect(r.err).toContain('scheduler: in questa sessione');
    // The delivery marker. The turn itself dies on the database this same
    // `/exit` just closed — which is fine and is the point: what is under test
    // is whether the tick reached the job at all.
    expect(r.out).toContain('⏰');
    expect(r.code).toBe(0);
  });

  it('the REPL does not fire a job the gateway owns — asked per tick, not once at startup', () => {
    // The wiring assertion for `standDown`. `cli/repl.ts` read the claim once,
    // at startup, and never again; the timer existing *was* the answer. Now the
    // timer always exists and the claim decides every tick, so this is the test
    // that fails when the `standDown` argument is dropped from the Scheduler in
    // `runRepl` — with the old shape nothing would have noticed, because with a
    // gateway up there was no ticker to be wrong.
    const dir = home();
    const id = overdueJob(dir);
    holdGateway(dir);

    const r = muffin(dir, ['repl'], '/exit\n');

    expect(r.err).toContain(`scheduler: del gateway (pid ${process.pid})`);
    expect(r.out).not.toContain('⏰');
    // And it stayed due. A stand-down that consumed the fire would be the same
    // lost job as a duplicate run, just quieter.
    const row = jobRow(dir, id);
    expect(row.last_run_at).toBeNull();
    expect(Date.parse(row.next_fire_at)).toBeLessThan(Date.now());
    expect(r.code).toBe(0);
  });
});

/**
 * The two orderings a boot-time answer cannot survive, driven through the real
 * `Scheduler`, the real `JobStore` and the real `GatewayLock` — the same three
 * objects `runRepl` builds, wired by the same `gatewayStandDown` it passes.
 *
 * Spawned processes prove the wiring (above); these prove the *sequence*, which
 * a spawn cannot reach without waiting out a thirty-second tick.
 */
describe('the claim can change under a REPL that is already ticking', () => {
  const world = () => {
    const db = new DatabaseCtor(':memory:');
    const jobs = new JobStore(db);
    const job = jobs.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    db.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), job.id);
    const said: string[] = [];
    const events: SchedulerEvent[] = [];
    const delivered: string[] = [];
    return { db, jobs, job, said, events, delivered };
  };
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('REPL first, gateway second: the next tick hands over and says so', async () => {
    const w = world();
    const standDown = gatewayStandDown(w.db, (l) => w.said.push(l), false);
    const sched = new Scheduler(
      w.jobs,
      async () => ({ stopped: 'answered', text: 'brief' }),
      async (_c, t) => {
        w.delivered.push(t);
      },
      undefined,
      (e) => w.events.push(e),
      undefined,
      standDown,
    );

    // Nobody owns it: this session is the scheduler, and behaves like one.
    sched.tick();
    await flush();
    expect(w.delivered).toEqual(['brief']);

    // The gateway starts — `muffin gateway install` finally run, or systemd
    // reaching the unit a moment after the shell did.
    new GatewayLock(w.db, () => true).claim(new Date(), 'in attesa', process.pid);
    sched.tick();
    await flush();

    expect(w.events.at(-1)).toEqual({ kind: 'deferred', reason: 'handover' });
    // Not silence. The boot line said "in questa sessione" and has just become
    // false, and a REPL that quietly stops scheduling is indistinguishable from
    // one that is broken.
    expect(w.said.join(' ')).toContain(`passato al gateway (pid ${process.pid})`);
  });

  it('the laptop lid: a stale claim reads free, and the wake-up beat takes it back', async () => {
    // A suspended gateway stops beating, so on wake its claim is older than ten
    // heartbeats and reads as dead — correctly, on the evidence a REPL opened at
    // that moment has. Seconds later the gateway resumes and beats, and this
    // session has to give the store back. Boot-time reading gets this exactly
    // backwards: it decides "no gateway" and keeps that answer for the session.
    const w = world();
    const lock = new GatewayLock(w.db, () => true);
    const asleep = new Date(Date.now() - STALE_AFTER_MS - 1000);
    lock.claim(asleep, 'in attesa', process.pid);

    const standDown = gatewayStandDown(w.db, (l) => w.said.push(l), false);
    expect(standDown()).toBe(false); // stale: this session is right to tick

    // The gateway wakes up and beats.
    lock.beat(new Date(), 'in attesa', process.pid);

    expect(standDown()).toBe(true);
    expect(w.said.join(' ')).toContain('passato al gateway');
  });

  it('a gateway that dies gives the jobs back, and that is announced too', () => {
    // The other direction, and it is the one the old shape could not do at all:
    // a terminal open since before the crash sat there scheduling nothing until
    // it was closed and reopened.
    const w = world();
    const lock = new GatewayLock(w.db, () => true);
    lock.claim(new Date(), 'in attesa', process.pid);
    const standDown = gatewayStandDown(w.db, (l) => w.said.push(l), true);
    expect(standDown()).toBe(true);
    expect(w.said).toEqual([]); // the boot line already said it — no double take

    lock.release(process.pid);

    expect(standDown()).toBe(false);
    expect(w.said.join(' ')).toMatch(/tornano a girare in questa finestra/);
  });

  it('a claim landing mid-turn costs the model call, never a second delivery', async () => {
    // The window the tick-start check cannot close: a turn is a model call with
    // tools, and the gateway can claim in the middle of one. The second check
    // sits between the run and the delivery, so what is lost is money — the
    // turn happened twice — and what is kept is the two irreversible things:
    // the owner is not told the same thing twice, and `markRan` does not move a
    // fire the new owner is about to serve.
    const w = world();
    const lock = new GatewayLock(w.db, () => true);
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    const sched = new Scheduler(
      w.jobs,
      async () => {
        await inFlight;
        return { stopped: 'answered', text: 'brief' };
      },
      async (_c, t) => {
        w.delivered.push(t);
      },
      undefined,
      (e) => w.events.push(e),
      undefined,
      gatewayStandDown(w.db, (l) => w.said.push(l), false),
    );

    sched.tick(); // nobody owns it yet — the turn starts
    await flush();
    lock.claim(new Date(), 'in attesa', process.pid); // …and now someone does
    release();
    await flush();
    await flush();

    expect(w.delivered).toEqual([]);
    expect(w.events.some((e) => e.kind === 'yielded')).toBe(true);
    expect(w.jobs.get(w.job.id)!.lastRunAt).toBeNull();
    expect(w.jobs.get(w.job.id)!.nextFireAt.getTime()).toBeLessThan(Date.now());
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

describe('muffin gateway stop admits what it cannot do', () => {
  it('says nothing on Linux, where the exit code makes the verb true', () => {
    // `RestartPreventExitStatus=143` is the whole mechanism there, and an
    // apology on top of a verb that works is noise.
    expect(stopCaveat('linux', true)).toBeNull();
  });

  it('says nothing on macOS when no LaunchAgent is installed', () => {
    // A gateway started by hand in a terminal has nothing watching it. Warning
    // there would train the owner to ignore the warning that matters.
    expect(stopCaveat('darwin', false)).toBeNull();
  });

  it('names launchd and the verb that actually holds it down', () => {
    // The plist has to keep `KeepAlive: true` — otherwise the SIGUSR1
    // drain-restart, which exits 0, leaves the agent down — so "gateway
    // fermato" is true of the process and false of the service, and the
    // difference has to be said where it happens rather than only in `install`.
    const caveat = stopCaveat('darwin', true) ?? '';
    expect(caveat).toContain('launchctl bootout');
    expect(caveat).toContain('ai.muffin.gateway');
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
