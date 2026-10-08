#!/usr/bin/env sh
# muffin installer — one command from a user or root login to a supervised agent.
#
#   curl -fsSL https://raw.githubusercontent.com/muffin-project/muffin-agent/main/bootstrap.sh | sh
#   bash install.sh          # from a clone or an unpacked tarball
#
# ## What this script owns, and why it grew
#
# Until 2026-09-06 it owned exactly one thing: turning an *already cloned,
# already built-able* checkout into a `muffin` command. Everything before that
# (Node, git, the clone itself) and everything after it (`init`, the
# supervisor) was prose in `README.md` — which meant the only path anyone ever
# exercised was a developer's Mac with Node already on it. DAY-1 A11 is the
# opposite claim: an empty Ubuntu VPS, one command, `muffin doctor` green and
# the gateway running under systemd. So the script owns the whole line now:
#
#   1. OS packages     fetch/build prerequisites + platform-specific sandbox deps
#   2. Node >= 22      the official tarball under MUFFIN_PREFIX, never a system package
#   3. the source      git clone (or reuse) — `muffin update` needs a real checkout
#   4. the build       npm ci/install -> dist/
#   5. the command     a symlink in a user-writable bin dir, never sudo into /usr
#   6. the setup       `muffin init` (the key arrives on stdin, never argv/env)
#   7. the supervisor  `muffin gateway install --write --start`
#
# Steps 1-5 are unattended. Steps 6-7 need something only the owner has (an API
# key) or something only a real login session has (a user systemd instance), so
# each one degrades to a printed command rather than to a lie. The public
# `bootstrap.sh` exists solely to stage this file and restore the controlling
# terminal to stdin when the outer `curl | sh` consumed fd 0.
#
# ## Why the code does not live in the data home
#
# `~/.muffin` is the *data* home and `muffin uninstall` deletes it whole. A Node
# runtime or a git checkout under there would be erased by a command whose
# stated job is removing config, keys and memory — and the systemd unit's
# `Environment=PATH` points at this Node, so the erase would take the service
# with it. Hence MUFFIN_PREFIX (default `~/.local/share/muffin`), which
# `uninstall` does not touch and `./install.sh --uninstall` names on request.
#
# ## Modes and overrides (all optional)
#
#   --personal | --checkout               install mode; personal is the default
#                                         and never binds to a source checkout.
#                                         MUFFIN_MODE does the same from the env.
#   --paths                               print the resolved paths and exit
#   --uninstall                           remove this build's launcher symlink(s)
#
#   MUFFIN_PREFIX=~/.local/share/muffin   where the code and Node live
#   MUFFIN_BINDIR=~/.local/bin            where the launcher symlink goes
#   MUFFIN_CMD=muffin                     force the command name (see the Mint note)
#   MUFFIN_REPO=<git url>                 where to clone from
#   MUFFIN_CHANNEL=main                   which branch to install
#   MUFFIN_REF=<commit sha>               install exactly this commit (the
#                                         bootstrap resolves one so the code
#                                         executed as root is immutable)
#   MUFFIN_HOME=~/.muffin                 runtime data home; reported here, read
#                                         by the runtime, never touched by this
#                                         installer
#   MUFFIN_API_KEY_FILE=<path>            unattended setup: the key is read from
#                                         this file and piped into `muffin init`.
#                                         A path, never the value: a secret in an
#                                         env var is readable from /proc and ends
#                                         up in shell history (ADR-0048).
#   MUFFIN_NO_APT=1                       never call apt-get
#   MUFFIN_NO_GATEWAY=1                   install, but do not touch the supervisor
#   MUFFIN_NODE_DIST_BASE=<url>           test/mirror hook: distribution directory
#                                         the Node tarball AND its SHASUMS256.txt
#                                         are fetched from (default: nodejs.org).
#                                         The checksum gate applies either way.
#
# Exit codes: 0 done · 1 something failed · 3 installed, gateway NOT active.
set -eu

# The PATH this script inherited: the only thing that says whether the shell
# that launched the installer will find `muffin` afterwards. A child cannot
# change its parent's environment, so every PATH mutation below (bundled Node,
# the launcher directory) is measured against this, never against the script's
# own working PATH. (`first_command_note`, at the end, reads it.)
INVOKING_PATH="$PATH"

MUFFIN_PREFIX=${MUFFIN_PREFIX:-$HOME/.local/share/muffin}
MUFFIN_REPO=${MUFFIN_REPO:-https://github.com/muffin-project/muffin-agent.git}
MUFFIN_CHANNEL=${MUFFIN_CHANNEL:-main}
NODE_MAJOR_REQUIRED=22
EXIT_GATEWAY_NOT_ACTIVE=3

say() { printf '%s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Sandbox containment: report it, never assume it.
#
# The runtime refuses shell/job execution when containment cannot be proven
# (`core/sandbox/shell-boundary.ts`). The installer reports that honestly, and
# on Ubuntu 24.04+ — where unprivileged user namespaces are restricted — offers
# Muffin's packaged AppArmor profile for bubblewrap. It is applied only with
# explicit consent (`MUFFIN_APPLY_SANDBOX_PROFILE=1`, or an interactive yes on
# a real terminal): no silent host-policy change, no unsandboxed fallback, and
# a failed application leaves the capability disabled.
#
#   sandbox_report <runner> <node> <src> <can-apply: yes|sudo|no> <owned-bwrap>
# ---------------------------------------------------------------------------
sandbox_direct() { "$@"; }

# ---------------------------------------------------------------------------
# The Muffin-owned bubblewrap.
#
# One versioned destination — `$MUFFIN_PREFIX/bwrap/<version>/bin/bwrap` — built
# from the upstream release through the single authority
# (`scripts/install/bubblewrap.sh`: version + sha256 + build + verify). Never a
# system replacement: `/usr/bin/bwrap` is left alone and only the runtime/tool
# PATH prefers the owned one, through the `tool-bin` pointer the unit, the
# launcher and the root path all read.
#
# Idempotent: a verified binary at the versioned path is reused. If the build
# deps or the verification are missing, the install continues and shell/job
# execution stays fail-closed — the sandbox step reports the capability.
# ---------------------------------------------------------------------------
provision_owned_bubblewrap() {
  owned_authority="$SRC/scripts/install/bubblewrap.sh"
  if ! owned_version=$(bash "$owned_authority" version 2>/dev/null); then
    say "bubblewrap: not provisioned here (Linux-only primitive; macOS uses seatbelt)."
    return 0
  fi
  owned_bin="$MUFFIN_PREFIX/bwrap/$owned_version/bin/bwrap"
  if bash "$owned_authority" verify "$owned_bin" >/dev/null 2>&1; then
    say "bubblewrap: Muffin-owned $owned_version already verified at $owned_bin"
  else
    say "bubblewrap: building the Muffin-owned $owned_version from the pinned upstream release…"
    if ! bash "$owned_authority" build "$MUFFIN_PREFIX/bwrap/$owned_version" / >/dev/null; then
      say "bubblewrap: the Muffin-owned build failed — shell and job execution stay fail-closed."
      say "            remedy: install the build dependencies (build-essential meson ninja-build pkg-config libcap-dev) and re-run."
      return 0
    fi
  fi
  owned_link="$MUFFIN_PREFIX/tool-bin"
  rm -f "$owned_link"
  ln -s "bwrap/$owned_version/bin" "$owned_link" || {
    say "bubblewrap: could not point $owned_link at the verified binary; shell and job execution stay fail-closed."
    return 0
  }
  if [ "$("$owned_link/bwrap" --version 2>/dev/null || true)" != "bubblewrap $owned_version" ]; then
    say "bubblewrap: the owned binary did not verify at $owned_link; shell and job execution stay fail-closed."
    return 0
  fi
  MUFFIN_TOOL_BIN="$owned_link"
  export MUFFIN_TOOL_BIN
  PATH="$MUFFIN_TOOL_BIN:$PATH"
  export PATH
  say "bubblewrap: Muffin-owned $owned_version verified and preferred ($owned_link)"
}

sandbox_report() {
  # The root path runs this once, as root over the service account, after the
  # delegated install: the delegated step is told to stay quiet so the same
  # turn never reports the capability twice (and never reports it before the
  # privileged step had a chance to apply the profile).
  if [ "${MUFFIN_SANDBOX_REPORT:-1}" = 0 ]; then return 0; fi
  sandbox_runner=$1
  sandbox_node=$2
  sandbox_src=$3
  sandbox_can_apply=$4
  sandbox_owned=${5:-}
  # The same gate the runtime and doctor use: behavioral probe AND patch
  # posture (`assessShellBoundary`). Checking the probe alone reported
  # 'containment verified' on a stock Ubuntu 24.04 whose bubblewrap 0.9.0
  # predates the setup-time fix — while the runtime correctly kept shell
  # disabled. One gate, three readers.
  sandbox_probe='const p=(await import(process.argv[1])).probeSandbox();const b=(await import(process.argv[2])).assessShellBoundary(p);process.stdout.write(JSON.stringify({probe:p,boundary:b}));process.exit(b.usable?0:2);'
  sandbox_run_probe() {
    "$sandbox_runner" "$sandbox_node" --input-type=module -e "$sandbox_probe" \
      "file://$sandbox_src/dist/core/sandbox/probe.js" \
      "file://$sandbox_src/dist/core/sandbox/shell-boundary.js" 2>/dev/null || true
  }
  sandbox_json=$(sandbox_run_probe)
  case "$sandbox_json" in
    *'"usable":true'*)
      say "sandbox: containment verified"
      return 0
      ;;
    *'"reason":"userns_denied"'*) : ;;
    *)
      say "sandbox: containment NOT verified — shell and job execution stay disabled."
      if [ -n "$sandbox_json" ]; then
        sandbox_reason=$(printf '%s' "$sandbox_json" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' | tail -1)
        sandbox_remedy=$(printf '%s' "$sandbox_json" | sed -n 's/.*"remedy":"\([^"]*\)".*/\1/p' | tail -1)
        [ -n "$sandbox_reason" ] && say "          reason: $sandbox_reason"
        [ -n "$sandbox_remedy" ] && say "          remedy: $sandbox_remedy"
      fi
      return 0
      ;;
  esac
  sandbox_consent=${MUFFIN_APPLY_SANDBOX_PROFILE:-}
  if [ -z "$sandbox_consent" ] && ( : </dev/tty ) 2>/dev/null; then
    printf "sandbox: unprivileged user namespaces are restricted here.\n" >&2
    printf "Apply Muffin's packaged AppArmor profile for bubblewrap? [y/N] " >&2
    sandbox_answer=
    read -r sandbox_answer </dev/tty || sandbox_answer=
    case "$sandbox_answer" in y | Y | yes | YES) sandbox_consent=1 ;; esac
  fi
  if [ "${sandbox_consent:-}" != 1 ]; then
    say "sandbox: the packaged AppArmor profile was not applied — shell and job execution stay disabled."
    say "          remedy: re-run with MUFFIN_APPLY_SANDBOX_PROFILE=1 (the profile is scripts/install/bwrap.apparmor)."
    return 0
  fi
  sandbox_profile="$sandbox_src/scripts/install/bwrap.apparmor"
  if [ ! -f "$sandbox_profile" ]; then
    say "sandbox: $sandbox_profile is missing — shell and job execution stay disabled."
    return 0
  fi
  # The profile attaches to the binary processes actually run: the
  # Muffin-owned path, not /usr/bin/bwrap. Without a verified owned binary
  # there is nothing honest to attach to, so the capability stays disabled.
  if [ -z "$sandbox_owned" ] || [ ! -x "$sandbox_owned" ]; then
    say "sandbox: no verified Muffin-owned bubblewrap to attach the profile to — shell and job execution stay disabled."
    return 0
  fi
  # AppArmor attaches by the pathname the kernel executes, and the kernel
  # resolves the tool-bin symlink first: the profile must name the realpath.
  sandbox_owned_real=$(readlink -f "$sandbox_owned" 2>/dev/null || true)
  if [ -z "$sandbox_owned_real" ]; then
    say "sandbox: could not resolve the Muffin-owned bubblewrap path — shell and job execution stay disabled."
    return 0
  fi
  sandbox_rendered=$(mktemp)
  if ! sed "s|<BWRAP_BINARY>|$sandbox_owned_real|" "$sandbox_profile" >"$sandbox_rendered" ||
    grep -q '<BWRAP_BINARY>' "$sandbox_rendered"; then
    rm -f "$sandbox_rendered"
    say "sandbox: could not render the packaged AppArmor profile — shell and job execution stay disabled."
    return 0
  fi
  sandbox_apply="install -m 0644 '$sandbox_rendered' /etc/apparmor.d/muffin-bwrap && apparmor_parser -r /etc/apparmor.d/muffin-bwrap"
  sandbox_cleanup="rm -f '$sandbox_rendered'"
  case "$sandbox_can_apply" in
    yes)
      sh -c "$sandbox_apply" || {
        sh -c "$sandbox_cleanup" || true
        say "sandbox: applying the packaged AppArmor profile failed — shell and job execution stay disabled."
        return 0
      }
      sh -c "$sandbox_cleanup" || true
      ;;
    sudo)
      sudo -n sh -c "$sandbox_apply" || {
        sudo -n sh -c "$sandbox_cleanup" || true
        say "sandbox: sudo could not apply the packaged AppArmor profile — shell and job execution stay disabled."
        return 0
      }
      sudo -n sh -c "$sandbox_cleanup" || true
      ;;
    *)
      say "sandbox: applying the packaged AppArmor profile needs root — shell and job execution stay disabled."
      return 0
      ;;
  esac
  sandbox_json=$(sandbox_run_probe)
  case "$sandbox_json" in
    *'"available":true'*) say "sandbox: containment verified after applying the packaged AppArmor profile" ;;
    *) say "sandbox: containment is still NOT verified — shell and job execution stay disabled." ;;
  esac
  return 0
}

