import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ensurePrivateDir, tightenPrivateFile } from '../config/private-fs.js';
import { snapshotTo } from '../db/migrate.js';

/**
 * One-time conservative repair of agent episodes (and matching session
 * assistant lines) that the recall taint ratchet stamped at tier 3 even
 * though the turn never ingested untrusted content.
 *
 * Touches only `role: 'agent'` message episodes from owner turns on a
 * trusted channel (`tenant = 'host'`) that invoked no untrusted-ingress
 * tools. Never rewrites user episodes, facts, or turns that genuinely
 * read the web, a group, the disk, a shell, or an MCP tool.
 *
 * Default is a dry-run. `--apply` writes after an automatic backup of
 * `muffin.db` and, when present, of `sessions/`.
 */

/** Tools that do not themselves ingest untrusted bytes into the turn. */
export const TRUSTED_TURN_TOOLS = new Set([
  'memory_search',
  'memory_why',
  'todo',
  'todo_read',
  'todo_write',
  'wait',
  'effects',
  'sys_inspect',
  'skill_read',
  'work_message',
  'capability_search',
]);

export const TRUSTED_TURN_CAPABILITIES = new Set([
  'memory.read',
  'memory.why',
  'sys.todo',
  'sys.wait',
  'sys.effects',
  'sys.inspect',
  'sys.skill',
  'sys.capability_discover',
  'surface.work_message',
]);

export type RepairSkipReason =
  | 'no-turn-id'
  | 'turn-missing'
  | 'not-owner'
  | 'untrusted-channel'
  | 'untrusted-ingress-tools'
  | 'already-clean';

export type RepairCandidate = {
  episodeId: number;
  turnId: string;
  from: number;
  to: 0;
};

export type RepairSkip = {
  episodeId: number;
  turnId: string | null;
  reason: RepairSkipReason;
  detail?: string;
};

export type SessionRepair = {
  file: string;
  rows: number;
};

export type RepairTaintReport = {
  candidates: RepairCandidate[];
  skipped: RepairSkip[];
  sessionFiles: SessionRepair[];
  sessionRows: number;
};

export type RepairTaintApplyResult = RepairTaintReport & {
  backupDb: string;
  backupSessions: string | null;
  updatedEpisodes: number;
  updatedSessionRows: number;
};

type AgentRow = {
  episodeId: number;
  turnId: string | null;
  trustTier: number;
  kind: string;
};

type TurnRow = {
  id: string;
  principal: string;
  tenant: string;
};

type ToolRow = { tool: string; capability: string };

function parseOwner(principalJson: string): boolean {
  try {
    const parsed = JSON.parse(principalJson) as { kind?: unknown };
    return parsed.kind === 'owner';
  } catch {
    return false;
  }
}

function toolsForTurn(db: Database.Database, turnId: string): ToolRow[] {
  return db
    .prepare(`SELECT tool, capability FROM turn_tool_calls WHERE turn_id = ?`)
    .all(turnId) as ToolRow[];
}

function hasUntrustedIngress(tools: readonly ToolRow[]): string | null {
  for (const row of tools) {
    const toolOk = TRUSTED_TURN_TOOLS.has(row.tool);
    const capOk = TRUSTED_TURN_CAPABILITIES.has(row.capability);
    if (!toolOk && !capOk) {
      return `${row.tool} (${row.capability})`;
    }
  }
  return null;
}

