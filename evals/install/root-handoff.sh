#!/usr/bin/env bash
# Run only in a disposable Ubuntu runner/container. Exercise public root
# bootstrap with local fake Git/Node inputs; never touches the developer host.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo 'root handoff eval: run as root in isolation' >&2; exit 1; }
REPO=${1:-$(git rev-parse --show-toplevel)}
REPO=$(cd "$REPO" && pwd)
# The companion root-boundary eval verifies that an untrusted /usr/local/bin
# makes the installer fail closed. For this successful end-to-end fixture, use
# the disposable runner's root-owned directory with its write bits removed;
# restore its original mode after deleting every fixture command.
ROOT_BIN_DIR=/usr/local/bin
if [ ! -d "$ROOT_BIN_DIR" ] || [ -L "$ROOT_BIN_DIR" ] ||
  [ "$(stat -c '%u:%g' "$ROOT_BIN_DIR")" != 0:0 ]; then
  echo 'root handoff eval: /usr/local/bin is not root-owned; cannot establish a trusted dispatcher fixture' >&2
  exit 1
fi
ROOT_BIN_ORIGINAL_MODE=$(stat -c '%a' "$ROOT_BIN_DIR")
LAB=$(mktemp -d /tmp/muffin-root-handoff.XXXXXX)
chmod 0755 "$LAB"
EVENTS=$LAB/events
touch "$EVENTS"
chmod 0666 "$EVENTS"
STUBS=(curl loginctl systemctl bwrap socat rg)
CREATED_STUBS=()
OTHER_USER=muffin-handoff-check

cleanup() {
  if getent passwd "$OTHER_USER" >/dev/null; then userdel "$OTHER_USER"; fi
  if getent passwd muffin >/dev/null; then
    uid=$(id -u muffin)
    userdel muffin >/dev/null 2>&1 || true
    if [ -d /var/lib/muffin ] && [ ! -L /var/lib/muffin ] && [ "$(stat -c '%u' /var/lib/muffin)" = "$uid" ]; then rm -rf /var/lib/muffin; fi
  fi
  rm -f /var/lib/.muffin-root-install /usr/local/bin/muffin
  if ! getent passwd muffin >/dev/null && getent group muffin >/dev/null; then groupdel muffin >/dev/null 2>&1 || true; fi
  for file in "${CREATED_STUBS[@]}"; do rm -f "$file"; done
  chmod "$ROOT_BIN_ORIGINAL_MODE" "$ROOT_BIN_DIR"
  rm -rf "$LAB"
}
trap cleanup EXIT HUP INT TERM

if getent passwd muffin >/dev/null || getent group muffin >/dev/null ||
  [ -e /var/lib/muffin ] || [ -L /var/lib/muffin ] || [ -e /var/lib/.muffin-root-install ] ||
  [ -e /usr/local/bin/muffin ] || [ -L /usr/local/bin/muffin ] ||
  getent passwd "$OTHER_USER" >/dev/null; then
  echo 'root handoff eval: refusing pre-existing Muffin state' >&2
  exit 1
fi
for name in "${STUBS[@]}"; do
  if [ -e "/usr/local/bin/$name" ] || [ -L "/usr/local/bin/$name" ]; then
    echo "root handoff eval: /usr/local/bin/$name already exists" >&2
    exit 1
  fi
done

chmod go-w "$ROOT_BIN_DIR"

write_stub() {
  local name=$1
  cat >"/usr/local/bin/$name"
  chmod 0755 "/usr/local/bin/$name"
  CREATED_STUBS+=("/usr/local/bin/$name")
}

write_stub curl <<EOF
#!/bin/sh
# Muffin test stub
set -eu
out= url=
while [ "\$#" -gt 0 ]; do
  case "\$1" in -o) out=\$2; shift 2 ;; -*) shift ;; *) url=\$1; shift ;; esac
done
case "\$url" in file://*) path=\${url#file://} ;; *) exit 2 ;; esac
if [ -d "\$path" ]; then find "\$path" -maxdepth 1 -type f -printf '%f\\n' | sort
elif [ -n "\$out" ]; then cp -- "\$path" "\$out"
else cat -- "\$path"; fi
EOF

