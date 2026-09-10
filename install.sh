#!/usr/bin/env sh
# muffin installer — one command, from an empty machine to a supervised agent.
#
#   curl -fsSL https://raw.githubusercontent.com/GiustoPiedimonte/muffin-agent/main/install.sh | sh
#   bash install.sh          # from a clone or an unpacked tarball
#
# ## What this script owns, and why it grew
#
# Until 2026-09-06 it owned exactly one thing: turning an *already cloned,
# already built-able* checkout into a `muffin` command. Everything before that
# (Node, git, the clone itself) and everything after it (`init`, the
# supervisor) was prose in `README.md` — which meant the only path anyone ever
# exercised was a developer's Mac with Node already on it. DAY-1 A11 is the
# opposite claim: an empty Ubuntu VPS, one command, `muffin doctor` green and
# the gateway running under systemd. So the script owns the whole line now:
#
#   1. OS packages     git/curl/xz for itself, bubblewrap/socat/ripgrep for the sandbox
#   2. Node >= 22      the official tarball under MUFFIN_PREFIX, never a system package
#   3. the source      git clone (or reuse) — `muffin update` needs a real checkout
#   4. the build       npm ci/install -> dist/
#   5. the command     a symlink in a user-writable bin dir, never sudo into /usr
#   6. the setup       `muffin init` (the key arrives on stdin, never argv/env)
#   7. the supervisor  `muffin gateway install --write --start`
#
# Steps 1-5 are unattended. Steps 6-7 need something only the owner has (an API
# key) or something only a real login session has (a user systemd instance), so
# each one degrades to a printed command rather than to a lie.
#
# ## Why the code does not live in the data home
#
# `~/.muffin` is the *data* home and `muffin uninstall` deletes it whole. A Node
# runtime or a git checkout under there would be erased by a command whose
# stated job is removing config, keys and memory — and the systemd unit's
# `Environment=PATH` points at this Node, so the erase would take the service
# with it. Hence MUFFIN_PREFIX (default `~/.local/share/muffin`), which
# `uninstall` does not touch and `./install.sh --uninstall` names on request.
#
# ## Overrides (all optional)
#
#   MUFFIN_PREFIX=~/.local/share/muffin   where the checkout and Node live
#   MUFFIN_BINDIR=~/.local/bin            where the launcher symlink goes
#   MUFFIN_CMD=muffin                     force the command name (see the Mint note)
#   MUFFIN_REPO=<git url>                 where to clone from
#   MUFFIN_CHANNEL=main                   which branch to install
#   MUFFIN_API_KEY_FILE=<path>            unattended setup: the key is read from
#                                         this file and piped into `muffin init`.
#                                         A path, never the value: a secret in an
#                                         env var is readable from /proc and ends
#                                         up in shell history (ADR-0048).
#   MUFFIN_NO_APT=1                       never call apt-get
#   MUFFIN_NO_GATEWAY=1                   install, but do not touch the supervisor
#
# Exit codes: 0 done · 1 something failed · 3 installed, gateway NOT active.
set -eu

MUFFIN_PREFIX=${MUFFIN_PREFIX:-$HOME/.local/share/muffin}
MUFFIN_REPO=${MUFFIN_REPO:-https://github.com/GiustoPiedimonte/muffin-agent.git}
MUFFIN_CHANNEL=${MUFFIN_CHANNEL:-main}
NODE_MAJOR_REQUIRED=22
EXIT_GATEWAY_NOT_ACTIVE=3

say() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 0. Where is the source?
#
# Two modes, decided by a fact and not by a flag: does the directory this script
# was read from actually contain Muffin's own package.json? Piped through
# `sh`, `$0` is the shell itself and `dirname` gives the working directory —
# which is why the test is the package *name* and not the mere existence of a
# file called package.json (a `curl | sh` run inside some other project's
# directory would otherwise try to build that project).
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] &&
  grep -q '"name": *"muffin-agent"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  SRC=$SCRIPT_DIR
  MODE=checkout
else
  SRC=$MUFFIN_PREFIX/src
  MODE=fetch
fi
NODE_DIR=$MUFFIN_PREFIX/node
BIN="$SRC/dist/cli/main.js"

