import type Database from 'better-sqlite3';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * State written before a private surface has proved who the owner is must not
 * disappear when pairing finally succeeds.
 *
 * The security boundary is intentionally asymmetric:
 *
 * - durable *evidence* and beliefs move to `host`, preserving their original
 *   trust tier and provenance;
 * - derived memory is dropped and rebuilt from that evidence under `host`;
 * - historical turns/todos/jobs are NOT promoted. They were created while the
 *   speaker was not authenticated, so making them host work after the fact
 *   would be an authority escalation disguised as a migration;
 * - the private transcript is merged into the canonical owner session without
 *   deleting either side first. Re-running after a crash is idempotent.
 *
 * This is deliberately keyed by the platform-authenticated conversation id,
 * never a display name or handle.
 */
export type OwnerAdoptionReport = {
  movedRows: number;
  transcriptRows: number;
};

const EVIDENCE_TABLES: readonly { table: string; tenantColumn: string }[] = [
  { table: 'episodes', tenantColumn: 'tenant_id' },
  { table: 'entities', tenantColumn: 'tenant_id' },
  { table: 'identities', tenantColumn: 'tenant_id' },
  { table: 'facts', tenantColumn: 'tenant_id' },
  { table: 'memory_review', tenantColumn: 'tenant_id' },
] as const;

const DERIVED_TABLES: readonly { table: string; tenantColumn: string }[] = [
  { table: 'profiles', tenantColumn: 'tenant_id' },
  { table: 'digests', tenantColumn: 'tenant_id' },
] as const;

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
}

function sessionFile(home: string, id: string): string {
  return join(home, 'sessions', `${id}.jsonl`);
}

function validJsonLines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      // Same contract as SessionStore.read(): a truncated crash tail is not a
      // reason to lose the complete messages before it.
    }
  }
  return out;
}

function createdAtOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const createdAt = (value as { createdAt?: unknown }).createdAt;
  return typeof createdAt === 'string' ? createdAt : '';
}

/**
 * Merge one pre-pairing conversation into the cross-surface owner session.
 *
 * Exact serialized-row de-duplication makes a retry safe if the process died
 * after replacing `owner.jsonl` but before archiving the source file.
 */
function adoptTranscript(home: string, sourceId: string, targetId = 'owner'): number {
  if (sourceId === targetId) return 0;
  const source = sessionFile(home, sourceId);
  if (!existsSync(source)) return 0;
  const target = sessionFile(home, targetId);

  const rows = [...validJsonLines(target), ...validJsonLines(source)];
  const unique = new Map<string, unknown>();
  for (const row of rows) unique.set(JSON.stringify(row), row);
  const merged = [...unique.values()].sort((a, b) => createdAtOf(a).localeCompare(createdAtOf(b)));

  const tmp = `${target}.adopting-${process.pid}`;
  writeFileSync(tmp, merged.map((row) => JSON.stringify(row)).join('\n') + (merged.length > 0 ? '\n' : ''), 'utf8');
  renameSync(tmp, target);

  // Archive, never delete: evidence that existed before pairing remains
  // inspectable even after the canonical session has adopted it.
  const archived = source.replace(/\.jsonl$/, `.adopted-${Date.now()}.jsonl`);
  renameSync(source, archived);
  return merged.length;
}

/**
 * Adopt the private conversation that just proved itself to be the owner.
 *
 * `group:*` is included because releases before this fix classified every
 * unpaired DM as a group. `direct:*` is the corrected pre-pairing tenant used
 * by this release. Supporting both is what makes an update repair an already
 * populated installation instead of only preventing the next one.
 */
export function adoptOwnerState(
  db: Database.Database,
  home: string,
  connector: string,
  conversationId: string,
): OwnerAdoptionReport {
  const sourceTenants = [`group:${connector}:${conversationId}`, `direct:${connector}:${conversationId}`];
  let movedRows = 0;

  db.transaction(() => {
    // Vector rows are derived and partitioned by tenant. Re-keying only the
    // ordinary `chunks` table would leave vec0 under the old partition. Drop
    // the derived rows instead; the normal backlog rebuilds them from the
    // evidence we preserve below.
    if (hasTable(db, 'chunks')) {
      const chunkIds = db
        .prepare(`SELECT id FROM chunks WHERE tenant_id IN (?, ?)`)
        .all(...sourceTenants) as Array<{ id: number }>;
      if (chunkIds.length > 0 && hasTable(db, 'chunks_vec')) {
        const dropVector = db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`);
        for (const row of chunkIds) dropVector.run(BigInt(row.id));
      }
      movedRows += db.prepare(`DELETE FROM chunks WHERE tenant_id IN (?, ?)`).run(...sourceTenants).changes;
    }

    // Profiles/digests are reconstructible summaries. Keeping a summary made
    // while the speaker was unauthenticated would launder framing across the
    // boundary even if the source rows retain tier 2, so rebuild instead.
    for (const { table, tenantColumn } of DERIVED_TABLES) {
      if (!hasTable(db, table)) continue;
      movedRows += db
        .prepare(`DELETE FROM ${table} WHERE ${tenantColumn} IN (?, ?)`).run(...sourceTenants).changes;
    }

    // Evidence and beliefs keep their ids, provenance, timestamps and trust
    // tiers; only the tenant boundary changes now that the account is proved.
    for (const { table, tenantColumn } of EVIDENCE_TABLES) {
      if (!hasTable(db, table)) continue;
      movedRows += db
        .prepare(`UPDATE ${table} SET ${tenantColumn} = 'host' WHERE ${tenantColumn} IN (?, ?)`).run(...sourceTenants)
        .changes;
    }
  })();

  const transcriptRows = adoptTranscript(home, `${connector}:${conversationId}`);
  return { movedRows, transcriptRows };
}
