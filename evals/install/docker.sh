#!/usr/bin/env bash
# Smoke eval for the experimental Docker Compose path (contrib/docker/).
#
# The claim under test is honesty, not availability: in every posture the
# container either runs the shell sandbox for real and exposes the shell tools,
# or exposes neither and `muffin doctor` says why. A host that cannot provide
# containment is not a failure; a shell tool without containment, or a
# containment `doctor` does not report, is.
#
# What it does, against the image built from THIS checkout:
#   1. build the gateway image and initialise a throwaway home with a useless
#      key fed on stdin (never argv, never the environment: ADR-0048);
#   2. default posture: Docker defaults, no added security options;
#   3. sandbox posture: compose.sandbox.yaml (+ compose.apparmor.yaml when
#      MUFFIN_EVAL_APPARMOR=1, for hosts with the profile loaded);
#   4. in both: the gateway comes up, `doctor --json` is consistent with the
#      tools it reports, the container is not privileged and not root, no
#      Docker socket is mounted, and the key appears in no log or inspect output.
#
# MUFFIN_EVAL_EXPECT_CONTAINED=1 turns "no containment in the sandbox posture"
# into a failure, for hosts where it is known to be possible.
#
# Requirements: Linux, Docker Engine, Docker Compose v2, network for the build.
# Usage:  bash evals/install/docker.sh [path-to-repo]      (default: git toplevel)
set -uo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "docker eval: Linux only (the sandbox under test is Linux bubblewrap)." >&2
  exit 2
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker eval: needs Docker Engine with Docker Compose v2." >&2
  exit 2
fi

REPO=${1:-}
if [ -z "$REPO" ]; then REPO=$(git rev-parse --show-toplevel); fi
REPO=$(cd "$REPO" && pwd)
DIR="$REPO/contrib/docker"
PROJECT="muffin-eval-$$"
GATEWAY="${PROJECT}-gateway-1"
FAILURES=0
KEY_FILE=$(mktemp)
KEY_VALUE="sk-ant-eval-$(date +%s)-not-a-real-key-0000000000"
printf '%s' "$KEY_VALUE" > "$KEY_FILE"

compose() { docker compose -p "$PROJECT" -f "$DIR/compose.yaml" "$@"; }
cleanup() {
  compose down -v -t 2 >/dev/null 2>&1
  rm -f "$KEY_FILE"
}
trap cleanup EXIT

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

wait_for_gateway() {
  # The gateway prints its banner once `muffin gateway run` has taken the lock.
  for _ in $(seq 1 60); do
    if docker logs --since "$1" "$GATEWAY" 2>&1 | grep -q 'muffin gateway ·'; then return 0; fi
    sleep 3
  done
  return 1
}

check_posture() {
  local label=$1 since=$2
  echo "== posture: $label"
  if wait_for_gateway "$since"; then pass "gateway running"; else
    fail "gateway did not start"; docker logs --tail 40 "$GATEWAY" 2>&1 | sed 's/^/        /'; return
  fi

  local doctor
  doctor=$(docker exec "$GATEWAY" muffin doctor --json 2>/dev/null)
  local verdict
  verdict=$(printf '%s' "$doctor" | docker exec -i "$GATEWAY" node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const checks = JSON.parse(s).checks;
      const level = (n) => (checks.find((c) => c.name === n) || { level: "missing" }).level;
      process.stdout.write(`${level("sandbox")} ${level("capacità: shell_run")}`);
    });')
  local sandbox=${verdict%% *} shell=${verdict##* }
  case "$sandbox/$shell" in
    ok/ok) pass "contained: doctor reports a real containment and shell tools on" ;;
    warn/warn) pass "not contained: shell tools off, and doctor says why" ;;
    *) fail "doctor is inconsistent: sandbox=$sandbox shell_run=$shell" ;;
  esac
  if [ "$label" = sandbox ] && [ "${MUFFIN_EVAL_EXPECT_CONTAINED:-}" = 1 ] && [ "$sandbox" != ok ]; then
    fail "MUFFIN_EVAL_EXPECT_CONTAINED=1 but the sandbox posture did not contain"
  fi

  local user privileged sock
  user=$(docker inspect -f '{{.Config.User}}' "$GATEWAY")
  privileged=$(docker inspect -f '{{.HostConfig.Privileged}}' "$GATEWAY")
  sock=$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$GATEWAY" | grep -c 'docker.sock' || true)
  if [ "$user" = node ]; then pass "runs as node"; else fail "runs as '$user', expected node"; fi
  if [ "$privileged" = false ]; then pass "not privileged"; else fail "container is privileged"; fi
  if [ "$sock" = 0 ]; then pass "no Docker socket mounted"; else fail "Docker socket mounted"; fi

  local leaks
  leaks=$( { docker logs "$GATEWAY" 2>&1; docker inspect "$GATEWAY"; } | grep -c "$KEY_VALUE" || true)
  if [ "$leaks" = 0 ]; then pass "key absent from logs and inspect"; else fail "key found $leaks times in logs/inspect"; fi
}

echo "== build (this checkout: $(git -C "$REPO" rev-parse --short HEAD))"
if compose build gateway >/tmp/"$PROJECT"-build.log 2>&1; then pass "image built"; else
  fail "image build failed"; tail -30 /tmp/"$PROJECT"-build.log; exit 1
fi

echo "== init (key on stdin, nothing contacts the provider)"
if compose run --rm -T gateway muffin init --provider openai-compat \
     --base-url http://127.0.0.1:9/v1 --model eval-model < "$KEY_FILE" >/dev/null 2>&1; then
  pass "home initialised"
else
  fail "muffin init failed"; exit 1
fi

since=$(date +%s)
compose up -d gateway >/dev/null 2>&1
check_posture default "$since"

overrides=(-f "$DIR/compose.sandbox.yaml")
if [ "${MUFFIN_EVAL_APPARMOR:-}" = 1 ]; then overrides+=(-f "$DIR/compose.apparmor.yaml"); fi
since=$(date +%s)
# --force-recreate: the check waits for a banner printed after `since`, so the
# container must restart even if an override happened to change nothing.
docker compose -p "$PROJECT" -f "$DIR/compose.yaml" "${overrides[@]}" up -d --force-recreate gateway >/dev/null 2>&1
check_posture sandbox "$since"

echo
if [ "$FAILURES" = 0 ]; then echo "docker eval: PASS"; exit 0; fi
echo "docker eval: $FAILURES failure(s)"
exit 1
