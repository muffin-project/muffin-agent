#!/usr/bin/env bash
# #702 — install modes are explicit, and every path is reported.
#
# Running install.sh from a muffin-agent checkout used to select checkout mode
# silently, just because the directory contained Muffin's package.json. This
# eval proves the contract without installing anything: `--paths` resolves and
# prints source / releases / node / launcher / data home, so the mode decision
# is observable and cheap. A personal install must never write `.releases/`
# into a source checkout; checkout mode must be opted into and must refuse
# outside a clone.
#
# Needs only sh, mktemp, grep — no Node, no git, no network.
#
# Usage:  bash evals/install/modes.sh [path-to-repo]   (default: git toplevel)
set -uo pipefail

REPO=${1:-}
if [ -z "$REPO" ]; then REPO=$(git rev-parse --show-toplevel); fi
REPO=$(cd "$REPO" && pwd)

FAILURES=0
STEP=""
step() { STEP=$1; printf '\n=== %s ===\n' "$1"; }
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  [%s] %s\n' "$STEP" "$*" >&2; FAILURES=$((FAILURES + 1)); }
finish() {
  printf '\n============================================================\n'
  printf 'install-modes eval: %s\n' "$([ "$FAILURES" = 0 ] && echo PASS || echo "FAIL ($FAILURES check(s))")"
  printf '============================================================\n'
  [ "$FAILURES" = 0 ] && exit 0
  exit 1
}

LAB=$(mktemp -d /tmp/muffin-install-modes.XXXXXX)
trap 'rm -rf "$LAB"' EXIT

PREFIX="$LAB/prefix"
BINDIR="$LAB/bin"
DATA="$LAB/data"

# A clone of Muffin: the installer plus its own package.json.
CLONE="$LAB/clone"
mkdir -p "$CLONE"
cp "$REPO/install.sh" "$CLONE/install.sh"
printf '{"name":"muffin-agent","version":"0.0.0"}\n' >"$CLONE/package.json"

# Some other project's directory: an install.sh that does NOT live in a clone.
PLAIN="$LAB/plain"
mkdir -p "$PLAIN"
cp "$REPO/install.sh" "$PLAIN/install.sh"
printf '{"name":"some-other-project","version":"1.0.0"}\n' >"$PLAIN/package.json"

# `run <dir> [args...]`: the installer, isolated to the lab's paths.
run() {
  local dir=$1
  shift
  MUFFIN_PREFIX="$PREFIX" MUFFIN_BINDIR="$BINDIR" MUFFIN_HOME="$DATA" sh "$dir/install.sh" "$@"
}

expect_contains() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) ok "$label" ;;
    *) bad "$label — missing: $needle" ;;
  esac
}

step "A: a clone without a flag is a PERSONAL install, and says so"
out=$(run "$CLONE" --paths 2>&1) || bad "install.sh --paths exited non-zero: $out"
expect_contains "$out" 'mode:      personal' "mode is personal"
expect_contains "$out" "source:    $PREFIX/src" "source is under the prefix"
expect_contains "$out" "releases:  $PREFIX/src/.releases" "releases are under the prefix"
expect_contains "$out" 'personal* install is selected' "the checkout notice tells the owner how to opt out"
expect_contains "$out" "launcher:  $BINDIR/muffin" "launcher path is reported"
expect_contains "$out" "data home: $DATA" "runtime data home is reported"
[ ! -e "$CLONE/.releases" ] && ok "no .releases created in the clone" || bad ".releases appeared in the checkout"

step "B: --checkout binds to the clone"
out=$(run "$CLONE" --checkout --paths 2>&1) || bad "install.sh --checkout --paths exited non-zero: $out"
expect_contains "$out" 'mode:      checkout' "mode is checkout"
expect_contains "$out" "source:    $CLONE" "source is the clone"
expect_contains "$out" "releases:  $CLONE/.releases" "releases follow the clone"

step "C: --checkout outside a clone is refused"
rc=0
out=$(run "$PLAIN" --checkout --paths 2>&1) || rc=$?
[ "$rc" -ne 0 ] && ok "refused (exit $rc)" || bad "accepted --checkout outside a clone"
expect_contains "$out" 'needs a muffin-agent checkout' "the refusal names the reason"

step "D: MUFFIN_MODE=checkout is equivalent to --checkout"
out=$(MUFFIN_MODE=checkout run "$CLONE" --paths 2>&1) || bad "MUFFIN_MODE=checkout exited non-zero: $out"
expect_contains "$out" 'mode:      checkout' "env override selects checkout"

step "E: --personal from a clone stays personal"
out=$(run "$CLONE" --personal --paths 2>&1) || bad "--personal exited non-zero: $out"
expect_contains "$out" 'mode:      personal' "explicit personal wins over the clone"
[ ! -e "$CLONE/.releases" ] && ok "still no .releases in the clone" || bad ".releases appeared in the checkout"

finish
