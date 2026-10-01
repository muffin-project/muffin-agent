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

# `install.sh` owns the privilege boundary. An ordinary user gets a user-local
# install; a root caller on Linux provisions the locked service identity and
# runs the same installer as that identity. Keep transport/TTY handling here.

# Code that runs as root must be identified immutably: GitHub over HTTPS is the
# transport/trust provider, and the installer is fetched **by committed SHA**,
# never from a mutable branch. No signing/attestation yet — the SHA is resolved
# once, printed, and passed down so the build checks out the same commit.
# `MUFFIN_REF` overrides the resolved SHA (development/pinned runs) and
# `MUFFIN_INSTALL_URL` overrides the URL entirely (evals/offline fixtures).
REPO_URL=${MUFFIN_REPO_URL:-https://github.com/muffin-project/muffin-agent}
REF=${MUFFIN_REF:-}
if [ -z "${MUFFIN_INSTALL_URL:-}" ]; then
  if [ -z "$REF" ]; then
    REPO_SLUG=${REPO_URL#https://github.com/}
    REF=$(curl -fsSL -H 'Accept: application/vnd.github.sha' \
      "https://api.github.com/repos/$REPO_SLUG/commits/${MUFFIN_CHANNEL:-main}") || REF=
    case "$REF" in
      "") echo "bootstrap: could not resolve an immutable commit for ${MUFFIN_CHANNEL:-main}; refusing to execute mutable branch code as root" >&2; exit 1 ;;
    esac
  fi
  if [ "${#REF}" -ne 40 ]; then
    echo "bootstrap: resolved ref is not a 40-character commit SHA: $REF" >&2
    exit 1
  fi
  case "$REF" in
    *[!0-9a-f]*) echo "bootstrap: resolved ref is not a hexadecimal commit SHA: $REF" >&2; exit 1 ;;
  esac
  INSTALL_URL="https://raw.githubusercontent.com/${REPO_URL#https://github.com/}/$REF/install.sh"
  echo "bootstrap: installing from commit $REF" >&2
else
  INSTALL_URL=${MUFFIN_INSTALL_URL}
fi
TMP_ROOT=${TMPDIR:-/tmp}
TMP=$(mktemp -d "$TMP_ROOT/muffin-bootstrap.XXXXXX")
INSTALLER="$TMP/install.sh"

# shellcheck disable=SC2317,SC2329 # Called indirectly by the EXIT/HUP/INT/TERM traps.
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
  MUFFIN_REF="$REF" sh "$INSTALLER" "$@" </dev/tty
  rc=$?
  set -e
else
  set +e
  MUFFIN_REF="$REF" sh "$INSTALLER" "$@"
  rc=$?
  set -e
fi

exit "$rc"
