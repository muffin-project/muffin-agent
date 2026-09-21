import DatabaseCtor from 'better-sqlite3';
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../core/config/config.js';
import { ensurePrivateDir, tightenPrivateDb } from '../core/config/private-fs.js';
import { readGateway } from '../core/gateway/lock.js';
import { currentSchemaVersion, migrate, schemaVersionOf, snapshotTo } from '../core/db/migrate.js';

const BACKUP_USAGE = `uso:
  muffin backup [--dir DIR]     copia online del database (VACUUM INTO) + quick_check
  muffin restore <file> --yes   ripristina un backup: rifiuta col gateway vivo,
                                mette da parte il db corrente, riapplica le migrazioni`;

/**
 * Online backup of the live database, salvaged in shape from the old Muffin's
 * \`scripts/backup-muffin-db.sh\` (four months of daily online backups): safe
 * while the gateway runs, atomic, one file per invocation. \`VACUUM INTO\`
 * rather than a file copy because a WAL database is TWO files mid-write and a
 * naive copy tears them; the vacuum runs as one read transaction and produces
 * a single self-contained snapshot. The snapshot is then opened and
 * quick_checked — a backup nobody has ever validated is a hope, not a backup.
 */
export function backupNow(
  dbPath: string,
  dir: string,
  now: () => Date = () => new Date(),
): { file: string; bytes: number } {
  if (!existsSync(dbPath)) throw new Error(`nessun database in ${dbPath}`);
  if (!ensurePrivateDir(dir)) {
    throw new Error(`non posso scrivere il backup in ${dir}: la directory privata non è stata stabilita (symlink sulla catena)`);
  }
  const file = join(dir, `muffin-${now().toISOString().replace(/[:.]/g, '-')}.db`);
  const db = new DatabaseCtor(dbPath);
  try {
    snapshotTo(db, file);
  } finally {
    db.close();
  }
  return { file, bytes: statSync(file).size };
}

/** A refusal is an answer, not a crash: printed without a stack trace. */
export class RestoreRefused extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RestoreRefused';
  }
}

/**
 * Restore = validate, refuse the unsafe cases, keep an escape hatch, then
 * copy and re-migrate. Refusals, in order of discovery cost:
 *
 * 1. the backup file must exist and pass quick_check;
 * 2. a backup stamped NEWER than this code is refused before any byte moves —
 *    the mirror of \`SchemaAheadError\` at boot;
 * 3. a live gateway is refused: a resident writer makes the swap a corruption,
 *    and "stop it first" is a one-liner;
 * 4. the current database, when present, is set aside as
 *    \`muffin.db.pre-restore-<ts>\` — the restore must never be the only copy
 *    of anything.
 *
 * After the copy the stale \`-wal\`/\`-shm\` siblings are removed (they belong
 * to the OLD database; SQLite would replay them over the restored file) and
 * \`migrate()\` runs, so an older backup comes forward to the current shape
 * through the same proven path as a boot.
 */
export function restoreFrom(
  dbPath: string,
  backupFile: string,
  opts: { backupDir: string; now?: () => Date },
): { asideCopy: string | null; applied: number[] } {
  const now = opts.now ?? (() => new Date());
  if (!existsSync(backupFile)) throw new RestoreRefused(`backup inesistente: ${backupFile}`);
  const probe = new DatabaseCtor(backupFile, { readonly: true });
  try {
    const verdict = probe.pragma('quick_check', { simple: true });
    if (verdict !== 'ok') throw new RestoreRefused(`il backup non passa quick_check: ${String(verdict)}`);
    const v = schemaVersionOf(probe);
    if (v !== null && v > currentSchemaVersion()) {
      throw new RestoreRefused(
        `il backup è a schema v${v}, questo codice arriva a v${currentSchemaVersion()} — aggiorna il codice prima di ripristinare`,
      );
    }
  } finally {
    probe.close();
  }
  let aside: string | null = null;
  if (existsSync(dbPath)) {
    const live = new DatabaseCtor(dbPath, { readonly: true });
    try {
      const gw = readGateway(live);
      if (gw !== null) {
        throw new RestoreRefused(`il gateway è vivo (pid ${gw.pid}) — \`muffin gateway stop\` prima del restore`);
      }
    } finally {
      live.close();
    }
    aside = `${dbPath}.pre-restore-${now().toISOString().replace(/[:.]/g, '-')}.db`;
    // VACUUM INTO, never a raw file copy: after any unclean exit the newest
    // committed rows sit only in `-wal`, which a copy of the main file misses
    // and the cleanup below then deletes — the aside would be the safety net
    // that silently lost exactly the rows worth saving (judge #93, blocking
    // finding 1, proven with a SIGKILLed writer).
    const current = new DatabaseCtor(dbPath);
    try {
      snapshotTo(current, aside);
    } finally {
      current.close();
    }
  }
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  copyFileSync(backupFile, dbPath);
  tightenPrivateDb(dbPath);
  const db = new DatabaseCtor(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const res = migrate(db, { backupDir: opts.backupDir, now });
    return { asideCopy: aside, applied: res.applied };
  } finally {
    db.close();
  }
}

export function cmdBackup(rest: string[]): number {
  const dirFlag = rest.indexOf('--dir');
  const p = paths();
  const dir = dirFlag !== -1 && rest[dirFlag + 1] ? rest[dirFlag + 1]! : join(p.home, 'backups');
  try {
    const { file, bytes } = backupNow(p.db, dir);
    process.stdout.write(`backup: ${file} (${(bytes / 1e6).toFixed(1)} MB, quick_check ok)\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export function cmdRestore(rest: string[]): number {
  const file = rest.find((a) => !a.startsWith('--'));
  if (!file) {
    process.stderr.write(`${BACKUP_USAGE}\n`);
    return 2;
  }
  if (!rest.includes('--yes')) {
    process.stderr.write(`il restore sostituisce il database corrente (una copia viene messa da parte). Aggiungi --yes per procedere.\n`);
    return 1;
  }
  const p = paths();
  try {
    const { asideCopy, applied } = restoreFrom(p.db, file, { backupDir: join(p.home, 'backups') });
    process.stdout.write(
      `ripristinato: ${file} → ${p.db}\n` +
        (asideCopy ? `db precedente messo da parte: ${asideCopy}\n` : '') +
        (applied.length > 0 ? `migrazioni riapplicate: ${applied.join(', ')}\n` : 'nessuna migrazione pendente\n') +
        `ora: muffin doctor\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof RestoreRefused) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
