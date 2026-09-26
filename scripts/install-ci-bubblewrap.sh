#!/usr/bin/env bash
set -euo pipefail

# The Ubuntu 24.04 apt repository still provides bubblewrap 0.9.0. Build the
# exact upstream release used by the sandbox security floor instead of silently
# accepting a distro backport or version string.
readonly version='0.13.0'
readonly archive="bubblewrap-${version}.tar.xz"
readonly archive_sha256='4734237473c0e5d695e4e9034a34e43b2dbf5164655bd13fa59ae376b2b7a765'

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

build_root="$(mktemp -d)"
trap 'rm -rf "$build_root"' EXIT
curl --fail --location --silent --show-error \
  "https://github.com/containers/bubblewrap/releases/download/v${version}/${archive}" \
  --output "${build_root}/${archive}"
printf '%s  %s\n' "$archive_sha256" "${build_root}/${archive}" | sha256sum --check --status
tar -xJf "${build_root}/${archive}" -C "$build_root"
meson setup "${build_root}/build" "${build_root}/bubblewrap-${version}" \
  --prefix=/usr --buildtype=release
ninja -C "${build_root}/build"
ninja -C "${build_root}/build" install

actual_version="$(bwrap --version)"
if [[ "$actual_version" != "bubblewrap ${version}" ]]; then
  echo "Expected upstream bubblewrap ${version}, got: ${actual_version}" >&2
  exit 1
fi
printf 'Installed verified upstream %s (%s).\n' "$actual_version" "$archive_sha256"
