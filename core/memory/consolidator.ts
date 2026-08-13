import type Database from 'better-sqlite3';
import type { TenantId } from '../policy/types.js';
import { CONSOLIDATION_PRINCIPAL, type IngestReport } from './ingest.js';

/**
 * What makes consolidation start by itself.
 *
 * `ingestPending` turns episodes into facts and has been correct since
 * `6ddba7c`. Until this file it had exactly one caller — `muffin memory
 * extract`, typed by hand — so on a real install facts stayed at **0** against
 * the old system's 414, and, because nothing else embeds an episode, recall
 * stayed keyword-only for the life of the install. ADR-0038 is the decision
 * record; this is the mechanism.
 *
 * ## The trigger: trailing edge of the conversation, with a count as the net
 *
 * The old system extracted on **every** turn and `memory_saved` fired on 78 of
 * 2 264 items — a **3.4%** yield, one model call per turn for one fact per
 * thirty. So the trigger has to be finer than "a turn arrived". Four
 * independent systems converged on the same finer thing (LangMem, Memobase,
 * Honcho, Supermemory — all trailing-edge idle debounce, none on a pure cron),
 * and this follows them with one difference that matters: their debounces are
 * tuned for *"the session is over"* (15-60 minutes), and the bar here is
 * stricter. The old pipeline's end-to-end median was **11.8 s**, not "minutes",
 * which means the fact was in place **before the next message of the same
 * conversation**. That property is the product; a mechanism that lands at
 * minutes would be a regression, not an approximation.
 *
 * A debounce alone has one failure: a conversation that never pauses never
 * consolidates. Hence the ceiling — the "N episodi non consolidati" the M5 DoD
 * asked for, kept as the **backstop** rather than the primary trigger, which is
 * the role the external evidence supports.
 *
 * ## Why this is not a `JobStore` job and not a `Scheduler` lane
 *
 * A `Job` carries a natural-language `goal` and is executed by `runTurn` with
 * the main model, the tool set and the kernel. Consolidation is none of those:
 * it is `ingestPending` on the light lane, with no tools and no capability for
 * `decide()` to rule on. Expressing it as a job would mean writing a sentence in
 * Italian and hoping the model calls a tool that does not exist.
 *
 * And `Scheduler` is deliberately a **single lane** — "one owner, one model
 * lane, one job at a time". Putting consolidation in it makes the 8am brief and
 * the memory lane compete: a brief in flight would defer consolidation past its
 * trailing edge, and a 20-episode backlog would delay the brief. Worse, the two
 * want *opposite* arbitration — a job yields to the owner (ADR-0022's
 * foreground gate), whereas consolidation is supposed to run precisely when the
 * owner has just stopped. Two mechanisms, because they are two mechanisms.
 *
 * ## Where it lives
 *
 * Built by `buildRuntime`, so **every process that runs turns has one**: the
 * gateway (which hosts the remote surfaces) and a REPL window alike. Making it
 * the gateway's alone would leave an owner without an installed unit exactly
 * where they are today — facts at zero. Two processes cannot double-extract:
 * `ingestPending` takes the durable lane lock (`ingest-lock.ts`) and a loser is
 * refused, not queued.
 */

/**
 * The trailing edge: how long the conversation must be quiet before the lane
 * runs.
 *
 * **20 s, measured on the owner's own corpus** (`~/dev/Muffin/muffin.dev.db`,
 * 4 107 episodes, 2026-03-16 → 2026-07-18) rather than picked. Three numbers
 * decided it, each from a different direction:
 *
 *  - **It does not fire while the owner is typing.** Of 1 793 consecutive owner
 *    messages, only **1.0%** are less than 20 s apart (3.5% under 30 s, 9.6%
 *    under 45 s). One turn in a hundred pays an extra light-model call; none
 *    pays a wrong fact, because extraction is per-episode and the marker is
 *    per-episode too.
 *  - **It keeps the property the 11.8 s bar bought.** Measuring the real clock —
 *    from the reply landing to the next owner message — a 20 s trailing edge
 *    fires **1 326 times for 1 793 turns**: 26% fewer model calls than
 *    per-turn, at 1.35 turns per fire. The fact lands ~20 s plus one light call
 *    after the turn, which is still inside the gap for the large majority of
 *    pairs (median gap from reply to next message: 56 s).
 *  - **Longer buys almost nothing and costs the property.** 30 s fires 1 282
 *    times — **3.3% fewer calls for 50% more latency**. 60 s fires 1 075 times
 *    (19% fewer calls) but exceeds the 56 s median gap, so the fact would
 *    routinely land *after* the next message, which is the thing being
 *    protected. The field's 15-60 minutes answers a different question ("is the
 *    session over"), and at the owner's 272 s median inter-message gap it would
 *    coalesce a whole day into one fire.
 */