export function previewRepairTaint(db: Database.Database, sessionsDir?: string): RepairTaintReport {
  const episodes = db
    .prepare(
      `SELECT id AS episodeId, turn_id AS turnId, trust_tier AS trustTier, kind
       FROM episodes
       WHERE role = 'agent'`,
    )
    .all() as AgentRow[];

  const turnStmt = db.prepare(
    `SELECT id, principal, tenant FROM turns WHERE id = ?`,
  ) as Database.Statement;

  const candidates: RepairCandidate[] = [];
  const skipped: RepairSkip[] = [];

  for (const episode of episodes) {
    if (episode.kind !== 'message') {
      skipped.push({
        episodeId: episode.episodeId,
        turnId: episode.turnId,
        reason: 'untrusted-ingress-tools',
        detail: `kind ${episode.kind}`,
      });
      continue;
    }
    if (episode.turnId === null || episode.turnId === '') {
      skipped.push({ episodeId: episode.episodeId, turnId: null, reason: 'no-turn-id' });
      continue;
    }
    const turn = turnStmt.get(episode.turnId) as TurnRow | undefined;
    if (turn === undefined) {
      skipped.push({
        episodeId: episode.episodeId,
        turnId: episode.turnId,
        reason: 'turn-missing',
      });
      continue;
    }
    if (!parseOwner(turn.principal)) {
      skipped.push({ episodeId: episode.episodeId, turnId: episode.turnId, reason: 'not-owner' });
      continue;
    }
    if (turn.tenant !== 'host') {
      skipped.push({
        episodeId: episode.episodeId,
        turnId: episode.turnId,
        reason: 'untrusted-channel',
        detail: turn.tenant,
      });
      continue;
    }
    const ingress = hasUntrustedIngress(toolsForTurn(db, episode.turnId));
    if (ingress !== null) {
      skipped.push({
        episodeId: episode.episodeId,
        turnId: episode.turnId,
        reason: 'untrusted-ingress-tools',
        detail: ingress,
      });
      continue;
    }
    if (episode.trustTier <= 0) {
      skipped.push({
        episodeId: episode.episodeId,
        turnId: episode.turnId,
        reason: 'already-clean',
      });
      continue;
    }
    candidates.push({
      episodeId: episode.episodeId,
      turnId: episode.turnId,
      from: episode.trustTier,
      to: 0,
    });
  }

  const eligibleTurns = new Set(candidates.map((c) => c.turnId));
  const session =
    sessionsDir !== undefined ? previewSessionRepairs(sessionsDir, eligibleTurns) : [];

  return {
    candidates,
    skipped,
    sessionFiles: session,
    sessionRows: session.reduce((n, file) => n + file.rows, 0),
  };
}

function listSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name));
}

function previewSessionRepairs(dir: string, turnIds: ReadonlySet<string>): SessionRepair[] {
  if (turnIds.size === 0) return [];
  const out: SessionRepair[] = [];
  for (const file of listSessionFiles(dir)) {
    const rows = countSessionRepairs(file, turnIds);
    if (rows > 0) out.push({ file, rows });
  }
  return out;
}

function countSessionRepairs(file: string, turnIds: ReadonlySet<string>): number {
  let n = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line) as { role?: unknown; traceId?: unknown; tier?: unknown };
      if (row.role !== 'assistant') continue;
      if (typeof row.traceId !== 'string' || !turnIds.has(row.traceId)) continue;
      if (typeof row.tier === 'number' && row.tier > 0) n += 1;
    } catch {
      // Leave unparseable lines alone; they are not evidence we can retier.
    }
  }
  return n;
}

