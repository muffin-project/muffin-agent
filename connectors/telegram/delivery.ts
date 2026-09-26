import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { TelegramError, type TelegramApiLike } from './api.js';
import type { OutboundRich } from './rich.js';

type TelegramDeliveryStatus = 'pending' | 'attempting' | 'sent' | 'rejected' | 'possibly_sent';
export type TelegramDeliveryOutcome = 'sent' | 'possibly_sent' | 'deferred';

/** One legacy chunk: exactly what `renderForTelegram`/`splitHtml` produced, bounded by `TELEGRAM_MAX`. */
export type TelegramDeliveryLegacyChunk = Pick<
  TelegramDeliveryPart,
  'operation' | 'chatId' | 'threadId' | 'replyTo' | 'editMessageId' | 'html'
>;

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
  /**
   * `'legacy'` (default) or `'rich'`. A rich row carries its payload in
   * `rich` and the pre-computed bounded legacy chunks in `fallback`, both
   * frozen at plan time: a deterministic rich rejection expands the SAME
   * chunks — never one giant send, never a re-render by newer code.
   */
  kind: 'legacy' | 'rich';
  /** The rich payload. Present only on rich rows; `html` holds a bounded forensic excerpt, never sent. */
  rich: OutboundRich | null;
  /** The legacy plan this rich row degrades to. Present only on rich rows. */
  fallback: TelegramDeliveryLegacyChunk[] | null;
  status: TelegramDeliveryStatus;
  attemptId: string | null;
  telegramMessageId: number | null;
  error: string | null;
};

