#!/usr/bin/env bash
# Smoke eval for the experimental Docker Compose path (contrib/docker/).
#
# The claims under test:
#   - honesty: in every posture the gateway either runs the shell sandbox for
#     real and exposes the shell tools, or exposes neither, and both `muffin
#     doctor` and the gateway's own boot line say which. A host that cannot
#     provide containment is not a failure; a disagreement is.
#   - no secret in the image: untracked files in the checkout (a key file, a
#     .env) never reach an image layer, and the image holds exactly a commit.
#   - no secret in the gateway: the unattended first run feeds the key through
#     the one-shot `init` service; the long-running gateway mounts only its three
#     volumes, so its sandboxed shell has no key file to read.
#   - no privilege: non-root, not privileged, no Docker socket, every capability
#     dropped, no-new-privileges, and the key in no log or inspect output.
#   - bounded: process and memory ceilings cover everything in the gateway
#     container, sandboxed commands included. A command that forks or allocates
#     without end hits them, and the gateway keeps running. The load is bounded
#     (2000 processes, 1.5 GiB), so a missing ceiling fails the check instead of
#     exhausting the host.
#
# Postures: default (Docker defaults), then sandbox (compose.sandbox.yaml, plus
# compose.apparmor.yaml when MUFFIN_EVAL_APPARMOR=1 on a host with the profile
# loaded). MUFFIN_EVAL_EXPECT_CONTAINED=1 makes "no containment in the sandbox
# posture" a failure, for hosts where it is known to be possible.
#
# It builds its own image tag and removes it, its volumes and the files it
# planted, whatever the outcome. Requirements: Linux, Docker Engine, Docker
# Compose v2, network for the build, a regular clone (not a linked worktree).
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
export MUFFIN_IMAGE="muffin-gateway:eval-$$"
# Lower than the 2g default so the memory check stays cheap on small hosts;
# the defaults themselves are checked in the rendered compose file.
export MUFFIN_GATEWAY_MEM_LIMIT=1g
PIDS_LIMIT=512
MEM_BYTES=1073741824
FAILURES=0
SCRATCH=$(mktemp -d)
KEY_FILE="$SCRATCH/provider.key"
KEY_VALUE="sk-ant-eval-$(date +%s)-not-a-real-key-0000000000"
printf '%s' "$KEY_VALUE" > "$KEY_FILE"
# Compose mounts a file secret as it is on the host (outside swarm it ignores
# uid/gid/mode), and the container user is uid 1000. 0644 inside the 0700
# scratch directory is readable there and private here, whoever runs the eval.
chmod 0644 "$KEY_FILE"
MARKER="muffin-eval-planted-$$-$(date +%s)"
PLANTED=("$DIR/muffin-eval-$$.key" "$DIR/.env.muffin-eval-$$")

