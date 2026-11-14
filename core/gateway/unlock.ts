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

/** The claim on the row, or null when nothing is holding it. Creates nothing. */
export function readGatewayClaim(db: Database.Database): GatewayClaim | null {
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
 * Fenced on the pid and, when the column exists, the holder id that were
 * read. `changes === 0` means the row moved: a new holder won between the
 * probe and the write, and this function did not remove them.
 */
export function clearGatewayClaim(
  db: Database.Database,
  claim: { pid: number; holderId: string | null },
): number {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(gateway_lock)`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (columns.has('holder_id')) {
    return db
      .prepare(
        `UPDATE gateway_lock SET pid = NULL, holder_id = NULL WHERE id = 1 AND pid IS ? AND holder_id IS ?`,
      )
      .run(claim.pid, claim.holderId).changes;
  }
  return db.prepare(`UPDATE gateway_lock SET pid = NULL WHERE id = 1 AND pid IS ?`).run(claim.pid)
    .changes;
}