write_stub loginctl <<EOF
#!/bin/sh
# Muffin test stub
set -eu
case "\$1" in
  enable-linger)
    touch "$LAB/linger"
    # The local file:// remote is a fixture, whereas a real remote has no
    # root-owned worktree on this host that Git must trust before cloning.
    if [ -d "$LAB/source/.git" ] && getent passwd muffin >/dev/null; then chown -R muffin:muffin "$LAB/source"; fi
    echo linger-enabled >>"$EVENTS" ;;
  disable-linger) rm -f "$LAB/linger"; echo linger-disabled >>"$EVENTS" ;;
  show-user) [ -e "$LAB/linger" ] && echo yes || echo no ;;
  *) exit 2 ;;
esac
EOF

write_stub systemctl <<EOF
#!/bin/sh
# Muffin test stub
set -eu
case " \$* " in
  *" --user show-environment "*) [ -e "$LAB/linger" ] || exit 1; echo user-manager-ready >>"$EVENTS" ;;
  *" --user disable --now muffin-gateway.service "*) echo service-disabled >>"$EVENTS" ;;
  *" --user is-active muffin-gateway.service "*)
    if [ -e "$LAB/fail-active-probe" ]; then echo 'failed to connect to user manager' >&2; exit 1; fi
    if [ ! -e /var/lib/muffin/.config/systemd/user/muffin-gateway.service ] && [ -e "$LAB/report-active-if-unit-missing" ]; then echo active; exit 0; fi
    echo inactive; exit 3 ;;
  *" --user daemon-reload "*) echo daemon-reload >>"$EVENTS" ;;
  *) echo "unexpected systemctl: \$*" >&2; exit 2 ;;
esac
EOF
for name in bwrap socat rg; do write_stub "$name" <<'EOF'
#!/bin/sh
# Muffin test stub
exit 0
EOF
done

# Local source and checksum-listed fake Node keep this end-to-end path offline.
mkdir "$LAB/source"
printf '{"name":"muffin-agent","version":"0.0.0-test","scripts":{"prepare":"sh ./compile-fixture.sh","compile":"sh ./compile-fixture.sh"}}\n' >"$LAB/source/package.json"
cat >"$LAB/source/compile-fixture.sh" <<EOF
#!/bin/sh
set -eu
[ "\$(id -u)" -ne 0 ] || exit 16
mkdir -p dist/cli
cp main-fixture.js dist/cli/main.js
chmod 0755 dist/cli/main.js
echo "build uid=\$(id -u)" >>"$EVENTS"
EOF
chmod 0755 "$LAB/source/compile-fixture.sh"
cat >"$LAB/source/main-fixture.js" <<'EOF'
const { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');

const events = '__EVENTS_PATH__';
const log = (line) => appendFileSync(events, line + '\n');
const args = process.argv.slice(2);
const command = args[0];

if (args.includes('fixture-secret') || Object.values(process.env).includes('fixture-secret')) {
  console.error('secret leaked to CLI');
  process.exit(20);
}

switch (command) {
  case 'completion':
    process.stdout.write('# fixture completion\n');
    break;
  case 'init': {
    if (process.getuid() === 0) process.exit(21);
    const keyPath = process.env.MUFFIN_API_KEY_FILE;
    if (!keyPath || statSync(keyPath).uid !== process.getuid() || (statSync(keyPath).mode & 0o777) !== 0o600) process.exit(22);
    if ((statSync(new URL('.', 'file://' + keyPath)).mode & 0o777) !== 0o711) process.exit(23);
    const key = readFileSync(0, 'utf8').trimEnd();
    if (key !== 'fixture-secret') process.exit(24);
    mkdirSync(process.env.HOME + '/.muffin', { recursive: true });
    writeFileSync(process.env.HOME + '/.muffin/config.json', '{}\n', { mode: 0o600 });
    log('init uid=' + process.getuid() + ' key-stdin=verified key-mode=600 stage-mode=711');
    break;
  }
  case 'gateway':
    if (process.getuid() === 0 || !readFileSync(events, 'utf8').includes('user-manager-ready')) process.exit(25);
    mkdirSync(process.env.HOME + '/.config/systemd/user', { recursive: true });
    writeFileSync(process.env.HOME + '/.config/systemd/user/muffin-gateway.service', '[Unit]\nDescription=Muffin eval\n');
    log('gateway-install uid=' + process.getuid());
    break;
  case 'doctor':
    log('doctor uid=' + process.getuid());
    break;
  default:
    console.error('unexpected CLI fixture: ' + args.join(' '));
    process.exit(26);
}
EOF
sed -i "s|__EVENTS_PATH__|$EVENTS|" "$LAB/source/main-fixture.js"
git -C "$LAB/source" init -q -b main
git -C "$LAB/source" -c user.name=Eval -c user.email=eval@example.invalid add package.json
git -C "$LAB/source" -c user.name=Eval -c user.email=eval@example.invalid add compile-fixture.sh main-fixture.js
git -C "$LAB/source" -c user.name=Eval -c user.email=eval@example.invalid commit -qm fixture
chmod -R a+rX "$LAB/source"

case "$(uname -m)" in
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  x86_64 | amd64) NODE_ARCH=x64 ;;
  *) echo "root handoff eval: unsupported test architecture $(uname -m)" >&2; exit 1 ;;
