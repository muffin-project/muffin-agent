#!/usr/bin/env bash
# Exercises the root account marker against a real Ubuntu passwd database and
# filesystem. Run only in a disposable Ubuntu runner/container; all fixture
# state is checked absent first and removed by the EXIT trap.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "root account eval: must run as root (use sudo in the isolated runner)" >&2
  exit 1
fi

REPO=${1:-$(git rev-parse --show-toplevel)}
REPO=$(cd "$REPO" && pwd)
HELPER="$REPO/scripts/install/root-account.sh"
ROOT_HOME=/var/lib/muffin
ROOT_MARKER=/var/lib/.muffin-root-install
CREATED_ACCOUNT=0
CREATED_GROUP=0
CREATED_HOME=0
CREATED_MARKER=0
CREATED_UID=""
LAB=$(mktemp -d /tmp/muffin-root-account-eval.XXXXXX)

cleanup() {
  if [ "$CREATED_ACCOUNT" = 1 ] && getent passwd muffin >/dev/null; then
    CREATED_UID=$(id -u muffin)
    userdel muffin
  fi
  if [ "$CREATED_MARKER" = 1 ]; then rm -f -- "$ROOT_MARKER"; fi
  if [ "$CREATED_HOME" = 1 ] && [ -d "$ROOT_HOME" ] && [ ! -L "$ROOT_HOME" ] &&
    [ "$(stat -c '%u' "$ROOT_HOME")" = "$CREATED_UID" ]; then
    rm -rf -- "$ROOT_HOME"
  fi
  if [ "$CREATED_GROUP" = 1 ] && getent group muffin >/dev/null; then groupdel muffin; fi
  rm -rf -- "$LAB"
}
trap cleanup EXIT HUP INT TERM

if getent passwd muffin >/dev/null || getent group muffin >/dev/null || [ -e "$ROOT_HOME" ] || [ -L "$ROOT_HOME" ] || [ -e "$ROOT_MARKER" ] || [ -L "$ROOT_MARKER" ]; then
  echo "root account eval: refusing to touch pre-existing Muffin state" >&2
  exit 1
fi

# An unmanaged account must be rejected without creating/adopting its home or
# marker. This is a falsifier for the collision path, not a static source check.
useradd --system --no-create-home --home-dir "$ROOT_HOME" --shell /usr/sbin/nologin muffin
CREATED_ACCOUNT=1
if getent group muffin >/dev/null; then CREATED_GROUP=1; fi
set +e
sh "$HELPER" prepare muffin >"$LAB/collision.out" 2>"$LAB/collision.err"
COLLISION_RC=$?
set -e
if [ "$COLLISION_RC" -eq 0 ] || ! grep -Eiq 'refus|existing|adopt|repair' "$LAB/collision.err"; then
  cat "$LAB/collision.out" "$LAB/collision.err" >&2
  echo "root account eval: helper did not refuse an unmanaged account" >&2
  exit 1
fi
if [ -e "$ROOT_HOME" ] || [ -L "$ROOT_HOME" ] || [ -e "$ROOT_MARKER" ] || [ -L "$ROOT_MARKER" ]; then
  echo "root account eval: collision check changed state" >&2
  exit 1
fi
userdel muffin
CREATED_ACCOUNT=0
if [ "$CREATED_GROUP" = 1 ] && getent group muffin >/dev/null; then groupdel muffin; fi
CREATED_GROUP=0

# A fresh install creates the locked non-login identity and private home. A
# repeat validates the same state; it does not chmod/chown a service-owned tree.
sh "$HELPER" prepare muffin >"$LAB/command.out"
CREATED_ACCOUNT=1
CREATED_HOME=1
CREATED_MARKER=1
[ "$(cat "$LAB/command.out")" = muffin ]
if getent group muffin >/dev/null; then CREATED_GROUP=1; fi
[ "$(passwd -S muffin | awk '{print $2}')" = L ]
[ "$(getent passwd muffin | cut -d: -f7)" = /usr/sbin/nologin ]
[ "$(stat -c '%u:%g:%a' "$ROOT_HOME")" = "$(id -u muffin):$(id -g muffin):700" ]
[ "$(stat -c '%u:%g:%a' "$ROOT_MARKER")" = 0:0:600 ]
[ "$(sh "$HELPER" prepare muffin)" = muffin ]

if getent group adm >/dev/null; then
  usermod --append --groups adm muffin
  set +e
  sh "$HELPER" prepare muffin >"$LAB/group.out" 2>"$LAB/group.err"
  GROUP_RC=$?
  set -e
  if [ "$GROUP_RC" -eq 0 ] || ! grep -Eiq 'refus|adopt|repair' "$LAB/group.err"; then
    echo "root account eval: helper accepted unexpected supplementary groups" >&2
    exit 1
  fi
  usermod --groups '' muffin
fi

chmod 0750 "$ROOT_HOME"
set +e
sh "$HELPER" prepare muffin >"$LAB/tamper.out" 2>"$LAB/tamper.err"
TAMPER_RC=$?
set -e
if [ "$TAMPER_RC" -eq 0 ] || ! grep -Eiq 'refus|adopt|repair' "$LAB/tamper.err"; then
  echo "root account eval: helper accepted or repaired a tampered service home" >&2
  exit 1
fi
[ "$(stat -c '%a' "$ROOT_HOME")" = 750 ]

echo "root account eval: PASS — collision refused; fresh account locked/private; rerun validates; group/home tampering is not repaired"
