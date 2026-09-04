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
      // 0. the installation itself — the category the five below were a
      //    partial spelling of.
      //
      //    The threat model's five are the five *escapes* that were known when
      //    it was written; they are not a description of what the home holds.
      //    Measured on the production `SandboxExecutor` with this very list
      //    (2026-09-03): `rot/` and `config.json` held, and `.rot-anchor`,
      //    `muffin.db`, `voice.md` and `sessions/` were all overwritten by an
      //    ordinary `shell_run` — because in the supervised gateway the write
      //    scope *was* the home (`core/config/workspace.ts` documents how it
      //    got to be). `.rot-anchor` lives beside `rot/`, not inside it — "an
      //    anchor inside what it anchors is decoration" (`core/rot/verify.ts`)
      //    — so the entry protecting the sealed directory did not protect the
      //    seal, and a write there costs the next boot an `anchor_mismatch`.
      //
      //    Naming the home is the only spelling of "Muffin's own state" that a
      //    file added next month is inside by default. The five below stay:
      //    three are subsumed by this line, two are not (`.git/hooks` and the
      //    dotfiles live outside the home), and a list that says which threats
      //    it answers is worth more than a shorter one.
      //
      //    This is the belt. The braces are that a turn no longer works *in*
      //    the home at all (`resolveWorkspace`); either alone would close the
      //    measured hole, and neither alone survives the next surface that
      //    forgets to pass a workspace.
      p.home,
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
      // The credentials this machine holds for *other* systems.
      //
      // **Measured on the owner's machine, 2026-09-04**, with this very
      // function's guards and the production `SandboxExecutor`:
      //
      //     ~/.ssh/id_ed25519      → LEGGIBILE 444 byte
      //     ~/.config/gh/hosts.yml → LEGGIBILE 100 byte
      //     ~/.muffin/secrets      → negato
      //
      // Muffin's own secret store held. Everything else did not, because the
      // sandbox is **allow-by-default on reads** and this list was three
      // entries long — so it protected the secrets Muffin knows it has and
      // nothing about the ones the host has.
      //
      // That was half an exfiltration waiting for its other half. `shell_run`
      // could already read these bytes and its stdout reaches the model; what
      // was missing was an exit. The GitHub-delivery research
      // (`docs/evidence/consegna-github-2026-09-04.md`) went looking for the
      // exit — and found that the credential a delivery capability would use is
      // exactly this one. Closing the read is what stops the two halves from
      // ever meeting, and it costs nothing today: no capability reaches these
      // paths on purpose, and the push shape that research recommends runs in
      // the host process, outside this sandbox, precisely so it never needs to.
      //
      // Directories rather than named key files: an SSH private key is
      // `id_ed25519`, `id_rsa`, `id_ecdsa` or whatever the owner named it when
      // `ssh-keygen` asked, and a list of filenames would be a list of the keys
      // we happened to think of. The same argument the shell-dotfile list
      // above answers the other way, and the difference is that these
      // directories hold nothing a contained command has a reason to read.
      join(userHome, '.ssh'),
      join(userHome, '.aws'),
      join(userHome, '.gnupg'),
      join(userHome, '.docker', 'config.json'),
      join(userHome, '.netrc'),
      join(userHome, '.npmrc'),
      join(userHome, '.pypirc'),
      join(userHome, '.kube'),
      // `gh` keeps an OAuth token here, and `git push` over HTTPS uses it.
      join(userHome, '.config', 'gh'),
      // `git config --global` can carry a credential helper's stored token.
      join(userHome, '.git-credentials'),
    ],
  };
}
