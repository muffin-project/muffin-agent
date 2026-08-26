import type Database from 'better-sqlite3';
import { ensureColumn } from '../../core/lock/durable.js';

/**
 * The inbox: every native Telegram update lands here before its offset is
 * confirmed. Evidence is recorded before anything is decided about it.
 *
 * The load-bearing order is:
 *
 *   1. `getUpdates` returns a batch;
 *   2. the batch is written durably in one transaction;
 *   3. only then does the Telegram offset advance;
 *   4. semantic consumption may fail, retry or resume after a restart.
 *
 * `update_id` is therefore the native-event idempotency key. It is deliberately
 * NOT the Work identity (ADR-0052). Between the event row and a Turn/Work lives
 * a surface-owned composition:
 *
 *   telegram_updates.update_id
 *       -> telegram_updates.composition_id
 *       -> telegram_compositions.composition_id
 *       -> telegram_compositions.work_id
 *
 * The first assembler policy is still singleton: when the connector asks to
 * bind an uncomposed update, `bind()` gives it a deterministic fallback
 * composition of its own. That is a policy, not a schema invariant. A future
 * Telegram assembler can call `include()` first for N updates and then the same
 * `bind()` seals that shared composition into one Work without changing the
 * crash-recovery protocol.
 *
 * `StoredUpdate.turnId` is kept as the connector-facing recovery view because a
 * Turn is the concrete Work identity today. It is derived through the join
 * above; there is no `update_id -> turn_id` column in the current schema.
 */

const TELEGRAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id     INTEGER PRIMARY KEY,
  payload       TEXT    NOT NULL,
  received_at   TEXT    NOT NULL,
  -- NULL until semantic consumption has completed. Recovery is exactly
  -- "everything where this is NULL".
  processed_at  TEXT,
  /** Set when processing failed for a reason worth seeing rather than retrying blindly. */
  failure       TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_pending ON telegram_updates(processed_at, update_id);

-- Surface-local composition state. This is not a generic event bus and not an
-- intents table: it exists only to preserve the parentage ADR-0052 requires
-- between native Telegram evidence and the concrete Work eventually created.
CREATE TABLE IF NOT EXISTS telegram_compositions (
  composition_id TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  work_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_composition_work ON telegram_compositions(work_id);

-- The confirmed offset, so a restart does not re-ask for what it already has.
-- One row, and the connector name is the key: a second connector gets its own.
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
  /** `null` until this update's composition has been sealed into a durable Work/Turn. */
  turnId: string | null;
  /** `null` until this native event's delivery/semantic consumption has settled. */
  settledAt: string | null;
};

export type CompositionBinding = {
  compositionId: string;
  workId: string | null;
};

