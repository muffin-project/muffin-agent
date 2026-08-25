import type Database from 'better-sqlite3';
import { ensureColumn } from '../../core/lock/durable.js';

/**
 * The inbox: every update lands here before its offset is confirmed.
 *
 * This exists because of one sentence in the Bot API documentation — *"An update
 * is considered confirmed as soon as getUpdates is called with an offset higher
 * than its update_id"* — and one consequence nobody puts next to it: **Telegram
 * will never send it again.** So if the offset advances and the process dies
 * before the message is processed, that message is gone. Not delayed. Gone. And
 * it is not a failure any test produces, because tests do not crash halfway.
 *
 * So the order is fixed and it is the whole point of this file:
 *
 *   1. `getUpdates` returns a batch
 *   2. the batch is written here, durably, in one transaction
 *   3. **only then** the offset advances
 *   4. processing happens afterwards, and can fail, retry, or resume after a
 *      restart — because the evidence is already on disk
 *
 * `update_id` is the primary key, so a duplicate delivery — which happens when
 * step 3 fails after step 2 — is an `INSERT OR IGNORE` and not a second answer
 * to the same message.
 *
 * The same ethic as the memory plane: evidence is recorded before anything is
 * decided about it.
 *
 * ## `turn_id`/`settled_at` — the identity bridge ADR-0035 emendamento №5 already named
 *
 * *"Ogni `update_id` mappa a UNA sola identità durevole di turno"* (owner,
 * `slice/inbound-unit`'s mandate) is the same shape `core/scheduler/job-fires.ts`
 * proves for a job occurrence — `claim` → `bind` → `settle` — with one
 * simplification the job case does not have: **`accept()` already creates this
 * row before any handling starts**, so there is no separate `claim()` to write.
 * A `job_fires` row has to be created *by* the scheduler, because `jobs` only
 * holds the recurrence rule, not a row per occurrence; a Telegram update is
 * already one row per occurrence from the moment it lands. Two columns, added
 * with `ensureColumn` on the table this repo already ships, host the rest of
 * the same three-method shape (`bind`, `settle`, plus this class's own
 * pre-existing `pending`/`markProcessed` standing in for `claim`/settle's
 * schedule-advance) — not a second table, and not a shared framework with
 * `job_fires`: ADR-0035 emendamento №5 refuses the generalisation until a third
 * consumer exists, and two instances are not a third.
 */

export const TELEGRAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id     INTEGER PRIMARY KEY,
  payload       TEXT    NOT NULL,
  received_at   TEXT    NOT NULL,
  -- NULL until a turn has finished with it. The recovery query is exactly
  -- "everything where this is NULL", which is why it is a timestamp and not a
  -- boolean: knowing *when* it was handled is free here and answers a question
  -- a boolean cannot.
  processed_at  TEXT,
  /** Set when processing failed for a reason worth seeing rather than retrying blindly. */
  failure       TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_pending ON telegram_updates(processed_at, update_id);

