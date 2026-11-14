import type Database from 'better-sqlite3';
import { incarnationDir, incarnationOf, pidAlive, probeIncarnation } from '../lock/incarnation.js';

/**
 * Hand-release of `gateway_lock`, for a row whose holder is already gone.
 *
 * This is not `heldBy` and not `DurableLock.release`. `heldBy` refuses to
 * expire a future `taken_at` on a live holder, and `release` only clears a
 * pid the caller itself holds. The owner asked for the opposite guard: do
 * not evict a process whose ADR-0094 incarnation lock is still held, and do
 * clear a row that lock says is stale. No tolerance is added to the stamp.
 *
 * The row is not deleted. `since` stays, so "when did a gateway last run
 * here" survives the same way a normal release does. What is removed is the
 * claim: `pid` and `holder_id`.
 *
 * A table that has no `holder_id` column is not cleared. ADR-0035 fences a
 * later holder with that token, and ADR-0094 keeps the incarnation id inside
 * it. A pid by itself is neither: a restarted process can reuse the number
 * between the probe and the write. The gateway adds the column when a current
 * build opens the database (`DurableLock`'s `ensureColumn`). Until then this
 * command refuses.
 */
export type GatewayClaim = {
  pid: number;
  holderId: string | null;
  takenAt: string | null;
  since: string | null;
  status: string | null;
};

export type UnlockVerdict =
  | { action: 'absent' }
  | { action: 'refuse'; claim: GatewayClaim; reason: string }
  | { action: 'release'; claim: GatewayClaim };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function gatewayLockColumns(db: Database.Database): Set<string> | null {
  const table = db
    .prepare(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'gateway_lock'`)
    .get();
  if (table === undefined) return null;
  return new Set(
    (db.prepare(`PRAGMA table_info(gateway_lock)`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
}

/**
 * Why a table without `holder_id` is not a candidate for a hand-release.
 * Shown as-is by `muffin gateway unlock`. The remedy is a current process,
 * which adds the column; this command does not.
 */
const UNFENCED_GATEWAY_LOCK =
  'gateway_lock non ha la colonna holder_id. ' +
  'Non si sgombera un claim solo dal pid: un processo che riparte può riprendersi ' +
  "lo stesso numero fra il controllo e la scrittura, e senza holder_id non c'è " +
  "né il recinto né l'incarnazione. Avvia un Muffin corrente — il gateway aggiunge " +
  'la colonna quando apre il database — e riprova `muffin gateway unlock`.';

/** The claim on the row, or null when nothing is holding it. Creates nothing. */
function readGatewayClaim(db: Database.Database): GatewayClaim | null {
  const table = db
    .prepare(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'gateway_lock'`)
    .get();
  if (table === undefined) return null;
  const row = db.prepare(`SELECT * FROM gateway_lock WHERE id = 1`).get() as
    | Record<string, unknown>
    | undefined;
  if (row === undefined || typeof row.pid !== 'number') return null;
  return {
    pid: row.pid,
    holderId: text(row.holder_id),
    takenAt: text(row.taken_at),
    since: text(row.since),
    status: text(row.status),
  };
}

/**
 * Whether this row may be cleared by hand.
 *
 * Same order as `holderLiveness`: an incarnation the kernel says is held is
 * a live holder, whatever the pid number and whatever `taken_at` says. A
 * probe that cannot answer falls back to the pid. A token with no
 * incarnation is the pid rule alone. Dead is the only "release".
 */
export function judgeGatewayUnlock(db: Database.Database): UnlockVerdict {
  const claim = readGatewayClaim(db);
  if (claim === null) return { action: 'absent' };

  // Before any liveness answer. A missing column cannot be probed as an
  // incarnation and cannot be fenced, so a dead pid is not permission to write.
  const columns = gatewayLockColumns(db);
  if (columns !== null && !columns.has('holder_id')) {
    return { action: 'refuse', claim, reason: UNFENCED_GATEWAY_LOCK };
  }

  const incarnation = incarnationOf(claim.holderId);
  const dir = incarnationDir(db);
  if (dir !== null && incarnation !== null) {
    const verdict = probeIncarnation(dir, incarnation);
    if (verdict === 'alive') {
      return {
        action: 'refuse',
        claim,
        reason:
          `l'incarnazione ${incarnation} è tenuta da un processo vivo ` +
          `(pid ${String(claim.pid)} sulla riga). Non si sgombera un detentore vivo: \`muffin gateway stop\``,
      };
    }
    if (verdict === 'unknown' && pidAlive(claim.pid)) {
      return {
        action: 'refuse',
        claim,
        reason:
          `l'incarnazione ${incarnation} non si sonda e il pid ${String(claim.pid)} risulta vivo. ` +
          'Non si sgombera',
      };
    }
    return { action: 'release', claim };
  }

  if (pidAlive(claim.pid)) {
    return {
      action: 'refuse',
      claim,
      reason:
        `la riga non porta un'incarnazione e il pid ${String(claim.pid)} risulta vivo. ` +
        'Non si sgombera un detentore vivo: `muffin gateway stop`',
    };
  }
  return { action: 'release', claim };
}

/**
 * Clear the claim that `judgeGatewayUnlock` just allowed.
 *
 * One immediate transaction, fenced on the pid and the holder id that were
 * read. A table without `holder_id` is not written: there is no pid-only
 * statement. `0` means nothing was removed — the row was re-taken, or it
 * cannot be fenced.
 */
export function clearGatewayClaim(
  db: Database.Database,
  claim: { pid: number; holderId: string | null },
): number {
  const clear = db.transaction((): number => {
    const columns = gatewayLockColumns(db);
    if (columns === null || !columns.has('holder_id')) return 0;
    const row = db
      .prepare(`SELECT pid, holder_id AS holderId FROM gateway_lock WHERE id = 1`)
      .get() as { pid: number | null; holderId: string | null } | undefined;
    if (row === undefined || row.pid !== claim.pid || (row.holderId ?? null) !== claim.holderId) {
      return 0;
    }
    return db
      .prepare(
        `UPDATE gateway_lock SET pid = NULL, holder_id = NULL WHERE id = 1 AND pid IS ? AND holder_id IS ?`,
      )
      .run(claim.pid, claim.holderId).changes;
  });
  return clear.immediate() as number;
}
