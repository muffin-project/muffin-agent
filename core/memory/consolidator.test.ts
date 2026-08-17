import DatabaseCtor from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Consolidator,
  CONSOLIDATION_CEILING,
  CONSOLIDATION_DRAIN_MS,
  CONSOLIDATION_IDLE_MS,
  readConsolidation,
} from './consolidator.js';
import type { IngestReport } from './ingest.js';

/**
 * The trigger's own behaviour, with the batch replaced by a counter.
 *
 * `consolidation-wiring.test.ts` is the one that proves production reaches this
 * — through `runTurn` and into real facts. This file is the second half of
 * PRACTICES §5: once the wiring is proven, the timing rules get their own tests,
 * because "fires 20 s after the last turn" and "fires at the twelfth turn" are
 * not observable from a test that has to run a whole pipeline.
 */

const empty = (over: Partial<IngestReport> = {}): IngestReport => ({
  tenantId: 'host',
  // One episode, one fact, one page that was *not* full: the default report is
  // the ordinary trailing-edge fire, and it must not arm the drain. Every test
  // about the drain says so explicitly by overriding `fetched`.
  fetched: 1,
  marked: 1,
  episodes: 1,
  factsAdded: 1,
  superseded: 0,
  skippedAgentOutput: 0,
  skippedDocuments: 0,
  skippedEmpty: 0,
  indexed: 0,
  busy: false,
  needsReview: [],
  errors: [],
  judgeUnavailable: [],
  ...over,
});

function harness(over: { report?: IngestReport; exhausted?: boolean } = {}) {
  const db = new DatabaseCtor(':memory:');
  const calls: number[] = [];
  const lines: string[] = [];
  const consolidator = new Consolidator({
    db,
    ingest: async (limit) => {
      calls.push(limit);
      return over.report ?? empty();
    },
    budgetExhausted: () => over.exhausted === true,
    log: (line) => lines.push(line),
  });
  return { db, calls, lines, consolidator };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the trailing edge', () => {
  it('does not run inside the turn — the reply goes out first', async () => {
    const h = harness();
    h.consolidator.notify('host');
    // The whole contract of `notify`: arm and return. If this is ever non-zero
    // the hook has become something the owner waits for.
    expect(h.calls).toEqual([]);
    expect(h.consolidator.isArmed()).toBe(true);
  });

  it('fires once the conversation has been quiet for the debounce', async () => {
    const h = harness();
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS - 1);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await h.consolidator.settled();
    expect(h.calls.length).toBe(1);
  });

  /**
   * The mutation this kills: a debounce that restarts nothing, i.e. a plain
   * `setTimeout` per turn. Measured on the owner's corpus, 1.0% of consecutive
   * messages arrive under 20 s apart — small, and not zero, so the trailing
   * edge has to be cancel-and-reschedule or those turns pay a model call each.
   */
  it('does not fire while the owner is still typing: every turn pushes it back', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      h.consolidator.notify('host');
      await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS - 1_000);
    }
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidator.settled();
    // Five turns, one batch: this is the 26% of model calls the debounce saves
    // against extracting per turn.
    expect(h.calls.length).toBe(1);
  });

  it('re-arms after a batch, so the next stretch of conversation is consolidated too', async () => {
    const h = harness();
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidator.settled();
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidator.settled();
    expect(h.calls.length).toBe(2);
  });
});

describe('the ceiling', () => {
  /**
   * The mutation this kills: no backstop at all. A conversation that never
   * pauses would never consolidate, and the owner would find out weeks later
   * from an empty `facts` table.
   */
  it('fires without any quiet once the conversation reaches the ceiling', async () => {
    const h = harness();
    for (let i = 0; i < CONSOLIDATION_CEILING; i += 1) h.consolidator.notify('host');
    // No timer advanced at all: this is the point of the ceiling.
    await h.consolidator.settled();
    expect(h.calls.length).toBe(1);
    expect(readConsolidation(h.db)?.last.trigger).toBe('ceiling');
  });

  it('does not fire one turn early', async () => {
    const h = harness();
    for (let i = 0; i < CONSOLIDATION_CEILING - 1; i += 1) h.consolidator.notify('host');
    await h.consolidator.settled();
    expect(h.calls).toEqual([]);
  });

  it('counts from the last batch, not from the start of the process', async () => {
    const h = harness();
    for (let i = 0; i < CONSOLIDATION_CEILING; i += 1) h.consolidator.notify('host');
    await h.consolidator.settled();
    for (let i = 0; i < CONSOLIDATION_CEILING; i += 1) h.consolidator.notify('host');
    await h.consolidator.settled();
    expect(h.calls.length).toBe(2);
  });
});

