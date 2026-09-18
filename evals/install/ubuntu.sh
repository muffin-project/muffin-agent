#!/usr/bin/env bash
# DAY-1 A11 — install Muffin on an empty Ubuntu box without inheriting the
# runner's home or service manager.
#
# This script is the *proof*, not the installer. It rehearses the claim end to
# end on a machine that has never seen Muffin: no Node, no checkout, no
# `~/.muffin`, nothing but Ubuntu and a non-root user with sudo. It is written
# to run inside `scripts/ci-local.ts`'s `ubuntu:24.04` container (and on
# GitHub's `ubuntu-latest`), which is the only place the claim can be tested —
# the claim is about Linux, and the developer machines are Macs. "Linux prima,
# macOS poi".
#
# ## What "an empty machine" means here, concretely
#
# The container that runs CI already has Node installed at `/opt/node/bin`
# (`buildBootstrapScript` puts it there to emulate `actions/setup-node`), so
# simply running the installer would prove nothing about the prerequisite it is
# supposed to solve. So this script builds a **clean PATH** out of the system
# directories only, dropping any that contains a `node`/`npm`, and refuses to
# continue unless `node` really is unreachable under it. Everything the
# installer does afterwards happens under that PATH, in a throwaway `HOME`.
#
# The repository under test is served to the installer through a **local bare
# git repo**, not GitHub: the point is to exercise `install.sh`'s clone/build/
# link path and `muffin update`'s `.releases/<sha>` path against *this commit*,
# and a fetch of github.com/main would silently test a different tree.
#
# ## What this eval cannot prove, declared and not papered over
#
# This eval owns a throwaway HOME. A host's user systemd manager belongs to its
# real login home and cannot supervise the unit written into this lab. So the
# eval gives its subprocesses a private, absent user-bus socket and proves the
# supervisor half in two pieces instead of accidentally querying the host's
# unrelated manager:
#
#   · `systemd-analyze verify` on the unit `muffin gateway install` actually
#     wrote — systemd's own parser, so a malformed or unloadable unit is red;
#   · the unit's own `ExecStart`, run in the foreground, until
#     `muffin gateway status` reports a live pid — which is the thing systemd
#     would have done, minus systemd.
#
# This deliberately does not prove that a service is active under systemd or
# survives logout. That needs a separate disposable VM with a user manager
# configured for this HOME; a green here proves the no-user-bus install path.
#
# ## The provider key
#
# `muffin init` needs one and this script has none, so it writes a syntactically
# valid but useless Anthropic-shaped key into a file and lets `install.sh` pipe
# it in. That is enough for every check below: nothing here makes a model call.
# It travels by file and stdin — never argv, never the environment — because
# that is the only path `cmdInit` accepts (ADR-0048), and this script must not
# be the place where that stops being true.
#
# Usage:  bash evals/install/ubuntu.sh [path-to-repo]      (default: git toplevel)
set -uo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "install eval: Linux only — a green on macOS proves the machine that does not count." >&2
  exit 1
fi

REPO=${1:-}
if [ -z "$REPO" ]; then REPO=$(git rev-parse --show-toplevel); fi
REPO=$(cd "$REPO" && pwd)

START=$(date +%s)
FAILURES=0
STEP=""

step() {
  STEP=$1
  printf '\n=== %s   [t+%ss] ===\n' "$1" "$(($(date +%s) - START))"
}
ok() { printf '  ok    %s\n' "$*"; }
bad() {
  printf '  FAIL  [%s] %s\n' "$STEP" "$*" >&2
  FAILURES=$((FAILURES + 1))
}
fatal() {
  bad "$*"
  finish
}

finish() {
  local secs=$(($(date +%s) - START))
  printf '\n============================================================\n'
  printf 'install eval: %s in %ss\n' "$([ "$FAILURES" = 0 ] && echo PASS || echo "FAIL ($FAILURES check(s))")" "$secs"
  printf '============================================================\n'
  [ "$FAILURES" = 0 ] && exit 0
  exit 1
}

