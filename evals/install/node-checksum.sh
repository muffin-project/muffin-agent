#!/usr/bin/env bash
# DAY-1 supply chain — the Node tarball checksum gate, proved fast.
#
# `evals/install/ubuntu.sh` proves the happy path end to end (real nodejs.org
# dist, real build) and asserts the `node checksum ok` line there. THIS script
# proves the other direction, without paying for a build: pointed at a local
# fake distribution directory over loopback HTTP, `install.sh` must refuse a
# tampered tarball, a checksum list without an entry, and a missing checksum
# list — each with its own message, each BEFORE anything under the Node
# directory is touched (a refused download must never wipe a working Node).
#
# Fast on purpose: every refusal happens in step 2 (Node), before git/npm ever
# run, so no repository, no compiler and no network beyond 127.0.0.1 are
# needed. Needs: sh, curl, python3 (loopback file server only), mktemp.
#
# Usage:  bash evals/install/node-checksum.sh [path-to-repo]   (default: git toplevel)
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
  printf 'node-checksum eval: %s\n' "$([ "$FAILURES" = 0 ] && echo PASS || echo "FAIL ($FAILURES check(s))")"
  printf '============================================================\n'
  [ "$FAILURES" = 0 ] && exit 0
  exit 1
}

LAB=$(mktemp -d /tmp/muffin-node-checksum.XXXXXX)
cleanup() { if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi; rm -rf "$LAB"; }
trap cleanup EXIT

# The filename install.sh will look for, computed with its own mapping.
case "$(uname -m)" in
  aarch64 | arm64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) echo "unsupported arch for this eval: $(uname -m)" >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "unsupported OS for this eval: $(uname -s)" >&2; exit 1 ;;
esac
FILE="node-v22.99.0-$OS-$ARCH.tar.xz"

step "fake distribution directory on loopback"
DIST="$LAB/dist"
mkdir -p "$DIST"
printf 'tampered-bytes-not-a-tarball' >"$DIST/$FILE"
# NOTE: no SHASUMS256.txt yet — variant C wants it absent first.
cp "$REPO/install.sh" "$LAB/install.sh"
if ! command -v python3 >/dev/null 2>&1; then bad "python3 missing (loopback file server)"; finish; fi
PORT=0
SERVER_PID=""
for try in 18831 18832 18833 18834 18835; do
  python3 -m http.server --directory "$DIST" --bind 127.0.0.1 "$try" >"$LAB/http.log" 2>&1 &
  SERVER_PID=$!
  sleep 1
  if curl -fsSL "http://127.0.0.1:$try/" 2>/dev/null | grep -q "$FILE"; then PORT=$try; break; fi
  kill "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
done
[ "$PORT" != 0 ] || { bad "loopback file server never served the fake dist (see $LAB/http.log)"; finish; }
ok "fake dist served at http://127.0.0.1:$PORT/ ($FILE)"

# One attempt = a throwaway HOME+PREFIX with a pre-seeded sentinel inside the
# Node directory: the sentinel must survive every refusal (verify-before-rm).
attempt() {
  # usage: attempt <label> <expected-message> [extra-setup...]
  label=$1
  expect=$2
  home=$(mktemp -d "$LAB/home.XXXXXX")
  prefix="$home/.local/share/muffin"
  mkdir -p "$prefix/node"
  echo sentinel >"$prefix/node/SENTINEL"
  log="$LAB/$label.log"
  set +e
  env -i HOME="$home" PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    MUFFIN_PREFIX="$prefix" MUFFIN_NO_APT=1 \
    MUFFIN_NODE_DIST_BASE="http://127.0.0.1:$PORT" \
    sh "$LAB/install.sh" </dev/null >"$log" 2>&1
  rc=$?
  set -e
  if [ "$rc" = 0 ]; then
    bad "$label: installer exited 0, expected refusal ($expect)"
    return
  fi
  if grep -qF "$expect" "$log"; then
    ok "$label: refused with '$expect' (exit $rc)"
  else
    bad "$label: refusal message missing '$expect' (exit $rc)"
    tail -8 "$log" | sed 's/^/  | /'
  fi
  if [ -f "$prefix/node/SENTINEL" ]; then
    ok "$label: pre-existing Node directory untouched (verify runs before rm)"
  else
    bad "$label: SENTINEL gone — a refused download wiped the Node directory"
  fi
}

step "variant C: checksum list missing entirely"
attempt missing-sums 'SHASUMS256.txt (no checksum list, no install)'

step "variant B: tarball tampered, list present"
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
# The list names the file with a hash that is NOT the file's (wrong-hash =
# tampered transit). Deliberately all-zero, never the real digest.
printf '%s  %s\n' '0000000000000000000000000000000000000000000000000000000000000000' "$FILE" >"$DIST/SHASUMS256.txt"
attempt tampered 'checksum mismatch'

step "variant C2: list present but entry absent"
printf '%s  %s\n' "$(sha_of "$DIST/$FILE")" "node-v22.99.0-$OS-otherarch.tar.xz" >"$DIST/SHASUMS256.txt"
attempt missing-entry 'no checksum entry'

finish
