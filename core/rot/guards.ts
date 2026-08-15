import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths, secretDir } from '../config/config.js';

/**
 * The mandatory deny paths, in one place, because the threat model names five
 * and the runtime was enforcing three.
 *
 * 03 §3-bis: *"**Mandatory deny paths**: `~/.muffin/rot/`, config, secrets,
 * `.git/hooks`, dotfile di shell — negati in scrittura SEMPRE, anche dentro un
 * allow-write ampio (anti config-tampering; complementa i permessi OS del
 * RoT)."* Five categories. `agent/runtime.ts` had `[p.rot, p.secrets,
 * p.config]` — written out twice, once for the filesystem tools and once for
 * the sandbox — and the last two categories were in no list at all.
 *
 * The two that were missing are the two that survive a reinstall of everything
 * else. A write to `.git/hooks/pre-commit` executes on the owner's next commit,
 * outside the sandbox, as the owner, with no capability check anywhere in the
 * path — the containment is escaped by leaving a note for a process that is not
 * contained. A line appended to `~/.zshrc` does the same on the next shell.
 * Neither needs a privilege the agent does not already have: `fs.write` is
 * medium risk, and the working directory is a git repo whose `.git` is inside
 * `root` (ADR-0030 requires exactly that).
 *
 * They live here rather than inline at the two call sites for the reason the
 * old comment at the second site already gave: *"two deny-lists that drift are
 * one deny-list plus a hole"*. That was true, and the answer to it is one
 * function, not two literals that happen to match today.
 */

export type Guards = {
  /** Never writable, whatever the per-call scope says. */
  denyWrite: readonly string[];
  /** Never readable either — narrower on purpose (see `agent/tools/fs.ts`). */
  denyRead: readonly string[];
};

/**
 * The shell startup files a write would turn into execution on the next login.
 *
 * Named individually rather than globbed as `~/.*rc`: a glob over the home
 * directory would deny writes to unrelated dotfiles the owner may legitimately
 * ask for, and would still miss `~/.config/fish/config.fish`. The list is the
 * four shells a Muffin host plausibly runs, and adding one is a one-line
 * change with a test that names it.
 */
const SHELL_DOTFILES = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.kshrc',
];

/**
 * @param home    the muffin home (`~/.muffin`, or `MUFFIN_HOME`)
 * @param cwd     the working directory a turn writes in — where `.git` lives
 * @param userHome the OS home, injectable so a test does not touch the real one
 */
export function mandatoryGuards(home: string, cwd: string, userHome: string = homedir()): Guards {
  const p = paths(home);
  return {
    denyWrite: [
      // 1. the root of trust
      p.rot,
      // 2. config
      p.config,
      // 3. secrets — both links of the ADR-0039 chain, not just the default
      secretDir('home', home),
      secretDir('persistent', home),
      // 4. git hooks: a write here runs on the owner's next commit, uncontained
      join(cwd, '.git', 'hooks'),
      // 5. shell dotfiles: the same trick, on the owner's next shell
      ...SHELL_DOTFILES.map((f) => join(userHome, f)),
      join(userHome, '.config', 'fish', 'config.fish'),
    ],
    denyRead: [
      secretDir('home', home),
      secretDir('persistent', home),
      // The working-directory `.env` ADR-0030 tells the owner to create.
      join(cwd, '.env'),
    ],
  };
}
