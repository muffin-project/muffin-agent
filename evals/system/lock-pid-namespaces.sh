#!/usr/bin/env bash
# The durable lock across real pid namespaces (ADR-0092).
#
# Every Muffin process that shares a home shares its lock rows. Whether the
# holder of a row is still running used to be `kill(pid, 0)`, and a pid only
# means something inside one pid namespace. Two situations make that visible,
# and both are ordinary with containers:
#
#   restart   a container is SIGKILLed (an OOM, a `docker kill`) and a new one
#             starts on the same home. It is a fresh pid namespace, so the new
#             process usually gets the dead holder's pid. With the pid rule it
#             finds "itself" alive and is refused until the hard horizon.
#   neighbour a second container reads the home while the holder runs in the
#             first. Its pid namespace cannot see the holder at all.
#
# Each container runs the production `DurableLock` (core/lock/durable.ts) from
# this checkout against one home on a shared bind mount. Expected with
# ADR-0092: the restarted process gets the lock at once; the neighbour is
# refused while the holder lives and gets the lock right after `kill -9`.
#
# Usage:  bash evals/system/lock-pid-namespaces.sh [path-to-repo]
# The checkout needs its node_modules installed (npm ci). Requirements: Linux,
# Docker Engine. MUFFIN_LOCK_EVAL_IMAGE overrides the image (default
# node:22-bookworm, the Linux gate's own).
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "lock eval: Linux only (pid namespaces)" >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || { echo "lock eval: needs Docker" >&2; exit 2; }

REPO=${1:-}
if [ -z "$REPO" ]; then REPO=$(git rev-parse --show-toplevel); fi
REPO=$(cd "$REPO" && pwd)
[ -d "$REPO/node_modules/better-sqlite3" ] || { echo "lock eval: run npm ci in $REPO first" >&2; exit 2; }
IMAGE="${MUFFIN_LOCK_EVAL_IMAGE:-node:22-bookworm}"
TAG="muffin-lock-eval-$$"
LAB=$(mktemp -d)
chmod 0700 "$LAB"
mkdir -m 0700 "$LAB/state"
FAILURES=0

cleanup() {
  docker rm -f "$TAG-holder" "$TAG-first" >/dev/null 2>&1 || true
  rm -rf "$LAB"
}
trap cleanup EXIT

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# One claim attempt with the production lock. `hold` keeps the process (and so
# its claim and its incarnation) alive until the container is killed.
cat > "$LAB/claim.mjs" <<'EOF'
import { createRequire } from 'node:module';
import { DurableLock } from '/repo/core/lock/durable.ts';
// Resolved from the checkout: this file lives in /data, outside it.
const DatabaseCtor = createRequire('/repo/package.json')('better-sqlite3');
const db = new DatabaseCtor('/data/state/muffin.db');
db.pragma('journal_mode = WAL');
const spec = {
  table: 'eval_lock',
  schema: `CREATE TABLE IF NOT EXISTS eval_lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, taken_at TEXT);`,
  staleAfterMs: 5 * 60_000,
  refusal: (holder) => ({ held: `held by ${holder}`, remedy: 'wait' }),
};
const got = 'release' in new DurableLock(db, spec).acquire(new Date());
console.log(`${got ? 'got' : 'refused'} pid=${process.pid}`);
if (process.argv[2] === 'hold' && got) setInterval(() => {}, 1000);
EOF

# `-w /repo` because `--import tsx` resolves against the working directory.
# node_modules is mounted by its real path, so a symlinked one (a worktree
# sharing another checkout's install) resolves inside the container too.
MODULES=$(readlink -f "$REPO/node_modules")
run() {
  docker run -u "$(id -u):$(id -g)" -v "$REPO:/repo:ro" -v "$MODULES:/repo/node_modules:ro" -v "$LAB:/data" \
    -w /repo --entrypoint node "$@"
}
claim_once() { run --rm "$IMAGE" --import tsx /data/claim.mjs 2>&1 | tail -1; }
# `start_holder NAME` runs node as pid 1, like the one-shot claimant: the restart
# case, where the replacement gets the dead holder's pid. `start_holder NAME
# far-pid` first burns a hundred pids, so the holder's node gets a pid that
# names nothing in the reader's namespace: the neighbour case. A small pid would
# pass by accident under the pid rule, because the reader's own node has threads
# with small ids and `kill(tid, 0)` answers for a thread too (measured: pid 7).
start_holder() {
  if [ "${2:-}" = far-pid ]; then
    docker run -d --name "$1" -u "$(id -u):$(id -g)" -v "$REPO:/repo:ro" -v "$MODULES:/repo/node_modules:ro" \
      -v "$LAB:/data" -w /repo --entrypoint sh "$IMAGE" \
      -c 'i=0; while [ $i -lt 100 ]; do /bin/true; i=$((i+1)); done; node --import tsx /data/claim.mjs hold; true' >/dev/null
  else
    run -d --name "$1" "$IMAGE" --import tsx /data/claim.mjs hold >/dev/null
  fi
  for _ in $(seq 1 60); do
    local line
    line=$(docker logs "$1" 2>&1 | grep -E '^(got|refused) pid=' || true)
    if [ -n "$line" ]; then echo "$line"; return; fi
    sleep 0.5
  done
  echo "no answer: $(docker logs "$1" 2>&1 | tail -3)"
}

echo "== lock across pid namespaces ($IMAGE, checkout $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?'))"

echo "-- restart: a SIGKILLed container is replaced by a new one on the same home"
first=$(start_holder "$TAG-first")
case "$first" in got*) pass "first container holds the lock ($first)" ;; *) fail "first container: $first" ;; esac
docker kill -s KILL "$TAG-first" >/dev/null
docker rm -f "$TAG-first" >/dev/null
second=$(claim_once)
case "$second" in
  got*) pass "the replacement gets the lock at once ($second, the dead holder had ${first#* })" ;;
  *) fail "the replacement is refused: $second (the dead holder had ${first#* })" ;;
esac

echo "-- neighbour: a second container reads the home while the holder runs"
rm -f "$LAB/state/muffin.db"*
holder=$(start_holder "$TAG-holder" far-pid)
case "$holder" in got*) pass "holder container holds the lock ($holder)" ;; *) fail "holder container: $holder" ;; esac
while_alive=$(claim_once)
case "$while_alive" in
  refused*) pass "the neighbour is refused while the holder lives ($while_alive)" ;;
  *) fail "the neighbour took a live holder's lock: $while_alive" ;;
esac
docker kill -s KILL "$TAG-holder" >/dev/null
after_kill=$(claim_once)
case "$after_kill" in
  got*) pass "the neighbour gets the lock right after kill -9 ($after_kill)" ;;
  *) fail "the neighbour is still refused after kill -9: $after_kill" ;;
esac

echo
if [ "$FAILURES" = 0 ]; then echo "lock eval: PASS"; exit 0; fi
echo "lock eval: $FAILURES failure(s)"
exit 1
