#!/usr/bin/env bash
# Load scripts/install/bwrap.apparmor on the bwrap binary PATH will execute.
# That binary is the pinned build from install-ci-bubblewrap.sh, under
# /usr/local. Refusing /usr/bin/bwrap and /bin/bwrap is the guard: on Ubuntu
# 26.04 those paths already belong to bwrap-userns-restrict, and a second
# profile falls through to unprivileged_userns (Launchpad #2169201, same
# apparmor 5.0.2 that the 2026-11-17 ubuntu-latest image reported).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
strip_hooks=0
if [ "${1:-}" = "--without-hook-denies" ]; then
  strip_hooks=1
elif [ -n "${1:-}" ]; then
  echo "usage: install-ci-apparmor.sh [--without-hook-denies]" >&2
  exit 2
fi

apparmor_parser --version
dpkg-query -W -f='apparmor=${Version}\n' apparmor
if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  printf 'kernel.apparmor_restrict_unprivileged_userns='
  cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
fi

resolved="$(command -v bwrap)"
real="$(readlink -f "$resolved")"
case "$real" in
  /usr/bin/bwrap | /bin/bwrap)
    echo "install-ci-apparmor.sh: refusing to attach muffin-bwrap to ${real}" >&2
    exit 1
    ;;
esac

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
sed "s|<BWRAP_BINARY>|${real}|" "$root/scripts/install/bwrap.apparmor" >"$rendered"
if [ "$strip_hooks" -eq 1 ]; then
  awk '!index($0, "deny /**/.git/hooks/")' "$rendered" >"${rendered}.stripped"
  mv "${rendered}.stripped" "$rendered"
fi
if grep -q '<BWRAP_BINARY>' "$rendered"; then
  echo 'install-ci-apparmor.sh: profile placeholder was not substituted' >&2
  exit 1
fi
install -m 0644 "$rendered" /etc/apparmor.d/muffin-bwrap
apparmor_parser -r /etc/apparmor.d/muffin-bwrap
printf 'muffin-bwrap attached to %s\n' "$real"