describe('the tenant seam', () => {
  /**
   * Refused, not widened — `assemble.ts` records that the group persona's "non
   * sto costruendo il ritratto di nessuno" is true only while extraction never
   * points at a group tenant. `consolidation-wiring.test.ts` asserts the same
   * thing through a real member turn on the production runtime.
   */
  it('ignores a turn from a group tenant entirely', async () => {
    const h = harness();
    h.consolidator.notify('group:telegram:42');
    expect(h.consolidator.isArmed()).toBe(false);
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS * 2);
    expect(h.calls).toEqual([]);
  });

  it('does not let group turns push the host conversation toward the ceiling', async () => {
    const h = harness();
    for (let i = 0; i < CONSOLIDATION_CEILING * 2; i += 1) h.consolidator.notify('group:telegram:42');
    await h.consolidator.settled();
    expect(h.calls).toEqual([]);
  });
});

describe('one batch at a time', () => {
  /**
   * The mutation this kills: dropping the in-process guard and trusting the
   * durable lane lock alone. The lock would still refuse the second batch, but
   * the refusal costs a transaction and shows up as a `busy` row every time,
   * which is a lane that looks broken while working.
   */
  it('a turn arriving mid-batch does not start a second one', async () => {
    const db = new DatabaseCtor(':memory:');
    const gate: { release: (() => void) | null } = { release: null };
    const calls: number[] = [];
    const consolidator = new Consolidator({
      db,
      // Only the first batch hangs: the second has to be free to finish, or the
      // assertion that the lane came back is untestable.
      ingest: async (limit) => {
        calls.push(limit);
        if (calls.length === 1) {
          await new Promise<void>((r) => {
            gate.release = r;
          });
        }
        return empty();
      },
      budgetExhausted: () => false,
    });

    consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    expect(calls.length).toBe(1);

    // Enough turns to trip the ceiling twice over, all while the first batch is
    // still in flight.
    for (let i = 0; i < CONSOLIDATION_CEILING * 2; i += 1) consolidator.notify('host');
    expect(calls.length).toBe(1);

    gate.release?.();
    await consolidator.settled();
    // The turns that arrived mid-batch are not lost: the batch that was running
    // could not see their episodes, so the lane re-arms for them.
    expect(consolidator.isArmed()).toBe(true);
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await consolidator.settled();
    expect(calls.length).toBe(2);
  });

  /**
   * The other door, and the reason the guard lives in `fire` as well as in
   * `notify`: a hand-typed `muffin memory extract` starts a batch through
   * `runNow` while a trailing edge is already armed, and the timer then fires
   * into it. Before the lane lock existed this was two extractions over the
   * same pending set — every episode processed twice, every judge call paid for
   * twice — and the lock would still refuse it, at the cost of a transaction
   * and a `busy` row on a lane that was working correctly.
   */
  it('a trailing edge that expires during a hand-typed batch does not start a second one', async () => {
    const db = new DatabaseCtor(':memory:');
    const gate: { release: (() => void) | null } = { release: null };
    const calls: number[] = [];
    const consolidator = new Consolidator({
      db,
      ingest: async (limit) => {
        calls.push(limit);
        if (calls.length === 1) await new Promise<void>((r) => (gate.release = r));
        return empty();
      },
      budgetExhausted: () => false,
    });

    consolidator.notify('host'); // arms the trailing edge
    const manual = consolidator.runNow('manual');
    await Promise.resolve();
    expect(calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    expect(calls.length).toBe(1);

    gate.release?.();
    await manual;
    await consolidator.settled();
    expect(calls.length).toBe(1);
  });

  it('reports the durable lane lock refusing as `busy`, not as a failure', async () => {
    const h = harness({
      report: empty({ episodes: 0, factsAdded: 0, busy: true, errors: ["un'altra estrazione è già in corso (pid 9)"] }),
    });
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidator.settled();
    expect(readConsolidation(h.db)?.last.outcome).toBe('busy');
  });
});

describe('the drain', () => {
  /**
   * A backlog with a page-by-page harness: `ingest` hands back a full page while
   * the queue lasts, then a short one. What is being asserted is that the lane
   * keeps taking pages **on its own**, which is the whole of the second
   * mechanism — before it, a fire under backlog spent its page on the oldest
   * episodes and the message that armed it was not in the batch at all.
   */
  function backlog(pages: number, over: { marked?: number } = {}) {
    const db = new DatabaseCtor(':memory:');
    const triggers: string[] = [];
    let left = pages;
    const consolidator = new Consolidator({
      db,
      ingest: async (limit) => {
        left -= 1;
        const full = left > 0;
        return empty({
          fetched: full ? limit : 3,
          marked: full ? (over.marked ?? limit) : 3,
          episodes: 1,
          factsAdded: 0,
        });
      },
      budgetExhausted: () => false,
    });
    const pageCount = () =>
      (db.prepare(`SELECT count(*) AS n FROM consolidation_runs`).get() as { n: number }).n;
    const seen = () =>
      (db.prepare(`SELECT trigger FROM consolidation_runs ORDER BY id`).all() as { trigger: string }[]).map(
        (r) => r.trigger,
      );
    return { db, consolidator, triggers, pageCount, seen };
  }

  it('keeps taking pages until the queue is shorter than one', async () => {
    const h = backlog(4);
    h.consolidator.notify('host');
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(CONSOLIDATION_DRAIN_MS);
      await h.consolidator.settled();
    }
    // Four pages, and then it stops: the fourth was short, so nothing is behind
    // it and re-arming would be a timer with no work.
    expect(h.pageCount()).toBe(4);
    expect(h.seen()).toEqual(['idle', 'drain', 'drain', 'drain']);
    expect(h.consolidator.isArmed()).toBe(false);
  });

  /**
   * The mutation this kills, and it is the expensive one: driving the drain off
   * "is anything still pending" instead of off progress. An episode whose
   * extraction fails permanently is left unmarked *on purpose* so it is retried,
   * so it sits at the head of `ORDER BY created_at` for ever — and a drain that
   * asked the queue would re-read that page every twenty seconds and re-pay the
   * same failing model call until the month's budget was gone. That is the same
   * failure ADR-0038 rejected the `stats.pending` ticker for, through a
   * different door.
   */
  it('stops on a full page that moved nothing, instead of paying for it forever', async () => {
    const db = new DatabaseCtor(':memory:');
    const calls: number[] = [];
    const consolidator = new Consolidator({
      db,
      ingest: async (limit) => {
        calls.push(limit);
        // A full page, one episode attempted, and the marker never advanced:
        // exactly what a permanently failing head looks like.
        return empty({ fetched: limit, marked: 0, episodes: 1, factsAdded: 0, errors: ['episodio 7: fallita'] });
      },
      budgetExhausted: () => false,
    });

    consolidator.notify('host');
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(CONSOLIDATION_DRAIN_MS);
      await consolidator.settled();
    }
    expect(calls.length).toBe(1);
  });

  it('does not arm at all when the page was not full', async () => {
    const h = harness({ report: empty({ fetched: 5, marked: 5 }) });
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidator.settled();
    expect(h.consolidator.isArmed()).toBe(false);
  });

  /**
   * The arbitration, and it is the reason the drain is safe to run at the live
   * lane's own pace: a turn arriving mid-drain re-arms the *trailing edge*, so
   * the head of the queue — where the owner's new words are — is served next.
   * The drain never gets to keep the lane away from a live conversation.
   */
  it('loses to a turn: the live trailing edge takes the next page', async () => {
    const h = backlog(6);
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_DRAIN_MS);
    await h.consolidator.settled();
    expect(h.seen()).toEqual(['idle']);

    // The owner speaks while the drain is armed.
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidator.settled();
    expect(h.seen()).toEqual(['idle', 'idle']);
  });

  it('does not keep the process alive: the drain timer is unref’d like the trailing edge', async () => {
    const h = backlog(3);
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_DRAIN_MS);
    await h.consolidator.settled();
    expect(h.consolidator.isArmed()).toBe(true);
    // `hasRef` is node's own answer, so this asserts the timer and not a flag we
    // set beside it. A headless `muffin run` that finished its turn must exit.
    const timer = (h.consolidator as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);
  });

  it('stops draining the moment the lane is stopped', async () => {
    const h = backlog(5);
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_DRAIN_MS);
    await h.consolidator.settled();
    h.consolidator.stop();
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_DRAIN_MS * 5);
    await h.consolidator.settled();
    expect(h.pageCount()).toBe(1);
  });
});