compose() { docker compose -p "$PROJECT" -f "$DIR/compose.yaml" "$@"; }
cleanup() {
  compose --profile unattended-init down -v -t 2 >/dev/null 2>&1
  docker image rm -f "$MUFFIN_IMAGE" >/dev/null 2>&1
  rm -f "${PLANTED[@]}"
  rm -rf "$SCRATCH"
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

  local verdict
  verdict=$(docker exec "$GATEWAY" muffin doctor --json 2>/dev/null | docker exec -i "$GATEWAY" node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const checks = JSON.parse(s).checks;
      const level = (n) => (checks.find((c) => c.name === n) || { level: "missing" }).level;
      process.stdout.write(`${level("sandbox")} ${level("capacità: shell_run")}`);
    });')
  local sandbox=${verdict%% *} shell=${verdict##* }
  # The gateway's own tool list, as announced at boot: it names the shell tools
  # only when it did NOT register them.
  local boot_off cut
  boot_off=$(docker logs --since "$since" "$GATEWAY" 2>&1 | grep -c 'shell_run, shell_run_write spento' || true)
  # Registered is not exposed: a profile's tool cap can still hide the tool
  # from the model ("shell_run tagliato"). The init model id selects a
  # profile wide enough that nothing should be cut.
  cut=$(docker logs --since "$since" "$GATEWAY" 2>&1 | grep -c 'shell_run tagliato' || true)
  case "$sandbox/$shell/$boot_off/$cut" in
    ok/ok/0/0) pass "contained: shell tools registered and exposed; doctor and the gateway agree" ;;
    warn/warn/[1-9]*/0) pass "not contained: shell tools off, doctor and the gateway say why" ;;
    *) fail "inconsistent: doctor sandbox=$sandbox shell_run=$shell, gateway 'off' lines=$boot_off, 'cut' lines=$cut" ;;
  esac
  if [ "$label" = sandbox ] && [ "${MUFFIN_EVAL_EXPECT_CONTAINED:-}" = 1 ] && [ "$sandbox" != ok ]; then
    fail "MUFFIN_EVAL_EXPECT_CONTAINED=1 but the sandbox posture did not contain"
  fi

  local user privileged capdrop secopt mounts
  user=$(docker inspect -f '{{.Config.User}}' "$GATEWAY")
  privileged=$(docker inspect -f '{{.HostConfig.Privileged}}' "$GATEWAY")
  capdrop=$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$GATEWAY")
  secopt=$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$GATEWAY")
  mounts=$(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$GATEWAY" | tr ' ' '\n' | sort | tr '\n' ' ')
  if [ "$user" = node ]; then pass "runs as node"; else fail "runs as '$user', expected node"; fi
  if [ "$privileged" = false ]; then pass "not privileged"; else fail "container is privileged"; fi
  if echo "$capdrop" | grep -q '"ALL"'; then pass "all capabilities dropped"; else fail "CapDrop is $capdrop"; fi
  if echo "$secopt" | grep -q 'no-new-privileges'; then pass "no-new-privileges set"; else fail "SecurityOpt is $secopt"; fi
  if [ "$mounts" = " /muffin/config /muffin/home /muffin/workspace " ] || [ "$mounts" = "/muffin/config /muffin/home /muffin/workspace " ]; then
    pass "mounts exactly home, config, workspace (no secret, no socket, no host path)"
  else
    fail "unexpected mounts: $mounts"
  fi
  local limits
  limits=$(docker inspect -f '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}' "$GATEWAY")
  if [ "$limits" = "$PIDS_LIMIT $MEM_BYTES $MEM_BYTES" ]; then
    pass "ceilings set: $PIDS_LIMIT processes, $MEM_BYTES bytes of memory, no extra swap"
  else
    fail "PidsLimit/Memory/MemorySwap are '$limits', expected '$PIDS_LIMIT $MEM_BYTES $MEM_BYTES'"
  fi
  if docker exec "$GATEWAY" test -e /run/secrets/muffin_provider_key; then
    fail "the provider key file is present in the gateway"
  else
    pass "no key file in the gateway"
  fi

  local leaks
  leaks=$( { docker logs "$GATEWAY" 2>&1; docker inspect "$GATEWAY"; } | grep -c "$KEY_VALUE" || true)
  if [ "$leaks" = 0 ]; then pass "key absent from logs and inspect"; else fail "key found $leaks times in logs/inspect"; fi

  check_ceilings "$label" "$sandbox"
}

