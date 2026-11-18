#!/usr/bin/env bash
set -euo pipefail

# CI installs the verified upstream bubblewrap under /usr/local so the whole
# job's commands resolve it from PATH, on a path the distro profile does not
# own. Version, URL and sha256 live in exactly one place:
# scripts/install/bubblewrap.sh. Nothing here keeps its own copy.
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

# Prefix /usr/local, not /. Ubuntu 26.04's apparmor package already attaches
# bwrap-userns-restrict to /usr/bin/bwrap. Installing the pinned binary
# there and loading muffin-bwrap on the same path is a second attachment:
# AppArmor reports a conflict and confines bwrap with unprivileged_userns,
# which denies net_admin (bwrap: loopback: Failed RTM_NEWADDR). The
# installer attaches only to a Muffin-owned path; CI does the same.
bash "$here/install/bubblewrap.sh" build / /usr/local
# Absolute path: this script runs under sudo, whose secure_path is not the
# job PATH. The probe later execs `bwrap` from the job PATH, where
# /usr/local/bin precedes /usr/bin.
actual_version="$(/usr/local/bin/bwrap --version)"
printf 'Installed verified upstream %s (%s).\n' "$actual_version" "$(bash "$here/install/bubblewrap.sh" sha256)"
