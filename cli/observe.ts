import DatabaseCtor from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { LoopDeps } from '../agent/loop.js';
import { BudgetEngine } from '../core/budget/budget.js';
import { ConfigError, loadConfig, paths } from '../core/config/config.js';
import { detectAbsences } from '../core/memory/absence.js';
import { MemoryStore } from '../core/memory/store.js';
import { FireLog } from '../core/scheduler/firelog.js';
import { observe, recordFired, type Observation } from '../core/scheduler/observe.js';
import { decideProactive, type QuietHours } from '../core/scheduler/proactivity.js';
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
 * Quiet hours are a rail, so they are read from the root of trust and not from
 * config.json — which is outside the seal and therefore not a place a rail can
 * live. Parsed rather than cast (PRACTICES §4): a hand-edited `"23"` would
 * otherwise become NaN minutes and quietly open the night.
 */
const BudgetsFile = z.object({
  quietHours: z.object({
    from: z.string().regex(/^\d{1,2}:\d{2}$/),
    to: z.string().regex(/^\d{1,2}:\d{2}$/),
    timezone: z.string().min(1),
  }),
});

/** A window, never an empty one: an unreadable file is not a licence to speak at 3am. */
const FALLBACK_QUIET: QuietHours = { from: '23:00', to: '08:00', timezone: 'UTC' };

function ownerQuietHours(home: string): { quiet: QuietHours; note: string | null } {
  const file = join(paths(home).rot, 'budgets.json');
  if (!existsSync(file)) return { quiet: FALLBACK_QUIET, note: `${file} assente` };
  try {
    const parsed = BudgetsFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) return { quiet: FALLBACK_QUIET, note: `${file}: quietHours non valide` };
    return { quiet: parsed.data.quietHours, note: null };
  } catch {
    return { quiet: FALLBACK_QUIET, note: `${file} illeggibile` };
  }
}

const printDeliver: Deliver = async (channel, text) => {
  if (channel === 'cli') {
    process.stdout.write(`\n${text}\n`);
    return;
  }
  // Same honest gap as the scheduler's: remote delivery is the M4 connect, and
  // until it lands the message surfaces here instead of vanishing.
  process.stderr.write(`\n[${channel}: consegna remota da cablare]\n${text}\n`);
};

/** The numbers, always: a nudge whose evidence is invisible is the old firehose. */
function evidence(obs: Observation): string {
  const a = obs.absence;
  return `${a.occasions} occasioni · arco ${a.spanDays}g · silenzio ${a.gapDays}g · p ${a.p.toFixed(4)}`;
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
  db.pragma('busy_timeout = 5000');
  try {
    // Both constructors create their own tables. A home that has never run a
    // turn has no memory schema, and no home has ever had a fires table.
    new MemoryStore(db);
    const fires = new FireLog(db);
    const budget = new BudgetEngine(db, config.budget);

    const now = over.now ?? new Date();
    const { quiet, note } = ownerQuietHours(home);
    if (note) process.stderr.write(`! quiet hours dal default (${note})\n`);
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
        await deliver(channel, await compose(obs.absence));
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