describe('the maintenance sweep', () => {
  /**
   * The gate is an argument, not a saving: a duplicate among the *current*
   * beliefs can only come into existence when a row is added, because
   * `supersede` only ever removes one from the active set and nothing else
   * writes to `facts`. So a batch that added nothing cannot have created a pair
   * the last sweep missed — and at the measured yield of one fact per thirty
   * turns, that is almost every fire.
   */
  it('does not run on a batch that added no facts', async () => {
    const db = new DatabaseCtor(':memory:');
    const sweeps: number[] = [];
    const consolidator = new Consolidator({
      db,
      ingest: async () => empty({ factsAdded: 0 }),
      budgetExhausted: () => false,
      sweep: () => {
        sweeps.push(1);
        return { merges: [] };
      },
    });
    consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await consolidator.settled();
    expect(sweeps).toEqual([]);
  });

  it('runs on a batch that added one, and records what it retired', async () => {
    const db = new DatabaseCtor(':memory:');
    const consolidator = new Consolidator({
      db,
      ingest: async () => empty({ factsAdded: 1 }),
      budgetExhausted: () => false,
      sweep: () => ({ merges: [{ keptFactId: 9 }, { keptFactId: 10 }] }),
    });
    consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await consolidator.settled();
    // Visible, for the same reason every other number in this row is: a sweep
    // that retires rows unattended and announces nothing is indistinguishable
    // from one that does not run.
    expect(readConsolidation(db)?.last.merged).toBe(2);
  });

  /**
   * The batch is what mattered. A sweep that threw must not turn a run that
   * wrote facts into an `error` row — the facts are there, and that row is what
   * the owner reads to know it.
   */
  it('a sweep that throws does not lose the batch that wrote the facts', async () => {
    const db = new DatabaseCtor(':memory:');
    const consolidator = new Consolidator({
      db,
      ingest: async () => empty({ factsAdded: 1 }),
      budgetExhausted: () => false,
      sweep: () => {
        throw new Error('database bloccato');
      },
    });
    consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await consolidator.settled();
    const last = readConsolidation(db)?.last;
    expect(last?.outcome).toBe('ran');
    expect(last?.facts).toBe(1);
    expect(last?.errors).toBe(1);
  });

  it('reads a run written before the sweep column existed as zero, not as a crash', () => {
    // `doctor` opens the database readonly, so on an ADR-0038 install the
    // migration cannot have run and the column is genuinely absent. That is the
    // install a diagnosis most needs to work on.
    const db = new DatabaseCtor(':memory:');
    db.exec(`CREATE TABLE consolidation_runs (
      id INTEGER PRIMARY KEY, ran_at TEXT NOT NULL, trigger TEXT NOT NULL, outcome TEXT NOT NULL,
      episodes INTEGER NOT NULL, facts INTEGER NOT NULL, superseded INTEGER NOT NULL,
      indexed INTEGER NOT NULL, review INTEGER NOT NULL, errors INTEGER NOT NULL, ms INTEGER NOT NULL)`);
    db.prepare(
      `INSERT INTO consolidation_runs VALUES (1, '2026-08-13T18:16:00Z', 'idle', 'ran', 1, 1, 0, 3, 0, 0, 321)`,
    ).run();
    expect(readConsolidation(db)?.last.merged).toBe(0);
    db.close();
  });
});