# ---------------------------------------------------------------------------
# The lab: a throwaway HOME, so nothing here can read or write the real
# `~/.muffin` of whoever runs it. Every default in `install.sh` and in
# `paths()` is anchored to $HOME, so moving $HOME moves the whole install.
# ---------------------------------------------------------------------------
LAB=$(mktemp -d /tmp/muffin-install-eval.XXXXXX)
export HOME="$LAB/home"
export XDG_CONFIG_HOME="$HOME/.config"
# GitHub-hosted runners can expose both a user XDG directory and a live
# systemd user bus. This eval owns a throwaway home, so neither may leak in.
# An empty private bus path intentionally exercises install.sh's documented
# no-user-manager path; a host manager for /home/runner cannot supervise this
# temporary installation.
export XDG_RUNTIME_DIR="$LAB/runtime"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export MUFFIN_PREFIX="$HOME/.local/share/muffin"
BINDIR="$HOME/.local/bin"
MUFFIN="$BINDIR/muffin"
UNIT="$HOME/.config/systemd/user/muffin-gateway.service"

cleanup() {
  # Only our own pid, never a pattern: the owner's real gateway runs on the
  # machine that also runs this suite, and `pkill -f "gateway run"` would take
  # it down (docs/evidence/lessons.md).
  if [ -n "${GATEWAY_PID:-}" ]; then kill "$GATEWAY_PID" 2>/dev/null || true; fi
  rm -rf "$LAB"
}
trap cleanup EXIT

echo "install eval — repo $REPO"
echo "lab           $LAB (HOME=$HOME)"

# ---------------------------------------------------------------------------
step "a machine with no Node"
# ---------------------------------------------------------------------------
CLEAN_PATH=""
for d in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
  [ -d "$d" ] || continue
  if [ -x "$d/node" ] || [ -x "$d/npm" ]; then
    echo "  (dropping $d from the clean PATH: it has a node/npm)"
    continue
  fi
  CLEAN_PATH="${CLEAN_PATH:+$CLEAN_PATH:}$d"
done
[ -n "$CLEAN_PATH" ] || fatal "nothing left in the clean PATH — cannot simulate a bare machine"
if PATH="$CLEAN_PATH" command -v node >/dev/null 2>&1; then
  fatal "node is still reachable under the clean PATH ($CLEAN_PATH) — this run would not test the Node prerequisite at all"
fi
ok "no node, no npm under PATH=$CLEAN_PATH"

# ---------------------------------------------------------------------------
step "a git origin holding exactly this commit"
# ---------------------------------------------------------------------------
SHA=$(git -C "$REPO" rev-parse HEAD) || fatal "$REPO is not a git checkout"
ORIGIN="$LAB/origin.git"
git clone --quiet --bare "$REPO" "$ORIGIN" || fatal "could not create the bare origin"
git -C "$ORIGIN" branch -f main "$SHA" || fatal "could not point origin/main at $SHA"
# `dev` too: `muffin update` fetches the upstream channel to report how far
# ahead it is, and a missing branch there would make it print "unknown" for a
# reason that has nothing to do with what is being tested.
git -C "$ORIGIN" branch -f dev "$SHA" >/dev/null 2>&1 || true
ok "origin/main = ${SHA:0:12}"

# ---------------------------------------------------------------------------
step "one command: install.sh"
# ---------------------------------------------------------------------------
KEYFILE="$LAB/key"
printf 'sk-ant-api03-installeval-not-a-real-key' >"$KEYFILE"
chmod 600 "$KEYFILE"

# Piped through `sh` from a file that is NOT inside a checkout, so the script
# takes its `curl … | sh` branch: it has to find git, install Node, clone, build
# and link entirely on its own. `< /dev/null` keeps stdin closed, exactly as a
# real pipe leaves it.
cp "$REPO/install.sh" "$LAB/install.sh"
INSTALL_LOG="$LAB/install.log"
set +e
env -i \
  HOME="$HOME" \
  XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  PATH="$CLEAN_PATH" \
  TERM="${TERM:-dumb}" \
  MUFFIN_PREFIX="$MUFFIN_PREFIX" \
  MUFFIN_REPO="$ORIGIN" \
  MUFFIN_CHANNEL=main \
  MUFFIN_API_KEY_FILE="$KEYFILE" \
  sh "$LAB/install.sh" </dev/null >"$INSTALL_LOG" 2>&1
