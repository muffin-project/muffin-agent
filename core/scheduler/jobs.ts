import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import { ensureColumn } from '../lock/durable.js';
import type { TrustTier } from '../policy/types.js';
import type { DelegationMode } from '../runtime/delega.js';

/**
 * The durable core of M5: jobs that survive a restart, and a next-fire that is
 * correct across a DST change.
 *
 * The "semantic" half of semantic cron is a model turning "ogni mattina alle 8"
 * into a cron spec, confirmed in chat — that lives in the CLI/loop. Here there
 * is no model: a stored cron expression plus a timezone, and a deterministic
 * `next()`. Computing "the next 08:00 Europe/Rome" through a spring-forward is
 * exactly the arithmetic you do not write by hand, so it goes to cron-parser
 * (pure parser, tz+DST correct, does not own any timer — the scheduler loop is
 * ours, per ADR-0022).
 *
 * Rows are never deleted (invariant §I-8): a retired job is `active = 0`, so
 * "what did I have scheduled in May" stays answerable.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  cron         TEXT NOT NULL,
  timezone     TEXT NOT NULL,
  goal         TEXT NOT NULL,
  channel      TEXT NOT NULL,
  -- 'goal' (un obiettivo che il modello interpreta) oppure 'script' (un
  -- comando che gira nella sandbox, senza modello). Default 'goal': le righe
  -- che esistevano prima di questa colonna sono tutte obiettivi, e la
  -- migrazione 2 la aggiunge con lo stesso default.
  kind         TEXT NOT NULL DEFAULT 'goal',
  -- Il tetto di spesa di QUESTO job, in dollari per mese solare, e NULL
  -- quando l'owner non ne ha messo uno. Nullable per costruzione: un default
  -- numerico qui spegnerebbe di sua iniziativa i job che esistevano prima di
  -- questa colonna, cioè cambierebbe il comportamento di righe che nessuno ha
  -- toccato. Il conto che lo consuma sta in spend.job_id
  -- (core/budget/budget.ts), non qui: una colonna contatore su questa riga
  -- si aggiornerebbe solo quando il giro torna, ed è esattamente ciò che
  -- ADR-0035 emendamento №2 dice di non fare.
  per_job_usd  REAL,
  created_at   TEXT NOT NULL,
  next_fire_at TEXT NOT NULL,
  last_run_at  TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  -- Provenance dell'intento che ha creato la riga (migrazione 7). Chi ha
  -- chiesto la ricorrenza, da quale superficie, in quale turno e con quanto
  -- taint addosso — perché il giro futuro deve partire da lì, non da zero.
  -- Default da legacy: i job nati da CLI prima di queste colonne arrivano da
  -- un owner al terminale, e i default li descrivono come tali.
  origin_tenant    TEXT NOT NULL DEFAULT 'host',
  origin_surface   TEXT NOT NULL DEFAULT 'cli',
  origin_principal TEXT NOT NULL DEFAULT 'owner',
  origin_turn      TEXT,
  tier             INTEGER NOT NULL DEFAULT 0,
  -- Armato una volta (#598 S3): 1 = spara una sola occorrenza e poi si
  -- disattiva in markRan invece di avanzare. Default 0: le righe legacy e
  -- ogni add senza once restano ricorrenti, quindi la migrazione non
  -- spegne niente che l'owner non abbia toccato (stessa disciplina di
  -- per_job_usd: nullable-additiva via ensureColumn, mai un default che
  -- cambia righe esistenti).
  run_once         INTEGER NOT NULL DEFAULT 0,
  -- Postura pre-delegata per il futuro turno di fire (#598 S3, #740): quale
  -- ask il fire puo consumare senza una nuova domanda. Default manual:
  -- le righe legacy chiedono come oggi. Solo yolo consuma (stesso registro,
  -- decided_by delegation); auto resta in escalation finche la busta di
  -- System One e vuota — nessuna soglia inventata qui.
  delegation       TEXT NOT NULL DEFAULT 'manual' CHECK (delegation IN ('manual','auto','yolo'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(active, next_fire_at);
`;

type JobCommon = {
  id: string;
  /** Standard 5-field cron expression. */
  cron: string;
  /** IANA timezone the cron is interpreted in. */
  timezone: string;
  /** Delivery surface id (e.g. 'cli', 'telegram'). */
  channel: string;
  createdAt: Date;
  nextFireAt: Date;
  lastRunAt: Date | null;
  active: boolean;
  /**
   * USD per calendar month this job may spend on the model, or `null` for "no
   * ceiling of its own" — which is every job written before this column and
   * every job added without `--per-job-usd`.
   *
   * The gate that reads it is `agent/scheduler-run.ts`, **before** the fire is
   * allowed to reach the model. It can only tighten: the sealed monthly cap
   * (`rot/budgets.json`, ADR-0039) still bounds everything above it, so a
   * value written here can never buy more model time than the seal allows.
   */
  perJobUsd: number | null;
  /**
   * Da dove viene questa riga: il tenant, la superficie, il principal e il
   * turno dell'intento che l'ha creata. Scritta una volta sola, mai
   * aggiornata: è la risposta a «chi ha chiesto che questo parli da solo ogni
   * mattina», letta a ogni giro futuro invece di essere dedotta.
   */
  origin: {
    tenant: string;
    surface: string;
    principal: string;
    turnId: string | null;
  };
  /**
   * Il soffitto del turno che ha creato la riga (`max(taint, intrinsicTaint)`
   * come `due_tier` di `core/turns/todo.ts`). Il giro futuro parte da qui,
   * non da zero: partire da zero laverebbe la provenienza del turno che ha
   * scritto l'intento. `0` sulle righe legacy, che è esattamente ciò che il
   * vecchio codice faceva — per quelle niente cambia.
   */
  tier: TrustTier;
  /**
   * Armato una volta (#598 S3): `true` = una sola occorrenza, poi `markRan`
   * disattiva invece di avanzare. `false` sulle righe legacy e su ogni `add`
   * senza `once`: ricorrente come oggi.
   */
  once: boolean;
  /**
   * Postura pre-delegata per il futuro turno di fire (#598 S3, #740), letta
   * da `Delega.modo` via `turns.job_id` quando il turno non ha una propria
   * riga. `'manual'` sulle righe legacy e quando l'owner non la nomina: chiede
   * come oggi. Nessuna soglia inventata: `auto` escala, `yolo` consuma via
   * stesso registro, `deny` resta `deny` nel kernel.
   */
  delegation: DelegationMode;
};

