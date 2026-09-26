#!/usr/bin/env sh
# muffin installer — one command, from an empty machine to a supervised agent.
#
#   curl -fsSL https://raw.githubusercontent.com/muffin-project/muffin-agent/main/bootstrap.sh | sh
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
#   1. OS packages     fetch/build prerequisites + platform-specific sandbox deps
#   2. Node >= 22      the official tarball under MUFFIN_PREFIX, never a system package
#   3. the source      git clone (or reuse) — `muffin update` needs a real checkout
#   4. the build       npm ci/install -> dist/
#   5. the command     a symlink in a user-writable bin dir, never sudo into /usr
#   6. the setup       `muffin init` (the key arrives on stdin, never argv/env)
#   7. the supervisor  `muffin gateway install --write --start`
#
# Steps 1-5 are unattended. Steps 6-7 need something only the owner has (an API
# key) or something only a real login session has (a user systemd instance), so
# each one degrades to a printed command rather than to a lie. The public
# `bootstrap.sh` exists solely to stage this file and restore the controlling
# terminal to stdin when the outer `curl | sh` consumed fd 0.
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
# ## Modes and overrides (all optional)
#
#   --personal | --checkout               install mode; personal is the default
#                                         and never binds to a source checkout.
#                                         MUFFIN_MODE does the same from the env.
#   --paths                               print the resolved paths and exit
#   --uninstall                           remove this build's launcher symlink(s)
#
#   MUFFIN_PREFIX=~/.local/share/muffin   where the code and Node live
#   MUFFIN_BINDIR=~/.local/bin            where the launcher symlink goes
#   MUFFIN_CMD=muffin                     force the command name (see the Mint note)
#   MUFFIN_REPO=<git url>                 where to clone from
#   MUFFIN_CHANNEL=main                   which branch to install
#   MUFFIN_HOME=~/.muffin                 runtime data home; reported here, read
#                                         by the runtime, never touched by this
#                                         installer
#   MUFFIN_API_KEY_FILE=<path>            unattended setup: the key is read from
#                                         this file and piped into `muffin init`.
#                                         A path, never the value: a secret in an
#                                         env var is readable from /proc and ends
#                                         up in shell history (ADR-0048).
#   MUFFIN_NO_APT=1                       never call apt-get
#   MUFFIN_NO_GATEWAY=1                   install, but do not touch the supervisor
#   MUFFIN_NODE_DIST_BASE=<url>           test/mirror hook: distribution directory
#                                         the Node tarball AND its SHASUMS256.txt
#                                         are fetched from (default: nodejs.org).
#                                         The checksum gate applies either way.
#
# Exit codes: 0 done · 1 something failed · 3 installed, gateway NOT active.
set -eu

MUFFIN_PREFIX=${MUFFIN_PREFIX:-$HOME/.local/share/muffin}
MUFFIN_REPO=${MUFFIN_REPO:-https://github.com/muffin-project/muffin-agent.git}
MUFFIN_CHANNEL=${MUFFIN_CHANNEL:-main}
NODE_MAJOR_REQUIRED=22
EXIT_GATEWAY_NOT_ACTIVE=3

say() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 0. Arguments, mode, and where the source is.
#
# Two install modes, and the choice is **explicit** — the script never infers
# it from where it happens to sit:
#
#   personal (default)  code and Node under $MUFFIN_PREFIX; the launcher and
#                       `muffin update`'s releases stay there. A personal
#                       install never writes `.releases/` into a source clone.
#   checkout            only with `--checkout` (or MUFFIN_MODE=checkout): the
#                       launcher points at THIS checkout's `dist/`, and
#                       `muffin update` stores releases under its `.releases/`.
#                       Development mode, named as such.
#
# Running this script from a clone used to select checkout mode silently, just
# because the directory contained Muffin's package.json (#702). Now the same
# run is a personal install and says so, with the one flag that changes it.
#
# `--paths` resolves and prints the same paths without touching the machine.
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")

CHECKOUT=0
UNINSTALL=0
PATHS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --checkout) CHECKOUT=1 ;;
    --personal) CHECKOUT=0 ;;
    --paths) PATHS_ONLY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
      cat >&2 <<'USAGE'
muffin install.sh [--personal | --checkout] [--paths] [--uninstall]

  (default)     personal install: code under $MUFFIN_PREFIX, data under ~/.muffin
  --checkout    development install bound to this source checkout
  --paths       print the resolved paths and exit, changing nothing
  --uninstall   remove the launcher symlink(s) pointing at this build
