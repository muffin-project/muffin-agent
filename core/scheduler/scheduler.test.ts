import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { JobStore, type Job } from './jobs.js';
import {
  Scheduler,
  type FireDeferred,
  type FireSettleOnly,
  type ForegroundGate,
  type JobOutcome,
  type SchedulerEvent,
} from './scheduler.js';
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

  describe('stillOwner — P20: this gateway re-verifies its own claim, not just whether some other one exists', () => {
    it('does not start a due job when the claim is already gone — the tick-start check', async () => {
      const { store, clock, set } = storeWith();
      set(AFTER_FIRE);
      const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }));
      const events: SchedulerEvent[] = [];
      const sched = new Scheduler(
        store, runJob, async () => DELIVERED, undefined, (e) => events.push(e), clock, undefined, undefined,
        new ModelLane(),
        () => false, // a second gateway already holds the real claim
      );

      sched.tick();
      await flush();
      expect(runJob).not.toHaveBeenCalled();
      expect(events).toContainEqual({ kind: 'deferred', reason: 'handover' });
      // Not consumed — the winner's own tick will pick it up.
      expect(store.due(AFTER_FIRE).length).toBe(1);
    });

    it('does not deliver a job whose claim was taken over while it was in flight — the pre-delivery check', async () => {
      // The exact race P20 names: `Gateway.tick` beats once (stillOwner still
      // true at that instant), the job's run takes seconds to minutes, and a
      // second gateway wins the claim before this run finishes.
      const { store, job, clock, set } = storeWith();
      set(AFTER_FIRE);
      let stillOwn = true;
      let release!: () => void;
      const gateOpen = new Promise<void>((r) => (release = r));
      const runJob = vi.fn(async (): Promise<JobOutcome> => {
        await gateOpen;
        return { stopped: 'answered', text: 'done', turnId: TURN };
      });
      const deliver = vi.fn(async () => DELIVERED);
      const events: SchedulerEvent[] = [];
      const sched = new Scheduler(
        store, runJob, deliver, undefined, (e) => events.push(e), clock, undefined, undefined,
        new ModelLane(),
        () => stillOwn,
      );

      sched.tick(); // stillOwner is true here — the run starts
      await flush();
      stillOwn = false; // a second gateway wins the claim mid-run
      release();
      await flush();

      expect(deliver).not.toHaveBeenCalled();
      expect(events.some((e) => e.kind === 'yielded')).toBe(true);
      // markRan did not run either — the fire is still due for the new owner.
      expect(store.get(job.id)!.lastRunAt).toBeNull();
    });

    /**
     * ADR-0060 §Limiti noti, item 2 — closed here (2026-09-04).
     *
     * Before this fix `stillOwner` was consulted only right before a job
     * *starts* — reachable exclusively through the `store.due(now)` branch
     * below it — so a tick with no due job (the common case: the beat is
     * 30 seconds, most beats find nothing) ran `commitments.tick` with no
     * ownership check at all, ever. A gateway that had just lost its claim
     * kept trying to speak dated commitments on every single beat.
     *
     * No job is added to the store here on purpose: this must fail even
     * when the job lane has nothing to do, which is exactly the gap the
     * old ordering left open.
     */
    it('does not run the commitments lane either, when the claim is already gone — even with no job due', async () => {
      const db = new DatabaseCtor(':memory:');
      const store = new JobStore(db); // no job added: due() is always empty
      const events: SchedulerEvent[] = [];
      const commitments = { tick: vi.fn() };
      const sched = new Scheduler(
        store, async () => ({ stopped: 'answered', text: 'x', turnId: TURN }), async () => DELIVERED, undefined,
        (e) => events.push(e), () => new Date(), undefined, undefined,
        new ModelLane(),
        () => false, // the claim is already someone else's
        undefined,
        undefined,
        commitments,
      );

      sched.tick();
      await flush();

      expect(commitments.tick).not.toHaveBeenCalled();
      expect(events).toContainEqual({ kind: 'deferred', reason: 'handover' });
    });

    it('DOES run the commitments lane when this process still owns the claim, even with no job due', async () => {
      const db = new DatabaseCtor(':memory:');
      const store = new JobStore(db);
      const commitments = { tick: vi.fn() };
      const sched = new Scheduler(
        store, async () => ({ stopped: 'answered', text: 'x', turnId: TURN }), async () => DELIVERED, undefined,
        () => {}, () => new Date(), undefined, undefined,
        new ModelLane(),
        () => true,
        undefined,
        undefined,
        commitments,
      );

      sched.tick();
      await flush();

      expect(commitments.tick).toHaveBeenCalledOnce();
    });
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
   * DAY-1 requirement B8 — «un job che dice "inviato" è arrivato?».
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
      //
      // Spied directly on `store.markRan`, not inferred from the `'ran'` event:
      // that event fires *after* every write `settle` makes, so tracking it via
      // `onEvent` proves `recordDelivery` ran before the event, never that it
      // ran before `markRan` specifically — a swap of the two lines inside
      // `settle` would have left this passing. Found while mutation-testing the
      // equivalent B7 ordering claim below, which copied this file's own
      // pattern and inherited the same gap.
      const { store, job, clock, set } = storeWith();
      set(AFTER_FIRE);
      const order: string[] = [];
      const originalMarkRan = store.markRan.bind(store);
      vi.spyOn(store, 'markRan').mockImplementation((id) => {
        order.push('markRan');
        return originalMarkRan(id);
      });
      const sched = new Scheduler(
        store,
        async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }),
        async () => DELIVERED,
        undefined,
        () => {},
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