# ---------------------------------------------------------------------------
# Uninstall: remove only the launcher symlinks that point at THIS build (never a
# foreign muffin). Data under ~/.muffin is left alone — remove it with
# `muffin uninstall` first if you want it gone too.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ]; then
  removed=0
  for dir in "${MUFFIN_BINDIR:-$HOME/.local/bin}" /opt/homebrew/bin /usr/local/bin; do
    for name in muffin muffin-agent; do
      link="$dir/$name"
      if [ -L "$link" ] && [ "$(readlink "$link")" = "$BIN" ]; then
        rm -f "$link" && { say "removed $link"; removed=1; }
      fi
    done
  done
  [ "$removed" = 0 ] && say "no muffin launcher pointing at this build was found"
  say "if you used 'npm link' for dev, also run: npm rm -g muffin-agent"
  say "to remove your data (config, keys, memory): muffin uninstall"
  if [ "$MODE" = fetch ]; then
    say "to remove the code and the bundled Node:  rm -rf $MUFFIN_PREFIX"
  fi
  exit 0
fi

say "muffin installer — source: $SRC ($MODE)"

# ---------------------------------------------------------------------------
# 1. OS packages.
#
# Split in two on purpose, because the two halves fail differently:
#
#   REQUIRED  git/curl/ca-certificates/xz-utils — without them this script
#             cannot fetch or unpack anything, so a failure here is fatal.
#   SANDBOX   bubblewrap/socat/ripgrep — Muffin boots without them and `doctor`
#             says so, but it degrades to asking for confirmation on every
#             single command, which is the difference between an agent that
#             does things on a VPS and one that only chats. Three binaries and
#             not two: SandboxManager needs ripgrep as well, and the remedy
#             that named only bubblewrap and socat sent people round in circles.
#
# `sudo -n` and never a password prompt: `curl … | sh` has no terminal on
# stdin, so a prompting sudo would hang forever instead of printing the one
# line the reader can act on.
# ---------------------------------------------------------------------------
apt_install() {
  # usage: apt_install <purpose> <fatal 0|1> <pkg...>
  purpose=$1
  fatal=$2
  shift 2
  if [ "${MUFFIN_NO_APT:-}" = 1 ]; then
    say "note: MUFFIN_NO_APT=1 — not installing: $*  ($purpose)"
    return 1
  fi
  if ! have apt-get; then
    say "note: no apt-get here; install yourself: $*  ($purpose)"
    return 1
  fi
  SUDO=""
  if [ "$(id -u)" != 0 ]; then
    if have sudo && sudo -n true 2>/dev/null; then
      SUDO="sudo -n"
    else
      say "note: no passwordless sudo — run yourself:  sudo apt-get install -y $*"
      if [ "$fatal" = 1 ]; then die "cannot continue without: $*"; fi
      return 1
    fi
  fi
  say "installing OS packages ($purpose): $*"
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get update -qq >/dev/null 2>&1 || true
  if ! DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "$@" >/dev/null 2>&1; then
    say "! apt-get install failed for: $*"
    if [ "$fatal" = 1 ]; then die "cannot continue without: $*"; fi
    return 1
  fi
  return 0
}

missing_required=''
have git || missing_required="$missing_required git"
have curl || missing_required="$missing_required curl"
have tar || missing_required="$missing_required tar"
if ! have xz && ! have unxz; then missing_required="$missing_required xz-utils"; fi
if [ -n "$missing_required" ]; then
  apt_install "needed by this installer" 1 ca-certificates $missing_required || true
fi
have git || die "git not found and could not be installed — install it, then re-run."
have curl || die "curl not found and could not be installed — install it, then re-run."

missing_sandbox=''
for b in bwrap socat rg; do
  have "$b" || missing_sandbox="$missing_sandbox $b"
done
if [ -n "$missing_sandbox" ]; then
  case "$(uname -s)" in
    Linux)
      apt_install "the sandbox — without it every command asks you first" 0 bubblewrap socat ripgrep || true
      say "      On Ubuntu 24.04+ bwrap also needs an AppArmor profile granting userns."
      ;;
    Darwin) say "note: the sandbox needs:$missing_sandbox — brew install bubblewrap socat ripgrep" ;;
    *) say "note: the sandbox needs:$missing_sandbox — install them with your package manager" ;;
  esac
fi