USAGE
      exit 0
      ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

is_clone=0
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] &&
  grep -q '"name": *"muffin-agent"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  is_clone=1
fi

if [ "$CHECKOUT" = 1 ]; then
  MODE=checkout
elif [ -n "${MUFFIN_MODE:-}" ]; then
  case "$MUFFIN_MODE" in
    personal | checkout) MODE=$MUFFIN_MODE ;;
    *) die "MUFFIN_MODE must be 'personal' or 'checkout', got '$MUFFIN_MODE'" ;;
  esac
else
  MODE=personal
fi

if [ "$MODE" = checkout ]; then
  [ "$is_clone" = 1 ] ||
    die "--checkout needs a muffin-agent checkout; run this script from the clone, or drop --checkout for a personal install"
  SRC=$SCRIPT_DIR
else
  SRC=$MUFFIN_PREFIX/src
  if [ "$is_clone" = 1 ]; then
    say "note: this is a muffin-agent checkout, and a *personal* install is selected."
    say "      code will live in $MUFFIN_PREFIX; pass --checkout to bind the launcher to this clone instead."
  fi
fi
NODE_DIR=$MUFFIN_PREFIX/node
BIN="$SRC/dist/cli/main.js"
RELEASES_DIR=$SRC/.releases
LAUNCHER_DIR=${MUFFIN_BINDIR:-$HOME/.local/bin}
DATA_HOME=${MUFFIN_HOME:-$HOME/.muffin}

report_paths() {
  say "muffin installer — resolved paths"
  say "  mode:      $MODE"
  say "  source:    $SRC"
  say "  releases:  $RELEASES_DIR"
  say "  node:      $NODE_DIR"
  say "  launcher:  $LAUNCHER_DIR/muffin"
  say "  data home: $DATA_HOME (owned by the runtime, never touched by this installer)"
}

if [ "$UNINSTALL" = 1 ]; then
  removed=0
  for dir in "$LAUNCHER_DIR" /opt/homebrew/bin /usr/local/bin; do
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
  if [ "$MODE" = personal ]; then
    say "to remove the code and the bundled Node:  rm -rf $MUFFIN_PREFIX"
  fi
  exit 0
fi

if [ "$PATHS_ONLY" = 1 ]; then
  report_paths
  exit 0
fi

report_paths

# ---------------------------------------------------------------------------
# 1. OS packages.
#
# Split in two on purpose, because the two halves fail differently:
#
#   REQUIRED  git/curl/ca-certificates/xz-utils — without them this script
#             cannot fetch or unpack anything, so a failure here is fatal.
#   SANDBOX   Linux: bubblewrap/socat/ripgrep. macOS: Seatbelt ships with the
#             OS and the sandbox runtime only needs ripgrep. These lists come
#             from the same platform split the runtime uses; recommending
#             bubblewrap on Darwin is not a harmless extra — it tells an owner
#             to install a Linux-only package for a mechanism Muffin never calls.
#
# `sudo -n` and never an installer-owned password prompt: even when bootstrap
# restored a controlling TTY, privilege escalation is a distinct owner action.
# A missing privileged package should produce one explicit remedy rather than
# silently turning installation into a root-interactive wizard.
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

case "$(uname -s)" in
  Linux)
    missing_sandbox=''
    for b in bwrap socat rg; do
      have "$b" || missing_sandbox="$missing_sandbox $b"
    done
    if [ -n "$missing_sandbox" ]; then
      apt_install "the sandbox — without it every command asks you first" 0 bubblewrap socat ripgrep || true
      say "      On Ubuntu 24.04+ bwrap also needs an AppArmor profile granting userns."
    fi
    ;;
  Darwin)
    # @anthropic-ai/sandbox-runtime uses the built-in sandbox-exec/Seatbelt
    # mechanism on macOS. Its only additional binary dependency is ripgrep;
    # socat is part of the Linux network-namespace bridge and bwrap is Linux-only.
    if ! have rg; then
      say "note: the macOS sandbox uses built-in Seatbelt; ripgrep is missing — brew install ripgrep"
    fi
    ;;
  *)
    say "note: no supported automatic sandbox dependency setup for $(uname -s); muffin doctor will report the actual containment state"
    ;;
