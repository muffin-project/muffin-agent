#!/usr/bin/env bash
# shellcheck disable=SC2016 # Grep patterns deliberately match source text literally.
# Fail closed when root is asked to install over an unmarked service account.
# Run only in a disposable Ubuntu runner/container: this creates and removes
# one temporary account named `muffin`.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "root boundary eval: must run as root (use sudo in the isolated runner)" >&2
  exit 1
fi

REPO=${1:-$(git rev-parse --show-toplevel)}
REPO=$(cd "$REPO" && pwd)
LAB=$(mktemp -d /tmp/muffin-root-boundary.XXXXXX)
ACCOUNT_CREATED=0
GROUP_CREATED=0
CONFLICT_CREATED=0

cleanup() {
  if [ "$ACCOUNT_CREATED" = 1 ] && getent passwd muffin >/dev/null; then
    userdel muffin
  fi
  if [ "$GROUP_CREATED" = 1 ] && ! getent passwd muffin >/dev/null && getent group muffin >/dev/null; then
    groupdel muffin
  fi
  if [ "$CONFLICT_CREATED" = 1 ] && [ -f /usr/local/bin/muffin-agent ] &&
    cmp -s /usr/local/bin/muffin-agent "$LAB/foreign-command.expected"; then
    rm -f /usr/local/bin/muffin-agent
  fi
  rm -rf -- "$LAB"
}
trap cleanup EXIT HUP INT TERM

if getent passwd muffin >/dev/null || getent group muffin >/dev/null; then
  echo "root boundary eval: refusing to touch pre-existing account/group muffin" >&2
  exit 1
fi
if [ -e /var/lib/muffin ] || [ -L /var/lib/muffin ] || [ -e /var/lib/.muffin-root-install ] ||
  [ -e /usr/local/bin/muffin-agent ] || [ -L /usr/local/bin/muffin-agent ]; then
  echo "root boundary eval: refusing to touch pre-existing Muffin service state" >&2
  exit 1
fi

SHIM_STATE=absent
if [ -e /usr/local/bin/muffin ] || [ -L /usr/local/bin/muffin ]; then
  SHIM_STATE=$(stat -c '%F:%U:%G:%a' /usr/local/bin/muffin)
  if [ -L /usr/local/bin/muffin ]; then SHIM_STATE="$SHIM_STATE:$(readlink /usr/local/bin/muffin)"; fi
fi

mkdir -p "$LAB/home"
cp "$REPO/install.sh" "$LAB/install.sh"
chmod 0444 "$LAB/install.sh"

# The key stage uses mktemp's private directory, explicitly stays 0700, and is
# opened to the service account only after owner/mode verification. These line
# order checks complement the runtime collision test without a production test
# hook that could alter the key path or permissions.
STAGE_CREATED_LINE=$(grep -nF 'ROOT_STAGE=$(mktemp -d /run/muffin-install.' "$REPO/install.sh" | cut -d: -f1)
STAGE_PRIVATE_LINE=$(grep -nF 'chmod 0700 "$ROOT_STAGE"' "$REPO/install.sh" | cut -d: -f1)
KEY_OWNER_LINE=$(grep -nF 'chown muffin:muffin "$KEY_COPY"' "$REPO/install.sh" | cut -d: -f1)
KEY_MODE_LINE=$(grep -nF 'chmod 0600 "$KEY_COPY"' "$REPO/install.sh" | cut -d: -f1)
KEY_VERIFY_LINE=$(grep -nF 'the staged API key is not owned by muffin with mode 0600' "$REPO/install.sh" | cut -d: -f1)
STAGE_OPEN_LINE=$(grep -nF 'chmod 0711 "$ROOT_STAGE"' "$REPO/install.sh" | cut -d: -f1)
if [ -z "$STAGE_CREATED_LINE" ] || [ -z "$STAGE_PRIVATE_LINE" ] || [ -z "$KEY_OWNER_LINE" ] ||
  [ -z "$KEY_MODE_LINE" ] || [ -z "$KEY_VERIFY_LINE" ] || [ -z "$STAGE_OPEN_LINE" ] ||
  [ "$STAGE_CREATED_LINE" -ge "$STAGE_PRIVATE_LINE" ] || [ "$STAGE_PRIVATE_LINE" -ge "$KEY_OWNER_LINE" ] ||
  [ "$KEY_OWNER_LINE" -ge "$KEY_MODE_LINE" ] || [ "$KEY_MODE_LINE" -ge "$KEY_VERIFY_LINE" ] ||
  [ "$KEY_VERIFY_LINE" -ge "$STAGE_OPEN_LINE" ] || grep -Fq 'chmod 0755 "$ROOT_STAGE"' "$REPO/install.sh"; then
  echo "root boundary eval: staged key directory could become traversable before the key is secured" >&2
  exit 1