esac
NODE_DIR=node-v22.15.0-linux-$NODE_ARCH
NODE_FILE=$NODE_DIR.tar.xz
mkdir -p "$LAB/node-dist/$NODE_DIR/bin"
cat >"$LAB/node-dist/$NODE_DIR/bin/node" <<EOF
#!/bin/sh
# Muffin test stub
set -eu
if [ "\${1:-}" = -p ]; then echo 22; exit 0; fi
if [ "\${1:-}" = -e ]; then readlink -f "\$3"; exit 0; fi
if [ "\${1:-}" = -v ]; then echo v22.15.0; exit 0; fi
script=\$1; shift
[ "\$(basename "\$(readlink -f "\$script")")" = main.js ] || exit 4
cmd=\${1:-}
echo "node-cli uid=\$(id -u) command=\$cmd" >>"$EVENTS"
case " \$* " in *" fixture-secret "*) echo 'secret in arguments' >&2; exit 5 ;; esac
if env | grep -Fq fixture-secret; then echo 'secret in environment' >&2; exit 6; fi
case "\$cmd" in
  completion) printf '# fixture completion\\n'; exit 0 ;;
  init)
    [ "\$(id -u)" -ne 0 ] || exit 7
    [ -n "\${MUFFIN_API_KEY_FILE:-}" ] || exit 8
    [ "\$(stat -c '%u:%g:%a' "\$MUFFIN_API_KEY_FILE")" = "\$(id -u):\$(id -g):600" ] || exit 9
    [ "\$(stat -c '%a' "\$(dirname "\$MUFFIN_API_KEY_FILE")")" = 711 ] || exit 10
    IFS= read -r key || [ -n "\${key:-}" ]
    [ "\$key" = fixture-secret ] || exit 11
    mkdir -p "\$HOME/.muffin"; printf '{}\\n' >"\$HOME/.muffin/config.json"; chmod 0600 "\$HOME/.muffin/config.json"
    echo "init uid=\$(id -u) key-stdin=verified key-mode=600 stage-mode=711" >>"$EVENTS"
    exit 0 ;;
  gateway)
    [ "\$(id -u)" -ne 0 ] || exit 12
    grep -Fq user-manager-ready "$EVENTS" || exit 13
    mkdir -p "\$HOME/.config/systemd/user"
    printf '[Unit]\\nDescription=Muffin eval\\n' >"\$HOME/.config/systemd/user/muffin-gateway.service"
    echo "gateway-install uid=\$(id -u)" >>"$EVENTS"
    exit 0 ;;
  doctor) echo "doctor uid=\$(id -u)" >>"$EVENTS"; exit 0 ;;
  *) echo "unexpected CLI fixture: \$*" >&2; exit 14 ;;
