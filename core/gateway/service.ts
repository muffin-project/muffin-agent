import type { JobStore } from '../scheduler/jobs.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { TurnLane } from '../turns/lane.js';
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
 * was running.
 *
 * **The signals differ in the exit code, and that is not cosmetic.** The first
 * version of this file said *"both supervisors restart on any exit; the
 * distinction is for the person reading the log"*. That sentence was false in
 * both directions and each direction was a broken verb: under `Restart=always`
 * a drained `muffin gateway stop` came straight back five seconds later, so
 * **stop did not stop**; under launchd's `SuccessfulExit: false` the SIGUSR1
 * drain-restart exited 0 and the agent stayed **down**, which is the opposite
 * failure and the exact thing the signal exists to do. The codes below are how
 * the two verbs are made true — see `unit.ts` for the supervisor half.
 *
 * The budget is a ceiling, not a promise. Past it the gateway leaves anyway and
 * says so, because the alternative is a process that never dies and gets
 * SIGKILLed at `TimeoutStopSec` — the same turn lost, later, with nothing in
 * the log explaining it. A turn cut off this way is not lost work: `markRan` is
 * the only thing that moves a job's next fire and it runs after delivery, so an
 * interrupted job is still due (constraint 5 of the ADR; `service.test.ts`
 * asserts it against the real store rather than trusting this paragraph).
 */

/**
 * The scheduler's cadence — and the heartbeat, which is the same timer.
 *
 * Defined *as* `HEARTBEAT_MS` rather than as a second `30_000` that has to
 * agree with it. They were two literals, and the coupling was real but
 * unwritten: `tick()` is what refreshes the claim, and `STALE_AFTER_MS` is ten
 * heartbeats, so raising this past `STALE_AFTER_MS` would make every other
 * process judge a healthy gateway stale — two schedulers again, through a door
 * nobody was watching. One constant cannot drift from itself.
 */
export const TICK_MS = HEARTBEAT_MS;

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
 * "I stopped because I was told to" — the code that makes `muffin gateway stop`
 * a true verb.
 *
 * 143 is 128 + SIGTERM, the encoding every shell already uses, chosen so the
 * line in `systemctl status` reads as *terminated on request* to a person who
 * has never seen this codebase instead of as an invented number. `unit.ts`
 * names it in `RestartPreventExitStatus`, which is the half that does the work:
 * without it a drained stop came straight back `RestartSec` later.
 *
 * SIGINT exits the same way. To this process the two signals mean one thing,
 * and the only reader of the code is a supervisor that never sends SIGINT —
 * Ctrl-C on `muffin gateway run` is a person at a terminal, where nothing is
 * watching the code at all.
 */
export const EXIT_STOPPED = 143;

/**
 * What each way out asks the supervisor to do, in one place because the two
 * halves used to disagree in opposite directions on the two platforms.
 *
 * **0 means "restart me"** — SIGUSR1 is the drain-and-come-back signal, and on
 * launchd (`KeepAlive: true`) and systemd (`Restart=always`) alike a zero exit
 * is what brings the process back. A claim taken over by another gateway
 * (`drain('lock')`) falls through to the same 0 deliberately: coming back and
 * refusing with `EXIT_ALREADY_RUNNING` is the honest sequence, and the loser
 * of that race is the process that should not be the one deciding to stay down.
 *
 * Anything not listed is a crash, and a crash must always restart. That is the
 * property the exit codes are not allowed to cost us, on either supervisor.
 */
