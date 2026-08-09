import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime, type Runtime } from '../../agent/runtime.js';
import { Scheduler, type JobOutcome } from '../../core/scheduler/scheduler.js';

/**
 * The scheduler, driven through the runtime's OWN job store — the production
 * assembly, not a hand-built one. The Scheduler mechanics and the RunJob
 * mapping each have their own tests; this proves buildRuntime actually exposes
 * a JobStore a Scheduler can run, on the same connection as everything else
 * (ADR-0022). Model-free: a fake runner stands in for runTurn so the property
 * under test is the wiring, not a live turn.
 */
describe('scheduler acceptance — the runtime job store is real and drivable', () => {
  const home = mkdtempSync(join(tmpdir(), 'muffin-sched-accept-'));
  runInit({ home, apiKey: 'sk-not-used' });
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-sched-ws-'));
  let runtime: Runtime;

  afterAll(() => runtime?.close());

  it('a job added to runtime.jobs is found due and run to delivery', async () => {
    runtime = buildRuntime(home, workspace);

    // A job whose fire time is already in the past (fires immediately).
    const job = runtime.jobs.add({ cron: '* * * * *', timezone: 'Europe/Rome', goal: 'brief', channel: 'cli' });
    expect(runtime.jobs.list().map((j) => j.id)).toEqual([job.id]);

    const delivered: Array<[string, string]> = [];
    const runJob = vi.fn(async (): Promise<JobOutcome> => ({ stopped: 'answered', text: 'ecco il brief' }));
    const sched = new Scheduler(runtime.jobs, runJob, async (ch, text) => {
      delivered.push([ch, text]);
    });

    // Fire time for '* * * * *' from now is within a minute; drive due directly.
    sched.tick(new Date(job.nextFireAt.getTime() + 1000));
    await new Promise((r) => setImmediate(r));

    expect(runJob).toHaveBeenCalledOnce();
    expect(delivered).toEqual([['cli', 'ecco il brief']]);
    expect(runtime.jobs.get(job.id)!.lastRunAt).not.toBeNull();
  });
});
