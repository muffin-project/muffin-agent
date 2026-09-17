import type Database from 'better-sqlite3';
import type { ProactiveDecision, ProactiveKind } from './proactivity.js';

/**
 * Every proactive gate evaluation, durably, with its discriminated reason.
 *
 * `FireLog` (`firelog.ts`) answers "already spoken, don't repeat" — it records
 * allows that reached the owner (and permanent tainted denies), and deliberately
 * never records defers. This table answers a different question: "what did the
 * gate decide, when, and why" — including defers and skips, which are exactly
 * the silences the old Muffin could never interrogate ("why did you stay
 * quiet?"). The two tables must not be merged: one is dedup state that shapes
 * future behaviour, the other is history that explains past behaviour.
 *
 * Rows are never deleted (invariant §I-8) and never re-decided: a `defer` row
 * does not silence anything, it only remembers that at this time the gate said
 * "not now". The next pass decides again and writes its own row — unless the
 * decision is identical to the anchor's latest, in which case the write is
 * skipped. That transition rule is what keeps a 30-second tick from writing
 * 2 880 identical rows a day while still showing every change of mind.
 *
 * Falsifier for the whole table (DT-10): if nothing reads these rows in 30
 * days, delete this module — an unread log is ceremony, not proprioception.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proactive_decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  decided_at TEXT NOT NULL,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  anchor     TEXT NOT NULL,
  tenant_id  TEXT NOT NULL DEFAULT 'host',
  tier       INTEGER NOT NULL,
  channel    TEXT NOT NULL,
  effect     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  until_at   TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive_decisions_anchor
  ON proactive_decisions(anchor, id DESC);
`;

/**
 * Additive migration for tables created before the tenant column existed
 * (slice/tenant-anchors). The table is days old and observability-only; rows
 * that predate the column keep the host default. Never DROP: rows are history
 * (§I-8), even when the history is young.
 */
function ensureTenantColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(proactive_decisions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'tenant_id')) {
    db.exec(`ALTER TABLE proactive_decisions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'host'`);
  }
}

export type DecisionSource = 'observe' | 'commitments';

export type DecisionEffect = ProactiveDecision['effect'] | 'skip';

export type Decision = {
  decidedAt: Date;
  source: DecisionSource;
  kind: ProactiveKind;
  anchor: string;
  /** Owning tenant. Anchors are namespaced by it, so transitions never cross rooms. */
  tenant: string;
  tier: number;
  channel: string;
  effect: DecisionEffect;
  /** Discriminated code: 'allow' | 'tainted_source' | 'quiet_hours' | 'budget' | 'already_fired'. */
  reason: string;
  /** Only for `defer`: when the gate said to come back. */
  untilAt?: Date;
};

type Row = {
  id: number;
  decided_at: string;
  source: string;
  kind: string;
  anchor: string;
  tenant_id: string;
  tier: number;
  channel: string;
  effect: string;
  reason: string;
  until_at: string | null;
};

function toDecision(row: Row): Decision {
  return {
    decidedAt: new Date(row.decided_at),
    source: row.source as DecisionSource,
    kind: row.kind as ProactiveKind,
    anchor: row.anchor,
    tenant: row.tenant_id,
    tier: row.tier,
    channel: row.channel,
    effect: row.effect as DecisionEffect,
    reason: row.reason,
    ...(row.until_at === null ? {} : { untilAt: new Date(row.until_at) }),
  };
}

/** Split a gate decision into the storable (effect, reason, until) triple. */
export function decisionParts(
  decision: ProactiveDecision | { effect: 'skip'; reason: 'already_fired' },
): {
  effect: DecisionEffect;
  reason: string;
  untilAt?: Date;
} {
  if (decision.effect === 'allow') return { effect: 'allow', reason: 'allow' };
  if (decision.effect === 'deny') return { effect: 'deny', reason: decision.reason };
  if (decision.effect === 'skip') return { effect: 'skip', reason: decision.reason };
  return { effect: 'defer', reason: decision.reason, untilAt: decision.until };
}

export class DecisionLog {
  private readonly insertStmt: Database.Statement;
  private readonly latestStmt: Database.Statement;
  private readonly listStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(SCHEMA);
    ensureTenantColumn(db);
    this.insertStmt = db.prepare(
      `INSERT INTO proactive_decisions
        (decided_at, source, kind, anchor, tenant_id, tier, channel, effect, reason, until_at)
       VALUES (@decidedAt, @source, @kind, @anchor, @tenant, @tier, @channel, @effect, @reason, @untilAt)`,
    );
    this.latestStmt = db.prepare(
      `SELECT effect, reason, until_at FROM proactive_decisions
        WHERE anchor = ? ORDER BY id DESC LIMIT 1`,
    );
    this.listStmt = db.prepare(`SELECT * FROM proactive_decisions ORDER BY id DESC LIMIT ?`);
  }

  /**
   * Append, unless the anchor's latest row already says exactly this.
   * Returns true when a row was written.
   */
  record(d: Decision): boolean {
    const latest = this.latestStmt.get(d.anchor) as
      | { effect: string; reason: string; until_at: string | null }
      | undefined;
    const untilIso = d.untilAt?.toISOString() ?? null;
    if (
      latest !== undefined &&
      latest.effect === d.effect &&
      latest.reason === d.reason &&
      latest.until_at === untilIso
    ) {
      return false;
    }
    this.insertStmt.run({
      decidedAt: d.decidedAt.toISOString(),
      source: d.source,
      kind: d.kind,
      anchor: d.anchor,
      tenant: d.tenant,
      tier: d.tier,
      channel: d.channel,
      effect: d.effect,
      reason: d.reason,
      untilAt: untilIso,
    });
    return true;
  }

  /** Newest first. The reader `muffin observe --decisions` lives on this. */
  list(limit = 20): Decision[] {
    return (this.listStmt.all(limit) as Row[]).map(toDecision);
  }
}