# A command that forks or allocates without end, run as the container user: as
# a plain process in the default posture, inside bubblewrap in a contained
# sandbox posture, to show that sandboxed processes count against the same
# ceilings. The counters are the container's own cgroup files.
check_ceilings() {
  local label=$1 sandbox=$2 how=plain
  if [ "$label" = sandbox ]; then
    if [ "$sandbox" != ok ]; then
      echo "  info  no sandbox in this posture: ceilings checked in the default posture only"
      return
    fi
    how=sandboxed
  fi
  local before idle mem_idle refused_before refused_after current=
  before=$(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' "$GATEWAY")
  idle=$(docker exec "$GATEWAY" cat /sys/fs/cgroup/pids.current)
  mem_idle=$(docker exec "$GATEWAY" cat /sys/fs/cgroup/memory.current)
  echo "  info  idle container: $idle processes, $((mem_idle / 1048576)) MiB"
  refused_before=$(docker exec "$GATEWAY" sed -n 's/^max //p' /sys/fs/cgroup/pids.events)
  local spawn='i=0; while [ $i -lt 2000 ]; do sleep 10 & i=$((i+1)); done'
  if [ "$how" = sandboxed ]; then
    timeout 90 docker exec -u node "$GATEWAY" bwrap --unshare-all --ro-bind / / --dev /dev \
      --proc /proc --die-with-parent sh -c "$spawn" >/dev/null 2>&1
  else
    timeout 90 docker exec -u node "$GATEWAY" sh -c "$spawn" >/dev/null 2>&1
  fi
  # Until the sleeps exit not even `docker exec` can fork. Orphans are
  # reparented to tini, which reaps them.
  for _ in $(seq 1 40); do
    current=$(docker exec "$GATEWAY" cat /sys/fs/cgroup/pids.current 2>/dev/null) &&
      [ "$current" -le $((idle + 10)) ] && break
    sleep 1
  done
  refused_after=$(docker exec "$GATEWAY" sed -n 's/^max //p' /sys/fs/cgroup/pids.events)
  if [ "${refused_after:-0}" -gt "${refused_before:-0}" ]; then
    pass "$how: 2000 processes asked for, the process ceiling refused the rest"
  else
    fail "$how: 2000 processes asked for and none refused"
  fi
  if [ -n "$current" ] && [ "$current" -le $((idle + 10)) ]; then
    pass "$how: the processes were reaped ($current now, $idle idle)"
  else
    fail "$how: ${current:-unreadable} processes left, $idle when idle"
  fi

  if [ "$how" = plain ]; then
    local hog oom_before oom_after rc
    hog='const a=[];let mb=0;while(mb<1536){a.push(Buffer.alloc(64<<20,1));mb+=64}console.log(mb)'
    oom_before=$(docker exec "$GATEWAY" sed -n 's/^oom_kill //p' /sys/fs/cgroup/memory.events)
    docker exec -u node "$GATEWAY" node -e "$hog" >/dev/null 2>&1
    rc=$?
    oom_after=$(docker exec "$GATEWAY" sed -n 's/^oom_kill //p' /sys/fs/cgroup/memory.events)
    if [ "$rc" = 137 ] && [ "${oom_after:-0}" -gt "${oom_before:-0}" ]; then
      pass "memory: the process allocating 1.5 GiB was killed at the ceiling"
    else
      fail "memory: allocating 1.5 GiB exited $rc, oom_kill ${oom_before:-?} -> ${oom_after:-?}"
    fi
  fi

  if [ "$(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' "$GATEWAY")" = "$before" ] &&
    docker top "$GATEWAY" 2>/dev/null | grep -q 'gateway run'; then
    pass "$how: the gateway kept running (same start, no restart)"
  else
    fail "$how: the gateway was restarted or is gone"
  fi
}

echo "== build (last commit of this checkout: $(git -C "$REPO" rev-parse --short HEAD))"
# Untracked files that must never reach a layer.
for f in "${PLANTED[@]}"; do printf '%s\n' "$MARKER" > "$f"; done
if compose build gateway >"$SCRATCH/build.log" 2>&1; then pass "image built"; else
  fail "image build failed"; tail -30 "$SCRATCH/build.log"; exit 1
fi
if [ "$(docker image save "$MUFFIN_IMAGE" | grep -ac "$MARKER" || true)" = 0 ]; then
  pass "untracked files in the checkout are absent from every image layer"
else
  fail "a planted untracked file reached the image"
fi
if [ -z "$(docker run --rm --entrypoint git "$MUFFIN_IMAGE" -C /opt/muffin status --porcelain 2>&1)" ]; then
  pass "the image tree is exactly a commit"
else
  fail "the image tree differs from its commit"
fi
defaults=$( (unset MUFFIN_GATEWAY_MEM_LIMIT MUFFIN_GATEWAY_PIDS_LIMIT; compose config 2>/dev/null) |
  sed -n 's/^ *\(pids_limit\|mem_limit\|memswap_limit\): *"\{0,1\}\([0-9]*\)"\{0,1\}$/\1=\2/p' | sort | tr '\n' ' ')
if [ "$defaults" = "mem_limit=2147483648 memswap_limit=2147483648 pids_limit=512 " ]; then
  pass "default ceilings: 512 processes, 2 GiB of memory, no extra swap"
else
  fail "default ceilings are '$defaults'"
fi

echo "== unattended init (one-shot service, key on stdin from a secret file)"
if MUFFIN_PROVIDER_KEY_FILE="$KEY_FILE" MUFFIN_INIT_PROVIDER=openai-compat \
   MUFFIN_INIT_BASE_URL=http://127.0.0.1:9/v1 MUFFIN_INIT_MODEL=eval-claude-sonnet-5 \
   compose --profile unattended-init run --rm init >"$SCRATCH/init.log" 2>&1; then
  pass "home initialised"
else
  fail "init failed"; tail -20 "$SCRATCH/init.log"; exit 1
fi
if grep -q "$KEY_VALUE" "$SCRATCH/init.log"; then fail "key printed by init"; else pass "key not printed by init"; fi

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
