import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { TelegramError, type TelegramApiLike } from './api.js';

type TelegramDeliveryStatus = 'pending' | 'attempting' | 'sent' | 'rejected' | 'possibly_sent';
export type TelegramDeliveryOutcome = 'sent' | 'possibly_sent' | 'deferred';

export type TelegramDeliveryPart = {
  turnId: string;
  partIndex: number;
  operation: 'send' | 'edit';
  chatId: number;
  /** Il topic del forum, o `null` fuori da un forum. Vedi `SendOptions.threadId`. */
  threadId: number | null;
  replyTo: number | null;
  editMessageId: number | null;
  html: string;
  status: TelegramDeliveryStatus;
  attemptId: string | null;
  telegramMessageId: number | null;
  error: string | null;
};

export type TelegramDeliveryPlanPart = Pick<
  TelegramDeliveryPart,
  'operation' | 'chatId' | 'threadId' | 'replyTo' | 'editMessageId' | 'html'
>;

const TELEGRAM_DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_delivery_parts (
  turn_id              TEXT NOT NULL,
  part_index           INTEGER NOT NULL CHECK (part_index >= 0),
  operation            TEXT NOT NULL CHECK (operation IN ('send','edit')),
  chat_id              INTEGER NOT NULL,
  thread_id            INTEGER,
  reply_to             INTEGER,
  edit_message_id      INTEGER,
  html                  TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('pending','attempting','sent','rejected','possibly_sent')),
  attempt_id            TEXT,
  telegram_message_id   INTEGER,
  error                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (turn_id, part_index)
);
CREATE INDEX IF NOT EXISTS idx_telegram_delivery_status
  ON telegram_delivery_parts(status, updated_at);