fi

# A conflicting global command must fail before package installation, account
# creation, marker writes or setup. Use a fixture unique to this container.
printf '%s\n' 'foreign Muffin-adjacent command; preserve me' >"$LAB/foreign-command.expected"
install -m 0755 "$LAB/foreign-command.expected" /usr/local/bin/muffin-agent
CONFLICT_CREATED=1
CONFLICT_HASH=$(sha256sum /usr/local/bin/muffin-agent | awk '{print $1}')
set +e
env -i HOME="$LAB/home" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  MUFFIN_CMD=muffin-agent sh "$LAB/install.sh" >"$LAB/conflict.log" 2>&1
CONFLICT_RC=$?
set -e
if [ "$CONFLICT_RC" -eq 0 ] || ! grep -Eiq 'already belongs|refusing before changing|collision' "$LAB/conflict.log"; then
  cat "$LAB/conflict.log" >&2
  echo "root boundary eval: installer did not reject the conflicting muffin-agent command" >&2
  exit 1
fi
if getent passwd muffin >/dev/null || getent group muffin >/dev/null || [ -e /var/lib/muffin ] ||
  [ -e /var/lib/.muffin-root-install ] || [ "$(sha256sum /usr/local/bin/muffin-agent | awk '{print $1}')" != "$CONFLICT_HASH" ]; then
  echo "root boundary eval: command collision caused persistent account/command changes" >&2
  exit 1
fi
rm -f /usr/local/bin/muffin-agent
CONFLICT_CREATED=0

# An intentionally unmanaged account must be rejected without creating/adopting
# its home or marker. This falsifies the account collision path.
useradd --system --no-create-home --home-dir /var/lib/muffin --shell /usr/sbin/nologin muffin
ACCOUNT_CREATED=1
if getent group muffin >/dev/null; then GROUP_CREATED=1; fi

# The public entrypoint must reach the canonical installer as root. The
# intentionally unmanaged account above makes the production installer refuse
# before package setup or service-state writes.
mkdir -p "$LAB/bootstrap-tmp"
set +e
env -i HOME="$LAB/home" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  TMPDIR="$LAB/bootstrap-tmp" MUFFIN_INSTALL_URL="file://$REPO/install.sh" \
  sh "$REPO/bootstrap.sh" >"$LAB/bootstrap.log" 2>&1
BOOTSTRAP_RC=$?
set -e
if [ "$BOOTSTRAP_RC" -eq 0 ] || ! grep -Eiq 'account|marker|managed|refus' "$LAB/bootstrap.log"; then
  cat "$LAB/bootstrap.log" >&2
  echo "root boundary eval: canonical bootstrap did not reach the unmanaged-account guard" >&2
  exit 1
fi

set +e
env -i \
  HOME="$LAB/home" \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  MUFFIN_PREFIX="$LAB/prefix" \
  MUFFIN_NO_APT=1 \
  MUFFIN_NODE_DIST_BASE="$LAB/no-node-distribution" \
  sh "$LAB/install.sh" >"$LAB/install.log" 2>&1
INSTALL_RC=$?
set -e

if [ "$INSTALL_RC" -eq 0 ]; then
  cat "$LAB/install.log" >&2
  echo "root boundary eval: installer succeeded over an unmarked account" >&2
  exit 1
fi
if ! grep -Eiq 'account|marker|managed|refus|root install' "$LAB/install.log"; then
  cat "$LAB/install.log" >&2
  echo "root boundary eval: installer stopped for another reason, not the account boundary" >&2
  exit 1
fi
if [ -e /var/lib/muffin ] || [ -L /var/lib/muffin ] || [ -e /var/lib/.muffin-root-install ]; then
  echo "root boundary eval: installer changed service state before refusing" >&2
  exit 1
fi
if [ -e /usr/local/bin/muffin ] || [ -L /usr/local/bin/muffin ]; then
  AFTER_SHIM=$(stat -c '%F:%U:%G:%a' /usr/local/bin/muffin)
  if [ -L /usr/local/bin/muffin ]; then AFTER_SHIM="$AFTER_SHIM:$(readlink /usr/local/bin/muffin)"; fi
else
  AFTER_SHIM=absent
fi
if [ "$AFTER_SHIM" != "$SHIM_STATE" ]; then
  echo "root boundary eval: installer changed /usr/local/bin/muffin before refusing" >&2
  exit 1
fi

echo "root boundary eval: PASS — foreign muffin-agent command preserved; account collisions refuse without service-state writes; key staging order keeps the directory private until owner/mode verification"
