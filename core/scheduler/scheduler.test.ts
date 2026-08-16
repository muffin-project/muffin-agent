import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { JobStore, type Job } from './jobs.js';
import { Scheduler, type ForegroundGate, type JobOutcome, type SchedulerEvent } from './scheduler.js';
import { ModelLane } from '../turns/model-lane.js';
import { DELIVERED, notDelivered } from '../surface/types.js';

const SPEC = { cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' };
const flush = () => new Promise((r) => setImmediate(r));

/** The row a fire wrote. Stands in for a trace id; only its identity matters. */
const TURN = 'turn-0001';

const AFTER_FIRE = new Date('2026-06-15T06:00:00Z');
const BEFORE_ADD = new Date('2026-06-15T05:00:00Z');

/**
 * Store and scheduler share one clock — in production both are
 * `() => new Date()`; the test advances a single mutable one so `due` and the
 * next-fire computed by `markRan` agree.
 */
function storeWith(start = BEFORE_ADD): { store: JobStore; job: Job; clock: () => Date; set: (d: Date) => void } {
  let current = start;
  const clock = () => current;
  const db = new DatabaseCtor(':memory:');
  const store = new JobStore(db, clock);
  const job = store.add(SPEC); // fires 06:00Z (08:00 Rome CEST)
  return { store, job, clock, set: (d) => (current = d) };
}

describe('Scheduler.tick', () => {
  it('runs a due job as scheduler work, delivers, and marks it ran', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const deliver = vi.fn(async () => DELIVERED);
    const runJob = vi.fn(async (j: Job): Promise<JobOutcome> => ({ stopped: 'answered', text: `ecco il brief per ${j.id}`, turnId: TURN }));
    const sched = new Scheduler(store, runJob, deliver, undefined, () => {}, clock, undefined, undefined, new ModelLane());

    sched.tick();
    await flush();

    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob.mock.calls[0]![0].id).toBe(job.id);
    expect(deliver).toHaveBeenCalledWith('cli', `ecco il brief per ${job.id}`);
    // markRan advanced the fire past today's 08:00 → tomorrow.
    expect(store.get(job.id)!.nextFireAt.toISOString()).toBe('2026-06-16T06:00:00.000Z');
    expect(store.get(job.id)!.lastRunAt).not.toBeNull();
  });

  it('does nothing when no job is due', async () => {
    const { store, clock, set } = storeWith();
    set(new Date('2026-06-15T05:59:00Z'));
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }));
    const sched = new Scheduler(store, runJob, async () => DELIVERED, undefined, () => {}, clock, undefined, undefined, new ModelLane());
    sched.tick();
    await flush();
    expect(runJob).not.toHaveBeenCalled();
  });

  it('never runs the same job twice while it is in flight (Hermes #25517)', async () => {
    const { store, clock, set } = storeWith();
    set(AFTER_FIRE);
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const runJob = vi.fn(async (): Promise<JobOutcome> => {
      await gateOpen; // stay in flight until the test releases it
      return { stopped: 'answered', text: 'done', turnId: TURN };
    });
    const events: SchedulerEvent[] = [];
    const sched = new Scheduler(store, runJob, async () => DELIVERED, undefined, (e) => events.push(e), clock, undefined, undefined, new ModelLane());

    sched.tick(); // launches the run, stays in flight
    await flush();
    sched.tick(); // second heartbeat — must NOT launch a duplicate
    sched.tick();
    expect(runJob).toHaveBeenCalledOnce();
    expect(events.filter((e) => e.kind === 'deferred').length).toBeGreaterThanOrEqual(2);

    release();
    await flush();
    expect(sched.isRunning()).toBe(false);
  });

  it('defers to foreground: no job starts while the owner holds the lane', async () => {
    const { store, clock, set } = storeWith();
    set(AFTER_FIRE);
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }));
    const events: SchedulerEvent[] = [];
    const busy: ForegroundGate = { isActive: () => true, signal: () => undefined };
    const sched = new Scheduler(store, runJob, async () => DELIVERED, busy, (e) => events.push(e), clock, undefined, undefined, new ModelLane());

    sched.tick();
    await flush();
    expect(runJob).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: 'deferred', reason: 'foreground' });
    // The job is still due — it did not lose its slot.
    expect(store.due(AFTER_FIRE).length).toBe(1);
  });

  it('a yielded (aborted) job is neither delivered nor marked ran — it retries', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const deliver = vi.fn(async () => DELIVERED);
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'aborted', text: '', turnId: TURN }));
    const before = store.get(job.id)!.nextFireAt.toISOString();
    const sched = new Scheduler(store, runJob, deliver, undefined, () => {}, clock, undefined, undefined, new ModelLane());

    sched.tick();
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.get(job.id)!.nextFireAt.toISOString()).toBe(before); // unchanged → still due
    expect(store.get(job.id)!.lastRunAt).toBeNull();
  });

  it('an ASK queued for the owner is delivered as the outcome and the job is marked ran', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const deliver = vi.fn(async () => DELIVERED);
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'ask', text: 'serve la tua conferma per X', turnId: TURN }));
    const sched = new Scheduler(store, runJob, deliver, undefined, () => {}, clock, undefined, undefined, new ModelLane());

    sched.tick();
    await flush();
    expect(deliver).toHaveBeenCalledWith('cli', 'serve la tua conferma per X');
    expect(store.get(job.id)!.lastRunAt).not.toBeNull();
  });

  it('a delivery failure still marks the job ran — it must not double the work', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const deliver = vi.fn(async () => notDelivered('canale giù'));
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }));
    const events: SchedulerEvent[] = [];
    const sched = new Scheduler(store, runJob, deliver, undefined, (e) => events.push(e), clock, undefined, undefined, new ModelLane());

    sched.tick();
    await flush();
    expect(store.get(job.id)!.lastRunAt).not.toBeNull(); // marked despite the failure
    expect(events.some((e) => e.kind === 'delivery_failed')).toBe(true);
  });

  /**
   * M5-BIS B8 — «un job che dice "inviato" è arrivato?».
   *
   * The defect these three guard is not that delivery could fail. It is that a
   * `Deliver` returning `Promise<void>` had no way to *say so*, so the one
   * implementation that printed to stderr and returned
   * (`cli/gateway.ts`'s `gatewayDeliver`, deleted in this slice) was
   * indistinguishable from one that sent a message: `markRan` advanced the
   * schedule, `stopped` said `answered`, and nothing recorded that the owner
   * never got it.
   */
  describe('a delivery that did not happen cannot read as success', () => {
    it('writes failed:<why> onto the turn row, not just an stderr line', async () => {
      const { store, clock, set } = storeWith();
      set(AFTER_FIRE);
      const recorded: [string, string][] = [];
      const sched = new Scheduler(
        store,
        async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'il brief', turnId: TURN }),
        async () => notDelivered('nessuna superficie serve "telegram"'),
        undefined,
        () => {},
        clock,
        undefined,
        (turnId, state) => recorded.push([turnId, state]),
        new ModelLane(),
      );

      sched.tick();
      await flush();

      // The durable half. Before this slice the turn row said `delivery = NULL`
      // — "this surface delivers in band, there is no step that can fail" —
      // which was the assertion that made the failure invisible.
      expect(recorded).toEqual([[TURN, 'failed:nessuna superficie serve "telegram"']]);
    });

    it('records the delivery before advancing the schedule', async () => {
      // Ordering, not decoration: a crash between the two must leave a fire that
      // has not moved rather than a delivery nobody recorded.
      const { store, job, clock, set } = storeWith();
      set(AFTER_FIRE);
      const order: string[] = [];
      const sched = new Scheduler(
        store,
        async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }),
        async () => DELIVERED,
        undefined,
        (e) => {
          if (e.kind === 'ran') order.push('markRan');
        },
        clock,
        undefined,
        () => order.push('recordDelivery'),
        new ModelLane(),
      );

      sched.tick();
      await flush();

      expect(order).toEqual(['recordDelivery', 'markRan']);
      expect(store.get(job.id)!.lastRunAt).not.toBeNull();
    });

    it('carries the delivery on the ran event, so an observer cannot report half the outcome', async () => {
      const { store, clock, set } = storeWith();
      set(AFTER_FIRE);
      const events: SchedulerEvent[] = [];
      const sched = new Scheduler(
        store,
        async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }),
        async () => notDelivered('token scaduto'),
        undefined,
        (e) => events.push(e),
        clock,
        undefined,
        undefined,
        new ModelLane(),
      );

      sched.tick();
      await flush();

      const ran = events.find((e) => e.kind === 'ran');
      // `stopped: 'answered'` and `delivered: false` are both true at once, and
      // that pair is the honest description of the fire.
      expect(ran).toMatchObject({ kind: 'ran', stopped: 'answered', delivered: false });
    });

    it('a bookkeeping write that throws does not take the fire down with it', async () => {
      // The precedent is literal: this class already crashed the gateway once
      // through a write against a closed database, from a floating promise.
      const { store, job, clock, set } = storeWith();
      set(AFTER_FIRE);
      const events: SchedulerEvent[] = [];
      const sched = new Scheduler(
        store,
        async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }),
        async () => DELIVERED,
        undefined,
        (e) => events.push(e),
        clock,
        undefined,
        () => {
          throw new Error('The database connection is not open');
        },
        new ModelLane(),
      );

      sched.tick();
      await flush();

      expect(events.some((e) => e.kind === 'not_recorded')).toBe(true);
      expect(store.get(job.id)!.lastRunAt).not.toBeNull(); // the fire still completed
    });

    it('settles nothing when the run produced no turn row', async () => {
      // A runner that threw before `runTurn` wrote the row has nothing to
      // settle, and inventing a turn id would put a plausible lie in the table.
      const { store, clock, set } = storeWith();
      set(AFTER_FIRE);
      const recorded: string[] = [];
      const sched = new Scheduler(
        store,
        async (): Promise<JobOutcome> => {
          throw new Error('il provider non risponde');
        },
        async () => notDelivered('irrilevante'),
        undefined,
        () => {},
        clock,
        undefined,
        (turnId) => recorded.push(turnId),
        new ModelLane(),
      );

      sched.tick();
      await flush();

      expect(recorded).toEqual([]);
    });
  });
});
