#!/usr/bin/env bash
# Verify the packaged profile's production substitution contract against a
# symlinked owned binary, as install.sh does before loading AppArmor.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
PROFILE=$REPO/scripts/install/bwrap.apparmor
LAB=$(mktemp -d)
trap 'rm -rf "$LAB"' EXIT

mkdir -p "$LAB/bwrap/0.13.0/bin" "$LAB/tool-bin"
printf '#!/bin/sh\nexit 0\n' >"$LAB/bwrap/0.13.0/bin/bwrap"
chmod 0755 "$LAB/bwrap/0.13.0/bin/bwrap"
ln -s ../bwrap/0.13.0/bin/bwrap "$LAB/tool-bin/bwrap"
OWNED_REAL=$(readlink -f "$LAB/tool-bin/bwrap")
RENDERED=$LAB/muffin-bwrap
sed "s|<BWRAP_BINARY>|$OWNED_REAL|" "$PROFILE" >"$RENDERED"

grep -Fqx "profile muffin-bwrap $OWNED_REAL flags=(attach_disconnected,mediate_deleted) {" "$RENDERED"
grep -Fqx '  allow userns,' "$RENDERED"
grep -Fq 'deny /**/.git/hooks/' "$RENDERED"
if grep -Fq '<BWRAP_BINARY>' "$RENDERED" || grep -Fq 'profile muffin-bwrap /usr/bin/bwrap ' "$RENDERED"; then
  echo 'apparmor profile eval: unresolved placeholder or system bwrap attachment' >&2
  exit 1
fi

# Keep this contract tied to the actual production renderer in install.sh.
grep -Fq 'sandbox_owned_real=$(readlink -f "$sandbox_owned"' "$REPO/install.sh"
grep -Fq 'sed "s|<BWRAP_BINARY>|$sandbox_owned_real|" "$sandbox_profile"' "$REPO/install.sh"
echo 'apparmor profile eval: PASS — production template grants userns on owned realpath only'