/**
 * What a fire actually does — and the two answers are not variations of one
 * thing, which is why this is a union and not a nullable field.
 *
 * A **goal** is interpreted: it becomes a turn, the model reads it, tools may
 * run, and the answer is delivered. That is the right shape for "riassumimi la
 * giornata" and the wrong shape for "controlla se il sito risponde", where the
 * work is deterministic and the model adds only cost and variance.
 *
 * A **script** is executed: a command runs in the sandbox and **the model is
 * never called**. It speaks only when it has something to say — empty output
 * means silence, not an empty message. A check every five minutes costs zero
 * tokens until the day it finds something.
 *
 * Both share one storage column (`goal`), because "what to run when it fires"
 * is genuinely one slot; the discriminant is what keeps a shell command from
 * ever being handed to the model as a goal, or the reverse, by type error
 * rather than by care.
 */
export type Job = JobCommon &
  (
    | { kind: 'goal'; goal: string; script?: undefined }
    | { kind: 'script'; script: string; goal?: undefined }
  );

export type NewJob = {
  /**
   * Standard 5-field cron expression — oppure il sentinella `'once'` per un
   * armato-immediato senza cadenza (`addOnce` lo usa; `markRan` non lo
   * interpreta mai perché un `once` disattiva invece di avanzare). Un `once`
   * con un cron reale spara una volta a quell'ora e poi si disattiva.
   */
  cron: string;
  timezone: string;
  channel: string;
  /** See `Job.perJobUsd`. Omitted means no per-job ceiling. */
  perJobUsd?: number | null;
  /**
   * Armato una volta (#598 S3). Omesso = ricorrente come oggi.
   */
  once?: boolean | undefined;
  /**
   * Postura pre-delegata per il futuro fire (#598 S3, #740). Omessa = manual.
   */
  delegation?: DelegationMode | undefined;
  /**
   * Chi ha chiesto la ricorrenza. La CLI passa l'owner al terminale; il tool
   * conversazionale passa il turno che ha ricevuto l'intento. Assente = riga
   * legacy/operator: i default dello schema la descrivono come owner su cli.
   */
  origin?: {
    tenant: string;
    surface: string;
    principal: string;
    turnId?: string | null;
    tier?: TrustTier;
  };
} & ({ kind?: 'goal'; goal: string } | { kind: 'script'; script: string });

