#!/usr/bin/env sh
# muffin installer — collision-safe command setup.
#
# Run from a clone of this repo:  ./install.sh
#
# Why a script and not `npm i -g`: the npm `bin` field is static ("muffin"),
# so it cannot adapt to the one place the name is already taken — Linux Mint
# ships /usr/bin/muffin, the Cinnamon window manager. Shadowing it would break
# the user's desktop. This script detects that case and installs under
# `muffin-agent` instead, never overwriting a foreign `muffin`, and never
# writing into a system dir (no sudo). See blueprint ADR-0012.
#
# Overrides:
#   MUFFIN_CMD=muffin       force the command name (e.g. accept the shadow)
#   MUFFIN_BINDIR=~/.local/bin   where to place the launcher symlink
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

say() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

BIN="$ROOT/dist/cli/main.js"

# Uninstall: remove only the launcher symlinks that point at THIS build (never a
# foreign muffin). Data under ~/.muffin is left alone — remove it with
# `muffin uninstall` first if you want it gone too.
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
  exit 0
fi

# 1. preflight: Node >= 22 (the runtime targets it; engines enforces it too)
command -v node >/dev/null 2>&1 || die "Node.js not found — install Node >= 22 first."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || die "Node >= 22 required (found $(node -v))."

# 1-bis. preflight the sandbox binaries. NOT fatal: Muffin boots without them,
#    and `doctor` says so. But it degrades to asking for confirmation on every
#    single command, which is the difference between an agent that does things
#    on the VPS and one that only chats — and discovering that AFTER setup,
#    from a diagnostic, is the wrong moment to learn it. Three binaries, not
#    two: `SandboxManager` needs ripgrep as well, and the remedy that named
#    only bubblewrap and socat sent people round in circles.
missing=''
for bin in bwrap socat rg; do
  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
done
if [ -n "$missing" ]; then
  say ""
  say "note: the sandbox needs three binaries and these are missing:$missing"
  case "$(uname -s)" in
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        say "      sudo apt-get install bubblewrap socat ripgrep"
      elif command -v dnf >/dev/null 2>&1; then
        say "      sudo dnf install bubblewrap socat ripgrep"
      else
        say "      install: bubblewrap socat ripgrep (your distro's package manager)"
      fi
      say "      On Ubuntu 24.04+ bwrap also needs an AppArmor profile granting userns."
      ;;
    Darwin) say "      brew install bubblewrap socat ripgrep" ;;
    *) say "      install: bubblewrap socat ripgrep" ;;
  esac
  say "      Without them every command Muffin runs will ask you first."
  say ""
fi

# 2. build the bin — code plus the non-TS assets init/profiles read at runtime.
#    `npm install` runs the `prepare` script, which compiles; the explicit
#    compile is a belt-and-suspenders in case prepare was disabled.
say "building muffin…"
npm install
[ -f "$BIN" ] || npm run compile
[ -f "$BIN" ] || die "build did not produce $BIN"
chmod +x "$BIN"

# 3. choose a command name that does not shadow a foreign `muffin`.
#    Detection is by identity, not by name or version string: the Cinnamon WM
#    is *also* called muffin and *also* prints a version, so we ask "does the
#    muffin already on PATH resolve to THIS build?" — if not, it is foreign.
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

# 4. link into a user-writable bin dir on PATH — never sudo into /usr/bin.
BINDIR=${MUFFIN_BINDIR:-$HOME/.local/bin}
mkdir -p "$BINDIR"
ln -sf "$BIN" "$BINDIR/$CMD"
say "installed: $BINDIR/$CMD -> $BIN"

# 5. PATH check + handoff.
case ":$PATH:" in
  *":$BINDIR:"*) : ;;
  *)
    say ""
    say "warning: $BINDIR is not on your PATH. Add it, then re-open the shell:"
    say "  echo 'export PATH=\"$BINDIR:\$PATH\"' >> ~/.profile"
    ;;
esac
# 6. offer to set up now — but only on a real terminal (Goose/Hermes chain the
#    wizard the same way). Off a TTY, just print the next steps.
if [ -t 0 ]; then
  printf 'set up muffin now? [Y/n] ' >&2
  read -r reply || reply=""
  case "$reply" in
    '' | y | Y | yes | YES)
      say ""
      "$BINDIR/$CMD" init
      exit $?
      ;;
  esac
fi
say ""
say "next:"
say "  $CMD init     set up ~/.muffin (it will prompt for your API key)"
say "  $CMD          open the agent"