esac
EOF
cat >"$LAB/node-dist/$NODE_DIR/bin/npm" <<EOF
#!/bin/sh
# Muffin test stub
set -eu
[ "\$(id -u)" -ne 0 ] || exit 15
echo "npm uid=\$(id -u)" >>"$EVENTS"
sh ./compile-fixture.sh
EOF
chmod 0755 "$LAB/node-dist/$NODE_DIR/bin/"{node,npm}
tar -cJf "$LAB/node-dist/$NODE_FILE" -C "$LAB/node-dist" "$NODE_DIR"
(cd "$LAB/node-dist" && sha256sum "$NODE_FILE" >SHASUMS256.txt)
printf '%s\n' "$NODE_FILE" >"$LAB/node-dist/index.html"
chmod -R a+rX "$LAB/node-dist"
printf 'fixture-secret\n' >"$LAB/api-key"
chmod 0600 "$LAB/api-key"

# Exercise the installer's exact root copy helper: a valid file is copied with
# private mode, while a symlinked parent and a shared writable parent are
# refused before they can redirect or race the privileged read.
SAFE_KEY_COPY=$LAB/safely-copied-key
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  sh "$REPO/install.sh" --muffin-secure-copy-key "$LAB/api-key" "$SAFE_KEY_COPY" 0
cmp -s "$LAB/api-key" "$SAFE_KEY_COPY"
[ "$(stat -c '%u:%a' "$SAFE_KEY_COPY")" = 0:600 ]

getent passwd nobody >/dev/null || { echo 'root handoff eval: Ubuntu fixture has no nobody account' >&2; exit 1; }
KEY_OWNER_UID=$(id -u nobody)
KEY_OWNER_GID=$(id -g nobody)
mkdir "$LAB/user-key-dir"
chown "$KEY_OWNER_UID:$KEY_OWNER_GID" "$LAB/user-key-dir"
chmod 0700 "$LAB/user-key-dir"
cp "$LAB/api-key" "$LAB/user-key-dir/key"
chown "$KEY_OWNER_UID:$KEY_OWNER_GID" "$LAB/user-key-dir/key"
chmod 0600 "$LAB/user-key-dir/key"
DOTDOT_KEY_COPY=$LAB/dotdot-copied-key
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  sh "$REPO/install.sh" --muffin-secure-copy-key "$LAB/user-key-dir/../user-key-dir/key" "$DOTDOT_KEY_COPY" "$KEY_OWNER_UID"
cmp -s "$LAB/api-key" "$DOTDOT_KEY_COPY"
USER_KEY_COPY=$LAB/sudo-user-key-copy
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  sh "$REPO/install.sh" --muffin-secure-copy-key "$LAB/user-key-dir/key" "$USER_KEY_COPY" "$KEY_OWNER_UID"
cmp -s "$LAB/api-key" "$USER_KEY_COPY"
if env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  sh "$REPO/install.sh" --muffin-secure-copy-key "$LAB/user-key-dir/key" "$LAB/wrong-owner-key-copy" 0 \
  >"$LAB/wrong-owner-key-copy.log" 2>&1; then
  echo 'root handoff eval: accepted the sudo-owned key without its invoking UID' >&2
  exit 1
fi
[ ! -e "$LAB/wrong-owner-key-copy" ]

ln -s /etc "$LAB/key-parent-link"
if env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  sh "$REPO/install.sh" --muffin-secure-copy-key "$LAB/key-parent-link/passwd" "$LAB/linked-key-copy" 0 \
  >"$LAB/linked-key-copy.log" 2>&1; then
  echo 'root handoff eval: secure key copy followed a symlinked directory' >&2
  exit 1
fi
[ ! -e "$LAB/linked-key-copy" ]

printf 'normalization-trap\n' >"$LAB/decoy-key"
chmod 0600 "$LAB/decoy-key"
if env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  sh "$REPO/install.sh" --muffin-secure-copy-key "$LAB/key-parent-link/../decoy-key" "$LAB/normalized-linked-key-copy" 0 \
  >"$LAB/normalized-linked-key-copy.log" 2>&1; then
  echo 'root handoff eval: normalized away a symlinked key-path component' >&2
  exit 1
