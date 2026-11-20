import type Database from 'better-sqlite3';
import { holderLiveness, type Liveness } from './incarnation.js';

/**
 * A durable claim whose stamp is strictly ahead of the wall clock.
 *
 * `heldBy` subtracts `takenAt` from `now`. A future stamp makes that
 * difference negative, so the hard horizon never fires while the holder
 * still reads as alive (`core/lock/durable.ts`). No tolerance is applied
 * here either: any positive gap is the finding. The owner rejected a
 * tolerance; this module only reports the row.
 *
 * The turn claim has no `taken_at` column. `TurnStore` passes `updated_at`
 * to `heldBy` as `takenAt`, and that is the stamp this scan reads.
 */
export type FutureLockKind = 'gateway' | 'send' | 'ingest' | 'turn';

export type FutureLock = {
  kind: FutureLockKind;
  /** Turn id, or `"1"` for a singleton lock row. */
  id: string;
  pid: number | null;
  holderId: string | null;
  /** ISO stamp. For a turn this is `updated_at`. */
  takenAt: string;
  /** Strictly positive. Milliseconds the stamp sits ahead of `now`. */
  aheadMs: number;
  /**
   * ADR-0094 liveness of the named pid, or null when the row names none.
   * The same rule `gateway unlock` refuses on, so the remedy and the
   * command cannot disagree.
   */
  holderAlive: boolean | null;
};

const SINGLETONS: readonly { kind: Exclude<FutureLockKind, 'turn'>; table: string }[] = [
  { kind: 'gateway', table: 'gateway_lock' },
  { kind: 'send', table: 'send_lock' },
  { kind: 'ingest', table: 'ingest_lock' },
];

/** How far `takenAt` sits ahead of `nowMs`, or null when it does not. */
export function msAhead(takenAt: string | null | undefined, nowMs: number): number | null {
  if (typeof takenAt !== 'string' || takenAt.length === 0) return null;
  const parsed = Date.parse(takenAt);
  if (!Number.isFinite(parsed)) return null;
  const ahead = parsed - nowMs;
  return ahead > 0 ? ahead : null;
}

/** A duration an owner can read. Sub-second gaps stay in milliseconds: rounding them up would invent a second. */
export function formatAhead(aheadMs: number): string {
  if (aheadMs < 1000) return `${String(aheadMs)} ms`;
  const seconds = Math.round(aheadMs / 1000);
  if (seconds < 60) return `${String(seconds)} ${seconds === 1 ? 'secondo' : 'secondi'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? 'minuto' : 'minuti'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} ${hours === 1 ? 'ora' : 'ore'}`;
  return `${String(Math.round(hours / 24))} giorni`;
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db.prepare(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  );
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function asPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Every held durable claim whose stamp is in the future.
 *
 * A row with no pid is not a claim: `heldBy` returns null before it looks
 * at the stamp, and a freed row must not keep warning after `unlock`.
 * A running turn is a claim even when `claimed_by` is null — `reclaim`
 * still reads it. Missing tables are "nothing claimed", the same answer
 * `readGateway` gives a home that has never had a gateway. This function
 * creates nothing: `doctor` opens the database readonly.
 */
export function futureLockClaims(
  db: Database.Database,
  nowMs: number = Date.now(),
  alive: Liveness = holderLiveness(db),
): FutureLock[] {
  const found: FutureLock[] = [];
  for (const spec of SINGLETONS) {
    if (!tableExists(db, spec.table)) continue;
    const columns = columnsOf(db, spec.table);
    if (!columns.has('pid') || !columns.has('taken_at')) continue;
    const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id = 1`).get() as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) continue;
    const pid = asPid(row.pid);
    if (pid === null) continue;
    const takenAt = asText(row.taken_at);
    const aheadMs = msAhead(takenAt, nowMs);
    if (takenAt === null || aheadMs === null) continue;
    const holderId = columns.has('holder_id') ? asText(row.holder_id) : null;
    found.push({
      kind: spec.kind,
      id: '1',
      pid,
      holderId,
      takenAt,
      aheadMs,
      holderAlive: alive(pid, holderId),
    });
  }
  if (tableExists(db, 'turns')) {
    const columns = columnsOf(db, 'turns');
    if (columns.has('status') && columns.has('updated_at') && columns.has('id')) {
      const rows = db.prepare(`SELECT * FROM turns WHERE status = 'running'`).all() as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        const takenAt = asText(row.updated_at);
        const aheadMs = msAhead(takenAt, nowMs);
        if (takenAt === null || aheadMs === null) continue;
        const id = asText(row.id);
        if (id === null) continue;
        const pid = columns.has('claimed_by') ? asPid(row.claimed_by) : null;
        const holderId = columns.has('claim_token') ? asText(row.claim_token) : null;
        found.push({
          kind: 'turn',
          id,
          pid,
          holderId,
          takenAt,
          aheadMs,
          holderAlive: pid === null ? null : alive(pid, holderId),
        });
      }
    }
  }
  return found;
}

export function futureLockCheckName(claim: FutureLock): string {
  if (claim.kind === 'gateway') return 'lock gateway';
  if (claim.kind === 'send') return 'lock invio';
  if (claim.kind === 'ingest') return 'lock ingest';
  return `lock turno ${claim.id.slice(0, 12)}`;
}

function holderPhrase(claim: FutureLock): string {
  const who = claim.pid === null ? 'nessun pid' : `pid ${String(claim.pid)}`;
  const token = claim.holderId === null ? 'senza holder_id' : `holder ${claim.holderId}`;
  const live =
    claim.holderAlive === null
      ? ''
      : claim.holderAlive
        ? ', il detentore risulta vivo'
        : ', il detentore non risulta vivo';
  return `${who}, ${token}${live}`;
}

function stampPhrase(claim: FutureLock): string {
  const column = claim.kind === 'turn' ? 'updated_at (taken_at del claim)' : 'taken_at';
  return `${column} ${claim.takenAt} è ${formatAhead(claim.aheadMs)} nel futuro`;
}

/** Holder, distance, and the clock-step reading. The remedy is separate. */
export function futureLockDetail(claim: FutureLock): string {
  return (
    `${holderPhrase(claim)}, ${stampPhrase(claim)}. ` +
    "Un passo d'orologio è la causa probabile: non c'è tolleranza, e un taken_at nel futuro non scade finché il detentore risulta vivo"
  );
}

/** What to do. A live holder is stopped, never evicted. A stale gateway row is `unlock`. */
export function futureLockRemedy(claim: FutureLock): string {
  if (claim.kind === 'gateway' && claim.holderAlive === true) {
    return '`muffin gateway stop` — `muffin gateway unlock` rifiuta un detentore vivo e non tocca la riga';
  }
  if (claim.kind === 'gateway') {
    return "`muffin gateway unlock` mostra la riga; `muffin gateway unlock --confirm` la rilascia solo perché l'incarnazione non è tenuta";
  }
  if (claim.holderAlive === true) {
    return "ferma il processo che tiene l'incarnazione. Non c'è un unlock per questo lock, e l'orizzonte non lo fa scadere";
  }
  if (claim.kind === 'turn') {
    return "l'incarnazione non è tenuta: il prossimo avvio del gateway reclama il turno. Non c'è un unlock del turno";
  }
  return "l'incarnazione non è tenuta: il prossimo claim prende la riga. Non c'è un unlock per questo lock";
}
