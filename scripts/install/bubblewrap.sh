#!/usr/bin/env bash
# One authority for the Muffin-owned bubblewrap: the version, the sha256 of
# the upstream release tarball, how to verify it, how to build it, and how to
# recognise a verified binary. CI and install.sh call this file; neither keeps
# its own copy of the pin.
#
# Usage:
#   bubblewrap.sh version
#   bubblewrap.sh sha256
#   bubblewrap.sh verify <bwrap-binary>
#   bubblewrap.sh build <destdir> [prefix]      # default prefix /usr/local
#
# `build` places the binary at <destdir><prefix>/bin/bwrap and fails unless the
# installed binary reports exactly the pinned upstream version.
set -euo pipefail

# Bubblewrap is the Linux containment primitive; macOS uses Seatbelt. Exit 3
# means "not applicable here", so a caller on Darwin can fail open on purpose.
if [ "$(uname -s)" != Linux ]; then
  echo 'bubblewrap.sh: bubblewrap is Linux-only (macOS uses seatbelt)' >&2
  exit 3
fi

readonly BWRAP_VERSION='0.13.0'
readonly BWRAP_SHA256='4734237473c0e5d695e4e9034a34e43b2dbf5164655bd13fa59ae376b2b7a765'
readonly BWRAP_ARCHIVE="bubblewrap-${BWRAP_VERSION}.tar.xz"
readonly BWRAP_URL="https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VERSION}/${BWRAP_ARCHIVE}"

# The cleanup trap must not reference a function-local: with `set -u` an EXIT
# trap that outlives the function is an unbound-variable failure *after* a
# successful build (found by the CI install job).
BWRAP_TMPDIR=''
trap 'rm -rf -- "${BWRAP_TMPDIR:-}"' EXIT

bwrap_fetch_verified() { # <workdir> -> archive path on stdout
  local workdir="$1" archive
  archive="$workdir/$BWRAP_ARCHIVE"
  curl --fail --location --silent --show-error "$BWRAP_URL" --output "$archive"
  printf '%s  %s\n' "$BWRAP_SHA256" "$archive" | sha256sum --check --status
  printf '%s\n' "$archive"
}

bwrap_verify_binary() { # <binary>
  local bin="$1"
  [ -x "$bin" ] || return 1
  [ "$("$bin" --version 2>/dev/null || true)" = "bubblewrap $BWRAP_VERSION" ]
}

bwrap_build() { # <destdir> [prefix]
  local destdir="$1" prefix="${2:-/usr/local}" archive
  BWRAP_TMPDIR="$(mktemp -d)"
  archive="$(bwrap_fetch_verified "$BWRAP_TMPDIR")"
  tar -xJf "$archive" -C "$BWRAP_TMPDIR"
  meson setup "$BWRAP_TMPDIR/build" "$BWRAP_TMPDIR/bubblewrap-$BWRAP_VERSION" \
    --prefix="$prefix" --buildtype=release >/dev/null
  ninja -C "$BWRAP_TMPDIR/build" >/dev/null
  DESTDIR="$destdir" ninja -C "$BWRAP_TMPDIR/build" install >/dev/null
  bwrap_verify_binary "$destdir$prefix/bin/bwrap" || {
    echo "bubblewrap.sh: the installed binary is not bubblewrap ${BWRAP_VERSION}" >&2
    return 1
  }
}

main() {
  case "${1:-}" in
    version) printf '%s\n' "$BWRAP_VERSION" ;;
    sha256) printf '%s\n' "$BWRAP_SHA256" ;;
    verify) shift; bwrap_verify_binary "${1:?usage: bubblewrap.sh verify <binary>}" ;;
    build) shift; bwrap_build "${1:?usage: bubblewrap.sh build <destdir> [prefix]}" "${2:-/usr/local}" ;;
    *)
      echo 'usage: bubblewrap.sh version|sha256|verify <binary>|build <destdir> [prefix]' >&2
      exit 2
      ;;
  esac
}

main "$@"