`;

/**
 * The surface-owned write-ahead record for Telegram's non-idempotent sends.
 *
 * `attempting` means the intent was durable before the HTTP request started.
 * On a fresh process it cannot be distinguished from "Telegram accepted it and
 * the process died before recording the response", so constructor recovery
 * turns it into the terminal, operator-visible `possibly_sent` state. It must
 * never silently become `pending` again.
 */
export class TelegramDeliveryStore {
  constructor(private readonly db: Database.Database) {
    db.exec(TELEGRAM_DELIVERY_SCHEMA);
    // `CREATE TABLE IF NOT EXISTS` non tocca una tabella che esiste già,
    // quindi su un database installato prima di questa colonna lo schema
    // sopra è un no-op e ogni INSERT qui sotto fallirebbe. L'ALTER è
    // idempotente perché la condizione è la presenza della colonna, non il
    // numero di versione di qualcosa.
    const colonne = db.prepare(`PRAGMA table_info(telegram_delivery_parts)`).all() as { name: string }[];
    if (!colonne.some((c) => c.name === 'thread_id')) {
      db.exec(`ALTER TABLE telegram_delivery_parts ADD COLUMN thread_id INTEGER`);
    }
    db.prepare(
      `UPDATE telegram_delivery_parts
       SET status = 'possibly_sent',
           error = COALESCE(error, 'processo interrotto durante il tentativo'),
           updated_at = @now
       WHERE status = 'attempting'`,
    ).run({ now: new Date().toISOString() });
  }

  /**
   * Freeze the exact wire payload before the first effect. If recovery finds a
   * plan, that plan wins byte-for-byte over a render produced by newer code.
   */
  plan(turnId: string, requested: TelegramDeliveryPlanPart[], at: string): TelegramDeliveryPart[] {
    if (requested.length === 0) throw new Error(`telegram delivery senza parti per ${turnId}`);
    const existing = this.parts(turnId);
    if (existing.length > 0) {
      const first = requested[0]!;
      if (existing[0]!.chatId !== first.chatId) {
        throw new Error(`telegram delivery ${turnId} già pianificata per un'altra chat`);
      }
      return existing;
    }

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO telegram_delivery_parts
         (turn_id, part_index, operation, chat_id, thread_id, reply_to, edit_message_id, html,
          status, created_at, updated_at)
       VALUES
         (@turnId, @partIndex, @operation, @chatId, @threadId, @replyTo, @editMessageId, @html,
          'pending', @at, @at)`,
    );
    this.db.transaction(() => {
      requested.forEach((part, partIndex) => insert.run({ turnId, partIndex, ...part, at }));
    })();
    return this.parts(turnId);
  }

  parts(turnId: string): TelegramDeliveryPart[] {
    return this.db
      .prepare(
        `SELECT turn_id AS turnId, part_index AS partIndex, operation, chat_id AS chatId,
                thread_id AS threadId,
                reply_to AS replyTo, edit_message_id AS editMessageId, html, status,
                attempt_id AS attemptId, telegram_message_id AS telegramMessageId, error
         FROM telegram_delivery_parts
         WHERE turn_id = ? ORDER BY part_index`,
      )
      .all(turnId) as TelegramDeliveryPart[];
  }

  claim(turnId: string, partIndex: number, attemptId: string, at: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE telegram_delivery_parts
           SET status = 'attempting', attempt_id = ?, error = NULL, updated_at = ?
           WHERE turn_id = ? AND part_index = ? AND status IN ('pending','rejected')`,
        )
        .run(attemptId, at, turnId, partIndex).changes === 1
    );
  }

  sent(turnId: string, partIndex: number, attemptId: string, messageId: number | null, at: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE telegram_delivery_parts
           SET status = 'sent', telegram_message_id = ?, error = NULL, updated_at = ?
           WHERE turn_id = ? AND part_index = ? AND status = 'attempting' AND attempt_id = ?`,
        )
        .run(messageId, at, turnId, partIndex, attemptId).changes === 1
    );
  }

  rejected(turnId: string, partIndex: number, attemptId: string, reason: string, at: string): void {
    this.finishAttempt(turnId, partIndex, attemptId, 'rejected', reason, at);
  }

  possiblySent(turnId: string, partIndex: number, attemptId: string, reason: string, at: string): void {
    this.finishAttempt(turnId, partIndex, attemptId, 'possibly_sent', reason, at);
  }

  private finishAttempt(
    turnId: string,
    partIndex: number,
    attemptId: string,
    status: 'rejected' | 'possibly_sent',
    reason: string,
    at: string,
  ): void {
    this.db
      .prepare(
        `UPDATE telegram_delivery_parts
         SET status = ?, error = ?, updated_at = ?
         WHERE turn_id = ? AND part_index = ? AND status = 'attempting' AND attempt_id = ?`,
      )
      .run(status, reason, at, turnId, partIndex, attemptId);
  }
}

/**
 * Execute a frozen plan sequentially. Confirmed earlier parts are skipped;
 * uncertainty on one part stops the suffix instead of replaying the prefix.
 */
export async function deliverTelegram(
  store: TelegramDeliveryStore,
  api: TelegramApiLike,
  turnId: string,
  requested: TelegramDeliveryPlanPart[],
  now: () => string,
): Promise<TelegramDeliveryOutcome> {
  const parts = store.plan(turnId, requested, now());
  for (const part of parts) {
    if (part.status === 'sent') continue;
    if (part.status === 'possibly_sent') return 'possibly_sent';
    if (part.status === 'attempting') return 'deferred';

    const attemptId = randomBytes(16).toString('hex');
    if (!store.claim(turnId, part.partIndex, attemptId, now())) return 'deferred';

    try {
      const response =
        part.operation === 'edit'
          ? await api.editMessageText(part.chatId, part.editMessageId!, part.html)
          : await api.sendMessage(part.chatId, part.html, {
              // Su **ogni** pezzo, non solo sul primo: `reply_parameters`
              // porta nel topic soltanto il messaggio che cita.
              ...(part.threadId === null ? {} : { threadId: part.threadId }),
              ...(part.replyTo === null ? {} : { replyTo: part.replyTo }),
            });
      const messageId =
        typeof response === 'object' && response !== null && 'message_id' in response &&
        typeof response.message_id === 'number'
          ? response.message_id
          : part.editMessageId;
      if (!store.sent(turnId, part.partIndex, attemptId, messageId, now())) {
        return 'possibly_sent';
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof TelegramError && error.status > 0) {
        store.rejected(turnId, part.partIndex, attemptId, reason, now());
        throw error;
      }
      store.possiblySent(turnId, part.partIndex, attemptId, reason, now());
      return 'possibly_sent';
    }
  }
  return 'sent';
}