/** What this job runs, whichever kind it is — for logs and list output. */
export function jobPayload(job: Job | NewJob): string {
  return job.kind === 'script' ? job.script : job.goal;
}

/** Thrown on a bad cron or timezone, so the CLI can name what was wrong. */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobError';
  }
}

/**
 * A bad timezone must be rejected here: `cron-parser` silently accepts an
 * unknown `tz` (verified — `Not/AZone` does not throw), which would compute
 * fire times against the wrong clock forever. `Intl.DateTimeFormat` throws on
 * an invalid IANA zone, so it is the boundary check.
 */
function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new JobError(`timezone non valida: "${tz}" (attesa una zona IANA, es. Europe/Rome)`);
  }
}

/** Next fire strictly after `after`, in `tz`. Throws JobError on bad input. */
export function nextFire(cron: string, tz: string, after: Date): Date {
  assertTimezone(tz);
  let interval;
  try {
    interval = CronExpressionParser.parse(cron, { tz, currentDate: after });
  } catch (error) {
    throw new JobError(`espressione cron non valida: "${cron}" — ${error instanceof Error ? error.message : String(error)}`);
  }
  return interval.next().toDate();
}

type Row = {
  id: string;
  cron: string;
  timezone: string;
  goal: string;
  channel: string;
  kind: string;
  created_at: string;
  next_fire_at: string;
  last_run_at: string | null;
  active: number;
  per_job_usd: number | null;
  origin_tenant?: string | null;
  origin_surface?: string | null;
  origin_principal?: string | null;
  origin_turn?: string | null;
  tier?: number | null;
  run_once?: number | null;
  delegation?: string | null;
};

function asTier(v: unknown): TrustTier {
  return v === 1 || v === 2 || v === 3 ? v : 0;
}

function asDelegation(v: unknown): DelegationMode {
  return v === 'auto' || v === 'yolo' ? v : 'manual';
}

function toJob(row: Row): Job {
  const common = {
    id: row.id,
    cron: row.cron,
    timezone: row.timezone,
    channel: row.channel,
    createdAt: new Date(row.created_at),
    nextFireAt: new Date(row.next_fire_at),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
    active: row.active === 1,
    // `?? null` e non `row.per_job_usd`: su una riga scritta prima della
    // colonna SQLite restituisce `null`, ma un database riaperto da codice
    // vecchio-su-nuovo può non avere la chiave affatto — e `undefined` qui
    // diventerebbe un tetto che il gate legge come «assente» invece che come
    // «non impostato». Sono lo stesso valore, e questa riga li rende lo stesso
    // *tipo*.
    perJobUsd: row.per_job_usd ?? null,
    // Stessa disciplina sulle colonne di provenance (migrazione 7): una riga
    // legacy descrive un owner al terminale, e i default dello schema dicono
    // già così — qui si rende solo lo stesso *tipo*, mai un valore inventato.
    // `||` e non `??`: una stringa vuota (riga corrotta a mano — lo schema la
    // impedisce sulle colonne nuove ma non su quelle vecchie) non è un tenant
    // né una superficie, e al fire arriverebbe come indirizzo vuoto invece
    // che come default noto.
    origin: {
      tenant: row.origin_tenant || 'host',
      surface: row.origin_surface || 'cli',
      principal: row.origin_principal || 'owner',
      turnId: row.origin_turn || null,
    },
    tier: asTier(row.tier),
    // Legacy senza colonne S3: ricorrente + manual — la migrazione non spegne
    // niente che l'owner non abbia toccato. `=== 1` e non truthy: una riga
    // corrotta a mano non deve diventare una-tantum per caso.
    once: row.run_once === 1,
    delegation: asDelegation(row.delegation),
  };
  // Anything that is not exactly 'script' is a goal. A row with a `kind` this
  // build does not know must not become an executable script by accident —
  // the safe default is the one that goes through the model and its kernel.
  return row.kind === 'script'
    ? { ...common, kind: 'script', script: row.goal }
    : { ...common, kind: 'goal', goal: row.goal };
}

