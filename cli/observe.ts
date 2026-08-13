import DatabaseCtor from 'better-sqlite3';
import { parseArgs } from 'node:util';
import type { LoopDeps } from '../agent/loop.js';
import { BudgetEngine } from '../core/budget/budget.js';
import { ConfigError, loadConfig, paths } from '../core/config/config.js';
import { loadSealedBudgets } from '../core/rot/budgets.js';
import { detectAbsences, formatP } from '../core/memory/absence.js';
import { MemoryStore } from '../core/memory/store.js';
import { FireLog } from '../core/scheduler/firelog.js';
import { SendLock } from '../core/scheduler/sendlock.js';
import { observe, recordFired, type Observation } from '../core/scheduler/observe.js';
import { decideProactive } from '../core/scheduler/proactivity.js';
import type { Deliver } from '../core/scheduler/scheduler.js';

/**
 * `muffin observe` — the two-stage gate with the lights on.
 *
 * The default command runs the whole path — detect, dedup, gate — and speaks to
 * nobody. That is not a dry-run flag bolted onto a feature: the owner rejected
 * the old Muffin's proactivity from experience (ADR-0028), and the honest first
 * cut of a signal shaped like the thing they rejected is one they can look at
 * before it is allowed to talk. `--send` is the opt-in, per run, and it is the
 * only path that costs a model call or burns an anchor.
 *
 * The database is opened directly rather than through `buildRuntime`, like
 * `muffin jobs`: looking at what went quiet has no reason to need a provider or
 * an API key. The runtime is built only under `--send`, where stage 2 needs it.
 */

const TENANT = 'host';

export const OBSERVE_USAGE = `usage:
  muffin observe           cosa è diventato silenzioso, e cosa ne farebbe il gate
  muffin observe --send    compone e consegna quello che il gate consente
`;

export type ObserveOverrides = {
  /** Turn deps for stage 2. Absent in production: they come from the runtime. */
  deps?: LoopDeps;
  deliver?: Deliver;
  now?: Date;
};

/**
 * Delivery, and the reason it throws rather than shrugging.
 *
 * Remote delivery is the M4 connect and is not wired. Printing the message and
 * returning normally made the caller record the fire — and the rule this slice
 * runs on is that only a message that *reached* the owner burns the anchor.
 * That anchor carries `lastSeen`, which does not move while the entity stays
 * silent, so the occasion would have been spent forever on a message nobody
 * received. The precondition is not exotic — it is any home that has run
 * `muffin surface enable`, which is the point of the slice. (`surfaces.default`
 * documents itself as deliberately not the CLI while `DEFAULT_CONFIG` ships
 * `'cli'`; that contradiction is real and is not this file's to settle, so the
 * argument here rests on the configured case instead of on the docstring.)
 *
 * The text is printed first regardless. Losing the message entirely would be a
 * worse bug than the one this fixes, and `sendAllowed` turns the throw into
 * "non inviato", exit 1, anchor left open for the next run.
 */
const printDeliver: Deliver = async (channel, text) => {
  if (channel === 'cli') {
    process.stdout.write(`\n${text}\n`);
    return;
  }
  process.stderr.write(`\n[${channel}: consegna remota da cablare]\n${text}\n`);
  throw new Error(`consegna su "${channel}" non è cablata — il messaggio è qui sopra, non è stato inviato`);
};

/** The numbers, always: a nudge whose evidence is invisible is the old firehose. */
function evidence(obs: Observation): string {
  const a = obs.absence;
  return `${a.occasions} occasioni · arco ${a.spanDays}g · silenzio ${a.gapDays}g · p ${formatP(a.p)}`;
}

function verdict(obs: Observation, fires: FireLog, sent: Map<string, string>): string {
  const d = obs.decision;
  if (d.effect === 'skip') {
    const at = fires.get(obs.anchor)?.decidedAt;
    return `già detto${at ? ` il ${at.toLocaleDateString('it-IT')}` : ''}`;
  }
  if (d.effect === 'deny') return `negato (${d.reason})`;
  if (d.effect === 'defer') {
    const until = d.until.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
    return `rimandato a ${until} (${d.reason})`;
  }
  return sent.get(obs.anchor) ?? 'parlerebbe';
}