esac

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
# MUFFIN_PREFIX is exactly that, and it is what `actions/setup-node` does as well.
#
# A system Node that is already >= 22 is used as-is: nothing is downloaded and
# nothing shadows what the machine already had.
# ---------------------------------------------------------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Portable SHA-256 of one file, hex on stdout. `sha256sum` (coreutils, Linux)
# first, `shasum -a 256` (macOS) second; neither is optional here — an
# unverifiable download is a download that does not get extracted.
sha256_file() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "neither sha256sum nor shasum is available — cannot verify the Node download, refusing to continue."
  fi
}

# Fail-closed integrity gate for the Node tarball. The tarball AND the
# checksum list come from the same MUFFIN_NODE_DIST_BASE, so this check
# verifies the PAIR as served — it does not authenticate the origin.
# It stops: corrupted/truncated downloads, mismatched artifacts, accidental
# mirror inconsistency, a tarball modified without a matching modification
# to the checksum manifest. It does NOT stop: a malicious/compromised mirror
# that replaces both files consistently, or compromise of the distribution
# origin itself. A `.asc`/GPG verification against ad-hoc fetched keys would
# move the same trust (this network, right now) into a second file without
# adding any, so it is deliberately not that; stronger origin authenticity
# needs a pinned/maintained trust root, tracked separately if required.
# Runs BEFORE anything under $NODE_DIR is touched, so a refused download can
# never wipe a working Node.
verify_node_tarball() {
  # usage: verify_node_tarball <tarball-path> <shasums-path> <expected-filename>
  tarball=$1
  sums=$2
  name=$3
  want=$(grep -F "  $name" "$sums" | awk '{print $1}' | head -1)
  [ -n "$want" ] || die "no checksum entry for $name in $(basename "$sums") — refusing to install an unlisted file."
  case "$want" in
    *[!0-9a-f]* | '') die "malformed checksum entry for $name — refusing to install." ;;
  esac
  [ "${#want}" = 64 ] || die "malformed checksum entry for $name — refusing to install."
  have_sum=$(sha256_file "$tarball")
  if [ "$have_sum" != "$want" ]; then
    die "checksum mismatch for $name (downloaded $have_sum, expected $want) — the file is discarded, nothing was installed."
  fi
  say "node checksum ok: $name"
}

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
  base=${MUFFIN_NODE_DIST_BASE:-https://nodejs.org/dist/latest-v$NODE_MAJOR_REQUIRED.x}
  say "installing Node $NODE_MAJOR_REQUIRED.x into $NODE_DIR (nothing outside your home is touched)"
  listing=$(curl -fsSL "$base/") || die "cannot reach $base — no network?"
  file=$(printf '%s' "$listing" | grep -oE "node-v$NODE_MAJOR_REQUIRED\.[0-9]+\.[0-9]+-$os-$arch\.tar\.xz" | head -1)
  [ -n "$file" ] || die "no node-v$NODE_MAJOR_REQUIRED.x-$os-$arch.tar.xz on $base/"
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/node.tar.xz" || die "download failed: $base/$file"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "download failed: $base/SHASUMS256.txt (no checksum list, no install)"
  verify_node_tarball "$tmp/node.tar.xz" "$tmp/SHASUMS256.txt" "$file"
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
if [ "$MODE" = personal ]; then
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
if [ "$MODE" = personal ] && [ -f "$SRC/package-lock.json" ]; then
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
OWNER_SHELL=${SHELL:-}
if [ "${OWNER_SHELL##*/}" = zsh ]; then
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
# An existing Home is NEVER re-initialised here, on any input mode: `init`
# used to rebuild the config from defaults, so accepting the prompt on an
# existing Home silently reset models/surfaces/provider routing and more
# (incident 2026-09-18 — `runInit` now preserves, but the installer still has
# no business re-running setup unasked). A deliberate reconfiguration is
# `muffin init` typed by the owner, never this prompt's default.
#
# Three cases, and the one that cannot get a key does not pretend:
#   · setup already exists → skip, continue to upgrade/supervisor/migration
#   · MUFFIN_API_KEY_FILE set → unattended, the file is piped in
#   · a terminal              → `init` runs and asks, hidden
#   · a pipe with no key file → print the one command and stop here
# ---------------------------------------------------------------------------
already_configured() { [ -f "${MUFFIN_HOME:-$HOME/.muffin}/config.json" ]; }

did_init=0
if already_configured; then
  say ""
  say "setup already exists (${MUFFIN_HOME:-$HOME/.muffin}/config.json) — skipping init, continuing to upgrade/supervisor steps"
  say "  to reconfigure deliberately:  $CMD init"
  did_init=1
elif [ -n "${MUFFIN_API_KEY_FILE:-}" ]; then
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