# Copy an API-key file without resolving an attacker-controlled pathname as
# root. Every path component is opened from a directory descriptor with
# symlink following disabled; after fstat, the same open file is copied into
# the private staging directory. The key bytes never enter argv or env.
root_copy_api_key_file() {
  ROOT_COPY_SOURCE=$1
  ROOT_COPY_DEST=$2
  ROOT_COPY_CALLER_UID=$3
  python3 - "$ROOT_COPY_SOURCE" "$ROOT_COPY_DEST" "$ROOT_COPY_CALLER_UID" <<'PY'
import os
import stat
import sys


def reject(message):
    raise RuntimeError(message)


source_raw, destination, caller_raw = sys.argv[1:]
open_fds = []
destination_created = False
try:
    caller_uid = int(caller_raw, 10)
    if caller_uid < 0:
        reject("invalid invoking-user id")
    # Keep '..' components in the walk instead of normalizing away path
    # components before checking them for symlinks.
    source = source_raw if os.path.isabs(source_raw) else os.path.join(os.getcwd(), source_raw)
    components = [part for part in source.split(os.sep) if part not in ("", ".")]
    if not components:
        reject("the source must name a regular file")

    path_flag = getattr(os, "O_PATH", None)
    if path_flag is None or not hasattr(os, "O_NOFOLLOW"):
        reject("this Linux system lacks safe no-follow file opens")
    trusted_owners = {0, caller_uid}
    walk_flags = path_flag | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    parent_fd = os.open(os.sep, walk_flags)
    open_fds.append(parent_fd)

    for component in components[:-1]:
        child_fd = os.open(component, walk_flags, dir_fd=parent_fd)
        open_fds.append(child_fd)
        directory = os.fstat(child_fd)
        if not stat.S_ISDIR(directory.st_mode) or directory.st_uid not in trusted_owners:
            reject("a source directory is not owned by root or the invoking user")
        writable_by_others = directory.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        root_sticky_directory = directory.st_uid == 0 and directory.st_mode & stat.S_ISVTX
        if writable_by_others and not root_sticky_directory:
            reject("a source directory is writable by an unrelated identity")
        parent_fd = child_fd

    source_fd = os.open(components[-1], path_flag | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    open_fds.append(source_fd)
    source_stat = os.fstat(source_fd)
    if not stat.S_ISREG(source_stat.st_mode):
        reject("the source is not a regular file")
    if source_stat.st_uid not in trusted_owners:
        reject("the source is not owned by root or the invoking user")
    if source_stat.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        reject("the source file is writable by an unrelated identity")

    # O_PATH lets us validate the exact inode before opening it for reading;
    # /proc/self/fd then refers to that already-open object even if its name is
    # replaced after the validation.
    read_fd = os.open(f"/proc/self/fd/{source_fd}", os.O_RDONLY | os.O_CLOEXEC)
    open_fds.append(read_fd)
    read_stat = os.fstat(read_fd)
    if (read_stat.st_dev, read_stat.st_ino) != (source_stat.st_dev, source_stat.st_ino):
        reject("the opened source changed during validation")

    destination_fd = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )
    open_fds.append(destination_fd)
    destination_created = True
    os.fchmod(destination_fd, 0o600)
    while True:
        chunk = os.read(read_fd, 65536)
        if not chunk:
            break
        view = memoryview(chunk)
        while view:
            view = view[os.write(destination_fd, view):]
    os.fsync(destination_fd)
    destination_stat = os.fstat(destination_fd)
    if not stat.S_ISREG(destination_stat.st_mode) or destination_stat.st_uid != 0 or stat.S_IMODE(destination_stat.st_mode) != 0o600:
        reject("the staged file did not retain root ownership and mode 0600")
except (OSError, RuntimeError, ValueError) as error:
    if destination_created:
        try:
            os.unlink(destination)
        except OSError:
            pass
    if isinstance(error, OSError):
        reason = error.strerror or "filesystem operation failed"
    else:
        reason = str(error)
    print(f"error: refusing API-key file copy ({reason}).", file=sys.stderr)
    sys.exit(1)
finally:
    for descriptor in reversed(open_fds):
        try:
            os.close(descriptor)
        except OSError:
            pass
PY
}

