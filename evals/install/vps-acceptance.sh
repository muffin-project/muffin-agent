#!/usr/bin/env bash
# VPS ACCEPTANCE — disposable Ubuntu 24.04 VM receipt for a Muffin Home.
#
# This script is NOT CI: it reboots the machine, stops/restores the database
# and runs update/rollback. It is deliberately disposable-VM-only:
#
#   * refuses without ALLOW_VPS_ACCEPT=1 in the environment;
#   * refuses a pre-existing ~/.muffin unless ALLOW_EXISTING_HOME=1
#     (a fresh disposable VM has none; the --post-reboot re-run sets it);
#   * runs in TWO phases around a real reboot:
#         bash evals/install/vps-acceptance.sh              # pre-reboot, ends with `sudo reboot`
#         bash evals/install/vps-acceptance.sh --post-reboot # after the reboot, prints the receipt
#
# State (including the pre-reboot partial receipt) lives in
# /var/tmp/muffin-vps-accept/ — NOT /tmp, which may be cleared on reboot.
#
# Coverage maps to the VPS acceptance matrix (V1..V17):
#   install artefacts, dedicated non-root user, linger, crash restart,
#   watchdog/hung-alive, sandbox+AppArmor, backup, restore, update, rollback,
#   no Muffin TCP listener, disk-space diagnostic, reboot + logout survival,
#   credential availability after reboot.
#
# Logout survival is proven by the reboot itself (a boot has zero sessions)
# plus the linger assertion — closing our own SSH session mid-script would
# kill the script, so no theatre there.
#
# Needs on the VM: muffin installed for $USER, passwordless sudo for
# loginctl/reboot/ss, iproute2 (ss), systemd user manager (i.e. a real VM or
# real server — never a container).
set -uo pipefail

POSTBOOT=0
[ "${1:-}" = "--post-reboot" ] && POSTBOOT=1
STATE=/var/tmp/muffin-vps-accept
RECEIPT=$STATE/receipt.txt
FAILURES=0
WARNS=0

step() { printf '\n=== %s ===\n' "$1"; }
rec() { # rec <PASS|FAIL|SKIP> <id> <text>  — to stdout AND the receipt file
  # Always returns 0: callers use `check && rec PASS ... || rec FAIL ...` and
  # a non-zero return from the PASS branch would fire the FAIL branch too.
  printf '%s %s %s\n' "$1" "$2" "$3" | tee -a "$RECEIPT"
  [ "$1" = FAIL ] && FAILURES=$((FAILURES + 1))
  [ "$1" = SKIP ] && WARNS=$((WARNS + 1))
  return 0
}
finish() {
  printf '\n============================================================\n'
  printf 'vps-acceptance: %s\n' "$(cat "$STATE/verdict" 2>/dev/null || echo INCOMPLETE)"
  printf '============================================================\n'
  [ "$FAILURES" = 0 ] && exit 0
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || { rec FAIL "$2" "missing binary: $1"; return 1; }; }

HOME_DIR=${MUFFIN_HOME:-$HOME/.muffin}
UNIT_NAME=muffin-gateway.service

# --------------------------------------------------------------------------
# Safety gates (both phases).
# --------------------------------------------------------------------------
if [ "${ALLOW_VPS_ACCEPT:-}" != 1 ]; then
  echo "refusing: this script reboots, restores and updates. Disposable VM only." >&2
  echo "re-run with ALLOW_VPS_ACCEPT=1 (and see the header before you do)." >&2
  exit 2
fi
if [ "$POSTBOOT" = 0 ]; then
  : >"$RECEIPT" 2>/dev/null || { mkdir -p "$STATE" && : >"$RECEIPT"; }
  echo "INCOMPLETE (pre-reboot)" >"$STATE/verdict"
  if [ -d "$HOME_DIR" ] && [ "${ALLOW_EXISTING_HOME:-}" != 1 ]; then
    echo "refusing: $HOME_DIR already exists (not a fresh disposable VM?)." >&2
    echo "Re-run with ALLOW_EXISTING_HOME=1 if you mean it." >&2
    exit 2
  fi
else
  [ -d "$STATE" ] || { echo "no pre-reboot state in $STATE — run without flags first." >&2; exit 2; }
fi

