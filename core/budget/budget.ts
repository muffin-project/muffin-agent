import type Database from 'better-sqlite3';
import { ensureColumn } from '../lock/durable.js';

/**
 * Spend caps.
 *
 * The kernel is synchronous and asks `budgetExhausted()` before every
 * non-trivial capability, so this has to answer without I/O latency —
 * better-sqlite3 is synchronous, which is the whole reason it was chosen.
 *
 * Two caps, not one, because they fail differently: the monthly cap protects
 * the wallet, the per-tenant daily cap protects against a group that starts
 * talking to itself. A documented echo loop burned $47 in twenty minutes on a
 * comparable system — that is not a hypothetical, and a single global cap would
 * have let it eat the whole month before tripping.
 *
 * A **third** gate lives half here and half on the job's own row, and it is the
 * one ADR-0035 emendamento №2 asked for by name: *"«il mese si è esaurito» è un
 * controllo troppo grosso: è la differenza fra un job rotto che costa €0,50 e
 * uno che si mangia il mese prima delle 7"*. Its number is not a cap in this
 * file — it is `jobs.per_job_usd`, because a ceiling that belongs to one
 * scheduled job cannot live in a sealed file the owner would have to reseal on
 * every `muffin jobs add` (ADR-0039 already rejects sealing a fragment of a
 * mutable file). What lives here is the **counter**: `jobMonthUsd`, keyed by
 * the `job_id` this ledger now records. The sealed monthly cap stays the
 * ceiling above it, so a per-job number can only ever tighten spending inside
 * a bound nothing outside the seal can raise.
 */

/**
 * The owner's own tenant. Spelled here rather than imported from
 * `agent/context/assemble.ts`: `core/` does not depend on `agent/`, and the
 * string is a contract in `core/policy/types.ts` (`'host' | group:… |
 * community:…`), not a detail of prompt assembly.
 */
const HOST_TENANT = 'host';

export type BudgetCaps = {
  /** USD per calendar month, across everything. */
  monthlyUsd: number;
  /** USD per tenant per day. Groups are the noisy ones. */
  perTenantDailyUsd: number;
};