fi
[ ! -e "$LAB/normalized-linked-key-copy" ]

mkdir "$LAB/shared-key-dir"
chmod 0777 "$LAB/shared-key-dir"
cp "$LAB/api-key" "$LAB/shared-key-dir/key"
if env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  sh "$REPO/install.sh" --muffin-secure-copy-key "$LAB/shared-key-dir/key" "$LAB/shared-key-copy" 0 \
  >"$LAB/shared-key-copy.log" 2>&1; then
  echo 'root handoff eval: secure key copy accepted an unrelated-writable directory' >&2
  exit 1
fi
[ ! -e "$LAB/shared-key-copy" ]

mkdir -p "$LAB/bootstrap-tmp"

COMMON_ENV=(
  "HOME=$LAB/root-home"
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  "TMPDIR=$LAB/bootstrap-tmp"
  MUFFIN_CMD=muffin
  "MUFFIN_REPO=file://$LAB/source"
  MUFFIN_CHANNEL=main
  "MUFFIN_NODE_DIST_BASE=file://$LAB/node-dist"
  "MUFFIN_INSTALL_URL=file://$REPO/install.sh"
  "SUDO_UID=$KEY_OWNER_UID"
)
env -i "${COMMON_ENV[@]}" MUFFIN_API_KEY_FILE="$LAB/user-key-dir/key" sh "$REPO/bootstrap.sh" >"$LAB/install.log" 2>&1 || {
  cat "$LAB/install.log" >&2; cat "$EVENTS" >&2; echo 'root handoff eval: public bootstrap install failed' >&2; exit 1;
}

SERVICE_UID=$(id -u muffin)
SERVICE_GID=$(id -g muffin)
[ "$(passwd -S muffin | awk '{print $2}')" = L ]
[ "$(getent passwd muffin | cut -d: -f7)" = /usr/sbin/nologin ]
[ "$(stat -c '%u:%g:%a' /var/lib/muffin)" = "$SERVICE_UID:$SERVICE_GID:700" ]
[ "$(stat -c '%u:%g' /var/lib/muffin/.local/share/muffin/src)" = "$SERVICE_UID:$SERVICE_GID" ]
[ "$(stat -c '%u:%g' /var/lib/muffin/.local/share/muffin/node/bin/node)" = "$SERVICE_UID:$SERVICE_GID" ]
[ "$(stat -c '%u:%g:%a' /usr/local/bin/muffin)" = 0:0:755 ]
[ ! -L /usr/local/bin/muffin ]
grep -Fqx '# Muffin managed root dispatcher' /usr/local/bin/muffin
grep -Fq "build uid=$SERVICE_UID" "$EVENTS"
grep -Fq "init uid=$SERVICE_UID key-stdin=verified key-mode=600 stage-mode=711" "$EVENTS"
grep -Fq "gateway-install uid=$SERVICE_UID" "$EVENTS"
if grep -Fq fixture-secret "$EVENTS"; then echo 'root handoff eval: key leaked to event log' >&2; exit 1; fi

/usr/local/bin/muffin doctor
grep -Fq "doctor uid=$SERVICE_UID" "$EVENTS"
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$OTHER_USER"
# The generated config exists and is readable by root, but the service home is
# private. An ordinary local account must fail when it tries to open the data.
PRIVATE_CONFIG=/var/lib/muffin/.muffin/config.json
[ -f "$PRIVATE_CONFIG" ] && [ ! -L "$PRIVATE_CONFIG" ]
[ "$(stat -c '%u:%g:%a' "$PRIVATE_CONFIG")" = "$SERVICE_UID:$SERVICE_GID:600" ]
cat "$PRIVATE_CONFIG" >/dev/null
set +e
runuser -u "$OTHER_USER" -- env LC_ALL=C cat "$PRIVATE_CONFIG" >"$LAB/private-read.log" 2>&1
PRIVATE_READ_RC=$?
set -e
[ "$PRIVATE_READ_RC" -ne 0 ] && grep -Fq 'Permission denied' "$LAB/private-read.log"