# Root account invariants live in this installer so the public bootstrap can
# hand off from the one staged file without downloading a second root program.
# This private mode is also the production function exercised by the account
# eval; the adjacent helper is only a source-checkout wrapper for that mode.
root_account_fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
root_account_validate() {
  RA_COMMAND=$1
  ROOT_USER=muffin
  ROOT_HOME=/var/lib/muffin
  ROOT_MARKER=/var/lib/.muffin-root-install
  [ "$(id -u)" = 0 ] || root_account_fail "root is required to manage the muffin service account."
  [ -d /var/lib ] && [ ! -L /var/lib ] || root_account_fail "/var/lib is not a real directory."
  [ "$(stat -c '%u:%g' /var/lib)" = 0:0 ] || root_account_fail "/var/lib is not root-owned."
  case "$(stat -c '%a' /var/lib)" in *[2367][0-7] | *[0-7][2367]) root_account_fail "/var/lib is writable by an untrusted identity." ;; esac
  [ -f "$ROOT_MARKER" ] && [ ! -L "$ROOT_MARKER" ] || return 1
  [ "$(stat -c '%u:%g:%a' "$ROOT_MARKER" 2>/dev/null || true)" = 0:0:600 ] || return 1
  RA_MARKER_COMMAND=$(sed -n 's/^command=//p' "$ROOT_MARKER")
  case "$RA_MARKER_COMMAND" in muffin | muffin-agent) ;; *) return 1 ;; esac
  [ "$(wc -l <"$ROOT_MARKER" | tr -d ' ')" = 4 ] || return 1
  grep -Fxq 'version=1' "$ROOT_MARKER" && grep -Fxq "user=$ROOT_USER" "$ROOT_MARKER" &&
    grep -Fxq "home=$ROOT_HOME" "$ROOT_MARKER" && grep -Fxq "command=$RA_MARKER_COMMAND" "$ROOT_MARKER" || return 1
  [ "$RA_MARKER_COMMAND" = "$RA_COMMAND" ] || return 1
  RA_PASSWD=$(getent passwd "$ROOT_USER") || return 1
  RA_UID=$(id -u "$ROOT_USER") || return 1
  RA_GID=$(id -g "$ROOT_USER") || return 1
  [ "$(id -gn "$ROOT_USER")" = "$ROOT_USER" ] && [ "$(id -Gn "$ROOT_USER")" = "$ROOT_USER" ] || return 1
  [ "$(printf '%s\n' "$RA_PASSWD" | cut -d: -f6)" = "$ROOT_HOME" ] &&
    [ "$(printf '%s\n' "$RA_PASSWD" | cut -d: -f7)" = /usr/sbin/nologin ] || return 1
  [ "$(passwd -S "$ROOT_USER" 2>/dev/null | awk '{print $2}')" = L ] || return 1
  [ -d "$ROOT_HOME" ] && [ ! -L "$ROOT_HOME" ] || return 1
  [ "$(stat -c '%u:%g:%a' "$ROOT_HOME")" = "$RA_UID:$RA_GID:700" ]
}
root_account_run() {
  RA_ACTION=${1:-}
  RA_COMMAND=${2:-}
  case "$RA_ACTION" in prepare | validate) ;; *) root_account_fail "usage: install.sh --muffin-root-account <prepare|validate> <muffin|muffin-agent>" ;; esac
  case "$RA_COMMAND" in muffin | muffin-agent) ;; *) root_account_fail "the managed command must be muffin or muffin-agent." ;; esac
  if getent passwd muffin >/dev/null 2>&1; then
    root_account_validate "$RA_COMMAND" || root_account_fail "refusing to adopt or repair an existing muffin account or home."
    printf '%s\n' "$RA_COMMAND"
    return 0
  fi
  [ "$RA_ACTION" = prepare ] || root_account_fail "no managed muffin account exists to validate."
  [ ! -e /var/lib/muffin ] && [ ! -L /var/lib/muffin ] || root_account_fail "/var/lib/muffin exists without a managed account."
  [ ! -e /var/lib/.muffin-root-install ] && [ ! -L /var/lib/.muffin-root-install ] || root_account_fail "the root-owned account marker exists without its account."
  useradd --user-group --create-home --home-dir /var/lib/muffin --shell /usr/sbin/nologin muffin || root_account_fail "could not create the muffin service account."
  if ! chmod 0700 /var/lib/muffin; then
    userdel muffin >/dev/null 2>&1 || true
    rmdir /var/lib/muffin >/dev/null 2>&1 || true
    root_account_fail "could not make the new muffin home private; account creation was rolled back."
  fi
  RA_TMP=$(mktemp /var/lib/.muffin-root-install.XXXXXX) || {
    userdel muffin >/dev/null 2>&1 || true
    rmdir /var/lib/muffin >/dev/null 2>&1 || true
    root_account_fail "could not stage the root-owned install marker; account creation was rolled back."
  }
  if ! printf 'version=1\nuser=muffin\nhome=/var/lib/muffin\ncommand=%s\n' "$RA_COMMAND" >"$RA_TMP" ||
    ! chmod 0600 "$RA_TMP" || ! mv -f "$RA_TMP" /var/lib/.muffin-root-install; then
    rm -f "$RA_TMP"
    userdel muffin >/dev/null 2>&1 || true
    rmdir /var/lib/muffin >/dev/null 2>&1 || true
    root_account_fail "could not write the root-owned account marker; account creation was rolled back."
  fi
  printf '%s\n' "$RA_COMMAND"
}

root_service_run() {
  root_service_path="$SERVICE_PREFIX/node/bin"
  if [ -x "$SERVICE_PREFIX/tool-bin/bwrap" ]; then root_service_path="$SERVICE_PREFIX/tool-bin:$root_service_path"; fi
  runuser -u muffin -- env -i HOME="$SERVICE_HOME" USER=muffin LOGNAME=muffin SHELL=/bin/sh \
    PATH="$root_service_path:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR="$SERVICE_RUNTIME" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$SERVICE_RUNTIME/bus" "$@"
}

root_wait_user_manager() {
  USER_MANAGER_ATTEMPT=0
  while [ "$USER_MANAGER_ATTEMPT" -lt 30 ]; do
    # A D-Bus request proves the manager answers; a directory/socket path alone
    # can exist without a usable user manager.
    if root_service_run systemctl --user show-environment >/dev/null 2>&1; then return 0; fi
    USER_MANAGER_ATTEMPT=$((USER_MANAGER_ATTEMPT + 1))
    sleep 1
  done
  return 1
}

root_uninstall_managed() {
  ROOT_UID=$(id -u muffin)
  ROOT_GID=$(id -g muffin)
  SERVICE_HOME=/var/lib/muffin
  SERVICE_PREFIX=$SERVICE_HOME/.local/share/muffin
  SERVICE_BINDIR=$SERVICE_HOME/.local/bin
  SERVICE_UID=$ROOT_UID
  SERVICE_RUNTIME=/run/user/$SERVICE_UID
  ROOT_SHIM=/usr/local/bin/$ROOT_CMD
  ROOT_LAUNCHER=$SERVICE_BINDIR/$ROOT_CMD
  ROOT_UNIT_DIR=$SERVICE_HOME/.config/systemd/user
  ROOT_UNIT=$ROOT_UNIT_DIR/muffin-gateway.service

  if [ -e "$ROOT_SHIM" ] || [ -L "$ROOT_SHIM" ]; then
    if [ ! -f "$ROOT_SHIM" ] || [ -L "$ROOT_SHIM" ] ||
      [ "$(stat -c '%u:%g:%a' "$ROOT_SHIM" 2>/dev/null || true)" != 0:0:755 ] ||
      ! grep -Fqx '# Muffin managed root dispatcher' "$ROOT_SHIM"; then
      root_fail "$ROOT_SHIM is not the managed Muffin command; refusing to remove it."
    fi
  fi
  if [ -e "$ROOT_LAUNCHER" ] || [ -L "$ROOT_LAUNCHER" ]; then
    [ -L "$ROOT_LAUNCHER" ] &&
      [ "$(readlink "$ROOT_LAUNCHER")" = "$SERVICE_PREFIX/src/dist/cli/main.js" ] ||
      root_fail "$ROOT_LAUNCHER is not the expected Muffin launcher; refusing to remove it."
  fi
  if [ -e "$SERVICE_PREFIX" ] || [ -L "$SERVICE_PREFIX" ]; then
    [ -d "$SERVICE_PREFIX" ] && [ ! -L "$SERVICE_PREFIX" ] &&
      [ "$(stat -c '%u:%g' "$SERVICE_PREFIX" 2>/dev/null || true)" = "$ROOT_UID:$ROOT_GID" ] ||
      root_fail "$SERVICE_PREFIX is not a real muffin-owned directory; refusing to remove it."
  fi

  HAS_UNIT=0
  if [ -e "$ROOT_UNIT" ] || [ -L "$ROOT_UNIT" ]; then
    [ -f "$ROOT_UNIT" ] && [ ! -L "$ROOT_UNIT" ] &&
      [ "$(stat -c '%u:%g' "$ROOT_UNIT" 2>/dev/null || true)" = "$ROOT_UID:$ROOT_GID" ] ||
      root_fail "$ROOT_UNIT is not a regular muffin-owned unit; refusing to remove it."
    HAS_UNIT=1
  fi
  # Start the manager and query the gateway even if its unit file has vanished:
  # systemd may still have the already-loaded service running in memory.
  loginctl enable-linger muffin || root_fail "could not start the muffin user manager for safe service removal."
  [ "$(loginctl show-user muffin -p Linger --value 2>/dev/null || true)" = yes ] ||
    root_fail "systemd did not confirm linger for the muffin account."
  root_wait_user_manager || root_fail "muffin's systemd user manager did not answer within 30 seconds; service and program were left in place."
  if [ "$HAS_UNIT" = 1 ]; then
    root_service_run systemctl --user disable --now muffin-gateway.service ||
      root_fail "systemd could not stop and disable muffin-gateway.service; program files were left in place."
  fi
  SERVICE_STATE=
  if SERVICE_STATE=$(root_service_run systemctl --user is-active muffin-gateway.service 2>&1); then
    root_fail "muffin-gateway.service is still active; program files were left in place."
  fi
  case "$SERVICE_STATE" in
    inactive | failed) ;;
    unknown)
      [ "$HAS_UNIT" = 0 ] || root_fail "systemd could not find muffin-gateway.service; program files were left in place."
      ;;
    *) root_fail "could not verify that muffin-gateway.service is stopped (systemd reported: ${SERVICE_STATE:-no state}); program files were left in place." ;;
  esac
  if [ "$HAS_UNIT" = 1 ]; then
    root_service_run rm -f -- "$ROOT_UNIT" || root_fail "could not remove the Muffin user unit."
    root_service_run systemctl --user daemon-reload || root_fail "systemd could not reload the muffin user manager."
  fi

  loginctl disable-linger muffin || root_fail "could not disable the muffin user manager."
  [ "$(loginctl show-user muffin -p Linger --value 2>/dev/null || true)" != yes ] ||
    root_fail "systemd still reports linger enabled for the muffin account."
  if [ -L "$ROOT_LAUNCHER" ]; then
    root_service_run rm -f -- "$ROOT_LAUNCHER" || root_fail "could not remove the Muffin launcher."
  fi
  if [ -d "$SERVICE_PREFIX" ]; then
    root_service_run rm -rf -- "$SERVICE_PREFIX" || root_fail "could not remove the Muffin program files."
  fi
  root_service_run rm -f -- \
    "$SERVICE_HOME/.local/share/bash-completion/completions/$ROOT_CMD" \
    "$SERVICE_HOME/.local/share/zsh/site-functions/_$ROOT_CMD" \
    "$SERVICE_HOME/.config/fish/completions/$ROOT_CMD.fish" || root_fail "could not remove generated Muffin completions."
  if [ -e "$ROOT_SHIM" ]; then rm -f -- "$ROOT_SHIM" || root_fail "could not remove the root-owned Muffin command."; fi
  say "Muffin program and service removed; the locked service account and /var/lib/muffin/.muffin data were preserved."
}