INSTALL_RC=$?
set -e
tail -40 "$INSTALL_LOG" | sed 's/^/  | /'

case "$INSTALL_RC" in
  0) ok "install.sh exited 0 — including the supervisor" ;;
  3) ok "install.sh exited 3 — installed, gateway not activated (checked below)" ;;
  *) bad "install.sh exited $INSTALL_RC; full log in the output above" ;;
esac

# ---------------------------------------------------------------------------
step "what one command left behind"
# ---------------------------------------------------------------------------
NODE="$MUFFIN_PREFIX/node/bin/node"
if [ -x "$NODE" ]; then
  ok "Node provisioned by the installer: $("$NODE" --version) at $NODE"
  NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
  [ "$NODE_MAJOR" -ge 22 ] || bad "the installer provisioned Node $NODE_MAJOR, and the runtime needs >= 22"
  # The tarball must have passed the checksum gate before extraction: this
  # machine had no Node, so a download necessarily happened (see "a machine
  # with no Node" above — a skipped download here would mean the PATH
  # isolation silently broke, not that verification was unnecessary).
  if grep -q 'node checksum ok' "$INSTALL_LOG"; then
    ok "the Node tarball was checksum-verified before extraction"
  else
    bad "no 'node checksum ok' in install.sh output — the tarball may have been installed unverified"
  fi
else
  bad "no Node under $MUFFIN_PREFIX/node — install.sh did not resolve the Node 22 prerequisite"
  NODE=node
fi

SRC="$MUFFIN_PREFIX/src"
if [ -d "$SRC/.git" ]; then
  ok "source checkout at $SRC ($(git -C "$SRC" rev-parse --short HEAD))"
else
  bad "no git checkout at $SRC — \`muffin update\` builds releases as git worktrees and needs one"
fi

if [ -L "$MUFFIN" ]; then
  ok "launcher $MUFFIN -> $(readlink "$MUFFIN")"
else
  bad "no launcher at $MUFFIN — the command is not installed"
fi

