import DatabaseCtor from 'better-sqlite3';
import { parseArgs } from 'node:util';
import { BudgetEngine } from '../core/budget/budget.js';
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
  * ## `add` takes an explicit cron, and this is one of two doors that create a job
  *
  * The other is the conversational one: `schedule_recurring`
  * (`agent/tools/schedule.ts`), the loop tool that turns the owner's phrase
  * into this cron and lands on the same store. Both doors validate through the
  * same `JobStore.add` — one cron engine, one persistence path — and both
  * write the intent's provenance onto the row (`origin_*`, `tier`), because a
  * job fires with a system principal and the fire reads its taint from the row
  * instead of a literal `0` (`agent/scheduler-run.ts`). A job created by a
  * turn no longer hands a later, unattended turn a clean provenance the
  * writing turn never had — which is the condition `docs/evidence/fuori-dal-turno-2026-09-03.md`
  * §1 set for opening this door at all.
  *
  * What still holds from the earlier warning: there is no shell path to the
  * scheduler, on any surface. The model reaches jobs through the typed tool,
  * never through `muffin jobs add --cron`.
  */

export const JOBS_USAGE = `usage:
  muffin jobs list
  muffin jobs add --cron "<expr>" [--tz <IANA>] [--channel <surface>]
                 [--per-job-usd <dollari>] "<obiettivo>"
  muffin jobs add --cron "<expr>" --script "<comando>" [--tz] [--channel]
                                un comando nella sandbox, senza chiamare il
                                modello: costa zero token, e parla solo quando
                                ha qualcosa da dire (stdout vuoto = silenzio)
  muffin jobs cap <id> <dollari|none>
                                il tetto di spesa di QUESTO job, al mese.
                                Raggiunto il tetto il job non parte e non
                                chiama il modello: "none" lo toglie.
  muffin jobs remove <id>
`;