# --------------------------------------------------------------------------
# POST-REBOOT phase: V6 reboot, V7 logout, V17 credentials. Then the receipt.
# --------------------------------------------------------------------------
if [ "$POSTBOOT" = 1 ]; then
  step "V6 reboot survival"
  if [ "$(cat /proc/sys/kernel/random/boot_id)" != "$(cat "$STATE/boot-id" 2>/dev/null)" ]; then
    rec PASS V6 "boot id changed — this IS a rebooted machine"
  else
    rec FAIL V6 "boot id unchanged — the reboot never happened, nothing below proves anything"
  fi
  step "V7 logout survival (linger + zero-session boot)"
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ]; then
    rec PASS V7-linger "linger enabled for $USER"
  else
    rec FAIL V7-linger "linger NOT enabled for $USER — services die at logout"
  fi
  if systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; then
    rec PASS V7-gateway "gateway active after reboot with $(loginctl list-sessions --no-legend 2>/dev/null | wc -l) sessions (a boot starts with zero)"
  else
    rec FAIL V7-gateway "gateway NOT active after reboot"
  fi
  step "V17 credential availability after reboot"
  if muffin gateway status >/dev/null 2>&1; then
    rec PASS V17-live "gateway answers status after reboot (whatever backend is configured resolved)"
  else
    rec FAIL V17-live "gateway does not answer after reboot"
  fi
  if [ -d "$HOME_DIR/secrets" ] || [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/muffin/secrets" ]; then
    rec PASS V17-backend "file secret backend present after reboot (interim backend — see D2; permanent backend pending)"
  else
    rec FAIL V17-backend "no secret backend directory found after reboot"
  fi
  step "doctor after reboot"
  if muffin doctor --json >"$STATE/doctor-post.json" 2>"$STATE/doctor-post.err"; then
    REDS=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.checks.filter(c=>c.level==="fail").length)' "$STATE/doctor-post.json" 2>/dev/null || echo "?")
    [ "$REDS" = 0 ] && rec PASS V1-doctor-post "doctor: 0 red after reboot" || rec FAIL V1-doctor-post "doctor: $REDS red after reboot"
  else
    # doctor exits non-zero on warnings too; the JSON verdict is what counts.
    if [ -s "$STATE/doctor-post.json" ]; then
      REDS=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.checks.filter(c=>c.level==="fail").length)' "$STATE/doctor-post.json" 2>/dev/null || echo "?")
      [ "$REDS" = 0 ] && rec PASS V1-doctor-post "doctor: 0 red after reboot (warnings only)" || rec FAIL V1-doctor-post "doctor: $REDS red after reboot"
    else
      rec FAIL V1-doctor-post "doctor produced no report after reboot"
    fi
  fi
  FAILS=$(grep -c '^FAIL' "$RECEIPT" || true)
  [ "$FAILS" = 0 ] && echo "PASS" >"$STATE/verdict" || echo "FAIL ($FAILS check(s))" >"$STATE/verdict"
  step "RECEIPT (pre-reboot + post-reboot)"
  cat "$RECEIPT"
  finish
fi

# --------------------------------------------------------------------------
# PRE-REBOOT phase.
# --------------------------------------------------------------------------
mkdir -p "$STATE"
cat /proc/sys/kernel/random/boot_id >"$STATE/boot-id"

step "V3 dedicated non-root user"
if [ "$(id -u)" = 0 ]; then
  rec FAIL V3-user "running as root — the Home must run as a dedicated unprivileged user"
else
  rec PASS V3-user "running as $(id -un) (uid $(id -u)), not root"
fi
HPERM=$(stat -c %a "$HOME" 2>/dev/null || echo "?")
case "$HPERM" in
  750 | 700 | 755) rec PASS V3-homeperm "home perms $HPERM" ;;
  *) rec FAIL V3-homeperm "home perms $HPERM (world-readable?)" ;;
esac