if [ "${1:-}" = --muffin-root-account ]; then
  shift
  root_account_run "$@"
  exit 0
fi
if [ "${1:-}" = --muffin-secure-copy-key ]; then
  [ "$(id -u)" = 0 ] || root_account_fail "root is required to stage the API-key file."
  [ "$#" = 4 ] || root_account_fail "usage: install.sh --muffin-secure-copy-key <source> <destination> <invoking-uid>"
  root_copy_api_key_file "$2" "$3" "$4"
  exit 0
fi

# Root provisions the host boundary, then this same staged installer re-execs
# under the dedicated account. No source/build/Muffin command runs at UID 0.
if [ "$(id -u)" = 0 ]; then
  root_fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
  [ "$(uname -s)" = Linux ] || root_fail "root-launched installation is supported only on Linux."

  # The `--paths` contract — print, change nothing — holds on a root login too:
  # answer the informational invocations before touching packages, the account
  # or the service. `--help` and an unknown flag behave like the non-root
  # parser instead of provisioning the host first.
  ROOT_PATHS_ONLY=0
  for arg in "$@"; do
    case "$arg" in
      --paths) ROOT_PATHS_ONLY=1 ;;
      -h | --help)
        cat >&2 <<'USAGE'
muffin install.sh [--personal | --checkout] [--paths] [--uninstall]

  (default)     from a root login: a locked, non-login muffin account owns
                /var/lib/muffin; build, setup and gateway run as that account
  --paths       print the resolved root-managed paths and exit, changing nothing
  --uninstall   remove the root dispatcher, keeping the account and data