function openStore(home: string): { store: JobStore; db: DatabaseCtor.Database } {
  const db = new DatabaseCtor(paths(home).db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return { store: new JobStore(db), db };
}

/**
 * Il conto per-job, letto dalla stessa connessione della lista.
 *
 * Un tetto senza il numero che lo consuma è una decisione che l'owner prende
 * al buio: «$2 al mese» non dice niente finché non si vede che questo mese ne
 * ha già spesi 1,90. `BudgetEngine` e non una query a mano perché la
 * definizione di «questo mese» — quale stringa, quale fuso — deve restare una
 * sola: due letture dello stesso registro che non concordano su dove comincia
 * il mese sono peggio di nessuna lettura. I tetti passati sono quelli sigillati
 * (ADR-0039), gli stessi che `ownerTimezone` già apre qui sopra; qui servono
 * solo perché il costruttore li chiede, la lista non li mostra.
 */
function speseDeiJob(home: string, db: DatabaseCtor.Database): (jobId: string) => number {
  const budget = new BudgetEngine(db, loadSealedBudgets(home).caps);
  return (jobId: string) => budget.jobMonthUsd(jobId);
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

function fmt(job: Job, spesoUsd: number): string {
  const next = job.nextFireAt.toLocaleString('it-IT', { timeZone: job.timezone, dateStyle: 'short', timeStyle: 'short' });
  // `jobPayload`, non `job.goal`: per un job `script` quel campo è undefined
  // per costruzione, e la lista stampava «undefined» — trovato lanciando il
  // binario vero, non dai test, che creavano job senza mai elencarli.
  //
  // E il tipo è mostrato: uno script gira senza modello e senza che nessuno
  // guardi, quindi «cosa farà domattina alle 8» deve essere leggibile da
  // questa riga, non deducibile.
  const che = job.kind === 'script' ? '$ ' : '';
  // Il tetto **e** quanto ne resta, sulla stessa riga: un tetto stampato da
  // solo non dice se il job sta per fermarsi, ed è quella la domanda che si fa
  // guardando la lista. Assente quando l'owner non ne ha messo uno — una riga
  // «senza tetto» ripetuta su ogni job sarebbe rumore.
  const tetto =
    job.perJobUsd === null
      ? ''
      : `\n            tetto $${job.perJobUsd}/mese — speso $${spesoUsd.toFixed(2)}${spesoUsd >= job.perJobUsd ? ' (raggiunto: non parte)' : ''}`;
  return `${job.id.slice(0, 8)}  ${job.cron.padEnd(14)} ${job.timezone.padEnd(16)} →${job.channel.padEnd(9)} prossima ${next}\n            ${che}${jobPayload(job)}${tetto}`;
}

export function cmdJobsList(home: string): number {
  const { store, db } = openStore(home);
  try {
    const jobs = store.list();
    if (jobs.length === 0) {
      process.stdout.write('nessun job schedulato. `muffin jobs add` per crearne uno.\n');
      return 0;
    }
    const speso = speseDeiJob(home, db);
    process.stdout.write(jobs.map((j) => fmt(j, speso(j.id))).join('\n') + '\n');
    return 0;
  } finally {
    db.close();
  }
}

export function cmdJobsAdd(home: string, argv: string[]): number {
  /**
   * `parseArgs` **lancia**, e su questa riga di comando lo fa per cose che un
   * owner scrive davvero: `--per-job-usd -1` («argument is ambiguous»), un
   * flag sconosciuto, un valore mancante. Senza questo catch la risposta era
   * uno stack trace di Node — la stessa forma di guasto che `cmdJobsAdd` già
   * evita per un cron invalido, e che qui era rimasta scoperta perché fino a
   * oggi nessun flag di `jobs add` prendeva un numero che può essere negativo.
   */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        cron: { type: 'string' },
        tz: { type: 'string' },
        channel: { type: 'string' },
        script: { type: 'string' },
        'per-job-usd': { type: 'string' },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${JOBS_USAGE}`);
    return 78;
  }
  const { values, positionals } = parsed;
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
  // Parsato qui e non lasciato a `Number(...)` dentro lo store: `--per-job-usd
  // abc` diventerebbe `NaN`, e un NaN scritto in SQLite è NULL — cioè
  // «nessun tetto». L'owner avrebbe chiesto un limite e ottenuto il contrario,
  // senza un errore da nessuna parte.
  let perJobUsd: number | null = null;
  if (values['per-job-usd'] !== undefined) {
    const n = Number(values['per-job-usd']);
    if (!Number.isFinite(n) || n < 0) {
      process.stderr.write(`--per-job-usd vuole dollari, non "${values['per-job-usd']}"\n`);
      return 78;
    }
    perJobUsd = n;
  }
  const config = loadConfig(home);
  const { store, db } = openStore(home);
  try {
    const comune = {
      cron: values.cron,
      timezone: values.tz ?? ownerTimezone(home),
      channel: values.channel ?? config.surfaces.default,
      perJobUsd,
    };
    const job = store.add(script !== '' ? { ...comune, kind: 'script' as const, script } : { ...comune, goal });
    const next = job.nextFireAt.toLocaleString('it-IT', { timeZone: job.timezone, dateStyle: 'short', timeStyle: 'short' });
    const conTetto = job.perJobUsd === null ? '' : `, tetto $${job.perJobUsd}/mese`;
    process.stdout.write(
      `job ${job.id.slice(0, 8)} creato — prossima esecuzione ${next} (${job.timezone}) su ${job.channel}${conTetto}\n`,
    );
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

/**
 * `muffin jobs cap <id> <dollari|none>` — la seconda porta del tetto.
 *
 * Esiste perché senza di lei il tetto sarebbe una porta sola: impostabile alla
 * creazione e mai più modificabile, quindi l'unico rimedio per un job fermato
 * dal proprio tetto sarebbe cancellarlo e rifarlo — perdendo l'id a cui punta
 * ogni occorrenza già registrata in `job_fires`. È la stessa regola che il
 * repo si dà altrove: una manopola va esposta da tutte le porte da cui la si
 * cerca, non solo da quella in cui è nata.
 */
export function cmdJobsCap(home: string, id: string, valore: string): number {
  const cap = valore === 'none' ? null : Number(valore);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) {
    process.stderr.write(`tetto non valido: "${valore}" (attesi dollari, es. 0.50, oppure "none")\n`);
    return 78;
  }
  const { store, db } = openStore(home);
  try {
    // Prefisso corto, come `remove`: è quello che `list` stampa.
    const match = store.list().find((j) => j.id === id || j.id.startsWith(id));
    if (!match) {
      process.stderr.write(`nessun job attivo con id "${id}"\n`);
      return 1;
    }
    store.setPerJobUsd(match.id, cap);
    process.stdout.write(
      cap === null
        ? `job ${match.id.slice(0, 8)}: tetto rimosso (resta solo il tetto mensile globale).\n`
        : `job ${match.id.slice(0, 8)}: tetto $${cap}/mese.\n`,
    );
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
