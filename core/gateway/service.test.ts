import DatabaseCtor from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DELIVERED } from '../surface/types.js';
import { JobStore } from '../scheduler/jobs.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { createNotifier } from './notify.js';
import { GatewayLock, readGateway } from './lock.js';
import { EXIT_STOPPED, Gateway, STATUS } from './service.js';

/**
 * The process, on the two things a process has that a command does not: it
 * keeps working while nobody is watching, and it has to be able to *stop*.
 *
 * Driven with a fake signal emitter and a millisecond tick so the lifecycle is
 * exercised rather than waited for. The scheduler and the job store are the
 * real ones — the point of ADR-0035 is that a job fires with no REPL open, and
 * a mock scheduler would prove that against a mock.
 */

function harness(
  over: {
    runJob?: () => Promise<{ stopped: 'answered'; text: string; turnId: string | null }>;
    tickMs?: number;
    /** Pass an array to make it supervised: every datagram lands here. */
    sent?: string[];
  } = {},
) {
  const db = new DatabaseCtor(':memory:');
  /**
   * One clock for this whole world, anchored to the real now and moved by hand.
   *
   * Two details make the anchoring necessary rather than decorative. `nextFire`
   * always returns a time in the *future* — no cron expression is ever already
   * due — so a gateway reading the true now waits up to a minute for
   * `* * * * *`; `advance(90_000)` steps past that boundary deterministically
   * instead of hoping the suite starts late in a minute. And the store must
   * share the clock, or `markRan` schedules the next fire behind the gateway's
   * now and the job re-fires on every tick.
   *
   * Anchored to the real now rather than a fixed date because the gateway lock
   * is judged stale against the wall clock: a world set in the far past would
   * read as a gateway that died an hour ago.
   */
  const base = new Date();
  let clock = base;
  const now = (): Date => clock;
  const jobs = new JobStore(db, now);
  const delivered: string[] = [];
  const logs: string[] = [];
  const signals = new EventEmitter();
  let closed = 0;

  const scheduler = new Scheduler(
    jobs,
    over.runJob ?? (async () => ({ stopped: 'answered', text: 'fatto', turnId: 'turn-test' })),
    async (_channel, text) => (delivered.push(text), DELIVERED),
  );

  const sent = over.sent;
  const gateway = new Gateway({
    lock: new GatewayLock(db, () => true),
    // Supervised only when the test asked: `WATCHDOG_USEC` of 4 000 µs gives a
    // 2 ms ping, so a 50 ms drain is dozens of beats rather than a coin flip.
    notify: sent
      ? createNotifier({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: '4000' }, (p) => sent.push(p))
      : createNotifier({}, () => {}),
    scheduler,
    jobs,
    close: () => {
      closed += 1;
    },
    log: (line) => logs.push(line),
    signals,
    now,
    tickMs: over.tickMs ?? 1,
    drainBudgetMs: 50,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    pid: 4242,
  });

  return {
    db,
    jobs,
    gateway,
    delivered,
    logs,
    signals,
    now,
    closed: () => closed,
    /** Step the world forward — past a cron boundary, so a job becomes due. */
    advance: (ms: number) => {
      clock = new Date(base.getTime() + ms);
    },
  };
}