USAGE
        exit 0
        ;;
      --personal | --checkout | --uninstall) : ;;
      -*) root_fail "unknown argument: $arg (see --help)" ;;
    esac
  done
  if [ "$ROOT_PATHS_ONLY" = 1 ]; then
    ROOT_CMD=${MUFFIN_CMD:-muffin}
    if getent passwd muffin >/dev/null 2>&1; then
      [ -f /var/lib/.muffin-root-install ] && [ ! -L /var/lib/.muffin-root-install ] ||
        root_fail "refusing to adopt an existing unmarked muffin account."
      ROOT_CMD=$(sed -n 's/^command=//p' /var/lib/.muffin-root-install)
    elif [ -z "${MUFFIN_CMD:-}" ] && command -v muffin >/dev/null 2>&1; then
      ROOT_CMD=muffin-agent
    fi
    say "muffin installer — resolved paths (root-managed)"
    say "  mode:      root"
    say "  service:   muffin (locked, non-login)"
    say "  program:   /var/lib/muffin/.local/share/muffin"
    say "  bin:       /var/lib/muffin/.local/bin"
    say "  data home: /var/lib/muffin/.muffin (owned by the runtime, never touched by this installer)"
    say "  command:   /usr/local/bin/$ROOT_CMD"
    exit 0
  fi

  for tool in getent useradd usermod userdel stat runuser mktemp passwd; do
    command -v "$tool" >/dev/null 2>&1 || root_fail "required root provisioning command is missing: $tool"
  done
  [ -f "$0" ] && [ ! -L "$0" ] || root_fail "installer must be a regular file; run the public bootstrap or a complete checkout."
  [ -d /var/lib ] && [ ! -L /var/lib ] && [ "$(stat -c '%u:%g' /var/lib)" = 0:0 ] || root_fail "/var/lib is not a trusted root-owned directory."
  case "$(stat -c '%a' /var/lib)" in *[2367][0-7] | *[0-7][2367]) root_fail "/var/lib is writable by an untrusted identity." ;; esac
  [ ! -e /var/lib/muffin ] || [ -d /var/lib/muffin ] || root_fail "/var/lib/muffin is not a directory."
  [ ! -L /var/lib/muffin ] || root_fail "/var/lib/muffin must not be a symlink."

  ROOT_CMD=${MUFFIN_CMD:-muffin}
  if getent passwd muffin >/dev/null 2>&1; then
    [ -f /var/lib/.muffin-root-install ] && [ ! -L /var/lib/.muffin-root-install ] || root_fail "refusing to adopt an existing unmarked muffin account."
    ROOT_CMD=$(sed -n 's/^command=//p' /var/lib/.muffin-root-install)
  elif [ -z "${MUFFIN_CMD:-}" ] && command -v muffin >/dev/null 2>&1; then
    ROOT_CMD=muffin-agent
  fi
  case "$ROOT_CMD" in muffin | muffin-agent) ;; *) root_fail "the managed command must be muffin or muffin-agent." ;; esac
  sh "$0" --muffin-root-account validate "$ROOT_CMD" >/dev/null 2>&1 && ROOT_ALREADY_VALID=1 || ROOT_ALREADY_VALID=0
  if getent passwd muffin >/dev/null 2>&1 && [ "$ROOT_ALREADY_VALID" != 1 ]; then
    root_fail "refusing to adopt or repair an existing muffin account or home."
  fi
  if ! getent passwd muffin >/dev/null 2>&1 && { [ -e /var/lib/muffin ] || [ -L /var/lib/muffin ] || [ -e /var/lib/.muffin-root-install ] || [ -L /var/lib/.muffin-root-install ]; }; then
    root_fail "refusing ambiguous pre-existing muffin service state."
  fi

  # The dispatcher is later invoked through sudo, so every directory that
  # contains it must be protected from replacement by an untrusted local user.
  for ROOT_BIN_DIR in /usr /usr/local /usr/local/bin; do
    [ -d "$ROOT_BIN_DIR" ] && [ ! -L "$ROOT_BIN_DIR" ] &&
      [ "$(stat -c '%u:%g' "$ROOT_BIN_DIR" 2>/dev/null || true)" = 0:0 ] ||
      root_fail "$ROOT_BIN_DIR is not a trusted root-owned directory."
    case "$(stat -c '%a' "$ROOT_BIN_DIR")" in
      *[2367][0-7] | *[0-7][2367]) root_fail "$ROOT_BIN_DIR is writable by an untrusted identity." ;;
    esac
  done

  ROOT_SHIM=/usr/local/bin/$ROOT_CMD
  if [ -e "$ROOT_SHIM" ] || [ -L "$ROOT_SHIM" ]; then
    if [ "$ROOT_ALREADY_VALID" != 1 ] || [ -L "$ROOT_SHIM" ] || [ ! -f "$ROOT_SHIM" ] ||
      [ "$(stat -c '%u:%g:%a' "$ROOT_SHIM" 2>/dev/null || true)" != 0:0:755 ] ||
      ! grep -Fqx '# Muffin managed root dispatcher' "$ROOT_SHIM"; then
      root_fail "$ROOT_SHIM already belongs to another command; refusing before changing the host."
    fi
  fi
  command -v loginctl >/dev/null 2>&1 || root_fail "loginctl is required to enable the service user's persistent user manager."

  if [ "${1:-}" = --uninstall ]; then
    command -v systemctl >/dev/null 2>&1 || root_fail "systemctl is required to safely remove the service user's gateway."
    getent passwd muffin >/dev/null 2>&1 || root_fail "no managed muffin service account exists to uninstall."
    [ -f /var/lib/.muffin-root-install ] && [ ! -L /var/lib/.muffin-root-install ] ||
      root_fail "refusing to remove an unmarked muffin account."
    root_uninstall_managed
    exit 0
  fi

  ROOT_PACKAGES=
  if ! dpkg-query -W -f='${Status}' ca-certificates 2>/dev/null | grep -q 'install ok installed'; then ROOT_PACKAGES="$ROOT_PACKAGES ca-certificates"; fi
  for spec in 'git:git' 'curl:curl' 'tar:tar' 'xz-utils:xz' 'bubblewrap:bwrap' 'socat:socat' 'ripgrep:rg' \
    'build-essential:gcc' 'meson:meson' 'ninja-build:ninja' 'pkg-config:pkg-config'; do
    package=${spec%%:*}
    binary=${spec#*:}
    command -v "$binary" >/dev/null 2>&1 || ROOT_PACKAGES="$ROOT_PACKAGES $package"
  done
  # The headers the Muffin-owned bubblewrap build needs, which ship no binary
  # of their own to look for.
  for dev in libcap-dev linux-libc-dev; do
    dpkg-query -W -f='${Status}' "$dev" 2>/dev/null | grep -q 'install ok installed' ||
      ROOT_PACKAGES="$ROOT_PACKAGES $dev"
  done
  if [ -n "${MUFFIN_API_KEY_FILE:-}" ] && ! command -v python3 >/dev/null 2>&1; then
    ROOT_PACKAGES="$ROOT_PACKAGES python3-minimal"
  fi
  if [ -n "$ROOT_PACKAGES" ]; then
    if [ "${MUFFIN_NO_APT:-}" = 1 ]; then
      root_fail "missing required host tools and MUFFIN_NO_APT=1 forbids installing them:$ROOT_PACKAGES"
    fi
    command -v apt-get >/dev/null 2>&1 || root_fail "missing required host tools and apt-get is unavailable:$ROOT_PACKAGES"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null || root_fail "apt package index update failed."
    # The value contains only package names from the fixed list above.
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $ROOT_PACKAGES >/dev/null || root_fail "could not install required host tools:$ROOT_PACKAGES"
  fi

  ROOT_CMD=$(sh "$0" --muffin-root-account prepare "$ROOT_CMD") || exit 1
  loginctl enable-linger muffin || root_fail "could not enable systemd linger for the muffin account."
  [ "$(loginctl show-user muffin -p Linger --value 2>/dev/null || true)" = yes ] || root_fail "systemd did not confirm linger for the muffin account."
  SERVICE_HOME=/var/lib/muffin
  SERVICE_PREFIX=$SERVICE_HOME/.local/share/muffin
  SERVICE_BINDIR=$SERVICE_HOME/.local/bin
  SERVICE_UID=$(id -u muffin)
  SERVICE_RUNTIME=/run/user/$SERVICE_UID
  if [ "${MUFFIN_NO_GATEWAY:-}" != 1 ]; then
    command -v systemctl >/dev/null 2>&1 || root_fail "systemctl is required to verify the muffin user manager."
    root_wait_user_manager || root_fail "linger is enabled, but muffin's systemd user manager did not answer within 30 seconds; no gateway was installed. Retry after checking systemd-logind."
  fi
  ROOT_STAGE=$(mktemp -d /run/muffin-install.XXXXXX) || root_fail "could not stage the installer."
  chmod 0700 "$ROOT_STAGE" || root_fail "could not make the temporary staging directory private."
  # shellcheck disable=SC2329 # The function is invoked by shell traps.
  ROOT_STAGE_CLEANUP() { rm -rf -- "$ROOT_STAGE"; }
  trap ROOT_STAGE_CLEANUP EXIT HUP INT TERM
  cp "$0" "$ROOT_STAGE/install.sh" || root_fail "could not copy installer for the service account."
  if ! chown root:root "$ROOT_STAGE/install.sh" || ! chmod 0444 "$ROOT_STAGE/install.sh"; then
    root_fail "could not secure the staged installer."
  fi
  KEY_COPY=
  if [ -n "${MUFFIN_API_KEY_FILE:-}" ]; then
    [ -f "$MUFFIN_API_KEY_FILE" ] && [ ! -L "$MUFFIN_API_KEY_FILE" ] || root_fail "MUFFIN_API_KEY_FILE must be a regular non-symlink file."
    KEY_COPY=$ROOT_STAGE/api-key
    ROOT_CALLER_UID=0
    if [ -n "${SUDO_UID:-}" ]; then
      case "$SUDO_UID" in *[!0-9]*) root_fail "SUDO_UID is not a valid numeric user id." ;; esac
      ROOT_CALLER_UID=$SUDO_UID
    fi
    root_copy_api_key_file "$MUFFIN_API_KEY_FILE" "$KEY_COPY" "$ROOT_CALLER_UID" ||
      root_fail "could not securely copy the API key into the private stage."
    chown muffin:muffin "$KEY_COPY" || root_fail "could not set service ownership on the staged API key."
    chmod 0600 "$KEY_COPY" || root_fail "could not restrict permissions on the staged API key."
    [ "$(stat -c '%u:%g:%a' "$KEY_COPY" 2>/dev/null || true)" = "$(id -u muffin):$(id -g muffin):600" ] ||
      root_fail "the staged API key is not owned by muffin with mode 0600."
  fi
  # Only now can the service account traverse the stage to read the installer
  # and (when present) the already private, service-owned key file.
  chmod 0711 "$ROOT_STAGE" || root_fail "could not expose the secured stage to the service account."
  say "root has prepared the service account; build and setup now run as muffin."
  set +e
  if [ -n "$KEY_COPY" ]; then
    runuser -u muffin -- env -i HOME="$SERVICE_HOME" USER=muffin LOGNAME=muffin SHELL=/bin/sh \
      PATH="$SERVICE_PREFIX/tool-bin:$SERVICE_PREFIX/node/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR="$SERVICE_RUNTIME" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=$SERVICE_RUNTIME/bus" MUFFIN_PREFIX="$SERVICE_PREFIX" MUFFIN_BINDIR="$SERVICE_BINDIR" \
      MUFFIN_TOOL_BIN="$SERVICE_PREFIX/tool-bin" \
      MUFFIN_CMD="$ROOT_CMD" MUFFIN_NO_APT=1 MUFFIN_REPO="${MUFFIN_REPO:-https://github.com/muffin-project/muffin-agent.git}" \
      MUFFIN_CHANNEL="${MUFFIN_CHANNEL:-main}" MUFFIN_REF="${MUFFIN_REF:-}" MUFFIN_NODE_DIST_BASE="${MUFFIN_NODE_DIST_BASE:-}" \
      MUFFIN_NO_GATEWAY="${MUFFIN_NO_GATEWAY:-}" MUFFIN_SANDBOX_REPORT=0 MUFFIN_API_KEY_FILE="$KEY_COPY" sh "$ROOT_STAGE/install.sh" "$@" <&0
  else
    runuser -u muffin -- env -i HOME="$SERVICE_HOME" USER=muffin LOGNAME=muffin SHELL=/bin/sh \
      PATH="$SERVICE_PREFIX/tool-bin:$SERVICE_PREFIX/node/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR="$SERVICE_RUNTIME" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=$SERVICE_RUNTIME/bus" MUFFIN_PREFIX="$SERVICE_PREFIX" MUFFIN_BINDIR="$SERVICE_BINDIR" \
      MUFFIN_TOOL_BIN="$SERVICE_PREFIX/tool-bin" \
      MUFFIN_CMD="$ROOT_CMD" MUFFIN_NO_APT=1 MUFFIN_REPO="${MUFFIN_REPO:-https://github.com/muffin-project/muffin-agent.git}" \
      MUFFIN_CHANNEL="${MUFFIN_CHANNEL:-main}" MUFFIN_REF="${MUFFIN_REF:-}" MUFFIN_NODE_DIST_BASE="${MUFFIN_NODE_DIST_BASE:-}" \
      MUFFIN_NO_GATEWAY="${MUFFIN_NO_GATEWAY:-}" MUFFIN_SANDBOX_REPORT=0 sh "$ROOT_STAGE/install.sh" "$@" <&0
  fi
  ROOT_INSTALL_RC=$?
  set -e
  case "$ROOT_INSTALL_RC" in 0 | 3) ;; *) exit "$ROOT_INSTALL_RC" ;; esac
  SHIM=/usr/local/bin/$ROOT_CMD
  if [ -e "$SHIM" ] || [ -L "$SHIM" ]; then
    if [ -L "$SHIM" ] || [ "$(stat -c '%u:%g:%a' "$SHIM" 2>/dev/null || true)" != 0:0:755 ] || ! grep -Fq 'Muffin managed root dispatcher' "$SHIM"; then
      root_fail "$SHIM already belongs to another command; refusing to replace it."
    fi
  fi
  umask 022
  DISPATCHER_PATH="$SERVICE_PREFIX/tool-bin:$SERVICE_PREFIX/node/bin:/usr/local/bin:/usr/bin:/bin"
  SHIM_TMP=$(mktemp "/usr/local/bin/.$ROOT_CMD.muffin-new.XXXXXX") ||
    root_fail "could not securely create a temporary root dispatcher."
  if ! cat >"$SHIM_TMP" <<EOF
#!/bin/sh
# Muffin managed root dispatcher
if [ "\$(id -u)" -ne 0 ]; then
  echo "error: use sudo $ROOT_CMD to operate the Muffin service" >&2
  exit 1
fi
exec runuser -u muffin -- env -i HOME=/var/lib/muffin USER=muffin LOGNAME=muffin SHELL=/bin/sh PATH=$DISPATCHER_PATH XDG_RUNTIME_DIR=/run/user/$SERVICE_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$SERVICE_UID/bus /var/lib/muffin/.local/bin/$ROOT_CMD "\$@"
EOF
  then
    rm -f -- "$SHIM_TMP"
    root_fail "could not write the root-owned command dispatcher."
  fi
  if ! chown root:root "$SHIM_TMP" || ! chmod 0755 "$SHIM_TMP"; then
    rm -f -- "$SHIM_TMP"
    root_fail "could not secure the root-owned command dispatcher."
  fi
  if ! mv -f "$SHIM_TMP" "$SHIM"; then
    rm -f -- "$SHIM_TMP"
    root_fail "could not install the root-owned command dispatcher."
  fi
  [ "$ROOT_INSTALL_RC" -eq 0 ] || exit "$ROOT_INSTALL_RC"
  sandbox_report root_service_run "$SERVICE_PREFIX/node/bin/node" "$SERVICE_PREFIX/src" yes "$SERVICE_PREFIX/tool-bin/bwrap"
  exit 0
