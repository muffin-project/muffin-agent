import type Database from 'better-sqlite3';

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
 */

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
  private wasExhausted = false;

  constructor(
    private readonly db: Database.Database,
    private readonly caps: BudgetCaps,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
    this.recordStmt = db.prepare(
      `INSERT INTO spend (tenant, capability, model, input_tokens, output_tokens, usd, day, month, created_at)
       VALUES (@tenant, @capability, @model, @inputTokens, @outputTokens, @usd, @day, @month, @createdAt)`,
    );
    this.monthStmt = db.prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE month = ?`);
    this.tenantDayStmt = db.prepare(
      `SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE tenant = ? AND day = ?`,
    );
  }

  record(entry: SpendRecord): void {
    const now = this.clock();
    this.recordStmt.run({
      ...entry,
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

  /** Global gate, for the kernel. Tenant gates go through `tenantExhausted`. */
  exhausted(): boolean {
    return this.monthToDateUsd() >= this.caps.monthlyUsd;
  }

  tenantExhausted(tenant: string): boolean {
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