export class JobStore {
  private readonly insertStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly dueStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly ranStmt: Database.Statement;
  private readonly ranOnceStmt: Database.Statement;
  private readonly disableStmt: Database.Statement;
  private readonly capStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
    // `CREATE TABLE IF NOT EXISTS` è un no-op su una tabella che esiste già,
    // quindi su un database scritto prima di `kind` il prepare qui sotto
    // esplodeva con «table jobs has no column named kind» — non solo per i job
    // script nuovi: per QUALUNQUE `muffin jobs list` dopo l'aggiornamento
    // (judge #106 giro 2, riprodotto). La migrazione 2 fa la stessa cosa per
    // chi passa da `migrate()`, ma `cli/jobs.ts` apre il database direttamente
    // e di proposito; questa è la stessa rete difensiva che `TurnStore` tiene
    // per `claim_token`, e il suo costo è un PRAGMA. È anche il gap che
    // l'audit P27 aveva già nominato per `turns`/`jobs`/le tabelle di lock.
    ensureColumn(db, 'jobs', 'kind', `kind TEXT NOT NULL DEFAULT 'goal'`);
    // Stessa rete, stessa ragione, per il tetto per-job: `cli/jobs.ts` apre il
    // database direttamente e non passa da `migrate()`, quindi senza questa
    // riga il primo `muffin jobs list` dopo l'aggiornamento morirebbe con
    // «table jobs has no column named per_job_usd» su un'installazione che
    // funzionava un minuto prima.
    ensureColumn(db, 'jobs', 'per_job_usd', 'per_job_usd REAL');
    // Stessa rete, stessa ragione, per la provenance dell'intento
    // (migrazione 7): `cli/jobs.ts` apre il database direttamente e non passa
    // da `migrate()`, e un `SELECT *` con colonne mancanti non fallisce —
    // restituisce righe senza quelle chiavi, che `toJob` legge come legacy.
    // Ma l'`INSERT` qui sotto le nomina, e senza queste righe morirebbe con
    // «table jobs has no column named origin_tenant» sul primo job creato da
    // conversazione dopo l'aggiornamento.
    ensureColumn(db, 'jobs', 'origin_tenant', `origin_tenant TEXT NOT NULL DEFAULT 'host'`);
    ensureColumn(db, 'jobs', 'origin_surface', `origin_surface TEXT NOT NULL DEFAULT 'cli'`);
    ensureColumn(db, 'jobs', 'origin_principal', `origin_principal TEXT NOT NULL DEFAULT 'owner'`);
    ensureColumn(db, 'jobs', 'origin_turn', 'origin_turn TEXT');
    ensureColumn(db, 'jobs', 'tier', 'tier INTEGER NOT NULL DEFAULT 0');
    // S3 una-tantum + pre-delega: stessa rete, stessa ragione. Senza, il primo
    // `muffin jobs add --once` dopo l'aggiornamento morirebbe con «table jobs
    // has no column named run_once» su un'installazione che funzionava un
    // minuto prima — il guasto già visto per `kind` e `per_job_usd`.
    ensureColumn(db, 'jobs', 'run_once', 'run_once INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'jobs', 'delegation', `delegation TEXT NOT NULL DEFAULT 'manual'`);
    this.insertStmt = db.prepare(
      `INSERT INTO jobs (id, cron, timezone, goal, channel, kind, per_job_usd, created_at, next_fire_at, last_run_at, active,
                         origin_tenant, origin_surface, origin_principal, origin_turn, tier, run_once, delegation)
       VALUES (@id, @cron, @timezone, @goal, @channel, @kind, @perJobUsd, @createdAt, @nextFireAt, NULL, 1,
               @originTenant, @originSurface, @originPrincipal, @originTurn, @tier, @runOnce, @delegation)`,
    );
    this.listStmt = db.prepare(`SELECT * FROM jobs WHERE active = 1 ORDER BY next_fire_at`);
    this.dueStmt = db.prepare(
      `SELECT * FROM jobs WHERE active = 1 AND next_fire_at <= ? ORDER BY next_fire_at`,
    );
    this.getStmt = db.prepare(`SELECT * FROM jobs WHERE id = ?`);
    this.ranStmt = db.prepare(`UPDATE jobs SET last_run_at = @now, next_fire_at = @next WHERE id = @id AND active = 1`);
    this.disableStmt = db.prepare(`UPDATE jobs SET active = 0 WHERE id = ? AND active = 1`);
    this.capStmt = db.prepare(`UPDATE jobs SET per_job_usd = @cap WHERE id = @id AND active = 1`);
    this.ranOnceStmt = db.prepare(`UPDATE jobs SET last_run_at = @now, active = 0 WHERE id = @id AND active = 1`);
  }