step "V1 install artefacts"
need muffin V1-cmd || { rec FAIL V1-skip "muffin not installed — install first (documented one-command path), then re-run"; finish; }
rec PASS V1-cmd "muffin at $(command -v muffin): $(muffin --version 2>/dev/null || echo 'version unknown')"
LAUNCHER=$(readlink -f "$(command -v muffin)" 2>/dev/null || echo "")
# Launcher shape: <checkout>[/.releases/<sha>]/dist/cli/main.js — three levels
# above the file is the checkout (a two-level strip lands in dist/ and every
# git check fails for the wrong reason; measured on the first VM run).
ROOT=$(dirname "$(dirname "$(dirname "$LAUNCHER")")")
[ -e "$ROOT/.git" ] && rec PASS V1-src "source checkout with .git at $ROOT (update/rollback need it)" || rec FAIL V1-src "no git checkout above launcher ($LAUNCHER)"
[ -f "$HOME_DIR/config.json" ] && rec PASS V1-home "data home configured ($HOME_DIR/config.json)" || rec FAIL V1-home "no $HOME_DIR/config.json"
[ -f "$HOME_DIR/muffin.db" ] && rec PASS V1-db "database present" || rec FAIL V1-db "no $HOME_DIR/muffin.db"
UNIT_PATH="$HOME/.config/systemd/user/$UNIT_NAME"
[ -f "$UNIT_PATH" ] && rec PASS V1-unit "user unit present ($UNIT_PATH)" || rec FAIL V1-unit "no user unit at $UNIT_PATH"
if command -v systemd-analyze >/dev/null 2>&1 && [ -f "$UNIT_PATH" ]; then
  systemd-analyze verify "$UNIT_PATH" >/dev/null 2>&1 && rec PASS V1-verify "systemd-analyze verify accepts the unit" || rec FAIL V1-verify "systemd-analyze rejects the unit"
fi