export async function cmdObserve(home: string, argv: string[], over: ObserveOverrides = {}): Promise<number> {
  let values: { send?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { send: { type: 'boolean' } }, allowPositionals: false }));
  } catch {
    process.stderr.write(OBSERVE_USAGE);
    return 78;
  }

  let config;
  try {
    config = loadConfig(home);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n→ ${error.remedy}\n`);
      return 78;
    }
    throw error;
  }

  const db = new DatabaseCtor(paths(home).db);
  // House pattern (`cli/jobs.ts`, `agent/runtime.ts`): every caller sets it. It
  // is belt-and-braces rather than load-bearing — better-sqlite3 already applies
  // 5000ms to every connection, measured — and removing it is caught by nothing,
  // which is the honest reason it stays rather than a claim that it is needed.
  db.pragma('busy_timeout = 5000');
  let releaseLock: (() => void) | null = null;
  try {
    // Both constructors create their own tables. A home that has never run a
    // turn has no memory schema, and no home has ever had a fires table.
    new MemoryStore(db);
    const fires = new FireLog(db);
    // One read of the sealed file for both rails this command needs: the spend
    // cap and the quiet window. They used to come from two places — the cap from
    // `config.json`, outside the seal, and the window from `rot/budgets.json` —
    // so the sentence "the same budget engine the kernel reads" below was true
    // of the object and false of the number inside it.
    const sealed = loadSealedBudgets(home);
    const budget = new BudgetEngine(db, sealed.caps);

    const now = over.now ?? new Date();

    // Scoped to --send: showing what is pending is this command's main use and
    // must work while a send is running. 75 is EX_TEMPFAIL — this run did not
    // fail, it lost a race and the same command will work in a moment; 78
    // (EX_CONFIG) above is why sysexits is the vocabulary here, not a bare 1.
    if (values.send) {
      const lock = new SendLock(db).acquire(now);
      if ('held' in lock) {
        process.stderr.write(`${lock.held}\n→ ${lock.remedy}\n`);
        return 75;
      }
      releaseLock = lock.release;
    }
    for (const note of sealed.notes) process.stderr.write(`! ${note}\n`);
    const quiet = sealed.quietHours;
    const channel = config.surfaces.default;

    const observations = observe({
      absences: () => detectAbsences(db, TENANT, now),
      decide: decideProactive,
      fires,
      // The same budget engine the kernel reads, not a second opinion about it.
      ctx: { now, quietHours: quiet, budgetExhausted: budget.exhausted() },
      channel,
    });

    if (observations.length === 0) {
      process.stdout.write('nessun silenzio sopra soglia.\n');
      return 0;
    }

    const sent = new Map<string, string>();
    let failures = 0;
    if (values.send) {
      failures = await sendAllowed(home, channel, observations, fires, now, sent, over);
    }

    const lines = observations.map(
      (o) =>
        `${o.absence.name} (${o.absence.kind}) — ${verdict(o, fires, sent)}\n` +
        `    ${evidence(o)}\n` +
        `    ancora ${o.anchor}`,
    );
    process.stdout.write(`${observations.length} sopra soglia · canale ${channel}\n\n${lines.join('\n')}\n`);

    if (!values.send && observations.some((o) => o.decision.effect === 'allow')) {
      process.stderr.write('\nniente è stato inviato. `muffin observe --send` per farlo parlare.\n');
    }
    return failures > 0 ? 1 : 0;
  } finally {
    // Release before the close, not after: the lock is a row in this database,
    // so a release on a closed handle throws — and it throws from a `finally`,
    // which would replace whatever the command was actually returning.
    releaseLock?.();
    db.close();
  }
}

/**
 * Stage 2 and delivery, for the ones the gate allowed.
 *
 * The fire is recorded after the message is out, never before: a composition
 * that failed or a delivery that threw must leave the anchor available, or the
 * one run that broke would silence that entity forever.
 */
async function sendAllowed(
  home: string,
  channel: string,
  observations: Observation[],
  fires: FireLog,
  now: Date,
  sent: Map<string, string>,
  over: ObserveOverrides,
): Promise<number> {
  const allowed = observations.filter((o) => o.decision.effect === 'allow');
  if (allowed.length === 0) return 0;

  // Imported here, not at the top: `muffin observe` without --send must not pay
  // for the provider graph, and must work on a home with no API key.
  const { makeAbsenceComposer } = await import('../agent/observe-run.js');
  let runtime: { deps: LoopDeps; close: () => void } | null = null;
  let deps = over.deps;
  if (!deps) {
    const { buildRuntime } = await import('../agent/runtime.js');
    runtime = buildRuntime(home);
    deps = runtime.deps;
  }

  const compose = makeAbsenceComposer(deps, channel);
  const deliver = over.deliver ?? printDeliver;
  let failures = 0;
  try {
    for (const obs of allowed) {
      try {
        const composed = await compose(obs.absence);
        await deliver(channel, composed.text);
        // Both records happen here, after the delivery, and in this order: the
        // episode is what Muffin said, the fire is that it said it. A throw from
        // `deliver` must leave neither behind.
        composed.record();
        recordFired(fires, obs, now);
        sent.set(obs.anchor, 'inviato');
      } catch (error) {
        failures += 1;
        sent.set(obs.anchor, `non inviato: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    runtime?.close();
  }
  return failures;
}