# ---------------------------------------------------------------------------
# 2. Node >= 22.
#
# The runtime targets it and `engines` enforces it, so "install Node first" was
# never a prerequisite this script could keep assuming — an empty VPS has no
# Node at all, and Ubuntu 24.04's own `nodejs` package is 18. Neither nvm nor
# fnm: both are shell-profile machinery whose whole value is *switching*
# versions interactively, and a systemd unit does not source a shell profile —
# it needs one absolute interpreter directory that still exists next month
# (`resolveInterpreterDir`, core/gateway/unit.ts). The official tarball under
# MUFFIN_PREFIX is exactly that, and it is what `actions/setup-node` and
# `scripts/ci-local.ts` do too.
#
# A system Node that is already >= 22 is used as-is: nothing is downloaded and
# nothing shadows what the machine already had.
# ---------------------------------------------------------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_node() {
  arch=$(uname -m)
  case "$arch" in
    aarch64 | arm64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "no official Node tarball for this architecture: $arch — install Node >= $NODE_MAJOR_REQUIRED yourself." ;;
  esac
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS for the Node tarball: $(uname -s) — install Node >= $NODE_MAJOR_REQUIRED yourself." ;;
  esac
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR_REQUIRED.x"
  say "installing Node $NODE_MAJOR_REQUIRED.x into $NODE_DIR (nothing outside your home is touched)"
  listing=$(curl -fsSL "$base/") || die "cannot reach nodejs.org — no network?"
  file=$(printf '%s' "$listing" | grep -oE "node-v$NODE_MAJOR_REQUIRED\.[0-9]+\.[0-9]+-$os-$arch\.tar\.xz" | head -1)
  [ -n "$file" ] || die "no node-v$NODE_MAJOR_REQUIRED.x-$os-$arch.tar.xz on $base/"
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/node.tar.xz" || die "download failed: $base/$file"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1 || die "could not unpack $file"
  rm -rf "$tmp"
  PATH="$NODE_DIR/bin:$PATH"
  export PATH
}

if [ -x "$NODE_DIR/bin/node" ]; then
  PATH="$NODE_DIR/bin:$PATH"
  export PATH
fi
if ! have node || [ "$(node_major)" -lt "$NODE_MAJOR_REQUIRED" ]; then
  install_node
fi
have node || die "Node is still not on PATH after installing it — this is a bug in this script."
[ "$(node_major)" -ge "$NODE_MAJOR_REQUIRED" ] || die "Node >= $NODE_MAJOR_REQUIRED required (found $(node -v))."
have npm || die "npm is missing next to $(command -v node) — a partial Node install."
say "node: $(node -v) at $(command -v node)"

# ---------------------------------------------------------------------------
# 3. The source.
#
# A **git checkout**, not a tarball, and not `npm i -g`: `muffin update` builds
# each release as a `git worktree` under `.releases/<sha>` and swings the
# launcher symlink over (cli/update.ts). Without a real repository here, the
# update and rollback path this installer promises does not exist — `muffin
# update` says so in as many words and stops.
# ---------------------------------------------------------------------------
if [ "$MODE" = fetch ]; then
  mkdir -p "$MUFFIN_PREFIX"
  if [ -d "$SRC/.git" ]; then
    say "updating the existing checkout in $SRC ($MUFFIN_CHANNEL)"
    git -C "$SRC" remote set-url origin "$MUFFIN_REPO"
    git -C "$SRC" fetch --quiet origin "$MUFFIN_CHANNEL" || die "git fetch failed from $MUFFIN_REPO"
    git -C "$SRC" checkout --quiet -B "$MUFFIN_CHANNEL" "origin/$MUFFIN_CHANNEL"
  else
    say "cloning $MUFFIN_REPO ($MUFFIN_CHANNEL) into $SRC"
    git clone --quiet --branch "$MUFFIN_CHANNEL" "$MUFFIN_REPO" "$SRC" || die "git clone failed from $MUFFIN_REPO"
  fi
fi
[ -f "$SRC/package.json" ] || die "no package.json in $SRC — the source is not there."
cd "$SRC"

# ---------------------------------------------------------------------------
# 4. Build the bin — code plus the non-TS assets init/profiles read at runtime.
#    `npm ci`/`npm install` runs the `prepare` script, which compiles; the
#    explicit compile is a belt-and-suspenders in case prepare was disabled.
# ---------------------------------------------------------------------------
say "building muffin…"
if [ "$MODE" = fetch ] && [ -f "$SRC/package-lock.json" ]; then
  npm ci
else
  npm install
fi
[ -f "$BIN" ] || npm run compile
[ -f "$BIN" ] || die "build did not produce $BIN"
chmod +x "$BIN"