function rewriteSessionFile(file: string, turnIds: ReadonlySet<string>): number {
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = 0;
  const rewritten = lines.map((line) => {
    if (line.trim() === '') return line;
    try {
      const row = JSON.parse(line) as { role?: unknown; traceId?: unknown; tier?: unknown };
      if (row.role !== 'assistant') return line;
      if (typeof row.traceId !== 'string' || !turnIds.has(row.traceId)) return line;
      if (typeof row.tier !== 'number' || row.tier <= 0) return line;
      changed += 1;
      return JSON.stringify({ ...row, tier: 0 });
    } catch {
      return line;
    }
  });
  if (changed === 0) return 0;
  const tmp = `${file}.${process.pid}.tmp`;
  const body = rewritten.join('\n');
  writeFileSync(tmp, body.endsWith('\n') || body === '' ? body : `${body}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  tightenPrivateFile(tmp);
  renameSync(tmp, file);
  tightenPrivateFile(file);
  return changed;
}

export function formatRepairTaintReport(report: RepairTaintReport, apply = false): string {
  const lines: string[] = [];
  if (report.candidates.length === 0) {
    lines.push('nessun episodio agente da ricalcolare');
  } else {
    const verb = apply ? 'ricalcolati' : 'da ricalcolare';
    lines.push(
      `${verb} ${report.candidates.length} episod${report.candidates.length === 1 ? 'io' : 'i'} agente (trust_tier → 0)`,
    );
    const fromCounts = new Map<number, number>();
    for (const c of report.candidates) {
      fromCounts.set(c.from, (fromCounts.get(c.from) ?? 0) + 1);
    }
    for (const [from, n] of [...fromCounts.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`  ${n} da tier ${from}`);
    }
  }
  const skippedIngress = report.skipped.filter(
    (s) => s.reason === 'untrusted-ingress-tools',
  ).length;
  const skippedNoTurn = report.skipped.filter(
    (s) => s.reason === 'no-turn-id' || s.reason === 'turn-missing',
  ).length;
  const skippedChannel = report.skipped.filter(
    (s) => s.reason === 'not-owner' || s.reason === 'untrusted-channel',
  ).length;
  if (skippedIngress > 0) {
    lines.push(
      `${skippedIngress} episodi di turni con tool di ingress non fidato lasciati invariati`,
    );
  }
  if (skippedChannel > 0) {
    lines.push(`${skippedChannel} episodi di canali o principal non fidati lasciati invariati`);
  }
  if (skippedNoTurn > 0) {
    lines.push(`${skippedNoTurn} episodi senza turno ricostruibile lasciati invariati`);
  }
  if (report.sessionRows > 0) {
    const verb = apply ? 'aggiornate' : 'da aggiornare';
    lines.push(
      `${verb} ${report.sessionRows} righe assistant in ${report.sessionFiles.length} file di sessione`,
    );
  }
  return lines.join('\n');
}

export function applyRepairTaint(
  db: Database.Database,
  options: { backupDir: string; sessionsDir?: string; now?: Date },
): RepairTaintApplyResult {
  const report = previewRepairTaint(db, options.sessionsDir);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  if (!ensurePrivateDir(options.backupDir)) {
    throw new Error(`non posso scrivere il backup in ${options.backupDir}`);
  }
  const backupDb = join(options.backupDir, `muffin-repair-taint-${stamp}.db`);
  snapshotTo(db, backupDb);

  let backupSessions: string | null = null;
  if (
    options.sessionsDir !== undefined &&
    existsSync(options.sessionsDir) &&
    report.sessionRows > 0
  ) {
    backupSessions = join(options.backupDir, `sessions-repair-taint-${stamp}`);
    if (!ensurePrivateDir(backupSessions)) {
      throw new Error(`non posso scrivere il backup delle sessioni in ${backupSessions}`);
    }
    for (const name of readdirSync(options.sessionsDir)) {
      const src = join(options.sessionsDir, name);
      copyFileSync(src, join(backupSessions, name));
    }
  }

  const update = db.prepare(`UPDATE episodes SET trust_tier = 0 WHERE id = ? AND role = 'agent'`);
  const applyEpisodes = db.transaction(() => {
    for (const candidate of report.candidates) update.run(candidate.episodeId);
  });
  applyEpisodes();

  let updatedSessionRows = 0;
  if (options.sessionsDir !== undefined) {
    const turnIds = new Set(report.candidates.map((c) => c.turnId));
    for (const file of report.sessionFiles) {
      updatedSessionRows += rewriteSessionFile(file.file, turnIds);
    }
  }

  return {
    ...report,
    backupDb,
    backupSessions,
    updatedEpisodes: report.candidates.length,
    updatedSessionRows,
  };
}
