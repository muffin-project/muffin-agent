#!/usr/bin/env sh
# muffin public bootstrap — keep `curl | sh` one command without making the
# canonical installer own transport quirks.
#
# A shell reading this file from a pipe has stdin = the pipe, even when the user
# launched it from a real terminal. `install.sh` deliberately uses TTY-ness to
# decide whether it may ask for secrets/consent, so invoking it directly through
# `curl .../install.sh | sh` turns the documented one-command path into a
# non-interactive install followed by "run muffin init".
#
# This shim stages the canonical installer first and, when the process actually
# has a controlling terminal, gives *that terminal* back to install.sh as stdin.
# The API key still goes only through init's masked stdin prompt; this file never
# reads, stores or forwards a secret itself.
set -eu

INSTALL_URL=${MUFFIN_INSTALL_URL:-https://raw.githubusercontent.com/GiustoPiedimonte/muffin-agent/main/install.sh}
TMP_ROOT=${TMPDIR:-/tmp}
TMP=$(mktemp -d "$TMP_ROOT/muffin-bootstrap.XXXXXX")
INSTALLER="$TMP/install.sh"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

curl -fsSL "$INSTALL_URL" -o "$INSTALLER"
chmod 700 "$INSTALLER"

# `test -r /dev/tty` is not enough: the device can have readable permissions
# while this process has no controlling terminal (CI/container/cron). Actually
# opening it is the fact we need. stdout/stderr stay where the caller put them;
# only stdin is restored so `muffin init` sees the real terminal.
if ( : </dev/tty ) 2>/dev/null; then
  set +e
  sh "$INSTALLER" "$@" </dev/tty
  rc=$?
  set -e
else
  set +e
  sh "$INSTALLER" "$@"
  rc=$?
  set -e
fi

exit "$rc"
