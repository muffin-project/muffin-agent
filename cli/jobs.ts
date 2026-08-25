import DatabaseCtor from 'better-sqlite3';
import { parseArgs } from 'node:util';
import { loadConfig, paths } from '../core/config/config.js';
import { loadSealedBudgets } from '../core/rot/budgets.js';
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
  muffin jobs add --cron "<expr>" [--tz <IANA>] [--channel <surface>] "<obiettivo>"
  muffin jobs add --cron "<expr>" --script "<comando>" [--tz] [--channel]
                                un comando nella sandbox, senza chiamare il
                                modello: costa zero token, e parla solo quando
                                ha qualcosa da dire (stdout vuoto = silenzio)
  muffin jobs remove <id>
`;

function openStore(home: string): { store: JobStore; db: DatabaseCtor.Database } {
  const db = new DatabaseCtor(paths(home).db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return { store: new JobStore(db), db };
}

/**
 * The owner's timezone lives in the root of trust, so "8am" means their 8am.
 * Through the one loader (`core/rot/budgets.ts`) rather than a third hand-rolled
 * parse of the same file: this one used to accept `{quietHours:{timezone:1}}`
 * shapes the observe path rejected, so the same sealed file meant two things
 * depending on who opened it. A broken RoT is still doctor's problem, not jobs' —
 * the fallback is UTC either way.
 */
function ownerTimezone(home: string): string {
  return loadSealedBudgets(home).quietHours.timezone;
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
      script: { type: 'string' },
    },
  });
  const goal = positionals.join(' ').trim();
  const script = values.script?.trim() ?? '';
  if (!values.cron || (goal === '' && script === '')) {
    process.stderr.write(JOBS_USAGE);
    return 78;
  }
  // I due non si mescolano. Un obiettivo passato accanto a `--script` sarebbe
  // ambiguo proprio dove l'ambiguità costa: uno dei due finirebbe in una shell
  // o davanti a un modello senza che nessuno abbia deciso quale.
  if (script !== '' && goal !== '') {
    process.stderr.write(`--script e un obiettivo sono due job diversi: passane uno solo\n`);
    return 78;
  }
  const config = loadConfig(home);
  const { store, db } = openStore(home);
  try {
    const comune = {
      cron: values.cron,
      timezone: values.tz ?? ownerTimezone(home),
      channel: values.channel ?? config.surfaces.default,
    };
    const job = store.add(script !== '' ? { ...comune, kind: 'script' as const, script } : { ...comune, goal });
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
