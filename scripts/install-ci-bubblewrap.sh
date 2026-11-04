#!/usr/bin/env bash
set -euo pipefail

# CI installs the verified upstream bubblewrap into /usr so the whole job's
# commands resolve it from PATH. Version, URL and sha256 live in exactly one
# place: scripts/install/bubblewrap.sh. Nothing here keeps its own copy.
readonly here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo 'install-ci-bubblewrap.sh must run under sudo.' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
if dpkg-query -W bubblewrap >/dev/null 2>&1; then
  apt-get purge -y bubblewrap
fi
apt-get install -y --no-install-recommends \
  build-essential ca-certificates curl libcap-dev linux-libc-dev meson ninja-build \
  pkg-config ripgrep socat xz-utils

bash "$here/install/bubblewrap.sh" build / /
actual_version="$(bwrap --version)"
printf 'Installed verified upstream %s (%s).\n' "$actual_version" "$(bash "$here/install/bubblewrap.sh" sha256)"
