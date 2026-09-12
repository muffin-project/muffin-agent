#!/usr/bin/env bash
# Proves the exact transport property `bootstrap.sh` exists for:
# the public script is read from a pipe, while the canonical installer it
# stages receives the user's controlling terminal on stdin.
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "pipe/tty eval: Linux only" >&2
  exit 0
fi

for bin in curl script; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "pipe/tty eval: missing $bin" >&2
    exit 1
  }
done

REPO=${1:-}
if [ -z "$REPO" ]; then REPO=$(git rev-parse --show-toplevel); fi
REPO=$(cd "$REPO" && pwd)
BOOTSTRAP="$REPO/bootstrap.sh"
[ -f "$BOOTSTRAP" ] || { echo "pipe/tty eval: no $BOOTSTRAP" >&2; exit 1; }

LAB=$(mktemp -d /tmp/muffin-pipe-tty.XXXXXX)
trap 'rm -rf "$LAB"' EXIT
FAKE="$LAB/install.sh"
cat >"$FAKE" <<'SH'
#!/usr/bin/env sh
if [ -t 0 ]; then
  echo 'FAKE_INSTALL_STDIN=tty'
  exit 0
fi
echo 'FAKE_INSTALL_STDIN=notty'
exit 41
SH
chmod 700 "$FAKE"

# `script` supplies a real controlling PTY to the outer shell. Inside it we
# recreate the production shape: `cat bootstrap.sh | sh`, so the shell that
# evaluates bootstrap has a PIPE on fd 0 while /dev/tty still names the PTY.
# The bootstrap must stage the fake canonical installer and reconnect *its*
# stdin to that controlling terminal.
CMD="MUFFIN_INSTALL_URL='file://$FAKE' sh -c 'cat \"$BOOTSTRAP\" | sh'"
set +e
OUT=$(script -qfec "$CMD" /dev/null </dev/null 2>&1)
RC=$?
set -e
printf '%s\n' "$OUT"

[ "$RC" -eq 0 ] || {
  echo "pipe/tty eval: bootstrap path exited $RC" >&2
  exit 1
}
printf '%s' "$OUT" | grep -q 'FAKE_INSTALL_STDIN=tty' || {
  echo "pipe/tty eval: staged installer did not receive a tty" >&2
  exit 1
}
printf '%s' "$OUT" | grep -q 'FAKE_INSTALL_STDIN=notty' && {
  echo "pipe/tty eval: staged installer still saw the bootstrap pipe" >&2
  exit 1
}

echo 'pipe/tty eval: PASS'