describe('the budget', () => {
  /**
   * The mutation this kills: an unattended lane that keeps calling the model
   * past the monthly cap. Until this slice the memory lane was not even
   * *visible* to the engine — see `agent/providers/light-lane.ts`.
   */
  it('refuses to run when the month is spent, and says so durably', async () => {
    const h = harness({ exhausted: true });
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidator.settled();
    expect(h.calls).toEqual([]);
    expect(readConsolidation(h.db)?.last.outcome).toBe('budget');
    expect(h.lines.join(' ')).toContain('budget');
  });
});

describe('the run log', () => {
  it('records a run that found nothing — which is the common case', async () => {
    const h = harness({ report: empty({ episodes: 0, factsAdded: 0 }) });
    h.consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await h.consolidator.settled();
    const seen = readConsolidation(h.db);
    // Zero facts and a run that happened: without the row these are the same
    // observation as a lane that never started, which is the state this repo
    // shipped in.
    expect(seen?.last.outcome).toBe('ran');
    expect(seen?.last.facts).toBe(0);
    expect(seen?.runs).toBe(1);
  });

  it('is empty on an install where nothing has ever consolidated', () => {
    const db = new DatabaseCtor(':memory:');
    expect(readConsolidation(db)).toBeNull();
  });

  it('survives a batch that threw, and does not take the process with it', async () => {
    const db = new DatabaseCtor(':memory:');
    const consolidator = new Consolidator({
      db,
      ingest: async () => {
        throw new Error('embedder giù');
      },
      budgetExhausted: () => false,
    });
    consolidator.notify('host');
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS);
    await consolidator.settled();
    expect(readConsolidation(db)?.last.outcome).toBe('error');
  });
});

describe('stop', () => {
  it('disarms, so a shutdown cannot fire a batch against a closed database', async () => {
    const h = harness();
    h.consolidator.notify('host');
    h.consolidator.stop();
    await vi.advanceTimersByTimeAsync(CONSOLIDATION_IDLE_MS * 2);
    expect(h.calls).toEqual([]);
    // And no later turn can re-arm it either.
    h.consolidator.notify('host');
    expect(h.consolidator.isArmed()).toBe(false);
  });
});