/**
 * B7 — `job_fires`. `runJob` can now hand back `FireDeferred`/`FireSettleOnly`
 * instead of a `JobOutcome`; these prove `Scheduler` reacts to each correctly
 * without ever needing a real `job_fires` row — that identity resolution is
 * `agent/scheduler-run.ts`'s job and is proved against it directly
 * (`agent/scheduler-run.test.ts`). This file proves what `Scheduler` does
 * with each of the three shapes it can now receive.
 */
describe('Scheduler.tick — B7 sentinels', () => {
  it('a deferred outcome touches nothing: no deliver, no settleFire, no markRan — the job stays due', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const deliver = vi.fn(async () => DELIVERED);
    const runJob = vi.fn(async (): Promise<FireDeferred> => ({ deferred: true }));
    const events: SchedulerEvent[] = [];
    const settled: string[] = [];
    const sched = new Scheduler(
      store,
      runJob,
      deliver,
      undefined,
      (e) => events.push(e),
      clock,
      undefined,
      undefined,
      new ModelLane(),
      undefined,
      (j) => settled.push(j.id),
    );

    sched.tick();
    await flush();

    expect(deliver).not.toHaveBeenCalled();
    expect(settled).toEqual([]);
    expect(store.get(job.id)!.lastRunAt).toBeNull();
    expect(events).toContainEqual({ kind: 'deferred', reason: 'bound_turn_pending' });
    // Not consumed — the fire is still due, exactly where the turn lane's own
    // machinery (or the next tick's job_fires check) will find it again.
    expect(store.due(AFTER_FIRE).length).toBe(1);
  });

  it('a settleOnly outcome settles the fire and marks the job ran, without ever calling deliver', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const deliver = vi.fn(async () => DELIVERED);
    const runJob = vi.fn(
      async (): Promise<FireSettleOnly> => ({ settleOnly: true, turnId: TURN, outcome: 'answered', delivered: true }),
    );
    const events: SchedulerEvent[] = [];
    const settled: string[] = [];
    const sched = new Scheduler(
      store,
      runJob,
      deliver,
      undefined,
      (e) => events.push(e),
      clock,
      undefined,
      undefined,
      new ModelLane(),
      undefined,
      (j) => settled.push(j.id),
    );

    sched.tick();
    await flush();

    // The whole point: text already went out (or definitively did not)
    // through some other path, so a second call to `deliver` here would send
    // it again.
    expect(deliver).not.toHaveBeenCalled();
    expect(settled).toEqual([job.id]);
    expect(store.get(job.id)!.lastRunAt).not.toBeNull();
    const ran = events.find((e) => e.kind === 'ran');
    expect(ran).toMatchObject({ kind: 'ran', stopped: 'answered', delivered: true });
  });

  it('a settleOnly outcome carries delivered:false through to the event when the other mechanism could not deliver', async () => {
    const { store, clock, set } = storeWith();
    set(AFTER_FIRE);
    const runJob = vi.fn(
      async (): Promise<FireSettleOnly> => ({ settleOnly: true, turnId: TURN, outcome: 'answered', delivered: false }),
    );
    const events: SchedulerEvent[] = [];
    const sched = new Scheduler(
      store,
      runJob,
      async () => DELIVERED,
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
    expect(ran).toMatchObject({ kind: 'ran', stopped: 'answered', delivered: false });
  });

  /**
   * Fault point 7, "solo dopo il settlement avanza la schedule" — proved as an
   * ordering, and spied directly on `store.markRan` rather than inferred from
   * the `'ran'` event (see the comment on `records the delivery before
   * advancing the schedule`, above, for why that indirection does not
   * actually pin the order).
   *
   * Mutated by hand while writing this slice (not left in the tree): swapping
   * `this.settleFire(job)` and `this.store.markRan(job.id)` in `settle` turns
   * this test red — `order` comes back `['markRan', 'settleFire:…']` —
   * confirming the assertion is load-bearing on the real ordering.
   */
  it('settleFire runs before markRan on the normal delivered path', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const order: string[] = [];
    const originalMarkRan = store.markRan.bind(store);
    vi.spyOn(store, 'markRan').mockImplementation((id) => {
      order.push('markRan');
      return originalMarkRan(id);
    });
    const sched = new Scheduler(
      store,
      async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }),
      async () => DELIVERED,
      undefined,
      () => {},
      clock,
      undefined,
      undefined,
      new ModelLane(),
      undefined,
      (j) => order.push(`settleFire:${j.id}`),
    );

    sched.tick();
    await flush();

    expect(order).toEqual([`settleFire:${job.id}`, 'markRan']);
  });

  /**
   * Same ordering, the suspended path — its own call site in `run`, not
   * `settle`, so it needs its own proof. Mutated the same way: swapping the
   * two lines in the suspended branch turns this test red too.
   */
  it('settleFire runs before markRan on the suspended path', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const order: string[] = [];
    const originalMarkRan = store.markRan.bind(store);
    vi.spyOn(store, 'markRan').mockImplementation((id) => {
      order.push('markRan');
      return originalMarkRan(id);
    });
    const sched = new Scheduler(
      store,
      async (): Promise<JobOutcome> => ({ stopped: 'suspended', text: 'aspetto un evento', turnId: TURN }),
      async () => DELIVERED,
      undefined,
      () => {},
      clock,
      undefined,
      undefined,
      new ModelLane(),
      undefined,
      () => order.push('settleFire'),
    );

    sched.tick();
    await flush();

    expect(order).toEqual(['settleFire', 'markRan']);
    expect(store.get(job.id)!.lastRunAt).not.toBeNull();
  });

  it('settleFire defaults to a no-op — every pre-existing construction site behaves exactly as before B7', async () => {
    // No eleventh argument at all, matching every call site in this file
    // above and in production before B7. If the default were anything other
    // than a true no-op, one of the 14 pre-existing tests in this file would
    // already have failed.
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const sched = new Scheduler(
      store,
      async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x', turnId: TURN }),
      async () => DELIVERED,
      undefined,
      () => {},
      clock,
      undefined,
      undefined,
      new ModelLane(),
    );

    sched.tick();
    await flush();

    expect(store.get(job.id)!.lastRunAt).not.toBeNull();
  });
});