fi
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# A pinned install is one immutable commit or it is refused: the bootstrap
# resolves it, and nothing here may silently fall back to a branch.
MUFFIN_REF=${MUFFIN_REF:-}
case "$MUFFIN_REF" in
  "") : ;;
  *[!0-9a-f]*) die "MUFFIN_REF must be a hexadecimal commit SHA, got '$MUFFIN_REF'" ;;
esac
if [ -n "$MUFFIN_REF" ] && [ "${#MUFFIN_REF}" -ne 40 ]; then
  die "MUFFIN_REF must be a 40-character commit SHA, got '$MUFFIN_REF'"
fi

# ---------------------------------------------------------------------------
# 0. Arguments, mode, and where the source is.
#
# Two install modes, and the choice is **explicit** — the script never infers
# it from where it happens to sit:
#
#   personal (default)  code and Node under $MUFFIN_PREFIX; the launcher and
#                       `muffin update`'s releases stay there. A personal
#                       install never writes `.releases/` into a source clone.
#   checkout            only with `--checkout` (or MUFFIN_MODE=checkout): the
#                       launcher points at THIS checkout's `dist/`, and
#                       `muffin update` stores releases under its `.releases/`.
#                       Development mode, named as such.
#
# Running this script from a clone used to select checkout mode silently, just
# because the directory contained Muffin's package.json (#702). Now the same
# run is a personal install and says so, with the one flag that changes it.
#
# `--paths` resolves and prints the same paths without touching the machine.
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")

FLAG_MODE=""
UNINSTALL=0
PATHS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --checkout) FLAG_MODE=checkout ;;
    --personal) FLAG_MODE=personal ;;
    --paths) PATHS_ONLY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
      cat >&2 <<'USAGE'
muffin install.sh [--personal | --checkout] [--paths] [--uninstall]

  (default)     personal install: code under $MUFFIN_PREFIX, data under ~/.muffin
  --checkout    development install bound to this source checkout
  --paths       print the resolved paths and exit, changing nothing
  --uninstall   remove the launcher symlink(s) pointing at this build
USAGE
      exit 0
      ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

is_clone=0
if [ -n "$SCRIPT_DIR" ] && [ -e "$SCRIPT_DIR/.git" ] && [ -f "$SCRIPT_DIR/package.json" ] &&
  grep -q '"name": *"muffin-agent"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  is_clone=1
fi

# A flag beats the environment, always: `--personal` must not be silently
# overridden by a stale MUFFIN_MODE, and vice versa.
if [ -n "$FLAG_MODE" ]; then
  MODE=$FLAG_MODE
elif [ -n "${MUFFIN_MODE:-}" ]; then
  case "$MUFFIN_MODE" in
    personal | checkout) MODE=$MUFFIN_MODE ;;
    *) die "MUFFIN_MODE must be 'personal' or 'checkout', got '$MUFFIN_MODE'" ;;
  esac
else
  MODE=personal
fi

if [ "$UNINSTALL" = 1 ] && [ "$PATHS_ONLY" = 1 ]; then
  die "--paths and --uninstall are different questions; run one at a time"
fi

if [ "$MODE" = checkout ]; then
  [ "$is_clone" = 1 ] ||
    die "--checkout needs a muffin-agent checkout; run this script from a git clone, or drop --checkout for a personal install"
  SRC=$SCRIPT_DIR
else
  SRC=$MUFFIN_PREFIX/src
  if [ "$is_clone" = 1 ]; then
    say "note: this is a muffin-agent checkout, and a *personal* install is selected."
    say "      code will live in $MUFFIN_PREFIX; pass --checkout to bind the launcher to this clone instead."
  fi
fi
NODE_DIR=$MUFFIN_PREFIX/node
BIN="$SRC/dist/cli/main.js"
RELEASES_DIR=$SRC/.releases
LAUNCHER_DIR=${MUFFIN_BINDIR:-$HOME/.local/bin}
DATA_HOME=${MUFFIN_HOME:-$HOME/.muffin}

report_paths() {
  say "muffin installer — resolved paths"
  say "  mode:      $MODE"
  say "  source:    $SRC"
  say "  releases:  $RELEASES_DIR"
  say "  node:      $NODE_DIR"
  # The collision check later may rename this to `muffin-agent` when another
  # `muffin` is on PATH; the requested name is what this reports.
  say "  launcher:  $LAUNCHER_DIR/${MUFFIN_CMD:-muffin}"
  say "  data home: $DATA_HOME (owned by the runtime, never touched by this installer)"
}

if [ "$UNINSTALL" = 1 ]; then
  removed=0
  for dir in "$LAUNCHER_DIR" /opt/homebrew/bin /usr/local/bin; do
    for name in muffin muffin-agent; do
      link="$dir/$name"
      if [ -L "$link" ] && [ "$(readlink "$link")" = "$BIN" ]; then
        rm -f "$link" && { say "removed $link"; removed=1; }
      fi
    done
  done
  [ "$removed" = 0 ] && say "no muffin launcher pointing at this build was found"
  say "if you used 'npm link' for dev, also run: npm rm -g muffin-agent"
  say "to remove your data (config, keys, memory): muffin uninstall"
  if [ "$MODE" = personal ]; then
    say "to remove the code and the bundled Node:  rm -rf $MUFFIN_PREFIX"
  fi
  exit 0
fi

if [ "$PATHS_ONLY" = 1 ]; then
  report_paths
  exit 0
fi

report_paths

# ---------------------------------------------------------------------------
# 1. OS packages.
#
# Split in two on purpose, because the two halves fail differently:
#
#   REQUIRED  git/curl/ca-certificates/xz-utils — without them this script
#             cannot fetch or unpack anything, so a failure here is fatal.
#   SANDBOX   Linux: bubblewrap/socat/ripgrep. macOS: Seatbelt ships with the
#             OS and the sandbox runtime only needs ripgrep. These lists come
#             from the same platform split the runtime uses; recommending
#             bubblewrap on Darwin is not a harmless extra — it tells an owner
#             to install a Linux-only package for a mechanism Muffin never calls.
#
# `sudo -n` and never an installer-owned password prompt: even when bootstrap
# restored a controlling TTY, privilege escalation is a distinct owner action.
# A missing privileged package should produce one explicit remedy rather than
# silently turning installation into a root-interactive wizard.
# ---------------------------------------------------------------------------
apt_install() {
  # usage: apt_install <purpose> <fatal 0|1> <pkg...>
  purpose=$1
  fatal=$2
  shift 2
  if [ "${MUFFIN_NO_APT:-}" = 1 ]; then
    say "note: MUFFIN_NO_APT=1 — not installing: $*  ($purpose)"
    return 1
  fi
  if ! have apt-get; then
    say "note: no apt-get here; install yourself: $*  ($purpose)"
    return 1
  fi
  SUDO=""
  if [ "$(id -u)" != 0 ]; then
    if have sudo && sudo -n true 2>/dev/null; then
      SUDO="sudo -n"
    else
      say "note: no passwordless sudo — run yourself:  sudo apt-get install -y $*"
      if [ "$fatal" = 1 ]; then die "cannot continue without: $*"; fi
      return 1
    fi
  fi
  say "installing OS packages ($purpose): $*"
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get update -qq >/dev/null 2>&1 || true
  if ! DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "$@" >/dev/null 2>&1; then
    say "! apt-get install failed for: $*"
    if [ "$fatal" = 1 ]; then die "cannot continue without: $*"; fi
    return 1
  fi
  return 0
}

missing_required=''
have git || missing_required="$missing_required git"
have curl || missing_required="$missing_required curl"
have tar || missing_required="$missing_required tar"
if ! have xz && ! have unxz; then missing_required="$missing_required xz-utils"; fi
if [ -n "$missing_required" ]; then
  apt_install "needed by this installer" 1 ca-certificates $missing_required || true
fi
have git || die "git not found and could not be installed — install it, then re-run."
have curl || die "curl not found and could not be installed — install it, then re-run."

case "$(uname -s)" in
  Linux)
    missing_sandbox=''
    for b in bwrap socat rg; do
      have "$b" || missing_sandbox="$missing_sandbox $b"
    done
    if [ -n "$missing_sandbox" ]; then
      apt_install "the sandbox — without it every command asks you first" 0 bubblewrap socat ripgrep || true
    fi
    say "      Linux shell tools require Muffin's hook-protection AppArmor profile; see docs/user/INSTALL.md."
    ;;
  Darwin)
    # @anthropic-ai/sandbox-runtime uses the built-in sandbox-exec/Seatbelt
    # mechanism on macOS. Its only additional binary dependency is ripgrep;
    # socat is part of the Linux network-namespace bridge and bwrap is Linux-only.
    if ! have rg; then
      say "note: the macOS sandbox uses built-in Seatbelt; ripgrep is missing — brew install ripgrep"
    fi
    ;;
  *)
    say "note: no supported automatic sandbox dependency setup for $(uname -s); muffin doctor will report the actual containment state"
    ;;
esac

