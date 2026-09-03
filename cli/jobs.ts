import DatabaseCtor from 'better-sqlite3';
import { parseArgs } from 'node:util';
import { loadConfig, paths } from '../core/config/config.js';
import { loadSealedBudgets } from '../core/rot/budgets.js';
import { JobError, JobStore, type Job, jobPayload } from '../core/scheduler/jobs.js';

/**
 * `muffin jobs` — the operator surface over scheduled work.
 *
 * Opens the database directly rather than through buildRuntime: listing or
 * removing a job has no reason to need the model provider or the whole runtime,
 * and `jobs list` must work on a home whose API key is absent.
 *
 * ## `add` takes an explicit cron, and this is the only door that creates a job
 *
 * These lines used to claim, in the present indicative, that *"the
 * natural-language path ('ogni mattina alle 8') is a loop tool that turns the
 * phrase into this cron after confirming it with the owner, and lands on the
 * same store"*. **No such tool has ever existed.** `agent/tools/` has never
 * contained a `jobs` tool, and `JobStore.add` has exactly one caller outside
 * tests and evals — the `add` in this file, typed by the owner at a terminal
 * (`docs/evidence/fuori-dal-turno-2026-09-03.md` §1). The sentence described a
 * door that was never built, in a file whose job is to say where the doors are.
 *
 * Whether the model should get that door is an open owner decision («Bivio
 * owner n. 2»), and the research note argues it is the wrong next step as it
 * stands: a job today fires with a system principal at a literal `taint: 0`
 * (`agent/scheduler-run.ts`), so a job created by a turn would hand a later,
 * unattended turn a clean provenance the writing turn never had. ADR-0060 took
 * the other road for the capability that was actually wanted — a dated
 * commitment on `todos`, whose row carries the writing turn's tier into
 * `decideProactive` — and left this one closed. If it is ever opened, the first
 * change is that `taint: 0` becoming a value read from the row.
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
  // `jobPayload`, non `job.goal`: per un job `script` quel campo è undefined
  // per costruzione, e la lista stampava «undefined» — trovato lanciando il
  // binario vero, non dai test, che creavano job senza mai elencarli.
  //
  // E il tipo è mostrato: uno script gira senza modello e senza che nessuno
  // guardi, quindi «cosa farà domattina alle 8» deve essere leggibile da
  // questa riga, non deducibile.
  const che = job.kind === 'script' ? '$ ' : '';
  return `${job.id.slice(0, 8)}  ${job.cron.padEnd(14)} ${job.timezone.padEnd(16)} →${job.channel.padEnd(9)} prossima ${next}\n            ${che}${jobPayload(job)}`;
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