# ---------------------------------------------------------------------------
# 5. Choose a command name that does not shadow a foreign `muffin`.
#    Detection is by identity, not by name or version string: the Cinnamon WM
#    is *also* called muffin and *also* prints a version, so we ask "does the
#    muffin already on PATH resolve to THIS build?" — if not, it is foreign.
#    See ADR-0012.
# ---------------------------------------------------------------------------
CMD=${MUFFIN_CMD:-}
if [ -z "$CMD" ]; then
  CMD=muffin
  existing=$(command -v muffin 2>/dev/null || true)
  if [ -n "$existing" ]; then
    existing_real=$(node -e 'try{process.stdout.write(require("fs").realpathSync(process.argv[1]))}catch(e){process.stdout.write("")}' "$existing" 2>/dev/null || true)
    if [ "$existing_real" != "$BIN" ]; then
      CMD=muffin-agent
      say ""
      say "note: a different 'muffin' is already on your PATH:"
      say "        $existing"
      say "      On Linux Mint that is the Cinnamon window manager. Installing as"
      say "      'muffin-agent' so it is not shadowed. Run it as: muffin-agent"
      say "      To take the name 'muffin' anyway: MUFFIN_CMD=muffin ./install.sh"
      say ""
    fi
  fi
fi

BINDIR=${MUFFIN_BINDIR:-$HOME/.local/bin}
mkdir -p "$BINDIR"
ln -sf "$BIN" "$BINDIR/$CMD"
MUFFIN="$BINDIR/$CMD"
say "installed: $MUFFIN -> $BIN"

# Completion is a projection of Muffin's command authority, not another command
# list the installer owns.  These user-local locations are discovered by the
# usual bash/fish integrations; zsh gets the small fpath marker only when the
# owner already uses zsh.
COMPLETION_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
mkdir -p "$COMPLETION_HOME/bash-completion/completions" "$COMPLETION_HOME/zsh/site-functions" "$HOME/.config/fish/completions"
"$MUFFIN" completion bash >"$COMPLETION_HOME/bash-completion/completions/$CMD"
"$MUFFIN" completion zsh >"$COMPLETION_HOME/zsh/site-functions/_$CMD"
"$MUFFIN" completion fish >"$HOME/.config/fish/completions/$CMD.fish"
if [ "${SHELL##*/}" = zsh ]; then
  ZSH_MARK="# muffin (install.sh): completion"
  if ! grep -qF "$ZSH_MARK" "$HOME/.zshrc" 2>/dev/null; then
    printf '\n%s\nfpath=("%s/zsh/site-functions" $fpath)\nautoload -Uz compinit; compinit\n' "$ZSH_MARK" "$COMPLETION_HOME" >>"$HOME/.zshrc" || die "could not write $HOME/.zshrc"
  fi
fi

# The contract of this section is «install → `muffin` works», in the next
# shell too, not only inside this script. Two directories have to be on the
# login shell's PATH for that: the launcher's, and — measured on a fresh VPS
# on 2026-09-08, where `muffin` printed «/usr/bin/env: 'node': No such file»
# after a clean run of this very script — the bundled Node's, because the
# launcher is a symlink whose shebang resolves `node` through PATH. Printing
# an `echo … >> ~/.profile` for the owner to copy was the previous answer,
# and it left the second directory out. So the script writes the line itself,
# once (the marker keeps re-runs from stacking it), into the files login
# shells actually read: `~/.profile` (sh/dash/bash when no .bash_profile),
# `~/.bash_profile` when it exists (bash then skips .profile), `~/.zprofile`
# on macOS/zsh. Interactive shells already open need `. ~/.profile` or a new
# login — said below, not assumed.
PERSIST=""
case ":$PATH:" in *":$BINDIR:"*) : ;; *) PERSIST="$BINDIR" ;; esac
if [ -x "$NODE_DIR/bin/node" ] && [ "$(command -v node 2>/dev/null)" = "$NODE_DIR/bin/node" ]; then
  PERSIST="$PERSIST${PERSIST:+:}$NODE_DIR/bin"