  /** Validates, computes the first fire from now, persists. Throws JobError. */
  add(spec: NewJob): Job {
    const now = this.clock();
    // Prima di qualunque scrittura, come il cron: un tetto NaN entrerebbe in
    // SQLite come NULL — cioè come «nessun tetto» — e l'owner avrebbe chiesto
    // un limite ottenendo il contrario, in silenzio. Zero è ammesso e
    // significa quello che dice: questo job non chiama il modello finché il
    // tetto non cambia.
    if (spec.perJobUsd !== undefined && spec.perJobUsd !== null) {
      if (!Number.isFinite(spec.perJobUsd) || spec.perJobUsd < 0) {
        throw new JobError(`tetto per-job non valido: "${spec.perJobUsd}" (attesi dollari, es. 0.50)`);
      }
    }
    if (spec.delegation !== undefined && spec.delegation !== 'manual' && spec.delegation !== 'auto' && spec.delegation !== 'yolo') {
      throw new JobError(`delega non valida: "${spec.delegation}" (attese manual|auto|yolo)`);
    }
    // Il sentinella `once`: un armato-immediato senza cadenza. Non passa da
    // `nextFire` — un cron reale non lo descrive — e la prima (unica) fire è
    // adesso, cioè dovuta al prossimo tick. `markRan` non lo interpreta mai
    // perché un `once` disattiva invece di avanzare.
    const once = spec.once === true;
    const next = spec.cron === 'once' ? now : nextFire(spec.cron, spec.timezone, now); // throws before any write
    if (spec.cron === 'once' && !once) {
      throw new JobError(`cron "once" solo per un job armato una volta (--once)`);
    }
    const origin = spec.origin;
    const common = {
      id: randomUUID(),
      cron: spec.cron,
      timezone: spec.timezone,
      channel: spec.channel,
      createdAt: now,
      nextFireAt: next,
      lastRunAt: null,
      active: true,
      perJobUsd: spec.perJobUsd ?? null,
      // Scritta una volta sola, qui: nessun UPDATE la tocca mai, quindi un
      // giro futuro non può riscrivere da dove è venuto l'intento.
      origin: {
        tenant: origin?.tenant ?? 'host',
        surface: origin?.surface ?? 'cli',
        principal: origin?.principal ?? 'owner',
        turnId: origin?.turnId ?? null,
      },
      tier: origin?.tier ?? 0,
      once,
      delegation: spec.delegation ?? 'manual',
    };
    const job: Job =
      spec.kind === 'script'
        ? { ...common, kind: 'script', script: spec.script }
        : { ...common, kind: 'goal', goal: spec.goal };
    this.insertStmt.run({
      id: job.id,
      cron: job.cron,
      timezone: job.timezone,
      goal: jobPayload(job),
      channel: job.channel,
      kind: job.kind,
      perJobUsd: job.perJobUsd,
      createdAt: now.toISOString(),
      nextFireAt: next.toISOString(),
      originTenant: job.origin.tenant,
      originSurface: job.origin.surface,
      originPrincipal: job.origin.principal,
      originTurn: job.origin.turnId,
      tier: job.tier,
      runOnce: job.once ? 1 : 0,
      delegation: job.delegation,
    });
    return job;
  }

