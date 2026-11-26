import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveIdentityLayers, USER_OVERLAY_TOKEN_BUDGET } from '../agent/context/identity.js';
import { type Config, ConfigError, loadConfig } from '../core/config/config.js';
import {
  collectStatus as collectStatusFromCore,
  formatIdentityLine,
  formatStatus,
  type StatusReport,
} from '../core/config/status.js';
import { findCheckoutRoot, type GitRunner } from './git-root.js';
import { describeBuild } from './update.js';

/**
 * `muffin status`: thin CLI adapter over `core/config/status.ts` (ADR-0114).
 *
 * The report itself is collected in `core/` so Telegram `/status` can reuse
 * it. This file keeps usage text, argv parsing, the Git channel lookup, and
 * the identity-line binding that would otherwise import `agent/` into `core/`.
 */

export const STATUS_USAGE = `uso: muffin status [--json]
  Riassunto in poche righe: versione e canale, gateway, catena dei modelli,
  identità, ricerca web, embedding, memoria. Non chiama provider e non scrive niente.
  Per la diagnosi completa: muffin doctor`;

export type { StatusReport };
export { formatStatus };

export type StatusDeps = {
  out: (line: string) => void;
  /** `muffin --version`'s answer, computed by the caller. */
  version: string;
  /** Which channel contains this build; default: local Git refs, never a fetch. */
  channel?: () => string | null;
  now?: number;
};

const realGit: GitRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * The channel that already contains this build, from local refs only
 * (`origin/main`, then `origin/dev`): no fetch, so it says what the last
 * `muffin update` saw. ADR-0057 keeps the channel a per-invocation choice,
 * never a stored setting, so this is read from Git rather than config.
 */
export function channelOf(moduleDir: string, git: GitRunner = realGit): string | null {
  const root = findCheckoutRoot(moduleDir, git);
  const build = describeBuild(moduleDir, git);
  if (root === null || build === null) return null;
  for (const channel of ['main', 'dev']) {
    const r = git(
      ['merge-base', '--is-ancestor', build.sha, `refs/remotes/origin/${channel}`],
      root,
    );
    if (r.status === 0) return channel === 'main' ? 'main' : 'dev (non ancora promosso su main)';
  }
  return 'build locale (non su origin/main né origin/dev)';
}

function identityLine(home: string): string {
  return formatIdentityLine(resolveIdentityLayers(home), USER_OVERLAY_TOKEN_BUDGET);
}

/**
 * Same collector Telegram `/status` will call, with the CLI identity binding
 * already applied. Kept as a named export so existing tests and call sites
 * do not fork a second report.
 */
export function collectStatus(
  home: string,
  config: Config,
  deps: Pick<StatusDeps, 'version' | 'channel' | 'now'>,
): StatusReport {
  return collectStatusFromCore(home, config, {
    version: deps.version,
    channel: deps.channel ?? (() => channelOf(dirname(fileURLToPath(import.meta.url)))),
    identityLine,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
}

export function cmdStatus(home: string, argv: string[], deps: StatusDeps): number {
  let json = false;
  try {
    json =
      parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: false })
        .values.json === true;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${STATUS_USAGE}\n`);
    return 78;
  }
  let config: Config;
  try {
    config = loadConfig(home);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`Muffin non è ancora configurato qui (${message}).\n→ muffin init\n`);
    return 78;
  }
  const report = collectStatus(home, config, deps);
  if (json) {
    deps.out(JSON.stringify(report, null, 2));
    return 0;
  }
  for (const line of formatStatus(report)) deps.out(line);
  return 0;
}