fi
PATH="$BINDIR:$PATH"
export PATH
if [ -n "$PERSIST" ]; then
  MARK="# muffin (install.sh): the launcher and its bundled Node"
  LINE="export PATH=\"$PERSIST:\$PATH\""
  written=""
  for rc in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.zprofile"; do
    case "$rc" in
      */.profile) ;;
      */.bash_profile) [ -f "$rc" ] || continue ;;
      */.zprofile) [ "$(uname -s)" = Darwin ] || [ "${SHELL:-}" != "" ] && [ "${SHELL##*/}" = zsh ] || continue ;;
    esac
    if [ -f "$rc" ] && grep -qF "$MARK" "$rc" 2>/dev/null; then
      written="$written $rc"
      continue
    fi
    printf '\n%s\n%s\n' "$MARK" "$LINE" >>"$rc" || die "could not write $rc"
    written="$written $rc"
  done
  say ""
  say "PATH: added $PERSIST to$written"
  say "      new login shells find muffin; in this one:  . ~/.profile"
fi

# ---------------------------------------------------------------------------
# 6. Setup — `muffin init`.
#
# The API key reaches `init` on **stdin** and nowhere else: never argv (shell
# history, and every `ps` on the box), never an environment variable (/proc,
# and inherited by every child). `cmdInit` refuses both by name, so this is not
# a convention this file could quietly break — ADR-0048.
#
# Three cases, and the one that cannot get a key does not pretend:
#   · MUFFIN_API_KEY_FILE set → unattended, the file is piped in
#   · a terminal              → `init` runs and asks, hidden
#   · a pipe with no key file → print the one command and stop here
# ---------------------------------------------------------------------------
already_configured() { [ -f "${MUFFIN_HOME:-$HOME/.muffin}/config.json" ]; }

did_init=0
if [ -n "${MUFFIN_API_KEY_FILE:-}" ]; then
  [ -f "$MUFFIN_API_KEY_FILE" ] || die "MUFFIN_API_KEY_FILE=$MUFFIN_API_KEY_FILE does not exist."
  say ""
  say "setting up (key read from $MUFFIN_API_KEY_FILE, never from argv or the environment)…"
  "$MUFFIN" init <"$MUFFIN_API_KEY_FILE" || die "muffin init failed"
  did_init=1
elif [ -t 0 ]; then
  printf 'set up muffin now? [Y/n] ' >&2
  read -r reply || reply=""
  case "$reply" in
    '' | y | Y | yes | YES)
      say ""
      "$MUFFIN" init || die "muffin init failed"
      did_init=1
      ;;
  esac
elif already_configured; then
  did_init=1
fi

if [ "$did_init" = 0 ]; then
  say ""
  say "next:"
  say "  $CMD init     set up ~/.muffin (it will prompt for your API key)"
  say "  $CMD          open the agent"
  say ""
  say "unattended instead:  MUFFIN_API_KEY_FILE=/path/to/key sh install.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# 7. The supervisor.
#
# `muffin init` on a terminal already offers to *write* the unit; what it
# deliberately does not do is load it into the supervisor (ADR-0035: writing a
# file in your home and starting a service are different acts). At the end of a
# one-command install the answer is unambiguous — the whole promise of the
# command is a running agent — so this step does both, through the single
# command that also runs `loginctl enable-linger` and then *verifies a pid*
# instead of trusting `systemctl`'s exit code.
#
# When there is no user systemd instance to talk to (a container, a
# `sudo`-without-login shell), this cannot succeed and must not claim to: the
# script exits 3 and says which command is left. Three and not one, so a script
# driving this installer can tell "nothing works" from "everything works except
# the part this machine cannot do".
# ---------------------------------------------------------------------------
if [ "${MUFFIN_NO_GATEWAY:-}" = 1 ]; then
  say ""
  say "MUFFIN_NO_GATEWAY=1 — the supervisor was not touched. When you want it:"
  say "  $CMD gateway install --write --start"
  exit 0
fi

say ""
say "installing the gateway as a supervised service…"
if "$MUFFIN" gateway install --write --start >/dev/null; then
  say ""
  say "muffin is installed and running:  $CMD"
  exit 0
fi

say ""
say "! the gateway is NOT active on this machine."
if [ "$(uname -s)" = Linux ]; then
  if ! have systemctl; then
    say "  systemd is not installed here, so there is no user service to load."
  elif ! systemctl --user is-system-running >/dev/null 2>&1; then
    say "  this shell has no user systemd bus (a container, or a \`su -\`/\`sudo -i\`"
    say "  shell): the line above says whether \`loginctl enable-linger $(id -un)\`"
    say "  from root is what is missing. Then re-run, in this same shell:"
  fi
fi
say "    $CMD gateway install --write --start"
say "  the command itself is installed and working: try  $CMD doctor"
exit "$EXIT_GATEWAY_NOT_ACTIVE"