step "V2 node provenance"
if command -v node >/dev/null 2>&1; then
  rec PASS V2-node "node $(node --version) at $(command -v node)"
  case "$(command -v node)" in
    "$HOME"/.local/share/muffin/node/*) rec PASS V2-origin "bundled Node under the install prefix (fresh-install provenance: see install log / ubuntu.sh gate)" ;;
    *) rec SKIP V2-origin "system Node in use — provenance outside this install (acceptable, recorded)" ;;
  esac
else
  rec FAIL V2-node "no node on PATH (sourcing ~/.profile first?)"
fi

step "V4 user service + linger"
[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ] && rec PASS V4-linger "linger enabled" || rec FAIL V4-linger "linger NOT enabled (unit dies at logout)"
systemctl --user is-enabled "$UNIT_NAME" >/dev/null 2>&1 && rec PASS V4-enabled "unit enabled (starts at boot with linger)" || rec FAIL V4-enabled "unit NOT enabled"
systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1 && rec PASS V4-active "unit active now" || rec FAIL V4-active "unit NOT active now"

step "V1 doctor (pre-reboot)"
muffin doctor --json >"$STATE/doctor-pre.json" 2>"$STATE/doctor-pre.err" || true
if [ -s "$STATE/doctor-pre.json" ]; then
  REDS=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.checks.filter(c=>c.level==="fail").length)' "$STATE/doctor-pre.json" 2>/dev/null || echo "?")
  [ "$REDS" = 0 ] && rec PASS V1-doctor-pre "doctor: 0 red" || rec FAIL V1-doctor-pre "doctor: $REDS red (see $STATE/doctor-pre.json)"
else
  rec FAIL V1-doctor-pre "doctor produced no report"
fi

step "V5 restart after process crash (kill -9)"
PID0=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || echo 0)
if [ -n "$PID0" ] && [ "$PID0" != 0 ]; then
  kill -9 "$PID0" 2>/dev/null || true
  PID1=""
  for _ in $(seq 1 24); do
    sleep 5
    PID1=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || echo 0)
    { [ -n "$PID1" ] && [ "$PID1" != 0 ] && [ "$PID1" != "$PID0" ]; } && break
  done
  if [ -n "$PID1" ] && [ "$PID1" != 0 ] && [ "$PID1" != "$PID0" ]; then
    rec PASS V5 "pid $PID0 -> $PID1 after SIGKILL (Restart=always)"
  else
    rec FAIL V5 "no new pid within 120s of SIGKILL (last: ${PID1:-none})"
  fi
else
  rec FAIL V5 "no MainPID to kill (unit not running?)"
fi

step "V8 watchdog / hung-alive process"
WD_USEC=$(systemctl --user show -p WatchdogUSec --value "$UNIT_NAME" 2>/dev/null || echo 0)
if [ -n "$WD_USEC" ] && [ "$WD_USEC" != 0 ]; then
  rec PASS V8-present "WatchdogUSec=$WD_USEC (Type=notify watchdog configured)"
  PIDW=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || echo 0)
  kill -STOP "$PIDW" 2>/dev/null && STOPPED=1 || STOPPED=0
  if [ "$STOPPED" = 1 ]; then
    PIDW2=""
    for _ in $(seq 1 30); do
      sleep 5
      PIDW2=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || echo 0)
      { [ -n "$PIDW2" ] && [ "$PIDW2" != 0 ] && [ "$PIDW2" != "$PIDW" ]; } && break
    done
    kill -CONT "$PIDW" 2>/dev/null || true
    if [ -n "$PIDW2" ] && [ "$PIDW2" != 0 ] && [ "$PIDW2" != "$PIDW" ]; then
      rec PASS V8-restart "wedged pid $PIDW replaced by $PIDW2 (watchdog saw the hang)"
    else
      rec FAIL V8-restart "wedged pid $PIDW NOT replaced within 150s — a hung-alive gateway stays hung"
    fi
  else
    rec FAIL V8-restart "could not STOP the gateway pid for the wedge test"
  fi
else
  rec SKIP V8-absent "no WatchdogUSec on this unit (Type=exec fallback: crash restart only, hung-alive NOT covered — recorded, not hidden)"
fi

step "V9 sandbox / bwrap / AppArmor"
command -v bwrap >/dev/null 2>&1 && rec PASS V9-bwrap "bwrap present ($(bwrap --version 2>&1 | head -1))" || rec FAIL V9-bwrap "bwrap missing — no shell containment (every command asks first at best)"
if [ -r /sys/kernel/security/apparmor/profiles ]; then
  grep -qi bwrap /sys/kernel/security/apparmor/profiles 2>/dev/null && rec PASS V9-apparmor "AppArmor carries a bwrap profile (unprivileged userns allowed)" || rec SKIP V9-apparmor "no bwrap line in AppArmor profiles — userns may be denied (see install.sh note)"
else
  rec SKIP V9-apparmor "AppArmor profiles not readable here — userns status unknown"
fi

step "V10+V11 backup (online, validated)"
if muffin backup --dir "$STATE/backups" >"$STATE/backup.log" 2>&1; then
  BKFILE=$(sed -n 's/^backup: \([^ ]*\).*/\1/p' "$STATE/backup.log" | head -1)
  if [ -n "$BKFILE" ] && [ -f "$BKFILE" ]; then
    grep -q 'quick_check ok' "$STATE/backup.log" && rec PASS V10 "backup $BKFILE (quick_check ok)" || rec FAIL V10 "backup file present but NOT quick_check-validated"
    rec PASS V11 "backup artefact recorded: $BKFILE"
    echo "$BKFILE" >"$STATE/backup-file"
  else
    rec FAIL V10 "backup command succeeded but no file found (see $STATE/backup.log)"
  fi
else
  rec FAIL V10 "muffin backup failed (see $STATE/backup.log)"
fi

step "V12 restore (destructive BY DESIGN — disposable VM only)"
if [ -f "$STATE/backup-file" ]; then
  muffin gateway stop >/dev/null 2>&1 || true
  sleep 3
  if muffin restore "$(cat "$STATE/backup-file")" --yes >"$STATE/restore.log" 2>&1; then
    grep -q 'messo da parte' "$STATE/restore.log" && rec PASS V12-aside "restore set the live db aside before replacing" || rec FAIL V12-aside "restore did not report setting the live db aside"
    rec PASS V12-restore "restore applied: $(head -1 "$STATE/restore.log")"
  else
    rec FAIL V12-restore "muffin restore failed (see $STATE/restore.log)"
  fi
  muffin gateway start >/dev/null 2>&1 || systemctl --user start "$UNIT_NAME" >/dev/null 2>&1 || true
  for _ in $(seq 1 12); do muffin gateway status >/dev/null 2>&1 && break; sleep 5; done
  muffin gateway status >/dev/null 2>&1 && rec PASS V12-live "gateway live again after restore" || rec FAIL V12-live "gateway NOT live after restore"