# ---------------------------------------------------------------------------
# 2. Node >= 22.
#
# The runtime targets it and `engines` enforces it, so "install Node first" was
# never a prerequisite this script could keep assuming — an empty VPS has no
# Node at all, and Ubuntu 24.04's own `nodejs` package is 18. Neither nvm nor
# fnm: both are shell-profile machinery whose whole value is *switching*
# versions interactively, and a systemd unit does not source a shell profile —
# it needs one absolute interpreter directory that still exists next month
# (`resolveInterpreterDir`, core/gateway/unit.ts). The official tarball under
# MUFFIN_PREFIX is exactly that, and it is what `actions/setup-node` does as well.
#
# A system Node that is already >= 22 is used as-is: nothing is downloaded and
# nothing shadows what the machine already had.
# ---------------------------------------------------------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Portable SHA-256 of one file, hex on stdout. `sha256sum` (coreutils, Linux)
# first, `shasum -a 256` (macOS) second; neither is optional here — an
# unverifiable download is a download that does not get extracted.
sha256_file() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "neither sha256sum nor shasum is available — cannot verify the Node download, refusing to continue."
  fi
}

# Fail-closed integrity gate for the Node tarball. The tarball AND the
# checksum list come from the same MUFFIN_NODE_DIST_BASE, so this check
# verifies the PAIR as served — it does not authenticate the origin.
# It stops: corrupted/truncated downloads, mismatched artifacts, accidental
# mirror inconsistency, a tarball modified without a matching modification
# to the checksum manifest. It does NOT stop: a malicious/compromised mirror
# that replaces both files consistently, or compromise of the distribution
# origin itself. A `.asc`/GPG verification against ad-hoc fetched keys would
# move the same trust (this network, right now) into a second file without
# adding any, so it is deliberately not that; stronger origin authenticity
# needs a pinned/maintained trust root, tracked separately if required.
# Runs BEFORE anything under $NODE_DIR is touched, so a refused download can
# never wipe a working Node.
verify_node_tarball() {
  # usage: verify_node_tarball <tarball-path> <shasums-path> <expected-filename>
  tarball=$1
  sums=$2
  name=$3
  want=$(grep -F "  $name" "$sums" | awk '{print $1}' | head -1)
  [ -n "$want" ] || die "no checksum entry for $name in $(basename "$sums") — refusing to install an unlisted file."
  case "$want" in
    *[!0-9a-f]* | '') die "malformed checksum entry for $name — refusing to install." ;;
  esac
  [ "${#want}" = 64 ] || die "malformed checksum entry for $name — refusing to install."
  have_sum=$(sha256_file "$tarball")
  if [ "$have_sum" != "$want" ]; then
    die "checksum mismatch for $name (downloaded $have_sum, expected $want) — the file is discarded, nothing was installed."
  fi
  say "node checksum ok: $name"
}

install_node() {
  arch=$(uname -m)
  case "$arch" in
    aarch64 | arm64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "no official Node tarball for this architecture: $arch — install Node >= $NODE_MAJOR_REQUIRED yourself." ;;
  esac
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS for the Node tarball: $(uname -s) — install Node >= $NODE_MAJOR_REQUIRED yourself." ;;
  esac
  base=${MUFFIN_NODE_DIST_BASE:-https://nodejs.org/dist/latest-v$NODE_MAJOR_REQUIRED.x}
  say "installing Node $NODE_MAJOR_REQUIRED.x into $NODE_DIR (nothing outside your home is touched)"
  listing=$(curl -fsSL "$base/") || die "cannot reach $base — no network?"
  file=$(printf '%s' "$listing" | grep -oE "node-v$NODE_MAJOR_REQUIRED\.[0-9]+\.[0-9]+-$os-$arch\.tar\.xz" | head -1)
  [ -n "$file" ] || die "no node-v$NODE_MAJOR_REQUIRED.x-$os-$arch.tar.xz on $base/"
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/node.tar.xz" || die "download failed: $base/$file"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "download failed: $base/SHASUMS256.txt (no checksum list, no install)"
  verify_node_tarball "$tmp/node.tar.xz" "$tmp/SHASUMS256.txt" "$file"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1 || die "could not unpack $file"
  rm -rf "$tmp"
  PATH="$NODE_DIR/bin:$PATH"
  export PATH
}

if [ -x "$NODE_DIR/bin/node" ]; then
  PATH="$NODE_DIR/bin:$PATH"
  export PATH
fi
if ! have node || [ "$(node_major)" -lt "$NODE_MAJOR_REQUIRED" ]; then
  install_node
fi
have node || die "Node is still not on PATH after installing it — this is a bug in this script."
[ "$(node_major)" -ge "$NODE_MAJOR_REQUIRED" ] || die "Node >= $NODE_MAJOR_REQUIRED required (found $(node -v))."
have npm || die "npm is missing next to $(command -v node) — a partial Node install."
say "node: $(node -v) at $(command -v node)"

# ---------------------------------------------------------------------------
# 3. The source.
#
# A **git checkout**, not a tarball, and not `npm i -g`: `muffin update` builds
# each release as a `git worktree` under `.releases/<sha>` and swings the
# launcher symlink over (cli/update.ts). Without a real repository here, the
# update and rollback path this installer promises does not exist — `muffin
# update` says so in as many words and stops.
# ---------------------------------------------------------------------------
if [ "$MODE" = personal ]; then
  mkdir -p "$MUFFIN_PREFIX"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" remote set-url origin "$MUFFIN_REPO"
    if [ -n "$MUFFIN_REF" ]; then
      # The bootstrap resolved one immutable commit: build exactly it, and prove
      # the checkout is there before anything is compiled.
      say "checking out the pinned commit $MUFFIN_REF in $SRC"
      git -C "$SRC" fetch --quiet origin "$MUFFIN_REF" || die "git fetch of the pinned commit failed from $MUFFIN_REPO"
      git -C "$SRC" checkout --quiet --detach "$MUFFIN_REF" || die "git checkout of the pinned commit failed"
    else
      say "updating the existing checkout in $SRC ($MUFFIN_CHANNEL)"
      git -C "$SRC" fetch --quiet origin "$MUFFIN_CHANNEL" || die "git fetch failed from $MUFFIN_REPO"
      git -C "$SRC" checkout --quiet -B "$MUFFIN_CHANNEL" "origin/$MUFFIN_CHANNEL"
    fi
  else
    if [ -n "$MUFFIN_REF" ]; then
      say "cloning $MUFFIN_REPO at the pinned commit $MUFFIN_REF into $SRC"
      git clone --quiet "$MUFFIN_REPO" "$SRC" || die "git clone failed from $MUFFIN_REPO"
      git -C "$SRC" checkout --quiet --detach "$MUFFIN_REF" || die "git checkout of the pinned commit failed"
    else
      say "cloning $MUFFIN_REPO ($MUFFIN_CHANNEL) into $SRC"
      git clone --quiet --branch "$MUFFIN_CHANNEL" "$MUFFIN_REPO" "$SRC" || die "git clone failed from $MUFFIN_REPO"
    fi
  fi
  if [ -n "$MUFFIN_REF" ]; then
    [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)" = "$MUFFIN_REF" ] ||
      die "the source checkout is not at the pinned commit $MUFFIN_REF"
  fi
fi
[ -f "$SRC/package.json" ] || die "no package.json in $SRC — the source is not there."
cd "$SRC"

# ---------------------------------------------------------------------------
# 4. Build the bin — code plus the non-TS assets init/profiles read at runtime.
#    `npm ci`/`npm install` runs the `prepare` script, which compiles; the
#    explicit compile is a belt-and-suspenders in case prepare was disabled.
# ---------------------------------------------------------------------------
say "building muffin…"
if [ "$MODE" = personal ] && [ -f "$SRC/package-lock.json" ]; then
  npm ci
else
  npm install
fi
[ -f "$BIN" ] || npm run compile
[ -f "$BIN" ] || die "build did not produce $BIN"
chmod +x "$BIN"

provision_owned_bubblewrap

# ---------------------------------------------------------------------------
# 5. Choose a command name that does not shadow a foreign `muffin`.
#    Detection is by identity, not by name or version string: the Cinnamon WM
#    is *also* called muffin and *also* prints a version, so we ask "does the
#    muffin already on PATH resolve to THIS build?" — if not, it is foreign.
#    See ADR-0012.
# ---------------------------------------------------------------------------
CMD=${MUFFIN_CMD:-}
if [ -z "$CMD" ]; then
  CMD=muffin
  existing=$(command -v muffin 2>/dev/null || true)
  if [ -n "$existing" ]; then
    existing_real=$(node -e 'try{process.stdout.write(require("fs").realpathSync(process.argv[1]))}catch(e){process.stdout.write("")}' "$existing" 2>/dev/null || true)
    if [ "$existing_real" != "$BIN" ]; then
      CMD=muffin-agent
      say ""
      say "note: a different 'muffin' is already on your PATH:"
      say "        $existing"
      say "      On Linux Mint that is the Cinnamon window manager. Installing as"
      say "      'muffin-agent' so it is not shadowed. Run it as: muffin-agent"
      say "      To take the name 'muffin' anyway: MUFFIN_CMD=muffin ./install.sh"
      say ""
    fi
  fi
fi

BINDIR=${MUFFIN_BINDIR:-$HOME/.local/bin}
mkdir -p "$BINDIR"
ln -sf "$BIN" "$BINDIR/$CMD"
MUFFIN="$BINDIR/$CMD"
say "installed: $MUFFIN -> $BIN"

# Completion is a projection of Muffin's command authority, not another command
# list the installer owns.  These user-local locations are discovered by the
# usual bash/fish integrations; zsh gets the small fpath marker only when the
# owner already uses zsh.
COMPLETION_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
mkdir -p "$COMPLETION_HOME/bash-completion/completions" "$COMPLETION_HOME/zsh/site-functions" "$HOME/.config/fish/completions"
"$MUFFIN" completion bash >"$COMPLETION_HOME/bash-completion/completions/$CMD"
"$MUFFIN" completion zsh >"$COMPLETION_HOME/zsh/site-functions/_$CMD"
"$MUFFIN" completion fish >"$HOME/.config/fish/completions/$CMD.fish"
OWNER_SHELL=${SHELL:-}
if [ "${OWNER_SHELL##*/}" = zsh ]; then
  ZSH_MARK="# muffin (install.sh): completion"
  if ! grep -qF "$ZSH_MARK" "$HOME/.zshrc" 2>/dev/null; then
    printf '\n%s\nfpath=("%s/zsh/site-functions" $fpath)\nautoload -Uz compinit; compinit\n' "$ZSH_MARK" "$COMPLETION_HOME" >>"$HOME/.zshrc" || die "could not write $HOME/.zshrc"
  fi
fi

# The contract of this section is «install → `muffin` works», in the next
# shell too, not only inside this script. Two directories have to be on the
# login shell's PATH for that: the launcher's, and — measured on a fresh VPS
# on 2026-09-08, where `muffin` printed «/usr/bin/env: 'node': No such file»
# after a clean run of this very script — the bundled Node's, because the
# launcher is a symlink whose shebang resolves `node` through PATH. Printing
# an `echo … >> ~/.profile` for the owner to copy was the previous answer,
# and it left the second directory out. So the script writes the line itself,
# once (the marker keeps re-runs from stacking it), into the files login
# shells actually read: `~/.profile` (sh/dash/bash when no .bash_profile),
# `~/.bash_profile` when it exists (bash then skips .profile), `~/.zprofile`
# on macOS/zsh. Interactive shells already open need `. ~/.profile` or a new
# login — said below, not assumed.
PERSIST=""
case ":$PATH:" in *":$BINDIR:"*) : ;; *) PERSIST="$BINDIR" ;; esac
if [ -x "$NODE_DIR/bin/node" ] && [ "$(command -v node 2>/dev/null)" = "$NODE_DIR/bin/node" ]; then
  PERSIST="$PERSIST${PERSIST:+:}$NODE_DIR/bin"