# From here on, PATH is what a *login shell* of this user would have: the
# clean system dirs plus whatever install.sh persisted in ~/.profile — not a
# line this script adds by hand. Until 2026-09-08 it did add that line, and so
# the one thing a fresh VPS actually broke on («/usr/bin/env: 'node': No such
# file or directory» from `muffin` in the next shell) was invisible here.
step "a login shell finds muffin"
export PATH="$CLEAN_PATH"
if [ -f "$HOME/.profile" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.profile"
  ok "sourced ~/.profile as a login shell would"
else
  bad "install.sh left no ~/.profile — a new login shell would not find muffin"
fi
if command -v muffin >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  ok "muffin -> $(command -v muffin) · node -> $(command -v node), from ~/.profile alone"
else
  bad "after ~/.profile, muffin or node is still not on PATH ($PATH)"
fi
if "$MUFFIN" --version >/dev/null 2>&1; then
  ok "\`muffin --version\` runs through the launcher: $("$MUFFIN" --version 2>/dev/null)"
else
  bad "\`muffin --version\` fails through the launcher: the symlink's node is not reachable"
fi

if [ -f "$HOME/.muffin/config.json" ]; then
  ok "~/.muffin is set up (config.json written by \`muffin init\`)"
else
  bad "no $HOME/.muffin/config.json — \`muffin init\` never completed"
fi
if grep -q 'installeval' "$INSTALL_LOG" 2>/dev/null; then
  bad "the API key leaked into install.sh's own output"
fi

# ---------------------------------------------------------------------------
step "muffin doctor"
# ---------------------------------------------------------------------------
DOCTOR_JSON="$LAB/doctor.json"
set +e
muffin doctor --json >"$DOCTOR_JSON" 2>"$LAB/doctor.err"
DOCTOR_RC=$?
set -e
if [ ! -s "$DOCTOR_JSON" ]; then
  bad "\`muffin doctor --json\` produced nothing (exit $DOCTOR_RC)"
  sed 's/^/  | /' "$LAB/doctor.err"
else
  # The red lines are the assertion; the yellow ones are printed and allowed.
  # `doctor` exits 1 on any warn at all, and a fresh install in a container
  # legitimately warns (no Ollama, no sandbox without --privileged, an empty
  # vector index). Requiring exit 0 would mean requiring a machine this test
  # cannot have, so the executable claim is the honest one: **no check at
  # level `fail`**, and the warnings named out loud.
  "$NODE" -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const fails = r.checks.filter((c) => c.level === "fail");
    const warns = r.checks.filter((c) => c.level === "warn");
    console.log(`  ${r.checks.length} checks · ${fails.length} red · ${warns.length} yellow · exit ${r.exitCode}`);
    for (const w of warns) console.log(`  warn  ${w.name}: ${w.detail}`);
    for (const f of fails) console.log(`  RED   ${f.name}: ${f.detail}`);
    process.exit(fails.length === 0 ? 0 : 1);
  ' "$DOCTOR_JSON" || bad "muffin doctor reported red checks on a fresh install (listed above)"
  if "$NODE" -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(r.checks.some((c) => c.level === "fail") ? 1 : 0);
  ' "$DOCTOR_JSON"; then
    ok "no red lines"
  fi
fi

# ---------------------------------------------------------------------------
step "the gateway as a supervised service"
# ---------------------------------------------------------------------------
if [ -f "$UNIT" ]; then
  ok "unit written: $UNIT"
  grep -E '^(ExecStart|WorkingDirectory|Environment)=' "$UNIT" | sed 's/^/  | /'
else
  bad "no unit at $UNIT — \`muffin gateway install --write --start\` never got as far as writing one"
fi

echo "  NO USER BUS: checking the written unit with systemd and running its ExecStart in the foreground."
if [ "$INSTALL_RC" != 3 ]; then
  bad "install.sh exited $INSTALL_RC on a machine with no user systemd — it should exit 3 and say so"
fi
# The two reasons this can be unavailable are different problems and must not
# print the same sentence: a wrong remedy is worse than no remedy, because it
# gets followed. (`[ -f "$UNIT" ]` already failed above with its own line.)
if ! command -v systemd-analyze >/dev/null 2>&1; then
  bad "systemd-analyze is not installed — the unit could not be checked by systemd itself"
elif [ -f "$UNIT" ]; then
  if systemd-analyze verify "$UNIT" 2>&1 | sed 's/^/  | /'; then
    ok "systemd-analyze verify accepts the unit"
  else
    bad "systemd-analyze rejected the unit"
  fi
fi

if [ -f "$UNIT" ]; then
  EXECSTART=$(sed -n 's/^ExecStart=//p' "$UNIT" | head -1)
  UNIT_PATH=$(sed -n 's/^Environment=PATH=//p' "$UNIT" | head -1)
  UNIT_HOME=$(sed -n 's/^Environment=MUFFIN_HOME=//p' "$UNIT" | head -1)
  if [ -z "$EXECSTART" ]; then
    bad "the unit has no ExecStart"
  else
    echo "  starting the unit's own ExecStart in the foreground: $EXECSTART"
    # Exactly what systemd would exec, with exactly the environment the unit
    # declares — anything else would prove a command this machine will never
    # actually run.
    env -i HOME="$HOME" PATH="${UNIT_PATH:-$PATH}" MUFFIN_HOME="${UNIT_HOME:-$HOME/.muffin}" \
      XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
      $EXECSTART >"$LAB/gateway.out" 2>&1 &
    GATEWAY_PID=$!
    up=0
    for _ in $(seq 1 30); do
      if muffin gateway status >/dev/null 2>&1; then
        up=1
        break
      fi
      kill -0 "$GATEWAY_PID" 2>/dev/null || break
      sleep 1
    done
    if [ "$up" = 1 ]; then
      ok "the gateway came up: $(muffin gateway status 2>/dev/null | head -1)"
    else
      bad "the unit's ExecStart did not produce a live gateway within 30s"
      tail -25 "$LAB/gateway.out" | sed 's/^/  | /'
    fi
    # By pid, never by pattern.
    kill "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
    GATEWAY_PID=""
  fi
fi

# ---------------------------------------------------------------------------
step "muffin update, on the same path the install used"
# ---------------------------------------------------------------------------
BEFORE=$(readlink "$MUFFIN" 2>/dev/null || echo "")
BUMP="$LAB/bump"
git clone --quiet "$ORIGIN" "$BUMP" >/dev/null 2>&1 || bad "could not clone the origin to make a new commit"
if [ -d "$BUMP/.git" ]; then
  date -u +%FT%TZ >"$BUMP/.install-eval-bump"
  git -C "$BUMP" -c user.email=eval@muffin.invalid -c user.name='install eval' add .install-eval-bump
  git -C "$BUMP" -c user.email=eval@muffin.invalid -c user.name='install eval' \
    commit --quiet -m 'install eval: a commit to update to' || bad "could not create the bump commit"
  git -C "$BUMP" push --quiet origin HEAD:main || bad "could not push the bump commit to the origin"
  NEWSHA=$(git -C "$BUMP" rev-parse --short HEAD)
  echo "  origin/main moved to $NEWSHA"
fi

set +e
muffin update --yes >"$LAB/update.log" 2>&1
UPDATE_RC=$?
set -e
tail -25 "$LAB/update.log" | sed 's/^/  | /'
if [ "$UPDATE_RC" != 0 ]; then bad "\`muffin update\` exited $UPDATE_RC"; fi

AFTER=$(readlink "$MUFFIN" 2>/dev/null || echo "")
case "$AFTER" in
  "$SRC/.releases/"*)
    ok "the launcher now points into a release built alongside: $AFTER"
    ;;
  *)
    bad "after \`muffin update\` the launcher still points at $AFTER — no release was built and swapped in"
    ;;