-- The confirmed offset, so a restart does not re-ask for what it already has.
-- One row, and the connector name is the key: a second connector would have its
-- own, rather than silently sharing this one.
CREATE TABLE IF NOT EXISTS telegram_offset (
  connector     TEXT PRIMARY KEY,
  next_offset   INTEGER NOT NULL,
  updated_at    TEXT    NOT NULL
);
`;

export type StoredUpdate = {
  updateId: number;
  /** The raw update, exactly as Telegram sent it. Parsed by the caller, not here. */
  payload: string;
  receivedAt: string;
  /** `null` until this update is bound to a durable turn identity (`bind`). */
  turnId: string | null;
  /** `null` until this update's delivery has been settled (`settle`). */
  settledAt: string | null;
};

export class UpdateInbox {
  private readonly bindStmt: Database.Statement;
  private readonly settleStmt: Database.Statement;
  private readonly getStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly connector = 'telegram',
  ) {
    db.exec(TELEGRAM_SCHEMA);
    // Additive, for a database written before this slice — see
    // `ensureColumn`'s own docstring in `core/lock/durable.ts`. `NULL` on
    // every pre-existing row reads exactly as "not yet bound" / "not yet
    // settled", which is the truth for a row nobody has resolved this way
    // before today.
    ensureColumn(db, 'telegram_updates', 'turn_id', 'turn_id TEXT');
    ensureColumn(db, 'telegram_updates', 'settled_at', 'settled_at TEXT');
    // Guarded on `turn_id IS NULL`, exactly like `JobFireStore.bind`: whichever
    // caller's write lands first wins, and a loser's `changes === 0` is how
    // `bind` below knows to hand back the winner's id instead of its own —
    // never two turns for one update, even if two passes both decided this
    // update looked unbound at once.
    this.bindStmt = db.prepare(`UPDATE telegram_updates SET turn_id = ? WHERE update_id = ? AND turn_id IS NULL`);
    // Guarded on `settled_at IS NULL` for the same reason: idempotent under a
    // retry, and the first settlement is the one that counts.
    this.settleStmt = db.prepare(`UPDATE telegram_updates SET settled_at = ? WHERE update_id = ? AND settled_at IS NULL`);
    this.getStmt = db.prepare(
      `SELECT update_id AS updateId, payload, received_at AS receivedAt, turn_id AS turnId, settled_at AS settledAt
       FROM telegram_updates WHERE update_id = ?`,
    );
  }

  /**
   * First writer wins, and every caller — first or raced — gets back the id
   * that actually landed rather than the one it proposed. A caller that lost
   * never has a turn of its own to run: it asks what the winner's id is and
   * defers to it, which is what makes a second, competing turn for the same
   * update structurally unreachable rather than merely unlikely. Mirrors
   * `core/scheduler/job-fires.ts`'s `JobFireStore.bind` exactly.
   */
  bind(updateId: number, turnId: string): string {
    this.bindStmt.run(turnId, updateId);
    const row = this.getStmt.get(updateId) as { turnId: string | null } | undefined;
    if (!row || row.turnId === null) throw new Error(`telegram_updates senza turn_id dopo bind per ${updateId}`);
    return row.turnId;
  }

  /**
   * Marks this update's delivery fully settled. Idempotent, so a duplicate
   * drain or a retried delivery never moves `settled_at` a second time.
   * `TelegramConnector` calls this immediately before marking the update
   * processed and never after — the same ordering `core/scheduler/scheduler.ts`
   * uses for `job_fires` ("solo dopo il settlement avanza la schedule"),
   * applied to an update instead of a fire.
   */
  settle(updateId: number, at: string): void {
    this.settleStmt.run(at, updateId);
  }

  /** This update's own row, including its turn binding — for recovery and tests. */
  get(updateId: number): StoredUpdate | null {
    const row = this.getStmt.get(updateId) as StoredUpdate | undefined;
    return row ?? null;
  }

  /**
   * Writes a batch and advances the offset, in one transaction.
   *
   * One transaction because the two halves must not be separable: writing
   * without advancing means re-processing (harmless, the primary key absorbs
   * it), but advancing without writing means losing a message (silent, and
   * permanent). If the process dies inside this call, SQLite rolls back and
   * Telegram sends the batch again.
   *
   * Returns how many were new, which is how a duplicate delivery becomes
   * visible rather than invisible.
   */
  accept(updates: { update_id: number }[], receivedAt: string): { stored: number; duplicates: number } {
    if (updates.length === 0) return { stored: 0, duplicates: 0 };

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO telegram_updates (update_id, payload, received_at)
       VALUES (?, ?, ?)`,
    );
    const setOffset = this.db.prepare(
      `INSERT INTO telegram_offset (connector, next_offset, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(connector) DO UPDATE SET next_offset = excluded.next_offset, updated_at = excluded.updated_at`,
    );

    let stored = 0;
    const tx = this.db.transaction(() => {
      for (const update of updates) {
        const info = insert.run(update.update_id, JSON.stringify(update), receivedAt);
        if (info.changes > 0) stored += 1;
      }
      // Highest id in the batch plus one: the offset Telegram wants next.
      const highest = Math.max(...updates.map((u) => u.update_id));
      setOffset.run(this.connector, highest + 1, receivedAt);
    });
    tx();

    return { stored, duplicates: updates.length - stored };
  }

  /** Where to resume. Zero on a fresh install, which asks Telegram for its backlog. */
  nextOffset(): number {
    const row = this.db
      .prepare(`SELECT next_offset AS o FROM telegram_offset WHERE connector = ?`)
      .get(this.connector) as { o: number } | undefined;
    return row?.o ?? 0;
  }

  /**
   * Everything not yet finished with, oldest first.
   *
   * This is the recovery path and the normal path at once — there is no separate
   * "catch up after a crash" mode, because a mode that only runs after a crash
   * is a mode that is never exercised.
   */
  pending(limit = 50): StoredUpdate[] {
    return this.db
      .prepare(
        `SELECT update_id AS updateId, payload, received_at AS receivedAt, turn_id AS turnId, settled_at AS settledAt
         FROM telegram_updates WHERE processed_at IS NULL
         ORDER BY update_id LIMIT ?`,
      )
      .all(limit) as StoredUpdate[];
  }

  markProcessed(updateId: number, at: string): void {
    this.db
      .prepare(`UPDATE telegram_updates SET processed_at = ?, failure = NULL WHERE update_id = ?`)
      .run(at, updateId);
  }

  /**
   * Records a failure without marking the update done.
   *
   * It stays pending on purpose: an update that failed once may well succeed
   * after a restart, and dropping it would be the data loss this whole file
   * exists to prevent — arriving by a different road.
   */
  markFailed(updateId: number, reason: string): void {
    this.db.prepare(`UPDATE telegram_updates SET failure = ? WHERE update_id = ?`).run(reason, updateId);
  }

  stats(): { total: number; pending: number; failed: number } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      total: one(`SELECT count(*) AS n FROM telegram_updates`),
      pending: one(`SELECT count(*) AS n FROM telegram_updates WHERE processed_at IS NULL`),
      failed: one(`SELECT count(*) AS n FROM telegram_updates WHERE failure IS NOT NULL`),
    };
  }
}