  /**
   * Arma un obiettivo una volta sola (#598 S3): la prima (unica) fire è
   * adesso — dovuta al prossimo tick — senza cadenza. Sottile sopra `add`
   * con il sentinella `cron:'once'` per non duplicare la validazione
   * (tetto, delega, provenance): un solo motore cron, un solo percorso di
   * persistenza.
   */
  addOnce(
    spec: {
      timezone?: string;
      channel: string;
      perJobUsd?: number | null;
      delegation?: DelegationMode | undefined;
      origin?: NewJob['origin'];
    } & ({ kind?: 'goal'; goal: string } | { kind: 'script'; script: string }),
  ): Job {
    const timezone = spec.timezone ?? 'UTC';
    const base = {
      cron: 'once',
      timezone,
      channel: spec.channel,
      once: true as const,
      ...(spec.perJobUsd !== undefined ? { perJobUsd: spec.perJobUsd } : {}),
      ...(spec.delegation !== undefined ? { delegation: spec.delegation } : {}),
      ...(spec.origin !== undefined ? { origin: spec.origin } : {}),
    };
    if (spec.kind === 'script') {
      return this.add({ ...base, kind: 'script' as const, script: spec.script });
    }
    return this.add({ ...base, goal: (spec as { goal: string }).goal });
  }

  list(): Job[] {
    return (this.listStmt.all() as Row[]).map(toJob);
  }

  /** Active jobs whose fire time has arrived. Default now = the injected clock. */
  due(now: Date = this.clock()): Job[] {
    return (this.dueStmt.all(now.toISOString()) as Row[]).map(toJob);
  }

  get(id: string): Job | null {
    const row = this.getStmt.get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /**
   * Record a run and schedule the next fire. Computed from `now`, not from the
   * old next_fire_at: if the process was down over a fire, the job runs once on
   * catch-up and then resumes its cadence, rather than replaying every missed
   * slot.
   *
   * Un `once` non avanza: la riga si disattiva (stessa forma del soft-delete
   * §I-8 — la riga resta, `get` la raggiunge, `due`/`list` non la vedono più)
   * così il secondo tick non trova niente da far girare e il modello non viene
   * richiamato. `job_fires` + `resolveBound` restano a garantire che una
   * seconda lettura della STESSA occorrenza (prima di `markRan`) non riesegua.
   */
  markRan(id: string): Job | null {
    const job = this.get(id);
    if (!job || !job.active) return null;
    const now = this.clock();
    if (job.once) {
      this.ranOnceStmt.run({ id, now: now.toISOString() });
      return { ...job, lastRunAt: now, active: false };
    }
    const next = nextFire(job.cron, job.timezone, now);
    this.ranStmt.run({ id, now: now.toISOString(), next: next.toISOString() });
    return { ...job, lastRunAt: now, nextFireAt: next };
  }

  /**
   * Change (or clear, with `null`) a job's own spending ceiling.
   *
   * The second door the cap needs: without it a ceiling would be a one-way
   * decision — settable at `add` and never changeable — so the only remedy for
   * a job stopped by its own cap would be deleting and recreating it, which
   * loses the id every fire in `job_fires` points at. `active = 1` in the
   * WHERE because a retired job has nothing to cap.
   */
  setPerJobUsd(id: string, capUsd: number | null): boolean {
    if (capUsd !== null && (!Number.isFinite(capUsd) || capUsd < 0)) {
      throw new JobError(`tetto per-job non valido: "${capUsd}" (attesi dollari, es. 0.50)`);
    }
    return this.capStmt.run({ id, cap: capUsd }).changes > 0;
  }

  /** Soft-delete: the row stays (§I-8), it just stops firing. */
  disable(id: string): boolean {
    return this.disableStmt.run(id).changes > 0;
  }
}
