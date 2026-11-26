import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Owner-facing path under this install's home.
 *
 * `~/.muffin/...` is only used for the default home. A custom `MUFFIN_HOME`
 * is shown as the real path, so help and doctor do not point at a file that
 * does not belong to this install.
 */
export function displayInHome(home: string, rel: string): string {
  const full = join(home, rel);
  const defaultHome = join(homedir(), '.muffin');
  if (resolve(home) === resolve(defaultHome)) {
    return `~/.muffin/${rel.replace(/\\/g, '/')}`;
  }
  return full;
}
