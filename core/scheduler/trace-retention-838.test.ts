import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlExporter } from '../tracing/tracer.js';
import { Scheduler, type ForegroundGate, type JobOutcome, type SchedulerEvent } from './scheduler.js';
import { makeTraceRetentionTick } from './trace-retention.js';
import { ModelLane } from '../turns/model-lane.js';
import { DELIVERED } from '../surface/types.js';
import { JobStore } from './jobs.js';

/**
 * #838 — the tick fires the proven prune on the real path.
 *
 * `JsonlExporter.pruneOlderThan` was already proven against a populated
 * `traces/` dir, but its only production caller was the boot
 * (`agent/runtime.ts`). A process that lives for weeks without restarting —
 * the gateway under launchd/systemd, the REPL's own ticker — never pruned.
 *
 * What this proves is the wiring, not the mechanism: the retention adapter is
 * built the way `cli/gateway.ts` and `cli/repl.ts` build it
 * (`makeTraceRetentionTick`), handed to a real `Scheduler` as
 * `traceRetention`, and the test only ever calls `sched.tick(now)` — never
 * `pruneOlderThan` directly. If the tick stops calling the pass (delete the
 * `this.traceRetention?.tick(now)` line in `scheduler.ts`), the first test
 * goes red with the expired files still on disk.
 */
describe('trace retention on the scheduler tick (#838)', () => {
  // A Saturday noon, fixed so the boundary is a date, not a moving target.
  const NOW = new Date('2026-09-20T12:00:00.000Z');
  const RETENTION_DAYS = 90;
  // cutoff = 2026-06-22: strictly older days go, the cutoff day itself stays
  // (`day < cutoff` in the implementation — same policy as the boot caller).
  const EXPIRED = ['2026-03-01.jsonl', '2026-06-21.jsonl'];
  const KEPT = ['2026-06-22.jsonl', '2026-09-19.jsonl', '2026-09-20.jsonl'];
  const JUNK = ['README.md', '2026-6-2.jsonl'];

  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  /** A home that has lived for months: expired days, the boundary, fresh days, junk. */
  function populatedHome(): { home: string; traces: string } {
    const home = mkdtempSync(join(tmpdir(), '.muffin-838-retention-'));
    homes.push(home);
    // The production constructor — it owns the private-dir work, same as boot.
    const exporter = new JsonlExporter(home);
    void exporter;
    const traces = join(home, 'traces');
    for (const file of [...EXPIRED, ...KEPT]) {
      writeFileSync(join(traces, file), `{"day":${JSON.stringify(file)}}\n`);
    }
    for (const file of JUNK) {
      writeFileSync(join(traces, file), 'not a day file\n');
    }
    return { home, traces };
  }

  function idleScheduler(home: string, gate?: ForegroundGate): { sched: Scheduler; runJob: ReturnType<typeof vi.fn> } {
    const db = new DatabaseCtor(':memory:');
    const store = new JobStore(db, () => NOW);
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: null }));
    const sched = new Scheduler(
      store,
      runJob,
      async () => DELIVERED,
      gate,
      () => {},
      () => NOW,
      undefined, // standDown: this process owns the store
      undefined, // recordDelivery
      new ModelLane(),
      undefined, // stillOwner: default, always true
      undefined, // settleFire
      undefined, // paused
      undefined, // commitments
      // The production wiring, built the way cli/gateway.ts builds it.
      makeTraceRetentionTick(home, RETENTION_DAYS),
    );
    return { sched, runJob };
  }

  it('an idle tick prunes exactly the expired days — no restart, no direct prune call', () => {
    const { home, traces } = populatedHome();
    const { sched, runJob } = idleScheduler(home);

    // No job is due on this store: the tick below is pure hygiene. With only
    // the boot caller in production, this tick pruned nothing.
    sched.tick(NOW);

    expect(runJob).not.toHaveBeenCalled();
    const remaining = readdirSync(traces).sort();
    expect(remaining).toEqual([...KEPT, ...JUNK].sort());
  });

  it('prunes before the lane arbitration: an active foreground still gets hygiene, jobs still defer', () => {
    const { home, traces } = populatedHome();
    const events: SchedulerEvent[] = [];
    const db = new DatabaseCtor(':memory:');
    const store = new JobStore(db, () => NOW);
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: null }));
    const busy: ForegroundGate = { isActive: () => true, signal: () => undefined };
    const sched = new Scheduler(
      store,
      runJob,
      async () => DELIVERED,
      busy,
      (e) => events.push(e),
      () => NOW,
      undefined,
      undefined,
      new ModelLane(),
      undefined,
      undefined,
      undefined,
      undefined,
      makeTraceRetentionTick(home, RETENTION_DAYS),
    );

    sched.tick(NOW);

    expect(runJob).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: 'deferred', reason: 'foreground' });
    expect(readdirSync(traces).sort()).toEqual([...KEPT, ...JUNK].sort());
  });

  it('a prune failure never fails the tick: jobs still run on the same beat', async () => {
    const { home } = populatedHome();
    // The traces dir vanishes after the adapter captured it — the prune throws,
    // the tick must not.
    rmSync(join(home, 'traces'), { recursive: true, force: true });
    const db = new DatabaseCtor(':memory:');
    const clock = () => NOW;
    const store = new JobStore(db, clock);
    store.add({ cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'brief', turnId: null }));
    const sched = new Scheduler(
      store,
      runJob,
      async () => DELIVERED,
      undefined,
      () => {},
      clock,
      undefined,
      undefined,
      new ModelLane(),
      undefined,
      undefined,
      undefined,
      undefined,
      makeTraceRetentionTick(home, RETENTION_DAYS),
    );

    expect(() => sched.tick(new Date('2026-09-21T06:00:00.000Z'))).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(runJob).toHaveBeenCalledOnce();
  });

  it('a stood-down tick prunes nothing — one pruner, the owner', () => {
    const { home, traces } = populatedHome();
    const db = new DatabaseCtor(':memory:');
    const store = new JobStore(db, () => NOW);
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: null }));
    const sched = new Scheduler(
      store,
      runJob,
      async () => DELIVERED,
      undefined,
      () => {},
      () => NOW,
      () => true, // another process owns the store
      undefined,
      new ModelLane(),
      undefined,
      undefined,
      undefined,
      undefined,
      makeTraceRetentionTick(home, RETENTION_DAYS),
    );

    sched.tick(NOW);

    expect(readdirSync(traces).sort()).toEqual([...EXPIRED, ...KEPT, ...JUNK].sort());
  });
});