export class UpdateInbox {
  private readonly includeStmt: Database.Statement;
  private readonly bindWorkStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly membershipStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly connector = 'telegram',
  ) {
    db.exec(TELEGRAM_SCHEMA);

    // Additive on databases written before this slice. NULL means exactly what
    // it should: the event has been received, but no assembler has included it
    // in a composition yet / no settlement has happened yet.
    ensureColumn(db, 'telegram_updates', 'composition_id', 'composition_id TEXT');
    ensureColumn(db, 'telegram_updates', 'settled_at', 'settled_at TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telegram_composition ON telegram_updates(composition_id, update_id);`);

    this.includeStmt = db.prepare(
      `UPDATE telegram_updates
       SET composition_id = ?
       WHERE update_id = ? AND composition_id IS NULL`,
    );
    this.bindWorkStmt = db.prepare(
      `UPDATE telegram_compositions
       SET work_id = ?
       WHERE composition_id = ? AND work_id IS NULL`,
    );
    this.membershipStmt = db.prepare(
      `SELECT composition_id AS compositionId, received_at AS receivedAt
       FROM telegram_updates WHERE update_id = ?`,
    );
    this.getStmt = db.prepare(
      `SELECT u.update_id AS updateId,
              u.payload,
              u.received_at AS receivedAt,
              c.work_id AS turnId,
              u.settled_at AS settledAt
       FROM telegram_updates u
       LEFT JOIN telegram_compositions c ON c.composition_id = u.composition_id
       WHERE u.update_id = ?`,
    );

    this.migrateLegacyDirectTurnBindings();
  }

  /**
   * Include one native event in a surface composition, first-writer-wins.
   *
   * This is intentionally separate from `bind`: a crash after inclusion and
   * before Work materialisation is a valid durable state, not a half-write to
   * hide. The next pass can see the same composition and finish sealing it.
   *
   * Multiple update ids may therefore return the same `compositionId`; one
   * update id can never be silently moved to another composition by a retry.
   */
  include(updateId: number, compositionId: string): string {
    if (compositionId.trim() === '') throw new Error('composition_id Telegram vuoto');

    this.includeStmt.run(compositionId, updateId);
    const row = this.membershipStmt.get(updateId) as
      | { compositionId: string | null; receivedAt: string }
      | undefined;
    if (!row) throw new Error(`telegram_updates mancante durante include per ${updateId}`);
    if (row.compositionId === null) throw new Error(`telegram_updates senza composition_id dopo include per ${updateId}`);

    this.db
      .prepare(`INSERT OR IGNORE INTO telegram_compositions (composition_id, created_at) VALUES (?, ?)`)
      .run(row.compositionId, row.receivedAt);
    return row.compositionId;
  }

  /**
   * Seal this update's composition into one concrete Work/Turn identity.
   *
   * The connector still calls this `bind(updateId, turnId)` because Turn is the
   * concrete Work implementation today, but the first-writer-wins guard lives
   * on `telegram_compositions.work_id`, not on the native event row. If an
   * assembler has already placed several updates in one composition, binding
   * any member makes every member resolve to the same Work through `get()`.
   *
   * If no assembler has acted yet, the fallback composition is deterministic
   * and surface-qualified. That keeps today's singleton behaviour while
   * leaving N-events -> 1-Work representable without a schema migration.
   */
  bind(updateId: number, turnId: string): string {
    const compositionId = this.include(updateId, this.defaultCompositionId(updateId));
    this.bindWorkStmt.run(turnId, compositionId);
    const binding = this.compositionOf(updateId);
    if (!binding || binding.workId === null) {
      throw new Error(`telegram composition senza work_id dopo bind per update ${updateId}`);
    }
    return binding.workId;
  }

  /** The durable parentage of one native event, for recovery/tests/future assembler wiring. */
  compositionOf(updateId: number): CompositionBinding | null {
    const row = this.db
      .prepare(
        `SELECT u.composition_id AS compositionId, c.work_id AS workId
         FROM telegram_updates u
         LEFT JOIN telegram_compositions c ON c.composition_id = u.composition_id
         WHERE u.update_id = ?`,
      )
      .get(updateId) as { compositionId: string | null; workId: string | null } | undefined;
    if (!row || row.compositionId === null) return null;
    return { compositionId: row.compositionId, workId: row.workId };
  }

  /**
   * Marks semantic consumption/delivery settled.
   *
   * Once a composition has a Work, settlement belongs to that semantic unit:
   * every native event that fed the Work is settled together. Before Work seal,
   * however, composition membership is only an assembler fact; settling one
   * member must not consume its siblings accidentally. `COALESCE` preserves the
   * first settlement timestamp across retries.
   */
  settle(updateId: number, at: string): void {
    this.db
      .prepare(
        `UPDATE telegram_updates
         SET settled_at = COALESCE(settled_at, ?)
         WHERE update_id = ?
            OR composition_id = (
              SELECT u.composition_id
              FROM telegram_updates u
              JOIN telegram_compositions c ON c.composition_id = u.composition_id
              WHERE u.update_id = ? AND c.work_id IS NOT NULL
            )`,
      )
      .run(at, updateId, updateId);
  }

  /** This update's own row, with Work binding derived through its composition. */
  get(updateId: number): StoredUpdate | null {
    const row = this.getStmt.get(updateId) as StoredUpdate | undefined;
    return row ?? null;
  }

  /**
   * Writes a batch and advances the offset in one transaction.
   *
   * Writing without advancing can cause a redelivery (harmless: the PK absorbs
   * it). Advancing without writing loses a message permanently, so those two
   * writes are never separable.
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

  /** Everything not yet finished with, oldest native event first. */
  pending(limit = 50): StoredUpdate[] {
    return this.db
      .prepare(
        `SELECT u.update_id AS updateId,
                u.payload,
                u.received_at AS receivedAt,
                c.work_id AS turnId,
                u.settled_at AS settledAt
         FROM telegram_updates u
         LEFT JOIN telegram_compositions c ON c.composition_id = u.composition_id
         WHERE u.processed_at IS NULL
         ORDER BY u.update_id LIMIT ?`,
      )
      .all(limit) as StoredUpdate[];
  }

  /**
   * A sealed composition is one semantic consumption unit, so completion of its
   * Work clears all member events. An unsealed composition is only membership:
   * marking one native event processed cannot silently erase its siblings.
   * Pairing updates are uncomposed and therefore affect only their own row.
   */
  markProcessed(updateId: number, at: string): void {
    this.db
      .prepare(
        `UPDATE telegram_updates
         SET processed_at = ?, failure = NULL
         WHERE update_id = ?
            OR composition_id = (
              SELECT u.composition_id
              FROM telegram_updates u
              JOIN telegram_compositions c ON c.composition_id = u.composition_id
              WHERE u.update_id = ? AND c.work_id IS NOT NULL
            )`,
      )
      .run(at, updateId, updateId);
  }

  /** A failure is evidence about this native event; it stays pending for retry. */
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

  private defaultCompositionId(updateId: number): string {
    return `${this.connector}:update:${updateId}`;
  }

  /**
   * The old #78 branch was dogfood-able before ADR-0052 existed and wrote a
   * nullable `turn_id` directly on `telegram_updates`. It never reached `dev`,
   * but migrating it costs little and avoids turning a branch switch into
   * duplicate work on an owner's real database.
   *
   * We preserve the old work binding by interposing the deterministic fallback
   * composition. The old column is left in place (SQLite additive migration);
   * current code never reads it afterwards.
   */
  private migrateLegacyDirectTurnBindings(): void {
    const columns = (this.db.prepare(`PRAGMA table_info(telegram_updates)`).all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('turn_id')) return;

    const legacy = this.db
      .prepare(
        `SELECT update_id AS updateId, received_at AS receivedAt, turn_id AS turnId
         FROM telegram_updates
         WHERE turn_id IS NOT NULL AND composition_id IS NULL`,
      )
      .all() as { updateId: number; receivedAt: string; turnId: string }[];
    if (legacy.length === 0) return;

    const setComposition = this.db.prepare(
      `UPDATE telegram_updates SET composition_id = ? WHERE update_id = ? AND composition_id IS NULL`,
    );
    const insertComposition = this.db.prepare(
      `INSERT OR IGNORE INTO telegram_compositions (composition_id, created_at, work_id) VALUES (?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const row of legacy) {
        const compositionId = this.defaultCompositionId(row.updateId);
        setComposition.run(compositionId, row.updateId);
        insertComposition.run(compositionId, row.receivedAt, row.turnId);
      }
    });
    tx();
  }
}