export const CONSOLIDATION_IDLE_MS = 20_000;

/**
 * The backstop: consolidate after this many turns even if the quiet never
 * comes.
 *
 * **12, and it is chosen to be a net rather than a second trigger.** On the same
 * corpus, at exactly the 20 s trailing edge above, the longest run of turns
 * without a qualifying pause was **7** (p90 = 2, p99 = 4). Twelve sits 70% above
 * the observed maximum, so on four months of the owner's real traffic this would
 * have fired **zero times** — which is what a backstop should do — while
 * bounding the un-consolidated window at twelve turns for the deep-work session
 * the corpus happens not to contain. It is also the observed maximum at a 60 s
 * debounce, so it stays a backstop if the trailing edge is ever raised toward
 * the field's range.
 *
 * The field brackets it without settling it: Letta 5, AgentCore 6, mem0 Dream
 * 20, Honcho 50. Generative Agents used a **salience sum** (importance ≥ 150,
 * 2-3 fires/day) instead of a count — rejected here for a specific reason, in
 * ADR-0038: our `importance` is assigned *by extraction*, so a salience trigger
 * would need the extraction it is supposed to trigger.
 */
export const CONSOLIDATION_CEILING = 12;

/**
 * Episodes per fire.
 *
 * A fire is armed by a turn, so the ordinary batch is one or two episodes and
 * this bound never binds. It exists for the other case: a migration or a long
 * offline stretch leaves hundreds pending, and one trailing edge must not turn
 * into a twenty-minute run of model calls. The remainder is not lost — the next
 * fire takes the next page.
 *
 * The consequence, stated because it is real: `pendingEpisodes` is
 * `ORDER BY created_at`, so while a backlog larger than this exists, the
 * *newest* episode is not the one being consolidated and the "in place before
 * the next message" property does not hold. Draining a backlog is the job of
 * the periodic-maintenance mechanism, which is **not in this slice**.
 */
export const CONSOLIDATION_BATCH = 20;

/**
 * The only tenant this lane consolidates, and the refusal is the point.
 *
 * `agent/context/assemble.ts` records that the group persona's claim *"non sto
 * costruendo il ritratto di nessuno"* is true today **only because**
 * `ingestPending`'s single caller hardcodes `'host'`. Scheduling ingestion is
 * exactly the change that was going to make it false: a group episode reaching
 * `extractFacts` is mined with `speakerName` derived from `role`, so a
 * stranger's claim gets written down under the label "owner", in a tenant whose
 * memory is not the owner's.
 *
 * So this slice **refuses** the tenant seam instead of widening it. `notify`
 * drops anything that is not this tenant, and `consolidator.test.ts` asserts it
 * through `runTurn` with a member principal. Widening it needs the speaker to
 * come from the episode's principal rather than its role — a change to
 * extraction, not to scheduling, and not this slice.
 */
export const CONSOLIDATION_TENANT: TenantId = 'host';

/**
 * The `spend.capability` label for everything the light lane bills.
 *
 * Derived from `CONSOLIDATION_PRINCIPAL` (declared in `ingest.ts`, next to the
 * work it names) rather than written a second time, so the trace and the ledger
 * cannot drift into calling the same lane two things.
 *
 * That principal — `{kind:'system', source:'consolidation'}` — had **zero
 * producers** in `core/policy/types.ts` until this slice. It is filled rather
 * than deleted, and the claim is kept narrow on purpose: the kernel never
 * inspects `source` (`decide.ts` treats every `system` principal alike), so this
 * is **not** a policy branch, because consolidation invokes no capability for
 * `decide()` to rule on. What it does is separate "the memory lane spent this"
 * from "a scheduled job spent this" in the only two places the owner can look.
 * If it ever stops being read there, the honest move is deletion.
 */
export const CONSOLIDATION_CAPABILITY = `${CONSOLIDATION_PRINCIPAL.kind}.${CONSOLIDATION_PRINCIPAL.source}`;

/**
 * What every surface says about the lane at boot, in one place.
 *
 * Written once and read by the REPL and the gateway for the reason `STATUS` in
 * `core/gateway/service.ts` gives: two vocabularies for one state is how "is it
 * working" stops having an answer. And it is said at all because a mechanism
 * that runs unattended and announces nothing is the eleventh member of this
 * repo's "declared and connected to nothing" family, wearing the other hat —
 * connected, and indistinguishable from disconnected.
 */
