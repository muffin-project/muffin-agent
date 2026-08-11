import type { JobStore } from '../scheduler/jobs.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { HEARTBEAT_MS, type GatewayLock } from './lock.js';
import type { Notifier } from './notify.js';

/**
 * The process that lives.
 *
 * ADR-0035: the scheduler used to be `setInterval(() => scheduler.tick(),
 * 30_000)` inside `cli/repl.ts`, so closing the terminal stopped every
 * scheduled thing. Here the ticker belongs to a process that outlives the
 * terminal, and the REPL becomes one client among others.
 *
 * The lifecycle is the whole content of this file, and it is written as methods
 * with an injected clock, emitter and sleep rather than as one long `serve()`,
 * because the two things worth testing — a job firing with nobody watching, and
 * a shutdown that does not eat a turn — are otherwise only reachable by waiting
 * thirty seconds.
 *
 * ## What "drain" has to mean
 *
 * SIGTERM and SIGUSR1 both: stop starting work, let what is in flight finish
 * inside a budget, tear down, exit. The ADR takes this from Hermes and the
 * reason is specific — `systemctl restart` sends SIGTERM and then SIGKILLs
 * turns in half, so a restart to pick up a new build silently destroys whatever
 * was running. Both signals drain because both supervisors restart on any exit;
 * the distinction is for the person reading the log, not for the code.
 *
 * The budget is a ceiling, not a promise. Past it the gateway leaves anyway and
 * says so, because the alternative is a process that never dies and gets
 * SIGKILLed at `TimeoutStopSec` — the same turn lost, later, with nothing in
 * the log explaining it. A turn cut off this way is not lost work: `markRan` is
 * the only thing that moves a job's next fire and it runs after delivery, so an
 * interrupted job is still due (constraint 5 of the ADR; `service.test.ts`
 * asserts it against the real store rather than trusting this paragraph).
 */

/** The scheduler's cadence. Moved here from `cli/repl.ts`, unchanged. */
export const TICK_MS = 30_000;

/**
 * How long a shutdown may wait for turns in flight. A scheduled turn is a model
 * call with tools; a minute covers the ordinary ones without making a stop feel
 * like a hang. `TimeoutStopSec` in the generated unit is derived from this — see
 * `unit.ts`, which must always leave the supervisor's patience longer than ours.
 */
export const DRAIN_BUDGET_MS = 60_000;

/**
 * EX_TEMPFAIL. A gateway that finds another one holding the lock has not failed
 * — it lost a race, and the same command works the moment the other exits. The
 * code matters beyond tidiness: the generated unit keeps `Restart=always`, so a
 * supervisor seeing this will retry, which is the correct behaviour here and
 * the wrong one for a bad API key (`unit.ts`, `RestartPreventExitStatus`).
 * `cli/observe.ts` already uses 75 for exactly this shape of refusal.
 */
export const EXIT_ALREADY_RUNNING = 75;

/**
 * What the gateway says it is doing. One place, because this string is read in
 * three (`muffin gateway status`, `doctor`, `systemctl status`) and three
 * vocabularies for one state is how "is it stuck" stops having an answer.
 *
 * The idle wording is a decision, not an accident: an idle process that reports
 * nothing is indistinguishable from a wedged one, so idle carries the next fire.
 */
export const STATUS = {
  starting: 'avvio',
  idle: 'in attesa',
  working: 'job in corso',
  draining: 'drenaggio',
} as const;

/** Only what the gateway actually uses, so a test can drive it with an emitter. */
export type SignalSource = {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
};

export type GatewayDeps = {
  lock: GatewayLock;
  notify: Notifier;
  scheduler: Pick<Scheduler, 'tick' | 'isRunning'>;
  /** Read for the idle status line only — the scheduler owns the firing. */
  jobs: Pick<JobStore, 'list'>;
  /** Teardown, in the caller's order: surfaces before the runtime under them. */
  close: () => void | Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  signals?: SignalSource;
  sleep?: (ms: number) => Promise<void>;
  tickMs?: number;
  drainBudgetMs?: number;
  pid?: number;
};

/** The signals that mean "stop", and what the log should call each one. */
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGUSR1'] as const;

