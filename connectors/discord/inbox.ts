import type Database from 'better-sqlite3';

/**
 * The inbox: every dispatch lands here before it is processed.
 *
 * `connectors/telegram/updates.ts` exists because Telegram will never resend a
 * confirmed update — so the write has to happen before the confirmation. The
 * Discord Gateway is a **worse** version of that same problem, not a
 * different one: it has no confirmation step to get wrong, no offset, no
 * backlog to ask for. A `MESSAGE_CREATE` dispatch is not durable *anywhere*
 * once it has left the socket, session Resume included — Resume replays what
 * the current session missed while briefly disconnected, not what a crashed
 * *process* never wrote down. So the same discipline applies one step
 * earlier: write first, in the handler `DiscordGateway.onDispatch` calls,
 * before anything about the message is interpreted — and if the process dies
 * between the write and the answer, a restart finds it in `pending()` and
 * tries again, exactly as `connectors/telegram/connector.ts`'s `drain()`
 * does.
 *
 * `message_id TEXT`, not `INTEGER` like Telegram's `update_id`: a Discord
 * snowflake is a 64-bit id carried as a string for the same reason every
 * other snowflake in this connector is (`connector.ts` explains it once,
 * where identity is decided) — `Number(id)` starts silently losing precision
 * past 2^53, and SQLite's own `INTEGER` affinity would invite exactly that
 * coercion the moment a caller was less careful than this file.
 */

export const DISCORD_SCHEMA = `
CREATE TABLE IF NOT EXISTS discord_messages (
  message_id    TEXT PRIMARY KEY,
  payload       TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  failure       TEXT
);
CREATE INDEX IF NOT EXISTS idx_discord_pending ON discord_messages(processed_at, message_id);
`;

export type StoredMessage = {
  messageId: string;
  /** The raw MESSAGE_CREATE payload, exactly as the gateway sent it. Parsed by the caller, not here. */
  payload: string;
  receivedAt: string;
};

export class DiscordInbox {
  constructor(private readonly db: Database.Database) {
    db.exec(DISCORD_SCHEMA);
  }

  /**
   * Writes one message. `INSERT OR IGNORE` on `message_id` absorbs the
   * duplicate that a `RESUMED` session or a rare Discord-side redelivery can
   * produce — a second arrival is a no-op here, not a second answer.
   *
   * Returns whether this was new, so a caller that only wants to act on the
   * first arrival can tell the two apart.
   */
  accept(messageId: string, raw: unknown, receivedAt: string): boolean {
    const info = this.db
      .prepare(`INSERT OR IGNORE INTO discord_messages (message_id, payload, received_at) VALUES (?, ?, ?)`)
      .run(messageId, JSON.stringify(raw), receivedAt);
    return info.changes > 0;
  }

  /** Everything not yet finished with, oldest first — the crash-recovery path and the normal path at once. */
  pending(limit = 50): StoredMessage[] {
    return this.db
      .prepare(
        `SELECT message_id AS messageId, payload, received_at AS receivedAt
         FROM discord_messages WHERE processed_at IS NULL
         ORDER BY message_id LIMIT ?`,
      )
      .all(limit) as StoredMessage[];
  }

  markProcessed(messageId: string, at: string): void {
    this.db.prepare(`UPDATE discord_messages SET processed_at = ?, failure = NULL WHERE message_id = ?`).run(at, messageId);
  }

  /** Stays pending on purpose — a message that failed once may succeed after a restart. */
  markFailed(messageId: string, reason: string): void {
    this.db.prepare(`UPDATE discord_messages SET failure = ? WHERE message_id = ?`).run(reason, messageId);
  }

  stats(): { total: number; pending: number; failed: number } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      total: one(`SELECT count(*) AS n FROM discord_messages`),
      pending: one(`SELECT count(*) AS n FROM discord_messages WHERE processed_at IS NULL`),
      failed: one(`SELECT count(*) AS n FROM discord_messages WHERE failure IS NOT NULL`),
    };
  }
}