fi
# The verified Muffin-owned bubblewrap comes first for every reader that goes
# through this launcher: the CLI, `muffin doctor`, acceptance and updates.
if [ -x "$MUFFIN_PREFIX/tool-bin/bwrap" ]; then
  PERSIST="$MUFFIN_PREFIX/tool-bin${PERSIST:+:$PERSIST}"
  PATH="$MUFFIN_PREFIX/tool-bin:$PATH"
  MUFFIN_TOOL_BIN="$MUFFIN_PREFIX/tool-bin"
  export MUFFIN_TOOL_BIN
fi
PATH="$BINDIR:$PATH"
export PATH
if [ -n "$PERSIST" ]; then
  MARK="# muffin (install.sh): the launcher and its bundled Node"
  LINE="export PATH=\"$PERSIST:\$PATH\""
  written=""
  for rc in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.zprofile"; do
    case "$rc" in
      */.profile) ;;
      */.bash_profile) [ -f "$rc" ] || continue ;;
      */.zprofile) [ "$(uname -s)" = Darwin ] || [ "${SHELL:-}" != "" ] && [ "${SHELL##*/}" = zsh ] || continue ;;
    esac
    if [ -f "$rc" ] && grep -qF "$MARK" "$rc" 2>/dev/null; then
      written="$written $rc"
      continue
    fi
    printf '\n%s\n%s\n' "$MARK" "$LINE" >>"$rc" || die "could not write $rc"
    written="$written $rc"
  done
  say ""
  say "PATH: added $PERSIST to$written"
  say "      new login shells find muffin."
fi

# Whether the shell that launched this installer can run what it installed.
# `PATH="$INVOKING_PATH" "$MUFFIN" --version` asks exactly that: the launcher
# by absolute path (so a broken install fails here, not as a PATH mystery),
# under the parent's PATH (so a missing directory fails here, not as the
# owner's first command). Nothing about the gateway: the launcher question is
# orthogonal to supervision, so this runs on every exit path below.
first_command_note() {
  if PATH="$INVOKING_PATH" "$MUFFIN" --version >/dev/null 2>&1; then
    return 0
  fi
  say ""
  say "muffin is installed, but this shell cannot run it yet: its PATH predates the install."
  if [ -n "$PERSIST" ]; then
    say "This shell, copy and paste:"
    say "  export PATH=\"$PERSIST:\$PATH\" && $CMD doctor"
  else
    say "Run it by absolute path to see the error:"
    say "  $MUFFIN doctor"
  fi
  say "Future shells: open a new login shell (the PATH line lives in$written)."
}

# ---------------------------------------------------------------------------
# 6. Setup — `muffin init`.
#
# The API key reaches `init` on **stdin** and nowhere else: never argv (shell
# history, and every `ps` on the box), never an environment variable (/proc,
# and inherited by every child). `cmdInit` refuses both by name, so this is not
# a convention this file could quietly break — ADR-0048.
#
# An existing Home is NEVER re-initialised here, on any input mode: `init`
# used to rebuild the config from defaults, so accepting the prompt on an
# existing Home silently reset models/surfaces/provider routing and more
# (incident 2026-09-18 — `runInit` now preserves, but the installer still has
# no business re-running setup unasked). A deliberate reconfiguration is
# `muffin init` typed by the owner, never this prompt's default.
#
# Three cases, and the one that cannot get a key does not pretend:
#   · setup already exists → skip, continue to upgrade/supervisor/migration
#   · MUFFIN_API_KEY_FILE set → unattended, the file is piped in
#   · a terminal              → `init` runs and asks, hidden
#   · a pipe with no key file → print the one command and stop here
# ---------------------------------------------------------------------------
already_configured() { [ -f "${MUFFIN_HOME:-$HOME/.muffin}/config.json" ]; }

did_init=0
if already_configured; then
  say ""
  say "setup already exists (${MUFFIN_HOME:-$HOME/.muffin}/config.json) — skipping init, continuing to upgrade/supervisor steps"
  say "  to reconfigure deliberately:  $CMD init"
  did_init=1
elif [ -n "${MUFFIN_API_KEY_FILE:-}" ]; then
  [ -f "$MUFFIN_API_KEY_FILE" ] || die "MUFFIN_API_KEY_FILE=$MUFFIN_API_KEY_FILE does not exist."
  say ""
  say "setting up (key read from $MUFFIN_API_KEY_FILE, never from argv or the environment)…"
  "$MUFFIN" init <"$MUFFIN_API_KEY_FILE" || die "muffin init failed"
  did_init=1
elif [ -t 0 ]; then
  printf 'set up muffin now? [Y/n] ' >&2
  read -r reply || reply=""
  case "$reply" in
    '' | y | Y | yes | YES)
      say ""
      "$MUFFIN" init || die "muffin init failed"
      did_init=1
      ;;
  esac
fi

if [ "$did_init" = 0 ]; then
  say ""
  say "next:"
  say "  $CMD init     set up ~/.muffin (it will prompt for your API key)"
  say "  $CMD          open the agent"
  say ""
  say "unattended instead:  MUFFIN_API_KEY_FILE=/path/to/key sh install.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# 7. The supervisor.
#
# `muffin init` on a terminal already offers to *write* the unit; what it
# deliberately does not do is load it into the supervisor (ADR-0035: writing a
# file in your home and starting a service are different acts). At the end of a
# one-command install the answer is unambiguous — the whole promise of the
# command is a running agent — so this step does both, through the single
# command that also runs `loginctl enable-linger` and then *verifies a pid*
# instead of trusting `systemctl`'s exit code.
#
# When there is no user systemd instance to talk to (a container, a
# `sudo`-without-login shell), this cannot succeed and must not claim to: the
# script exits 3 and says which command is left. Three and not one, so a script
# driving this installer can tell "nothing works" from "everything works except
# the part this machine cannot do".
# ---------------------------------------------------------------------------
if [ "${MUFFIN_NO_GATEWAY:-}" = 1 ]; then
  say ""
  say "MUFFIN_NO_GATEWAY=1 — the supervisor was not touched. When you want it:"
  say "  $CMD gateway install --write --start"
  first_command_note
  exit 0
fi

sandbox_report sandbox_direct "$NODE_DIR/bin/node" "$SRC" sudo "$MUFFIN_PREFIX/tool-bin/bwrap"

say ""
say "installing the gateway as a supervised service…"
if "$MUFFIN" gateway install --write --start >/dev/null; then
  say ""
  say "muffin is installed and running:  $CMD"
  first_command_note
  exit 0
fi

say ""
say "! the gateway is NOT active on this machine."
if [ "$(uname -s)" = Linux ]; then
  if ! have systemctl; then
    say "  systemd is not installed here, so there is no user service to load."
  elif ! systemctl --user is-system-running >/dev/null 2>&1; then
    say "  this shell has no user systemd bus (a container, or a \`su -\`/\`sudo -i\`"
    say "  shell): the line above says whether \`loginctl enable-linger $(id -un)\`"
    say "  from root is what is missing. Then re-run, in this same shell:"
  fi
fi
say "    $CMD gateway install --write --start"
say "  the command itself is installed and working: try  $CMD doctor"
first_command_note
exit "$EXIT_GATEWAY_NOT_ACTIVE"
