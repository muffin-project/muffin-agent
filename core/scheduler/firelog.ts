import type Database from 'better-sqlite3';
import type { ProactiveDecision, ProactiveKind } from './proactivity.js';

/**
 * What Muffin has already spoken about, and when.
 *
 * `ProactiveTrigger.anchor` promised a consumer that "records fired anchors and
 * skips a repeat" and there was none, so every rail on *when* to speak stood
 * behind nothing on *how often*: the same silence would have been noticed again
 * on the next run, and the next — the old firehose reached through the front
 * door instead of the back.
 *
 * Durable rather than in-memory for the reason that decides it: a dedup that
 * lives in the process re-fires everything it knew at the first restart, which
 * on a personal agent is roughly daily.
 *
 * Rows are never deleted (invariant §I-8). This table is the only place that can
 * answer "what did you nudge me about in May", and an anchor whose row was
 * cleaned up is an anchor that speaks twice.
 */

// No index on `decided_at`: nothing in this slice queries by time — every read
// goes through the `anchor` primary key. The per-window rate limit that would
// use it is deliberately not being built here (inventing another unmeasured
// constant is what the research note warns against), so an index today is a
// write cost with no reader. It comes back with its query, not before.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS proactive_fires (
  anchor     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  effect     TEXT NOT NULL,
  reason     TEXT NOT NULL
);
`;

export type Fire = {
  /** The stable id of the concrete anchor. Primary key: one anchor, one fire. */
  anchor: string;
  kind: ProactiveKind;
  decidedAt: Date;
  /**
   * Three values in the type, **two** in the table since ADR-0060.
   *
   * `'allow'` — `recordFired` (`observe.ts`) and `recordCommitmentFired`: this
   * was said, and must not be said again.
   *
   * `'deny'` — `recordCommitmentDenied` (`commitments.ts`) only, and only for
   * `tainted_source`. The sentence this comment used to carry, *"the only
   * writer always records 'allow'"*, was true of one mechanism and became a
   * trap for the next: a dated commitment denied for its provenance is denied
   * on a number that only ever rises, so re-deciding it on every tick was pure
   * cost — and, with a per-pass ceiling, it starved the clean commitments
   * behind it. A decision that cannot change is a decision worth writing down.
   *
   * `'defer'` is still **never** written, and that is the line that has not
   * moved: "not now" has to stay re-decidable, or one quiet-hours pass would
   * become a permanent silence.
   */
  effect: ProactiveDecision['effect'];
  /** Short, and the evidence rather than prose: what made this worth saying. */
  reason: string;
};

type Row = { anchor: string; kind: string; decided_at: string; effect: string; reason: string };

export class FireLog {
  private readonly insertStmt: Database.Statement;
  private readonly hasStmt: Database.Statement;
  private readonly getStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(SCHEMA);
    // OR IGNORE, not OR REPLACE: two runs racing on the same anchor is benign,
    // but the row that stays has to be the fire that actually happened. Replacing
    // it would rewrite history (§I-8), and throwing would turn a harmless
    // re-entry into a crash in the middle of a run.
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO proactive_fires (anchor, kind, decided_at, effect, reason)
       VALUES (@anchor, @kind, @decidedAt, @effect, @reason)`,
    );
    this.hasStmt = db.prepare(`SELECT 1 FROM proactive_fires WHERE anchor = ?`);
    this.getStmt = db.prepare(`SELECT * FROM proactive_fires WHERE anchor = ?`);
  }

  has(anchor: string): boolean {
    return this.hasStmt.get(anchor) !== undefined;
  }

  /** The fire itself, so a surface can say *when* it already said this. */
  get(anchor: string): Fire | null {
    const row = this.getStmt.get(anchor) as Row | undefined;
    if (!row) return null;
    return {
      anchor: row.anchor,
      kind: row.kind as ProactiveKind,
      decidedAt: new Date(row.decided_at),
      effect: row.effect as Fire['effect'],
      reason: row.reason,
    };
  }

  record(fire: Fire): void {
    this.insertStmt.run({
      anchor: fire.anchor,
      kind: fire.kind,
      decidedAt: fire.decidedAt.toISOString(),
      effect: fire.effect,
      reason: fire.reason,
    });
  }
}