/** A job that is due the moment the world advances past the next minute. */
function dueJob(h: ReturnType<typeof harness>): ReturnType<typeof h.jobs.add> {
  const job = h.jobs.add({ cron: '* * * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
  h.advance(90_000);
  return job;
}

describe('the gateway owns the scheduler', () => {
  it('fires a due job with no REPL anywhere', async () => {
    // The whole of ADR-0035 in one assertion: the ticker used to live in
    // `cli/repl.ts`, so closing the terminal stopped everything. Nothing here
    // opens a REPL.
    const h = harness();
    dueJob(h);

    const served = h.gateway.serve();
    await vi.waitFor(() => expect(h.delivered).toEqual(['fatto']), { timeout: 2000 });

    h.signals.emit('SIGTERM');
    expect(await served).toBe(EXIT_STOPPED);
  });

  it('refuses to be the second gateway, and names the pid of the first', async () => {
    const h = harness();
    new GatewayLock(h.db, () => true).claim(h.now(), 'in attesa', 9999);

    const outcome = h.gateway.start(h.now());

    expect(outcome).toMatchObject({ started: false, held: expect.stringContaining('9999') });
    // A refusal must not tear down the runtime the winner is using: the loser
    // closes its own, and `close` here belongs to this instance only.
    expect(h.closed()).toBe(0);
  });

  it('holds the lock while it serves and lets it go when it stops', async () => {
    const h = harness();
    const served = h.gateway.serve();
    await vi.waitFor(() => expect(readGateway(h.db, h.now(), () => true)?.pid).toBe(4242));

    h.signals.emit('SIGTERM');
    await served;

    expect(readGateway(h.db, h.now(), () => true)).toBeNull();
  });

  it('ticks once at startup instead of waiting a whole interval', async () => {
    // Measured on a real gateway before this existed: `status` reported "avvio"
    // for thirty seconds while it was already serving, and a job that fell due
    // while the process was down — the restart case the job store's catch-up is
    // written for — sat there for a full interval. The tick interval here is an
    // hour, so nothing but the startup tick can satisfy this.
    const h = harness({ tickMs: 3_600_000 });
    dueJob(h);

    const served = h.gateway.serve();
    await vi.waitFor(() => expect(h.delivered).toEqual(['fatto']), { timeout: 2000 });
    expect(readGateway(h.db, h.now(), () => true)?.status).not.toBe(STATUS.starting);

    h.signals.emit('SIGTERM');
    expect(await served).toBe(EXIT_STOPPED);
  });

  it('says what it is doing, and the idle line names the next fire', async () => {
    const h = harness();
    h.jobs.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    h.gateway.start(h.now());
    h.gateway.tick(h.now());

    const status = readGateway(h.db, h.now(), () => true)?.status ?? '';
    expect(status).toContain(STATUS.idle);
    // Idle with nothing to say is a status that answers "is it stuck?" with
    // silence. The next fire is the cheapest thing that makes it an answer.
    expect(status).toMatch(/\d{2}:\d{2}/);
  });
});

describe('a drain does not lose work', () => {
  it('SIGTERM stops new work, waits for what is in flight, then closes', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    const h = harness({
      runJob: async () => {
        await inFlight;
        return { stopped: 'answered', text: 'fatto', turnId: 'turn-test' };
      },
    });
    dueJob(h);

    const served = h.gateway.serve();
    await vi.waitFor(() => expect(h.gateway.scheduler.isRunning()).toBe(true));

    h.signals.emit('SIGTERM');
    // The drain is a wait, not a kill: while the turn is in flight the gateway
    // has neither closed the runtime nor exited. Closing here would pull the
    // database out from under a turn that is still writing to it.
    await new Promise((r) => setTimeout(r, 10));
    expect(h.closed()).toBe(0);

    release();
    expect(await served).toBe(EXIT_STOPPED);
    expect(h.closed()).toBe(1);
    expect(h.delivered).toEqual(['fatto']);
  });

  it('SIGUSR1 drains the same way — the ADR calls it the restart signal', async () => {
    const h = harness();
    const served = h.gateway.serve();
    h.signals.emit('SIGUSR1');
    expect(await served).toBe(0);
    expect(h.closed()).toBe(1);
  });

  it('exits 0 on SIGUSR1 and EXIT_STOPPED on SIGTERM — the two verbs, in the code', async () => {
    // The same drain, two different instructions to the supervisor, and until
    // this line they were the same instruction. Under `Restart=always` a drained
    // `muffin gateway stop` came back five seconds later — stop did not stop —
    // and under launchd's `SuccessfulExit: false` the SIGUSR1 restart exited 0
    // and stayed down. `unit.test.ts` holds the supervisor half; this is the
    // process half, and neither is worth anything without the other.
    const restart = harness();
    const restarted = restart.gateway.serve();
    restart.signals.emit('SIGUSR1');
    expect(await restarted).toBe(0);

    const stop = harness();
    const stopped = stop.gateway.serve();
    stop.signals.emit('SIGTERM');
    expect(await stopped).toBe(EXIT_STOPPED);
    expect(EXIT_STOPPED).not.toBe(0);
  });

  it('a SIGUSR1 arriving mid-drain does not turn a stop into a restart', async () => {
    // The drain is idempotent, so the second signal is absorbed — but the exit
    // code is what the supervisor reads, and it must be absorbed too. Otherwise
    // `muffin gateway stop` racing anything that restarts comes back up.
    const h = harness({ runJob: () => new Promise(() => {}) });
    dueJob(h);
    const served = h.gateway.serve();
    await vi.waitFor(() => expect(h.gateway.scheduler.isRunning()).toBe(true));

    h.signals.emit('SIGTERM');
    h.signals.emit('SIGUSR1');

    expect(await served).toBe(EXIT_STOPPED);
  });

  it('says that a second Ctrl-C will not help, and what does', async () => {
    // Handlers are registered and idempotent, so Ctrl-C twice does nothing for
    // up to the whole budget while the terminal looks hung. Correct, intended,
    // and indistinguishable from a wedge unless the way out is in the log.
    const h = harness();
    await h.gateway.drain('SIGINT');
    expect(h.logs.join(' ')).toMatch(/Ctrl-C/);
    expect(h.logs.join(' ')).toMatch(/kill -9 4242/);
  });

  it('starts no further work once the drain has begun', async () => {
    // `clearInterval` stops future timers; it does not unqueue a callback that
    // already fired. Without the flag, a tick already on the event loop starts a
    // turn during shutdown and the drain it was supposed to wait for is over.
    const h = harness();
    dueJob(h);
    h.gateway.start(h.now());

    const drained = h.gateway.drain('SIGTERM');
    h.gateway.tick(new Date());
    await drained;

    expect(h.delivered).toEqual([]);
  });

  it('gives up on a turn that overruns the budget instead of hanging forever', async () => {
    // A drain without a ceiling is a process that never dies, and the supervisor
    // SIGKILLs it at TimeoutStopSec anyway — losing the same turn, later, with
    // no line in the log saying why.
    const h = harness({ runJob: () => new Promise(() => {}) });
    dueJob(h);

    const served = h.gateway.serve();
    await vi.waitFor(() => expect(h.gateway.scheduler.isRunning()).toBe(true));

    h.signals.emit('SIGTERM');
    expect(await served).toBe(EXIT_STOPPED);
    expect(h.closed()).toBe(1);
    expect(h.logs.join(' ')).toMatch(/budget|volo/i);
  });

  it('leaves an interrupted job due rather than consumed', async () => {
    // ADR-0035 constraint 5: "la sua morte non perde lavoro — i job restano
    // dovuti, non consumati". Verified rather than assumed: `markRan` is what
    // moves `next_fire_at`, and it runs only after delivery, so a turn killed
    // mid-flight leaves the row exactly as due as it was.
    const h = harness({ runJob: () => new Promise(() => {}) });
    const job = dueJob(h);
    const due = new Date(job.nextFireAt.getTime() + 1000);

    const served = h.gateway.serve();
    await vi.waitFor(() => expect(h.gateway.scheduler.isRunning()).toBe(true));
    h.signals.emit('SIGTERM');
    await served;

    expect(h.jobs.get(job.id)!.lastRunAt).toBeNull();
    expect(h.jobs.due(due).map((j) => j.id)).toEqual([job.id]);
  });
});

describe('supervision hooks', () => {
  it('reports ready only once it is actually serving, and stopping on the way out', async () => {
    const sent: string[] = [];
    const db = new DatabaseCtor(':memory:');
    const jobs = new JobStore(db);
    const signals = new EventEmitter();
    const gateway = new Gateway({
      lock: new GatewayLock(db, () => true),
      // A supervisor that is listening, faked at the transport so no systemd is
      // involved: the module under test is the cadence, not the socket.
      notify: createNotifier({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: '4000' }, (p) => sent.push(p)),
      scheduler: new Scheduler(jobs, async () => ({ stopped: 'answered', text: '', turnId: 'turn-test' }), async () => DELIVERED),
      jobs,
      close: () => {},
      log: () => {},
      signals,
      tickMs: 1,
      drainBudgetMs: 50,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
      pid: 4242,
    });

    const served = gateway.serve();
    // READY is sent after the claim succeeded, never before: under Type=notify
    // that is the difference between "the process started" and "it is serving",
    // and a gateway that announced ready and then lost the lock would have told
    // systemd a crash-loop was a healthy boot.
    await vi.waitFor(() => expect(sent[0]).toMatch(/^READY=1/));
    await vi.waitFor(() => expect(sent.filter((p) => p.startsWith('WATCHDOG=1')).length).toBeGreaterThan(1), {
      timeout: 2000,
    });

    signals.emit('SIGTERM');
    await served;

    expect(sent.some((p) => p.startsWith('STOPPING=1'))).toBe(true);
    expect(sent.filter((p) => p.startsWith('WATCHDOG=1')).length).toBeGreaterThan(1);
  });

  it('keeps feeding the watchdog for the whole drain', async () => {
    // `drain` used to clear every timer, this one included, and then wait up to
    // DRAIN_BUDGET_MS (60 s) against a WatchdogSec of 60 s — so a drain systemd
    // did not initiate (SIGUSR1, or the SIGTERM `gateway stop` sends straight to
    // the pid) meant up to 90 s of silence against a 60 s deadline. It was
    // *presumed* that `STOPPING=1` suspends the watchdog; that presumption
    // cannot be executed here, and `sd_notify(3)` documents STOPPING=1 without
    // mentioning the watchdog at all. So the presumption is gone instead.
    const sent: string[] = [];
    const h = harness({ sent, runJob: () => new Promise(() => {}) });
    dueJob(h);

    const served = h.gateway.serve();
    await vi.waitFor(() => expect(h.gateway.scheduler.isRunning()).toBe(true));
    h.signals.emit('SIGTERM');
    await served;

    // Counted from the STOPPING=1 marker, not from a timestamp: what has to be
    // true is that pings kept arriving *after the drain began*, and with the
    // old code that slice of the transcript was empty.
    const from = sent.findIndex((p) => p.startsWith('STOPPING=1'));
    expect(from).toBeGreaterThanOrEqual(0);
    const during = sent.slice(from).filter((p) => p.startsWith('WATCHDOG=1'));
    expect(during.length).toBeGreaterThan(0);
    // And they say what is happening. Without the draining branch in `state()`
    // the first ping after STOPPING=1 republishes "in attesa" over it, and a
    // stop in progress reads from outside as a gateway that just went quiet.
    expect(during.every((p) => p === `WATCHDOG=1\nSTATUS=${STATUS.draining}`)).toBe(true);
  });

  it('publishes the live status on the ping, not only into the row', async () => {
    // `systemctl status` used to show the boot-time line for the life of the
    // process: the status was computed every tick and written only to SQLite,
    // and the method that could have sent it had no callers at all.
    const sent: string[] = [];
    const h = harness({ sent });
    h.jobs.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    h.gateway.start(h.now());

    // Both timers, as in production: the tick publishes into the row, the beat
    // publishes to the supervisor. They must say the same thing.
    h.gateway.tick(h.now());
    h.gateway.beat(h.now());

    const last = sent.at(-1) ?? '';
    expect(last.startsWith(`WATCHDOG=1\nSTATUS=${STATUS.idle}`)).toBe(true);
    // The same string the claim row carries — one vocabulary for one state, or
    // "is it stuck" stops having an answer depending on where you ask.
    expect(last).toContain(readGateway(h.db, h.now(), () => true)?.status ?? 'nope');
  });

  it('starts, and keeps ticking, with no supervisor at all', async () => {
    // macOS is the dev machine: NOTIFY_SOCKET is never set there. A gateway that
    // needed it would be a gateway the owner cannot run.
    const h = harness();
    dueJob(h);
    const served = h.gateway.serve();
    await vi.waitFor(() => expect(h.delivered).toEqual(['fatto']), { timeout: 2000 });
    h.signals.emit('SIGTERM');
    expect(await served).toBe(EXIT_STOPPED);
  });

  it('removes its signal handlers when it stops', async () => {
    // A `serve()` that leaked handlers would make a second one in the same
    // process drain twice on one SIGTERM — and the CLI is a process that can
    // legitimately do more than one thing.
    const h = harness();
    const served = h.gateway.serve();
    expect(h.signals.listenerCount('SIGTERM')).toBe(1);
    h.signals.emit('SIGTERM');
    await served;
    expect(h.signals.listenerCount('SIGTERM')).toBe(0);
  });
});