else
  rec FAIL V12-restore "no backup file from V11 — cannot prove restore"
fi

step "V13+V14 update and rollback"
BEFORE=$(readlink "$(command -v muffin)" 2>/dev/null || echo "")
if muffin update --yes >"$STATE/update.log" 2>&1; then
  AFTER=$(readlink "$(command -v muffin)" 2>/dev/null || echo "")
  if [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; then
    rec PASS V13 "update moved the launcher ($BEFORE -> $AFTER)"
    if muffin update --rollback --yes >"$STATE/rollback.log" 2>&1; then
      ROLLED=$(readlink "$(command -v muffin)" 2>/dev/null || echo "")
      [ "$ROLLED" = "$BEFORE" ] && rec PASS V14 "rollback returned the launcher ($ROLLED)" || rec FAIL V14 "rollback landed at $ROLLED, expected $BEFORE"
    else
      rec FAIL V14 "rollback command failed (see $STATE/rollback.log)"
    fi
  else
    rec SKIP V13-noop "update is a no-op (already at tip) — forward path not exercised this run"
    rec SKIP V14-noop "no update happened, nothing to roll back (covered by install CI on every PR)"
  fi
  muffin --help >/dev/null 2>&1 && rec PASS V13-runs "post-update build answers" || rec FAIL V13-runs "post-update build does not run"
else
  rec FAIL V13 "muffin update failed (see $STATE/update.log)"
fi

step "V16 no inbound Muffin TCP listener"
if command -v ss >/dev/null 2>&1; then
  GWPID=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || echo 0)
  if ss -ltnp 2>/dev/null | grep -q "pid=$GWPID"; then
    rec FAIL V16 "a TCP listener belongs to the gateway pid $GWPID (control plane must be Unix-socket-only)"
    ss -ltnp 2>/dev/null | grep "pid=$GWPID" | sed 's/^/  | /'
  else
    rec PASS V16 "no TCP listener for gateway pid ${GWPID:-unknown} (ss -ltnp clean)"
  fi
  [ -S "$HOME_DIR/gateway.sock" ] && rec PASS V16-sock "control plane present as Unix socket ($HOME_DIR/gateway.sock)" || rec SKIP V16-sock "no gateway.sock found (naming may differ — recorded)"
else
  rec FAIL V16 "ss missing — cannot prove no listener (install iproute2)"
fi

step "V15 disk-space diagnostic"
DF=$(df -h "$HOME" | tail -1)
DUPCT=$(echo "$DF" | awk '{print $5}')
DUMUFFIN=$(du -sh "$HOME_DIR" 2>/dev/null | cut -f1 || echo "?")
DUBK=$(du -sh "$HOME_DIR/backups" 2>/dev/null | cut -f1 || echo "none")
JDU=$(journalctl --disk-usage 2>/dev/null || echo "journal size unknown")
{
  echo "disk $HOME: $DF"
  echo "home size: $DUMUFFIN (backups: $DUBK)"
  echo "journal: $JDU"
} | tee "$STATE/disk.txt" | sed 's/^/  | /'
CT=$(echo "$DUPCT" | tr -d '%')
if [ -n "$CT" ] && [ "$CT" -ge 90 ] 2>/dev/null; then
  rec FAIL V15 "disk $DUPCT used (>=90%)"
elif [ -n "$CT" ] && [ "$CT" -ge 80 ] 2>/dev/null; then
  rec SKIP V15 "disk $DUPCT used (>=80% — recorded, housekeeping advised)"
else
  rec PASS V15 "disk $DUPCT used; home $DUMUFFIN"
fi
[ "$DUBK" != "none" ] || rec SKIP V15-nobackups "no backups directory yet (retention policy applies once backups exist)"

step "pre-reboot done — receipt so far"
cat "$RECEIPT"
printf '\nPre-reboot checks recorded. Now: copy THIS command, the machine WILL reboot:\n\n'
printf '  ALLOW_VPS_ACCEPT=1 ALLOW_EXISTING_HOME=1 bash %s --post-reboot\n\n' "$0"
printf 'Rebooting in 10s (Ctrl-C to abort)...\n'
sleep 10
sudo -n reboot || { rec FAIL V6-rebootcmd "sudo reboot refused (passwordless sudo required)"; finish; }
