import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { paths } from '../core/config/config.js';
import { JobStore } from '../core/scheduler/jobs.js';
import { cmdJobsAdd, cmdJobsList, cmdJobsRemove } from './jobs.js';

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-jobs-cli-'));
  runInit({ home, apiKey: 'sk-not-used' });
  return home;
}

function activeJobs(home: string) {
  const db = new DatabaseCtor(paths(home).db);
  try {
    return new JobStore(db).list();
  } finally {
    db.close();
  }
}

describe('muffin jobs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('add validates and persists; list and remove round-trip through exit codes', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(cmdJobsList(home)).toBe(0); // empty is fine
    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *', '--tz', 'Europe/Rome', 'brief della giornata'])).toBe(0);

    const jobs = activeJobs(home);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.goal).toBe('brief della giornata');
    expect(jobs[0]!.timezone).toBe('Europe/Rome');

    // remove by the short prefix that list prints
    const prefix = jobs[0]!.id.slice(0, 8);
    expect(cmdJobsRemove(home, prefix)).toBe(0);
    expect(activeJobs(home)).toEqual([]);
    // removing again finds nothing active
    expect(cmdJobsRemove(home, prefix)).toBe(1);
  });

  it('a malformed cron is rejected with exit 78 and writes nothing', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(cmdJobsAdd(home, ['--cron', 'not a cron', 'goal'])).toBe(78);
    expect(activeJobs(home)).toEqual([]);
  });

  it('add without a cron or goal shows usage (78)', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *'])).toBe(78); // no goal
    expect(cmdJobsAdd(home, ['just a goal'])).toBe(78); // no cron
    expect(activeJobs(home)).toEqual([]);
  });

  it('defaults the timezone to the owner zone in the root of trust', () => {
    const home = bootHome();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // no --tz: falls back to budgets.json quietHours.timezone (Europe/Rome default)
    expect(cmdJobsAdd(home, ['--cron', '0 8 * * *', 'brief'])).toBe(0);
    expect(activeJobs(home)[0]!.timezone).toBe('Europe/Rome');
  });
});