export class Gateway {
  readonly scheduler: GatewayDeps['scheduler'];
  private readonly now: () => Date;
  private readonly signals: SignalSource;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tickMs: number;
  private readonly drainBudgetMs: number;
  private readonly pid: number;
  private stopping = false;
  private claimed = false;
  private stopped: (() => void) | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: GatewayDeps) {
    this.scheduler = deps.scheduler;
    this.now = deps.now ?? (() => new Date());
    this.signals = deps.signals ?? process;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tickMs = deps.tickMs ?? TICK_MS;
    this.drainBudgetMs = deps.drainBudgetMs ?? DRAIN_BUDGET_MS;
    this.pid = deps.pid ?? process.pid;
  }

  /**
   * Take the lock, or name the gateway that already has it. Called before the
   * expensive half of boot in the CLI, so the loser of the race has not spawned
   * MCP children or connected a surface by the time it finds out.
   */
  start(now: Date = this.now()): { started: true } | { started: false; held: string; remedy: string } {
    // Idempotent, because `serve` claims too. The claim deliberately refuses a
    // live holder even when that holder is this same pid (see sendlock.ts), so
    // without this flag a caller that pre-checked would refuse itself.
    if (this.claimed) return { started: true };
    const outcome = this.deps.lock.claim(now, STATUS.starting, this.pid);
    if ('held' in outcome) return { started: false, ...outcome };
    this.claimed = true;
    return { started: true };
  }

  /**
   * One beat of the process: refresh the claim, publish what it is doing, and
   * ask the scheduler for the next due job.
   *
   * The heartbeat and the tick share a timer on purpose — a heartbeat on its own
   * timer could keep the claim looking alive while the scheduler had stopped
   * being asked anything, which is the "up but wedged" state this whole slice is
   * about. Here, if ticking stops, the claim goes stale and the REPL takes over.
   */
  tick(now: Date = this.now()): void {
    if (this.stopping) return; // see `drain`: clearInterval does not unqueue a fired callback
    const state = this.scheduler.isRunning() ? STATUS.working : this.idleStatus(now);
    if (!this.deps.lock.beat(now, state, this.pid)) {
      // Something took the claim over, which can only mean this process was
      // judged dead. Two schedulers is the thing we refuse, so this one leaves.
      this.deps.log('gateway: la sua rivendicazione è stata presa da un altro processo — esco');
      void this.drain('lock');
      return;
    }
    this.deps.scheduler.tick(now);
  }

  private idleStatus(now: Date): string {
    const next = this.deps.jobs.list().find((j) => j.nextFireAt >= now)?.nextFireAt;
    if (!next) return STATUS.idle;
    return `${STATUS.idle} · prossimo job ${next.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}`;
  }

  /** The watchdog ping, at the cadence the supervisor declared. */
  beat(): void {
    this.deps.notify.watchdog();
  }

  /**
   * Refuse new work, wait for what is in flight, tear down. Idempotent: two
   * signals in a row must not run two teardowns.
   */
  async drain(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];

    this.deps.notify.stopping(STATUS.draining);
    this.deps.log(`gateway: ${reason} — drenaggio, nessun turno nuovo`);

    const deadline = Date.now() + this.drainBudgetMs;
    while (this.deps.scheduler.isRunning() && Date.now() < deadline) {
      await this.sleep(50);
    }
    if (this.deps.scheduler.isRunning()) {
      // Said out loud, with the number: this is the one exit that abandons a
      // turn, and it must never be the silent kind.
      this.deps.log(
        `gateway: un turno era ancora in volo dopo ${Math.round(this.drainBudgetMs / 1000)}s — esco comunque, il job resta dovuto`,
      );
    }

    // The claim goes before the teardown: from here on there is no scheduler in
    // this process, so a REPL starting now is right to start its own ticker.
    this.deps.lock.release(this.pid);
    await this.deps.close();
    // Every way out ends here, not only a signal: a claim taken over from under
    // us also has to end `serve`, or the process stays up with no timers,
    // scheduling nothing and reporting nothing.
    this.stopped?.();
  }

  /**
   * Run until told to stop. Resolves with the exit code once the drain is done.
   *
   * The tick timer is deliberately **not** `unref`'d — it is the thing that
   * keeps the process alive, which is the entire difference between this and a
   * command. Clearing it in `drain` lets the process end on its own rather than
   * through `process.exit`, which would truncate whatever is still being
   * written to stdout.
   */
  async serve(): Promise<number> {
    // The claim belongs to the thing that starts ticking, not to a caller that
    // is trusted to remember. A `serve` that scheduled without claiming is
    // precisely the two-schedulers failure this slice exists to make impossible.
    const outcome = this.start();
    if (!outcome.started) {
      this.deps.log(`${outcome.held}\n→ ${outcome.remedy}`);
      return EXIT_ALREADY_RUNNING;
    }

    const handlers: Array<[string, () => void]> = [];
    const done = new Promise<void>((resolve) => {
      this.stopped = resolve;
      for (const signal of STOP_SIGNALS) {
        const handler = (): void => {
          void this.drain(signal);
        };
        handlers.push([signal, handler]);
        this.signals.on(signal, handler);
      }
    });

    this.timers.push(setInterval(() => this.tick(), this.tickMs));
    const watchdogMs = this.deps.notify.watchdogIntervalMs;
    if (watchdogMs !== null) this.timers.push(setInterval(() => this.beat(), watchdogMs));

    // READY only now: under `Type=notify` this is what separates "the process
    // started" from "it is serving", and announcing it before the lock was taken
    // would let a crash loop look like a healthy boot.
    this.deps.notify.ready(this.idleStatus(this.now()));
    const problem = this.deps.notify.problem();
    if (problem) {
      // A missing transport means the watchdog never gets fed and systemd kills
      // a healthy process every WatchdogSec. Visible, or it reads as a crash
      // loop with no cause anywhere.
      this.deps.log(`gateway: notifiche al supervisore non consegnate (${problem}) — watchdog non alimentato`);
    }

    // One tick straight away, not only on the interval. Two things go wrong
    // without it, both measured on a real run: the published status sits at
    // "avvio" for the first thirty seconds while the gateway is already
    // serving, and a job that came due while the process was down — the restart
    // case `JobStore.markRan` calls catch-up — waits a full interval before it
    // fires. After READY, so a turn never starts before the supervisor has been
    // told the gateway is up.
    this.tick();

    await done;
    // Handlers off before returning: a leaked one makes a second serve() in the
    // same process drain twice on one SIGTERM.
    for (const [signal, handler] of handlers) this.signals.off(signal, handler);
    return 0;
  }
}

export { HEARTBEAT_MS };