export function consolidationBootLine(): string {
  return (
    `memoria: consolidamento automatico ${Math.round(CONSOLIDATION_IDLE_MS / 1000)}s dopo l'ultimo turno` +
    ` (tetto ${CONSOLIDATION_CEILING} turni) — \`muffin memory stats\` per l'ultimo giro`
  );
}

/** What made this fire. `manual` is `muffin memory extract`, on the same lane. */
export type ConsolidationTrigger = 'idle' | 'ceiling' | 'manual';

/**
 * How it ended. `busy` is the durable lane lock refusing — another process (or
 * a hand-typed extract) was already in the batch.
 */
export type ConsolidationOutcome = 'ran' | 'budget' | 'busy' | 'error';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id         INTEGER PRIMARY KEY,
  ran_at     TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  episodes   INTEGER NOT NULL,
  facts      INTEGER NOT NULL,
  superseded INTEGER NOT NULL,
  indexed    INTEGER NOT NULL,
  review     INTEGER NOT NULL,
  errors     INTEGER NOT NULL,
  ms         INTEGER NOT NULL
);
`;

export type ConsolidationRun = {
  ranAt: Date;
  trigger: ConsolidationTrigger;
  outcome: ConsolidationOutcome;
  episodes: number;
  facts: number;
  superseded: number;
  indexed: number;
  review: number;
  errors: number;
  /** Wall time of the whole batch. The one number nobody had: the old system
   * logged to console and persisted nothing, so of its 18.5 s claim→processed
   * we never learned how much was extraction. */
  ms: number;
};

type Row = {
  ran_at: string;
  trigger: string;
  outcome: string;
  episodes: number;
  facts: number;
  superseded: number;
  indexed: number;
  review: number;
  errors: number;
  ms: number;
};

/**
 * The durable record that the lane ran.
 *
 * Without it, a lane that runs unattended and finds nothing to do is
 * indistinguishable from one that never runs — and finding nothing is the
 * common case, because the yield is one fact per thirty turns. `muffin memory
 * stats` and `muffin doctor` read this; nothing else can answer "is it working"
 * for an install whose facts are legitimately still zero.
 *
 * Rows are never deleted (invariant §I-8): this table is also the only thing
 * that can answer "how often did the memory lane run in May", and it is where
 * the 11.8 s bar gets checked against reality instead of arithmetic.
 */
export class ConsolidationLog {
  private readonly insertStmt: Database.Statement;
  private readonly lastStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(SCHEMA);
    this.insertStmt = db.prepare(
      `INSERT INTO consolidation_runs
         (ran_at, trigger, outcome, episodes, facts, superseded, indexed, review, errors, ms)
       VALUES (@ranAt, @trigger, @outcome, @episodes, @facts, @superseded, @indexed, @review, @errors, @ms)`,
    );
    this.lastStmt = db.prepare(`SELECT * FROM consolidation_runs ORDER BY id DESC LIMIT 1`);
    this.countStmt = db.prepare(
      `SELECT count(*) AS runs, COALESCE(SUM(facts), 0) AS facts FROM consolidation_runs`,
    );
  }

  record(run: ConsolidationRun): void {
    this.insertStmt.run({ ...run, ranAt: run.ranAt.toISOString() });
  }

  last(): ConsolidationRun | null {
    const row = this.lastStmt.get() as Row | undefined;
    return row ? hydrate(row) : null;
  }

  totals(): { runs: number; facts: number } {
    return this.countStmt.get() as { runs: number; facts: number };
  }
}

/**
 * The log, read without being able to write it.
 *
 * A separate function and not `new ConsolidationLog(db)` because `doctor` opens
 * the database **readonly** — deliberately, so looking at Muffin can never
 * create or migrate anything — and the constructor above runs `CREATE TABLE IF
 * NOT EXISTS`, which is a write the moment the table is absent. Absent is also
 * exactly the state `doctor` most needs to report, so the check must survive
 * it: null means "this install has never consolidated", which is the finding.
 */
export function readConsolidation(
  db: Database.Database,
): { last: ConsolidationRun; runs: number; facts: number } | null {
  try {
    const row = db.prepare(`SELECT * FROM consolidation_runs ORDER BY id DESC LIMIT 1`).get() as
      | Row
      | undefined;
    if (!row) return null;
    const totals = db
      .prepare(`SELECT count(*) AS runs, COALESCE(SUM(facts), 0) AS facts FROM consolidation_runs`)
      .get() as { runs: number; facts: number };
    return { last: hydrate(row), ...totals };
  } catch {
    // No such table: the lane has never run on this install.
    return null;
  }
}

function hydrate(row: Row): ConsolidationRun {
  return {
    ranAt: new Date(row.ran_at),
    trigger: row.trigger as ConsolidationTrigger,
    outcome: row.outcome as ConsolidationOutcome,
    episodes: row.episodes,
    facts: row.facts,
    superseded: row.superseded,
    indexed: row.indexed,
    review: row.review,
    errors: row.errors,
    ms: row.ms,
  };
}

/**
 * What a batch produced: the row that was logged, plus the full report when
 * there was one.
 *
 * `report` is null when the batch never started — the budget refused it, or
 * `ingest` threw. The detail exists for `muffin memory extract`, which prints
 * every `needsReview` line and every error verbatim; the automatic lane only
 * ever needs the row.
 */
export type ConsolidationResult = { run: ConsolidationRun; report: IngestReport | null };

export type ConsolidatorDeps = {
  db: Database.Database;
  /** The batch. Bound by `buildRuntime` to `ingestPending` on the light lane. */
  ingest: (limit: number) => Promise<IngestReport>;
  /**
   * The cap, asked before every fire. An unattended lane that keeps spending
   * past the monthly cap is the failure `budget.ts` was written for, and until
   * this slice the memory lane could not even be seen by it.
   */
  budgetExhausted: () => boolean;
  /** Where a refusal or an error is said out loud. stderr, in every surface. */
  log?: ((line: string) => void) | undefined;
  now?: (() => Date) | undefined;
  idleMs?: number | undefined;
  ceiling?: number | undefined;
  batch?: number | undefined;
};

export class Consolidator {
  private readonly log: ConsolidationLog;
  private readonly now: () => Date;
  private readonly idleMs: number;
  private readonly ceiling: number;
  private readonly batch: number;

  private timer: NodeJS.Timeout | null = null;
  private sinceLastRun = 0;
  private running: Promise<void> | null = null;
  /** A turn arrived while a batch was in flight: re-arm when it finishes. */
  private armAgain = false;
  private stopped = false;

  constructor(private readonly deps: ConsolidatorDeps) {
    this.log = new ConsolidationLog(deps.db);
    this.now = deps.now ?? (() => new Date());
    this.idleMs = deps.idleMs ?? CONSOLIDATION_IDLE_MS;
    this.ceiling = deps.ceiling ?? CONSOLIDATION_CEILING;
    this.batch = deps.batch ?? CONSOLIDATION_BATCH;
  }

  /**
   * A turn ended. **Arms a timer and returns** — this is the whole contract.
   *
   * Called from `agent/loop.ts`'s `finish`, which runs microseconds before the
   * caller writes the reply, so anything that blocks here is something the owner
   * waits for. It therefore does no I/O, makes no model call, and never awaits:
   * cancel-and-reschedule plus one increment.
   *
   * This is deliberately **not** the hand-back-a-closure shape of
   * `agent/observe-run.ts`, and the difference is not style. There the write has
   * to be withheld until delivery succeeds, because an episode recorded for a
   * message the owner never received would be memory of something that did not
   * happen. Here the episode was already written at the *top* of `runTurn`,
   * before the model was called — so the input to this trigger exists whether or
   * not the reply lands, and withholding the arm would only delay work that is
   * already owed.
   */
  notify(tenant: TenantId): void {
    if (this.stopped) return;
    // The tenant seam, refused rather than widened. See CONSOLIDATION_TENANT.
    if (tenant !== CONSOLIDATION_TENANT) return;

    // No "is a batch running" branch here on purpose. A turn arriving mid-batch
    // arms the trailing edge like any other, and the single guard in `fire`
    // decides what to do when that edge expires — which keeps the ceiling
    // counting the turns that really happened instead of silently forgiving the
    // ones that landed during a slow batch. The first version had a second
    // guard here; a mutation run showed it changed no outcome and cost a
    // branch, which is the argument against every guard that only looks careful.
    this.sinceLastRun += 1;
    if (this.sinceLastRun >= this.ceiling) {
      this.disarm();
      this.fire('ceiling');
      return;
    }
    this.rearm();
  }

  /** Timer off, and no further arming. Called by `runtime.close()`. */
  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  /** True while a trailing edge is pending. Read by tests and the boot line. */
  isArmed(): boolean {
    return this.timer !== null;
  }

  /** Resolves when the batch in flight (if any) is done. For tests and drains. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Runs the batch by hand, on the same lane and through the same guard.
   * `muffin memory extract` uses it, so a hand-typed run and an automatic one
   * cannot diverge — same budget gate, same lane lock, same row in the log.
   *
   * The limit is a parameter because the two callers want different pages: the
   * automatic lane takes one bounded page per trailing edge, the CLI loops to
   * drain a backlog the owner asked it to drain.
   */
  async runNow(trigger: ConsolidationTrigger = 'manual', limit = this.batch): Promise<ConsolidationResult> {
    await this.settled();
    return this.start(trigger, limit);
  }

  private rearm(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire('idle');
    }, this.idleMs);
    // The trailing edge must never be the reason a process stays alive: a
    // headless `muffin run` that finished its turn should exit, not linger 20 s
    // waiting to extract. `cli/repl.ts` does the same to the scheduler ticker.
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Fire and forget, by design: nothing upstream of here may be made to wait. */
  private fire(trigger: ConsolidationTrigger): void {
    if (this.running) {
      this.armAgain = true;
      return;
    }
    void this.start(trigger, this.batch);
  }

  /**
   * The one door into a batch, for both the timer and the CLI.
   *
   * Two consolidations at once is refused twice over, and the two guards are not
   * redundant: `running` stops a second batch **inside this process** without
   * paying a transaction, and the durable lane lock inside `ingestPending` stops
   * one **across processes** — which is the case that exists now that a gateway
   * and a REPL window can both be up.
   */
  private start(trigger: ConsolidationTrigger, limit: number): Promise<ConsolidationResult> {
    const run = this.execute(trigger, limit);
    // `.then(noop, noop)` before anything awaits it: the tracked promise must
    // never reject. `execute` already catches what it can, and this is the last
    // net — a floating promise that rejects is exactly what took the gateway
    // down once before (`Scheduler.run`: a write against a database the drain
    // had closed, thrown from a floating promise, unhandled rejection, exit 1).
    this.running = run.then(
      () => undefined,
      () => undefined,
    );
    void this.running.finally(() => {
      this.running = null;
      if (this.armAgain && !this.stopped) {
        this.armAgain = false;
        this.rearm();
      }
    });
    return run;
  }

  private async execute(trigger: ConsolidationTrigger, limit: number): Promise<ConsolidationResult> {
    const started = Date.now();
    // Counted as spent before the batch, not after: a turn arriving mid-batch
    // has to start a fresh count toward the ceiling, or a long conversation
    // fires once and then never again.
    this.sinceLastRun = 0;

    const blank = {
      ranAt: this.now(),
      trigger,
      episodes: 0,
      facts: 0,
      superseded: 0,
      indexed: 0,
      review: 0,
      errors: 0,
    };

    if (this.deps.budgetExhausted()) {
      // Recorded rather than skipped in silence: "the memory lane stopped
      // because the month is spent" is a thing the owner has to be able to read
      // off `memory stats`, and it is the difference between a cap working and
      // a lane that quietly died.
      const run = { ...blank, outcome: 'budget' as const, ms: Date.now() - started };
      this.write(run);
      this.deps.log?.('consolidamento: saltato, budget mensile esaurito');
      return { run, report: null };
    }

    let report: IngestReport;
    try {
      report = await this.deps.ingest(limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const run = { ...blank, outcome: 'error' as const, errors: 1, ms: Date.now() - started };
      this.write(run);
      this.deps.log?.(`consolidamento: fallito — ${message}`);
      return { run, report: null };
    }

    // The lane lock refuses rather than queues (`ingest-lock.ts`). Told apart
    // from a real failure because they mean opposite things: `busy` is the
    // guarantee working, `error` is it not.
    const run: ConsolidationRun = {
      ...blank,
      outcome: report.busy ? 'busy' : 'ran',
      episodes: report.episodes,
      facts: report.factsAdded,
      superseded: report.superseded,
      indexed: report.indexed,
      review: report.needsReview.length,
      errors: report.errors.length,
      ms: Date.now() - started,
    };
    this.write(run);
    for (const e of report.errors) this.deps.log?.(`consolidamento: ${e}`);
    return { run, report };
  }

  /**
   * The record, guarded. `runtime.close()` can close the database under a batch
   * that is still finishing, and an insert against a closed handle throws
   * `TypeError: The database connection is not open` — from a floating promise,
   * which is a process exit. The run happened either way; losing its row is the
   * lesser loss.
   */
  private write(run: ConsolidationRun): void {
    try {
      this.log.record(run);
    } catch {
      /* the batch is what mattered; the log line is not worth an exit */
    }
  }
}
