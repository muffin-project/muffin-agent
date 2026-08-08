import DatabaseCtor from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, paths } from '../core/config/config.js';
import { JobError, JobStore, type Job } from '../core/scheduler/jobs.js';

/**
 * `muffin jobs` — the operator surface over scheduled work.
 *
 * Opens the database directly rather than through buildRuntime: listing or
 * removing a job has no reason to need the model provider or the whole runtime,
 * and `jobs list` must work on a home whose API key is absent. `add` here takes
 * an explicit cron — the natural-language path ("ogni mattina alle 8") is a
 * loop tool that turns the phrase into this cron after confirming it with the
 * owner, and lands on the same store.
 */

export const JOBS_USAGE = `usage:
  muffin jobs list
  muffin jobs add --cron "<expr>" [--tz <IANA>] [--channel <surface>] "<goal>"
  muffin jobs remove <id>
`;

function openStore(home: string): { store: JobStore; db: DatabaseCtor.Database } {
  const db = new DatabaseCtor(paths(home).db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return { store: new JobStore(db), db };
}

/** The owner's timezone lives in the root of trust, so "8am" means their 8am. */
function ownerTimezone(home: string): string {
  const file = join(paths(home).rot, 'budgets.json');
  if (existsSync(file)) {
    try {
      const tz = (JSON.parse(readFileSync(file, 'utf8')) as { quietHours?: { timezone?: string } }).quietHours?.timezone;
      if (typeof tz === 'string' && tz.length > 0) return tz;
    } catch {
      // fall through to UTC — a broken RoT is doctor's problem, not jobs'
    }
  }
  return 'UTC';
}

function fmt(job: Job): string {
  const next = job.nextFireAt.toLocaleString('it-IT', { timeZone: job.timezone, dateStyle: 'short', timeStyle: 'short' });
  return `${job.id.slice(0, 8)}  ${job.cron.padEnd(14)} ${job.timezone.padEnd(16)} →${job.channel.padEnd(9)} prossima ${next}\n            ${job.goal}`;
}

export function cmdJobsList(home: string): number {
  const { store, db } = openStore(home);
  try {
    const jobs = store.list();
    if (jobs.length === 0) {
      process.stdout.write('nessun job schedulato. `muffin jobs add` per crearne uno.\n');
      return 0;
    }
    process.stdout.write(jobs.map(fmt).join('\n') + '\n');
    return 0;
  } finally {
    db.close();
  }
}

export function cmdJobsAdd(home: string, argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cron: { type: 'string' },
      tz: { type: 'string' },
      channel: { type: 'string' },
    },
  });
  const goal = positionals.join(' ').trim();
  if (!values.cron || goal === '') {
    process.stderr.write(JOBS_USAGE);
    return 78;
  }
  const config = loadConfig(home);
  const { store, db } = openStore(home);
  try {
    const job = store.add({
      cron: values.cron,
      timezone: values.tz ?? ownerTimezone(home),
      channel: values.channel ?? config.surfaces.default,
      goal,
    });
    const next = job.nextFireAt.toLocaleString('it-IT', { timeZone: job.timezone, dateStyle: 'short', timeStyle: 'short' });
    process.stdout.write(`job ${job.id.slice(0, 8)} creato — prossima esecuzione ${next} (${job.timezone}) su ${job.channel}\n`);
    return 0;
  } catch (error) {
    if (error instanceof JobError) {
      process.stderr.write(`${error.message}\n`);
      return 78;
    }
    throw error;
  } finally {
    db.close();
  }
}

export function cmdJobsRemove(home: string, id: string): number {
  const { store, db } = openStore(home);
  try {
    // Accept a short prefix, since that is what `list` prints.
    const match = store.list().find((j) => j.id === id || j.id.startsWith(id));
    if (!match) {
      process.stderr.write(`nessun job attivo con id "${id}"\n`);
      return 1;
    }
    store.disable(match.id);
    process.stdout.write(`job ${match.id.slice(0, 8)} rimosso (non spara più; la riga resta).\n`);
    return 0;
  } finally {
    db.close();
  }
}
