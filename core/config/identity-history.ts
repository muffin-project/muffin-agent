import { spawnSync } from 'node:child_process';

const IDENTITY_PATH = 'defaults/rot/identity.md';
const HISTORY_LIMIT = 200;

/** Read product defaults reachable from the local build, without fetching or writing Git state. */
export function* shippedIdentityHistory(cwd: string): Iterable<string> {
  const options = { cwd, encoding: 'utf8' as const, timeout: 1_500, maxBuffer: 512_000 };
  const log = spawnSync(
    'git',
    ['log', '--format=%H', `-n${String(HISTORY_LIMIT)}`, 'HEAD', '--', `:/${IDENTITY_PATH}`],
    options,
  );
  if (log.status !== 0) return;
  for (const sha of log.stdout.split('\n')) {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const show = spawnSync('git', ['show', `${sha}:${IDENTITY_PATH}`], options);
    if (show.status === 0) yield show.stdout;
  }
}