const EXIT_FOR: Record<string, number> = {
  SIGUSR1: 0,
  SIGTERM: EXIT_STOPPED,
  SIGINT: EXIT_STOPPED,
};

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
  /**
   * The other lane: turns that were enqueued, suspended or interrupted.
   *
   * **Required**, and on the same beat as the scheduler rather than on a timer
   * of its own. Two reasons, and neither is tidiness. A second timer would let
   * the turn lane keep working while the scheduler had stopped being asked
   * anything — the "up but wedged" state this whole file exists to make
   * impossible. And a `wait` is only ever as precise as the beat that ends it,
   * so one beat means one number to reason about (`MIN_WAIT_MS` is written
   * against exactly this one).
   *
   * Not optional, because an optional lane is a lane some assembly forgets, and
   * a forgotten one means every suspended turn on that install sleeps for ever
   * with the row saying `waiting` and nobody looking.
   */
  turnLane: Pick<TurnLane, 'tick' | 'isRunning'>;
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
  private exitCode = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  /**
   * Kept apart from the tick timer, and the separation is the whole point.
   *
   * `drain` used to clear every timer at once, including this one, and then
   * wait up to `DRAIN_BUDGET_MS` (60 s) against a `WatchdogSec` of 60 s — so a
   * drain the supervisor did not initiate (SIGUSR1, or the SIGTERM `muffin
   * gateway stop` sends straight to the pid) meant up to ninety seconds of
   * silence against a sixty-second deadline. The rescue was *presumed* to be
   * `notify.stopping()`, and that presumption is exactly what could not be
   * checked: there is no systemd on the machine this was written on, and
   * `sd_notify(3)` documents `STOPPING=1` as "the service is beginning its
   * shutdown" without saying one word about the watchdog while it does. So the
   * dependency is removed instead of documented — the ping keeps going for as
   * long as the drain does, and this timer is cleared only once the wait is
   * over.
   */
  private watchdogTimer: NodeJS.Timeout | null = null;

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
    if (!this.deps.lock.beat(now, this.state(now), this.pid)) {
      // Something took the claim over, which can only mean this process was
      // judged dead. Two schedulers is the thing we refuse, so this one leaves.
      this.deps.log('gateway: la sua rivendicazione è stata presa da un altro processo — esco');
      void this.drain('lock');
      return;
    }
    this.deps.scheduler.tick(now);
    // After the scheduler, on the same beat. The order is not arbitrary: a job
    // that comes due creates work the turn lane may then pick up in the same
    // beat, whereas the reverse ordering would make every job's turn wait a
    // full interval before anything looked at it.
    this.deps.turnLane.tick(now);
  }

  /**
   * The one sentence describing what this process is doing right now — written
   * to the claim row *and* carried on the watchdog ping, so `muffin gateway
   * status`, `doctor` and `systemctl status` cannot disagree.
   *
   * Draining wins over everything: without this line a ping landing during a
   * drain would republish "in attesa" over the `STOPPING=1` status and a stop
   * in progress would read, to the one tool watching from outside, as an idle
   * gateway that had simply gone quiet.
   */
  private state(now: Date): string {
    if (this.stopping) return STATUS.draining;
    return this.busy() ? STATUS.working : this.idleStatus(now);
  }

  /**
   * Is either lane holding the model right now?
   *
   * One question with two answers underneath, asked in one place so the status
   * line, the drain and `muffin gateway status` cannot disagree. A gateway
   * resuming an interrupted turn is working, and a drain that only watched the
   * scheduler would tear the database out from under it — which is the measured
   * crash `Scheduler.run` wraps `markRan` for.
   */
  private busy(): boolean {
    return this.scheduler.isRunning() || this.deps.turnLane.isRunning();
  }

  private idleStatus(now: Date): string {
    const next = this.deps.jobs.list().find((j) => j.nextFireAt >= now)?.nextFireAt;
    if (!next) return STATUS.idle;
    return `${STATUS.idle} · prossimo job ${next.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}`;
  }

  /**
   * The watchdog ping, at the cadence the supervisor declared, carrying the
   * status with it.
   *
   * The status is not a second message: `WATCHDOG=1\nSTATUS=…` is one datagram
   * and therefore one `systemd-notify` spawn, which is what makes publishing it
   * twice a minute free. Before this the live status reached only the SQLite
   * row, so `systemctl status` showed the boot-time line for the life of the
   * process while ADR-0035 asked for a readable `STATUS=`.
   */
  beat(now: Date = this.now()): void {
    this.deps.notify.watchdog(this.state(now));
  }

  /**
   * Refuse new work, wait for what is in flight, tear down. Idempotent: two
   * signals in a row must not run two teardowns.
   */
  async drain(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // Decided here and not in the signal handler, because `drain` is the thing
    // that is idempotent: a SIGUSR1 arriving during a SIGTERM drain must not
    // turn a stop into a restart.
    this.exitCode = EXIT_FOR[reason] ?? 0;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    // The watchdog timer deliberately survives this line — see its declaration.

    this.deps.notify.stopping(STATUS.draining);
    this.deps.log(
      `gateway: ${reason} — drenaggio, nessun turno nuovo` +
        // Said in the same breath as the drain, because the drain is exactly
        // when it gets asked: the signal handlers are registered and
        // idempotent, so a second Ctrl-C is absorbed and the terminal looks
        // hung for up to the whole budget. Correct, intended, and indis-
        // tinguishable from a crash unless the way out is written here.
        ` (fino a ${Math.round(this.drainBudgetMs / 1000)}s; un secondo Ctrl-C non accelera niente — se devi uscire adesso, kill -9 ${this.pid})`,
    );

    const deadline = Date.now() + this.drainBudgetMs;
    while (this.busy() && Date.now() < deadline) {
      await this.sleep(50);
    }
    if (this.busy()) {
      // Said out loud, with the number: this is the one exit that abandons a
      // turn, and it must never be the silent kind.
      this.deps.log(
        `gateway: un turno era ancora in volo dopo ${Math.round(this.drainBudgetMs / 1000)}s — esco comunque, il job resta dovuto`,
      );
    }

    // Only now: the ping had to outlive the wait above, not the process.
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;

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
   *
   * The code it resolves with is the supervisor's instruction, not a summary:
   * `EXIT_FOR` above, and `unit.ts` for what each supervisor then does.
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

    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    const watchdogMs = this.deps.notify.watchdogIntervalMs;
    if (watchdogMs !== null) this.watchdogTimer = setInterval(() => this.beat(), watchdogMs);

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
    return this.exitCode;
  }
}

export { HEARTBEAT_MS };