esac
if muffin --help >/dev/null 2>&1; then
  ok "the updated build answers"
else
  bad "the updated build does not run"
fi

# ---------------------------------------------------------------------------
step "and back: muffin update --rollback"
# ---------------------------------------------------------------------------
set +e
muffin update --rollback --yes >"$LAB/rollback.log" 2>&1
ROLLBACK_RC=$?
set -e
tail -15 "$LAB/rollback.log" | sed 's/^/  | /'
if [ "$ROLLBACK_RC" != 0 ]; then bad "\`muffin update --rollback\` exited $ROLLBACK_RC"; fi
# The command has to *say* where it went back to. It used to do the flip in
# silence — the accumulated step was never emitted — so a green rollback and a
# rollback that found no previous release printed the same nothing.
if grep -q 'tornato a' "$LAB/rollback.log"; then
  ok "the rollback says which release it went back to"
else
  bad "\`muffin update --rollback\` never printed which release it returned to"
fi
ROLLED=$(readlink "$MUFFIN" 2>/dev/null || echo "")
if [ -n "$BEFORE" ] && [ "$ROLLED" = "$BEFORE" ]; then
  ok "the launcher is back where the install left it: $ROLLED"
else
  bad "after the rollback the launcher points at '$ROLLED', not at the pre-update '$BEFORE'"
fi
set +e
muffin doctor --json >"$LAB/doctor-after.json" 2>/dev/null
AFTER_RC=$?
set -e
# 0/1/2 are all "doctor ran and had an opinion" (ok/warn/fail); anything else,
# or an empty report, means the rolled-back build does not execute.
if [ -s "$LAB/doctor-after.json" ] && [ "$AFTER_RC" -le 2 ]; then
  ok "the rolled-back build still answers \`muffin doctor\`"
else
  bad "the rolled-back build cannot run \`muffin doctor\` (exit $AFTER_RC)"
fi

finish