set +e
runuser -u "$OTHER_USER" -- /usr/local/bin/muffin doctor >"$LAB/nonroot.log" 2>&1
NONROOT_RC=$?
set -e
[ "$NONROOT_RC" -ne 0 ] && grep -Fq 'use sudo muffin' "$LAB/nonroot.log"

# A second run reuses the verified service identity and does not repeat setup.
ORIGINAL_UID=$SERVICE_UID
env -i "${COMMON_ENV[@]}" sh "$REPO/bootstrap.sh" >"$LAB/reinstall.log" 2>&1 || {
  cat "$LAB/reinstall.log" >&2; echo 'root handoff eval: reinstall failed' >&2; exit 1;
}
[ "$(id -u muffin)" = "$ORIGINAL_UID" ]
[ -f /var/lib/muffin/.muffin/config.json ]
[ "$(grep -Fc "init uid=$SERVICE_UID" "$EVENTS")" -eq 1 ]

touch "$LAB/fail-active-probe"
set +e
env -i "${COMMON_ENV[@]}" sh "$REPO/bootstrap.sh" --uninstall >"$LAB/uninstall-probe-failure.log" 2>&1
UNINSTALL_PROBE_RC=$?
set -e
[ "$UNINSTALL_PROBE_RC" -ne 0 ]
[ -f /usr/local/bin/muffin ]
[ -e /var/lib/muffin/.local/share/muffin/src/dist/cli/main.js ]
[ -f /var/lib/muffin/.config/systemd/user/muffin-gateway.service ]
[ "$(loginctl show-user muffin -p Linger --value)" = yes ]
rm "$LAB/fail-active-probe"

# If the unit file disappeared while systemd still has it loaded and active,
# uninstall must query the manager anyway and leave every program file intact.
mv /var/lib/muffin/.config/systemd/user/muffin-gateway.service "$LAB/muffin-gateway.service"
touch "$LAB/report-active-if-unit-missing"
set +e
env -i "${COMMON_ENV[@]}" sh "$REPO/bootstrap.sh" --uninstall >"$LAB/uninstall-missing-unit.log" 2>&1
UNINSTALL_MISSING_UNIT_RC=$?
set -e
[ "$UNINSTALL_MISSING_UNIT_RC" -ne 0 ]
[ -f /usr/local/bin/muffin ]
[ -e /var/lib/muffin/.local/share/muffin/src/dist/cli/main.js ]
[ -f "$LAB/muffin-gateway.service" ]
[ "$(loginctl show-user muffin -p Linger --value)" = yes ]
mv "$LAB/muffin-gateway.service" /var/lib/muffin/.config/systemd/user/muffin-gateway.service
rm "$LAB/report-active-if-unit-missing"

env -i "${COMMON_ENV[@]}" sh "$REPO/bootstrap.sh" --uninstall >"$LAB/uninstall.log" 2>&1 || {
  cat "$LAB/uninstall.log" >&2; echo 'root handoff eval: uninstall failed' >&2; exit 1;
}
[ ! -e /usr/local/bin/muffin ] && [ ! -L /usr/local/bin/muffin ]
[ ! -e /var/lib/muffin/.local/bin/muffin ] && [ ! -L /var/lib/muffin/.local/bin/muffin ]
[ ! -e /var/lib/muffin/.local/share/muffin ] && [ ! -L /var/lib/muffin/.local/share/muffin ]
[ ! -e /var/lib/muffin/.config/systemd/user/muffin-gateway.service ]
[ -f /var/lib/muffin/.muffin/config.json ]
[ "$(passwd -S muffin | awk '{print $2}')" = L ]
[ "$(loginctl show-user muffin -p Linger --value)" = no ]
grep -Fq service-disabled "$EVENTS"
grep -Fq linger-disabled "$EVENTS"
echo 'root handoff eval: PASS — build/setup/gateway ran as muffin; key stayed private and on stdin; shim denied ordinary user; uninstall stopped service and preserved data/account'
