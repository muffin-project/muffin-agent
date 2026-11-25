import { copyFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensurePrivateDir, tightenPrivateFile } from '../config/private-fs.js';

/**
 * Copy an owner-owned config file aside before a tool-driven write (ADR-0108).
 * The agent still cannot write `rot/` from a turn; this is for CLI/setup
 * paths that the owner invoked (egress widen, owner binding, migrate).
 *
 * Returns the backup path. A missing source is not a backup: the caller is
 * creating a file, not replacing one.
 */
export function backupOwnerConfigFile(
  home: string,
  sourcePath: string,
  now: Date = new Date(),
): string | null {
  if (!existsSync(sourcePath)) return null;
  const dir = join(home, 'backups');
  if (!ensurePrivateDir(dir)) {
    throw new Error(
      `non posso scrivere il backup in ${dir}: la directory privata non è stata stabilita (symlink sulla catena)`,
    );
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = join(dir, `${basename(sourcePath)}-${stamp}`);
  copyFileSync(sourcePath, dest);
  tightenPrivateFile(dest);
  return dest;
}