export type TelegramDeliveryPlanPart = TelegramDeliveryLegacyChunk & {
  kind?: 'legacy' | 'rich';
  rich?: OutboundRich;
  fallback?: TelegramDeliveryLegacyChunk[];
};

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
  -- Bot API 10.3 rich lane. 'legacy' rows predate the lane and leave all
  -- three at their defaults; a rich row always carries both payloads.
  kind                  TEXT NOT NULL DEFAULT 'legacy' CHECK (kind IN ('legacy','rich')),
  rich_json             TEXT,
  fallback_json         TEXT,
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
    const colonne = db.prepare(`PRAGMA table_info(telegram_delivery_parts)`).all() as {
      name: string;
    }[];
    if (!colonne.some((c) => c.name === 'thread_id')) {
      db.exec(`ALTER TABLE telegram_delivery_parts ADD COLUMN thread_id INTEGER`);
    }
    // Additive, same shape as `thread_id` above: `CREATE TABLE IF NOT
    // EXISTS` is a no-op on pre-rich databases, so each column lands via its
    // own presence check. `kind` defaults to 'legacy', which is exactly what
    // every pre-existing row is.
    for (const [nome, ddl] of [
      ['kind', `ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy' CHECK (kind IN ('legacy','rich'))`],
      ['rich_json', 'ADD COLUMN rich_json TEXT'],
      ['fallback_json', 'ADD COLUMN fallback_json TEXT'],
    ] as const) {
      if (!colonne.some((c) => c.name === nome)) {
        db.exec(`ALTER TABLE telegram_delivery_parts ${ddl}`);
      }
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
   *
   * A rich part freezes BOTH payloads: the rich message and the bounded
   * legacy chunks it degrades to. The fallback is fixed here — never
   * re-rendered at rejection time, never a single oversized send.
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

    for (const part of requested) {
      if ((part.kind ?? 'legacy') === 'rich' && (part.rich === undefined || part.fallback === undefined || part.fallback.length === 0)) {
        throw new Error(`telegram delivery ${turnId}: parte rich senza payload o senza fallback limitato`);
      }
    }
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO telegram_delivery_parts
          (turn_id, part_index, operation, chat_id, thread_id, reply_to, edit_message_id, html,
           kind, rich_json, fallback_json,
           status, created_at, updated_at)
        VALUES
          (@turnId, @partIndex, @operation, @chatId, @threadId, @replyTo, @editMessageId, @html,
           @kind, @richJson, @fallbackJson,
           'pending', @at, @at)`,
    );
    this.db.transaction(() => {
      requested.forEach((part, partIndex) => {
        const kind = part.kind ?? 'legacy';
        insert.run({
          turnId,
          partIndex,
          operation: part.operation,
          chatId: part.chatId,
          threadId: part.threadId,
          replyTo: part.replyTo,
          editMessageId: part.editMessageId,
          // Rich rows keep a bounded excerpt for forensics; it is never sent.
          html: kind === 'rich' ? excerptOf(part) : part.html,
          kind,
          richJson: kind === 'rich' ? JSON.stringify(part.rich) : null,
          fallbackJson: kind === 'rich' ? JSON.stringify(part.fallback) : null,
          at,
        });
      });
    })();
    return this.parts(turnId);
  }

  parts(turnId: string): TelegramDeliveryPart[] {
    const rows = this.db
      .prepare(
        `SELECT turn_id AS turnId, part_index AS partIndex, operation, chat_id AS chatId,
                thread_id AS threadId,
                reply_to AS replyTo, edit_message_id AS editMessageId, html, kind,
                rich_json AS richJson, fallback_json AS fallbackJson, status,
                attempt_id AS attemptId, telegram_message_id AS telegramMessageId, error
         FROM telegram_delivery_parts
         WHERE turn_id = ? ORDER BY part_index`,
      )
      .all(turnId) as (Omit<TelegramDeliveryPart, 'kind' | 'rich' | 'fallback'> & {
      kind: string;
      richJson: string | null;
      fallbackJson: string | null;
    })[];
    return rows.map((row) => ({
      ...row,
      kind: row.kind === 'rich' ? 'rich' : 'legacy',
      rich: row.richJson === null ? null : (JSON.parse(row.richJson) as OutboundRich),
      fallback: row.fallbackJson === null ? null : (JSON.parse(row.fallbackJson) as TelegramDeliveryLegacyChunk[]),
    }));
  }

  /**
   * A deterministic rich rejection, expanded atomically: the rich row goes
   * `rejected` and its frozen legacy chunks become pending rows BEHIND it,
   * in one transaction. A crash anywhere in this statement leaves either
   * the rich row still `attempting` (recovery: `possibly_sent`, no
   * fallback sent twice) or the full expansion durable — never a rejected
   * rich row without its fallback, never a fallback without its rejection.
   *
   * Returns the inserted fallback rows, in send order.
   */
  expandFallback(
    turnId: string,
    partIndex: number,
    attemptId: string,
    reason: string,
    at: string,
  ): TelegramDeliveryPart[] {
    let inserted: TelegramDeliveryPart[] = [];
    this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE telegram_delivery_parts
           SET status = 'rejected', error = ?, updated_at = ?
           WHERE turn_id = ? AND part_index = ? AND status = 'attempting' AND attempt_id = ?`,
        )
        .run(reason, at, turnId, partIndex, attemptId).changes;
      if (changed !== 1) return;
      const row = this.db
        .prepare(`SELECT fallback_json AS fallbackJson FROM telegram_delivery_parts WHERE turn_id = ? AND part_index = ?`)
        .get(turnId, partIndex) as { fallbackJson: string | null };
      const fallback = row.fallbackJson === null ? [] : (JSON.parse(row.fallbackJson) as TelegramDeliveryLegacyChunk[]);
      const base = this.db
        .prepare(`SELECT COALESCE(MAX(part_index), -1) AS m FROM telegram_delivery_parts WHERE turn_id = ?`)
        .get(turnId) as { m: number };
      const insert = this.db.prepare(
        `INSERT INTO telegram_delivery_parts
            (turn_id, part_index, operation, chat_id, thread_id, reply_to, edit_message_id, html,
             kind, status, created_at, updated_at)
         VALUES
            (@turnId, @partIndex, @operation, @chatId, @threadId, @replyTo, @editMessageId, @html,
             'legacy', 'pending', @at, @at)`,
      );
      fallback.forEach((chunk, k) => {
        insert.run({
          turnId,
          partIndex: base.m + 1 + k,
          operation: chunk.operation,
          chatId: chunk.chatId,
          threadId: chunk.threadId,
          replyTo: chunk.replyTo,
          editMessageId: chunk.editMessageId,
          html: chunk.html,
          at,
        });
      });
      inserted = this.parts(turnId).filter((p) => p.partIndex > base.m);
    })();
    return inserted;
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

  sent(
    turnId: string,
    partIndex: number,
    attemptId: string,
    messageId: number | null,
    at: string,
  ): boolean {
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

  possiblySent(
    turnId: string,
    partIndex: number,
    attemptId: string,
    reason: string,
    at: string,
  ): void {
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
 *
 * Rich rows ride `sendRichMessage` / `editMessageRichText`. Their two
 * failure classes diverge, and the divergence is the whole point:
 *
 * - deterministic rejection (`TelegramError` with a real status, including
 *   the client-side protocol guard in `api.ts`): nothing was displayed, so
 *   the frozen legacy chunks expand into pending rows behind the rejected
 *   rich row and delivery continues with them — no loss, no giant send;
 * - ambiguous transport failure (status 0, unreadable response): Telegram
 *   may already have accepted the message, so the row goes `possibly_sent`
 *   and the suffix stops. NO fallback is sent: a fallback now would be the
 *   duplicate Hermes measured (retry after an accepted-but-unanswered
 *   request). Uncertainty is terminal and operator-visible, exactly as for
 *   legacy parts.
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
    if (part.status === 'rejected' && part.kind === 'rich') {
      // A deterministically rejected rich row: its fallback rows (appended
      // atomically by `expandFallback` below, or already present after a
      // crash) carry the work. Re-attempting the rich payload would loop on
      // a refusal Telegram has already pronounced.
      continue;
    }

    const attemptId = randomBytes(16).toString('hex');
    if (!store.claim(turnId, part.partIndex, attemptId, now())) return 'deferred';

    try {
      const response =
        part.kind === 'rich'
          ? await sendRich(api, part)
          : part.operation === 'edit'
            ? await api.editMessageText(part.chatId, part.editMessageId!, part.html)
            : await api.sendMessage(part.chatId, part.html, {
                // Su **ogni** pezzo, non solo sul primo: `reply_parameters`
                // porta nel topic soltanto il messaggio che cita.
                ...(part.threadId === null ? {} : { threadId: part.threadId }),
                ...(part.replyTo === null ? {} : { replyTo: part.replyTo }),
              });
      const messageId =
        typeof response === 'object' &&
        response !== null &&
        'message_id' in response &&
        typeof response.message_id === 'number'
          ? response.message_id
          : part.editMessageId;
      if (!store.sent(turnId, part.partIndex, attemptId, messageId, now())) {
        return 'possibly_sent';
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Un edit che Telegram rifiuta perché il testo è **già quello** non è
      // una consegna fallita: il messaggio sullo schermo è esattamente ciò
      // che volevamo scrivere. Succede a ogni riavvio del gateway: gli
      // update in sospeso vengono rielaborati e l'edit finale riscrive un
      // messaggio identico. Misurato sull'installazione dell'owner il 06/09
      // dopo `muffin update`: cinque `update … fallito — Telegram 400: Bad
      // Request: message is not modified` in un secondo, e `doctor` che
      // contava otto consegne non confermate per un testo che era già lì.
      // Vale per gli edit rich come per quelli legacy: stesso metodo, stessa
      // stringa stabile della Bot API.
      if (part.operation === 'edit' && isNotModified(error)) {
        if (!store.sent(turnId, part.partIndex, attemptId, part.editMessageId, now())) {
          return 'possibly_sent';
        }
        continue;
      }
      if (error instanceof TelegramError && error.status > 0) {
        if (part.kind === 'rich') {
          // Deterministic: Telegram refused the rich payload, so nothing was
          // displayed. Expand the frozen legacy chunks and keep delivering —
          // WITHOUT throwing: the turn still has a complete answer to give.
          // The rich row is `rejected` (skipped on every replay, never
          // re-attempted); the chunks are ordinary pending legacy rows.
          const extra = store.expandFallback(turnId, part.partIndex, attemptId, reason, now());
          if (extra.length === 0) {
            // The atomic expansion did not land (a concurrent attempt moved
            // the row under us): the rich row is neither rejected nor
            // expanded, so claiming success would be a lie. Uncertainty is
            // terminal and operator-visible, like every other ambiguous end.
            return 'possibly_sent';
          }
          parts.push(...extra);
          continue;
        }
        store.rejected(turnId, part.partIndex, attemptId, reason, now());
        throw error;
      }
      store.possiblySent(turnId, part.partIndex, attemptId, reason, now());
      return 'possibly_sent';
    }
  }
  return 'sent';
}

/** One rich attempt, send or transcript-owned edit. Thread/reply routing identical to the legacy path. */
function sendRich(api: TelegramApiLike, part: TelegramDeliveryPart): Promise<unknown> {
  if (part.rich === null) throw new Error(`telegram delivery: parte rich senza payload per ${part.turnId}`);
  if (part.operation === 'edit') {
    return api.editMessageRichText(part.chatId, part.editMessageId!, part.rich);
  }
  return api.sendRichMessage(part.chatId, part.rich, {
    ...(part.threadId === null ? {} : { threadId: part.threadId }),
    ...(part.replyTo === null ? {} : { replyTo: part.replyTo }),
  });
}

/**
 * Bounded forensic excerpt for a rich row's `html` column. Never sent —
 * `sendRich` reads `rich`, the legacy path reads frozen chunk rows.
 */
function excerptOf(part: TelegramDeliveryPlanPart): string {
  const rich = JSON.stringify(part.rich);
  return rich.length <= 1000 ? rich : `${rich.slice(0, 1000)}…`;
}

/**
 * `400 Bad Request: message is not modified` — la stringa stabile della Bot
 * API per un `editMessageText` con testo e markup identici a quelli già sul
 * messaggio. Solo su 400 e solo quel testo: ogni altro 4xx resta un rifiuto.
 */
function isNotModified(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    error.status === 400 &&
    /message is not modified/i.test(error.description)
  );
}