export type SpendRecord = {
  tenant: string;
  capability: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /**
   * The scheduled job this call was made for, when there is one.
   *
   * `undefined`/`null` on every interactive turn, which is the majority of
   * rows: only the scheduler path (`agent/scheduler-run.ts` → `runTurn`'s
   * `jobId`) sets it. It is written **per model call**, not once per turn, and
   * that is the half ADR-0035 emendamento №2 is specific about — *"il conto va
   * tenuto fuori dal turno, non dentro: un contatore che si aggiorna solo
   * quando il loop torna al controllo è un contatore che non protegge dal caso
   * in cui il loop non torna"*. A job killed mid-turn has already paid for the
   * calls it made, and those rows are already on disk.
   */
  jobId?: string | null | undefined;
};

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend (
  id            INTEGER PRIMARY KEY,
  tenant        TEXT NOT NULL,
  capability    TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  usd           REAL NOT NULL,
  day           TEXT NOT NULL,
  month         TEXT NOT NULL,
  -- Nullable, and it stays nullable: an interactive turn has no job, and a
  -- sentinel string would make "spent by nobody's job" indistinguishable from
  -- a job whose id happened to be that string.
  job_id        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_month ON spend(month);
CREATE INDEX IF NOT EXISTS idx_spend_tenant_day ON spend(tenant, day);
`;

export type BudgetStatus = {
  monthUsd: number;
  monthlyCapUsd: number;
  exhausted: boolean;
  /** Set on the first call that crosses a cap, so the runtime can say it once. */
  justCrossed: 'monthly' | null;
};

export class BudgetEngine {
  private readonly recordStmt: Database.Statement;
  private readonly monthStmt: Database.Statement;
  private readonly tenantDayStmt: Database.Statement;
  private readonly jobMonthStmt: Database.Statement;
  private wasExhausted = false;

  constructor(
    private readonly db: Database.Database,
    private readonly caps: BudgetCaps,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
    // `CREATE TABLE IF NOT EXISTS` non aggiunge una colonna a una tabella che
    // esiste già: su un database dell'owner scritto prima di `job_id` il
    // `prepare` qui sotto esploderebbe con «table spend has no column named
    // job_id» al primo boot dopo l'aggiornamento — e `spend` la scrive
    // *ogni* chiamata al modello, quindi il guasto non sarebbe dei soli job.
    // Stessa rete che `JobStore` tiene per `kind` e `TurnStore` per
    // `claim_token`; costa un PRAGMA per costruzione.
    ensureColumn(db, 'spend', 'job_id', 'job_id TEXT');
    // **Dopo** `ensureColumn`, non dentro `SCHEMA`: un indice su una colonna
    // che non esiste ancora è un errore, non un no-op, e `CREATE TABLE IF NOT
    // EXISTS` non aggiunge la colonna a una tabella che c'è già. Messo nello
    // SCHEMA, il costruttore moriva con «no such column: job_id» su ogni
    // database scritto prima di questa slice — cioè su quello dell'owner, e
    // per ogni chiamata al modello, non solo per i job. Trovato dal test di
    // migrazione qui sotto, non a mano.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_spend_job_month ON spend(job_id, month)`);
    this.recordStmt = db.prepare(
      `INSERT INTO spend (tenant, capability, model, input_tokens, output_tokens, usd, day, month, job_id, created_at)
       VALUES (@tenant, @capability, @model, @inputTokens, @outputTokens, @usd, @day, @month, @jobId, @createdAt)`,
    );
    this.monthStmt = db.prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE month = ?`);
    this.tenantDayStmt = db.prepare(
      `SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE tenant = ? AND day = ?`,
    );
    this.jobMonthStmt = db.prepare(
      `SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE job_id = ? AND month = ?`,
    );
  }

  record(entry: SpendRecord): void {
    const now = this.clock();
    this.recordStmt.run({
      ...entry,
      // Esplicito, e non `entry.jobId`: better-sqlite3 rifiuta un parametro
      // nominato assente dall'oggetto, e `undefined` non è un valore che sa
      // legare. Una spesa senza job è `NULL`, detto qui una volta.
      jobId: entry.jobId ?? null,
      day: day(now),
      month: month(now),
      createdAt: now.toISOString(),
    });
  }

  monthToDateUsd(): number {
    return (this.monthStmt.get(month(this.clock())) as { total: number }).total;
  }

  tenantTodayUsd(tenant: string): number {
    return (this.tenantDayStmt.get(tenant, day(this.clock())) as { total: number }).total;
  }

  /**
   * What one scheduled job has spent this calendar month.
   *
   * The **month**, and not "ever", because the failure this closes is the one
   * ADR-0035 names — a broken job eating the monthly wallet — and the monthly
   * cap above is scoped the same way. A lifetime total would silently retire a
   * daily job for good on the strength of one bad day, which is a different
   * product decision and a worse one: the owner set a ceiling on cost, not an
   * expiry date on the job.
   */
  jobMonthUsd(jobId: string): number {
    return (this.jobMonthStmt.get(jobId, month(this.clock())) as { total: number }).total;
  }

  /**
   * The per-job gate. `null` cap means the owner never set one — no gate.
   *
   * Deliberately takes the cap as an argument instead of reading `jobs`: this
   * class owns the ledger, not the scheduler's schema, and `core/budget` has
   * no business importing `core/scheduler`. The caller that holds the job row
   * (`agent/scheduler-run.ts`) is also the only one that can refuse to run it.
   */
  jobExhausted(jobId: string, capUsd: number | null): boolean {
    if (capUsd === null) return false;
    return this.jobMonthUsd(jobId) >= capUsd;
  }

  /** Global gate, for the kernel. Tenant gates go through `tenantExhausted`. */
  exhausted(): boolean {
    return this.monthToDateUsd() >= this.caps.monthlyUsd;
  }

  /**
   * The daily cap, and it does not apply to the owner — deliberately.
   *
   * The docstring at the top of this file says what the cap is for in one
   * sentence: *"the per-tenant daily cap protects against a group that starts
   * talking to itself"*, and *"groups are the noisy ones"*. Applied to `host`
   * as well, the same number becomes a ceiling on the owner's own working day:
   * two dollars is roughly fifteen frontier turns, so the cap written to stop
   * an echo loop would instead stop the owner by mid-morning — and DAY-1 is
   * measured in days of ordinary use. The monthly cap is the owner's ceiling.
   *
   * This is the one interpretive choice in wiring the cap up, so it is written
   * here rather than left in a commit message: the sealed number means "per
   * *remote* tenant per day". Widening it to the owner is a one-line change and
   * a reseal, and it should be a decision, not a side effect.
   */
  tenantExhausted(tenant: string): boolean {
    if (tenant === HOST_TENANT) return false;
    return this.tenantTodayUsd(tenant) >= this.caps.perTenantDailyUsd;
  }

  /**
   * Reports the crossing exactly once: an agent that repeats "budget finito"
   * on every turn is an agent you mute, and then you miss the next thing.
   */
  status(): BudgetStatus {
    const monthUsd = this.monthToDateUsd();
    const exhausted = monthUsd >= this.caps.monthlyUsd;
    const justCrossed = exhausted && !this.wasExhausted ? ('monthly' as const) : null;
    this.wasExhausted = exhausted;
    return { monthUsd, monthlyCapUsd: this.caps.monthlyUsd, exhausted, justCrossed };
  }
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function month(d: Date): string {
  return d.toISOString().slice(0, 7);
}
