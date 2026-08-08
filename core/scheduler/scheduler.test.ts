import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { JobStore, type Job } from './jobs.js';
import { Scheduler, type ForegroundGate, type JobOutcome, type SchedulerEvent } from './scheduler.js';

const SPEC = { cron: '0 8 * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' };
const flush = () => new Promise((r) => setImmediate(r));

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
    const deliver = vi.fn(async () => {});
    const runJob = vi.fn(async (j: Job): Promise<JobOutcome> => ({ stopped: 'answered', text: `ecco il brief per ${j.id}` }));
    const sched = new Scheduler(store, runJob, deliver, undefined, () => {}, clock);

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
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x' }));
    const sched = new Scheduler(store, runJob, async () => {}, undefined, () => {}, clock);
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
      return { stopped: 'answered', text: 'done' };
    });
    const events: SchedulerEvent[] = [];
    const sched = new Scheduler(store, runJob, async () => {}, undefined, (e) => events.push(e), clock);

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
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x' }));
    const events: SchedulerEvent[] = [];
    const busy: ForegroundGate = { isActive: () => true, signal: () => undefined };
    const sched = new Scheduler(store, runJob, async () => {}, busy, (e) => events.push(e), clock);

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
    const deliver = vi.fn(async () => {});
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'aborted', text: '' }));
    const before = store.get(job.id)!.nextFireAt.toISOString();
    const sched = new Scheduler(store, runJob, deliver, undefined, () => {}, clock);

    sched.tick();
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.get(job.id)!.nextFireAt.toISOString()).toBe(before); // unchanged → still due
    expect(store.get(job.id)!.lastRunAt).toBeNull();
  });

  it('an ASK queued for the owner is delivered as the outcome and the job is marked ran', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const deliver = vi.fn(async () => {});
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'ask', text: 'serve la tua conferma per X' }));
    const sched = new Scheduler(store, runJob, deliver, undefined, () => {}, clock);

    sched.tick();
    await flush();
    expect(deliver).toHaveBeenCalledWith('cli', 'serve la tua conferma per X');
    expect(store.get(job.id)!.lastRunAt).not.toBeNull();
  });

  it('a delivery failure still marks the job ran — it must not double the work', async () => {
    const { store, job, clock, set } = storeWith();
    set(AFTER_FIRE);
    const deliver = vi.fn(async () => {
      throw new Error('canale giù');
    });
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'x' }));
    const events: SchedulerEvent[] = [];
    const sched = new Scheduler(store, runJob, deliver, undefined, (e) => events.push(e), clock);

    sched.tick();
    await flush();
    expect(store.get(job.id)!.lastRunAt).not.toBeNull(); // marked despite the failure
    expect(events.some((e) => e.kind === 'delivery_failed')).toBe(true);
  });
});
