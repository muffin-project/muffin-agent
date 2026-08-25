import { execFileSync } from 'node:child_process';
import { platform, userInfo } from 'node:os';

/**
 * Does the sandbox actually contain anything?
 *
 * This module exists because of a real incident, not a hypothesis. On the
 * production host of the previous Muffin, `SANDBOX_ENABLED` was true for two
 * months, `bwrap` was installed, and the sandbox contained nothing: Ubuntu
 * 24.04 ships `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks
 * exactly the user namespace bubblewrap needs. A check that looked for the
 * binary in PATH would have answered "fine" every single day.
 *
 * So: we execute a real containment and see whether it holds. And we execute it
 * as the user that will run the runtime — root bypasses the restriction and
 * would report a false positive.
 */

export type SandboxProbe =
  | { available: true; mechanism: 'seatbelt' | 'bubblewrap' }
  | {
      available: false;
      mechanism: 'seatbelt' | 'bubblewrap' | 'none';
      reason: 'binary_missing' | 'userns_denied' | 'unsupported_platform' | 'probe_failed';
      detail: string;
      remedy: string;
    };

const PROBE_TIMEOUT_MS = 5_000;

export function probeSandbox(): SandboxProbe {
  const os = platform();
  if (os === 'darwin') return probeSeatbelt();
  if (os === 'linux') return probeBubblewrap();
  return {
    available: false,
    mechanism: 'none',
    reason: 'unsupported_platform',
    detail: `no OS-level sandbox on ${os}`,
    remedy: 'run on macOS or Linux; execution capabilities degrade to ask',
  };
}

/**
 * Linux caps a Unix-domain socket path at ~108 bytes (`sun_path`). The Linux
 * sandbox bridges its egress proxy through exactly such a socket inside
 * TMPDIR (`socat`; upstream bug #213, cited in ADR-0026): once the resolved
 * TMPDIR is too long, `SandboxManager.initialize` fails with a generic
 * "Sandbox failed to initialize" that never says TMPDIR is the reason. 108 is
 * the figure #213 itself reports the failure at — kept exact, not padded with
 * a safety margin invented for this check.
 */
export const TMPDIR_SUN_PATH_LIMIT = 108;

/**
 * Would this TMPDIR break the Linux sandbox's socket bridge? Pure function —
 * no OS calls, no execFileSync — so `doctor` (or anything else that wants to
 * warn about it, e.g. `muffin init`) can test it without being on Linux or
 * shelling out to bwrap. Linux-only concern: Seatbelt does not proxy through
 * a Unix socket in TMPDIR, so a long TMPDIR is harmless on macOS.
 *
 * Exported from here rather than duplicated wherever it is needed, per the
 * same reasoning `probeSandbox` already follows: the probe is the source of
 * truth on sandbox posture, not a README or a second hand-rolled check.
 */
export function tmpdirBreaksSandboxSockets(os: NodeJS.Platform, dir: string): boolean {
  return os === 'linux' && dir.length > TMPDIR_SUN_PATH_LIMIT;
}

/**
 * A `(deny default)` profile, and then a read that must fail.
 *
 * The first version of this ran `(allow default)` and reported "a real
 * containment ran and held" if the process started. It proved that
 * `sandbox-exec` exists — which is the question nobody asked, and precisely the
 * mistake the Linux branch was written to avoid. The Linux branch got it right
 * and the branch that runs on the developer's own machine did not.
 */
const DENY_ALL = '(version 1)(deny default)(allow process-fork)(allow sysctl-read)';
/**
 * The positive control. Not a containment test — it is the opposite, and that
 * is the point: it is the run that must *succeed*, so that a failure of the
 * deny profile can be read as containment rather than as a broken tool.
 */
const ALLOW_ALL = '(version 1)(allow default)';

function probeSeatbelt(): SandboxProbe {
  // A file that certainly exists and that a contained process must not read.
  // `/etc/hosts` is world-readable, so success here means the sandbox is off.
  const forbidden = '/etc/hosts';
  let contained: boolean;
  let denial = '';
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', DENY_ALL, '/bin/cat', forbidden], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: 'pipe',
    });
    contained = false; // the read succeeded: nothing was contained
  } catch (error) {
    const detail = message(error);
    if (/ENOENT|not found/i.test(detail)) {
      return {
        available: false,
        mechanism: 'seatbelt',
        reason: 'binary_missing',
        detail,
        remedy: 'sandbox-exec is part of macOS; if it is missing the platform is not as expected',
      };
    }
    // The expected outcome: the profile refused the read, so the process died.
    denial = detail;
    contained = true;
  }

  if (!contained) {
    return {
      available: false,
      mechanism: 'seatbelt',
      reason: 'probe_failed',
      detail: `a deny-all profile still let a process read ${forbidden}: the sandbox is not containing anything`,
      remedy: 'check whether sandbox-exec is being intercepted or the profile is being ignored',
    };
  }

  // A non-zero exit is not yet evidence. Measured 2026-08-15 on macOS 15: a
  // profile sandbox-exec refuses to parse exits 65 with `unbound variable: …`,
  // which matches neither ENOENT nor "not found" and lands in the branch above
  // as "the profile refused the read". So the day a macOS release drops one of
  // the three primitives in DENY_ALL, this function would report the sandbox
  // available on a host where nothing was ever contained — this module's own
  // incident, in the branch that runs on the developer's machine.
  //
  // The control: the same binary, a profile that must succeed. Failure here
  // means sandbox-exec is broken, not that it contained us.
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', ALLOW_ALL, '/usr/bin/true'], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: 'pipe',
    });
  } catch (error) {
    return {
      available: false,
      mechanism: 'seatbelt',
      reason: 'probe_failed',
      detail:
        `sandbox-exec failed on an allow-all profile too (${message(error)}), so its failure on ` +
        `the deny-all profile (${denial}) is not evidence of containment`,
      remedy: 'sandbox-exec itself is failing — check the profile syntax against this macOS release',
    };
  }

  return { available: true, mechanism: 'seatbelt' };
}

/**
 * A bind that must deny one read, and then the same read with the deny lifted.
 *
 * Until this slice, this branch ran one bwrap invocation —
 * `--unshare-all ... true` — and reported "available" the moment that process
 * exited zero. That proves a namespace was created, which is the presence
 * question; it is not the containment question, because `--ro-bind / /` with
 * no deny at all *also* exits zero. The seatbelt branch above already carries
 * this lesson in its own comment and its own incident; this branch shipped
 * without it, on the platform that runs the production host — the audit that
 * found this (2026-08-25) is this module's second instance of its own defect.
 *
 * The fix is the same two-legged shape. `--tmpfs /etc` mounted after
 * `--ro-bind / /` shadows the real `/etc` with a fresh, empty filesystem —
 * bwrap applies mount operations in argument order, so anything bound earlier
 * at that path stops being reachable — and then the probe asks for
 * `/etc/hosts`. If containment holds, that path does not exist inside the
 * sandbox at all. `/etc/hosts` is world-readable outside any sandbox (the
 * same choice the seatbelt branch makes, for the same reason: success there
 * means nothing was contained).
 */
const DENY_ARGV = ['--ro-bind', '/', '/', '--tmpfs', '/etc', '--unshare-all', '--die-with-parent', 'cat', '/etc/hosts'];
/**
 * The positive control: the identical bind and the identical read, minus the
 * tmpfs shadow over /etc. It must succeed, so that a failure of `DENY_ARGV`
 * reads as containment and not as a bwrap invocation broken for an unrelated
 * reason — a mount error, a seccomp failure, a kernel that dropped a flag —
 * which is exactly the gap the single-command version of this check could not
 * tell apart from a deny holding.
 */
const ALLOW_ARGV = ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'cat', '/etc/hosts'];

const APPARMOR_REMEDY =
  'unprivileged user namespaces are restricted (Ubuntu 24.04+ default). ' +
  'Add an AppArmor profile for bwrap granting `userns` and reload it with apparmor_parser -r; ' +
  'lowering kernel.apparmor_restrict_unprivileged_userns works too but disarms the protection host-wide';

/**
 * Ubuntu 24.04's `kernel.apparmor_restrict_unprivileged_userns=1` (ADR-0018's
 * field note) is the one bwrap failure with both a known cause and a known
 * fix. Matched by message, not assumed from "any non-ENOENT failure" — that
 * blanket assumption was this function's second defect: a mount error, a
 * seccomp failure, or #213's overlong-TMPDIR socket failure (see
 * `tmpdirBreaksSandboxSockets` below) would all have sent the owner chasing
 * an AppArmor profile that was never the problem.
 *
 * `RTM_NEWADDR` is the verbatim signature measured twice independently — the
 * previous Muffin's production VPS (ADR-0018, field note 2026-08-04) and this
 * repo's own CI runner before its AppArmor profile step existed (ci.yml) —
 * both Ubuntu 24.04, both the identical restriction. The second pattern
 * catches bwrap's more direct failure mode: namespace creation refused before
 * bwrap gets far enough to attempt the loopback setup that produces the first
 * message.
 */
function isUsernsDenied(detail: string): boolean {
  if (/RTM_NEWADDR/i.test(detail)) return true;
  if (/operation not permitted/i.test(detail) && /(user namespace|userns|creating new namespace)/i.test(detail)) {
    return true;
  }
  return false;
}

function probeBubblewrap(): SandboxProbe {
  if (userInfo().uid === 0) {
    // Not a hard failure — but the answer would be meaningless, and a
    // meaningless green is what caused the incident this module exists for.
    return {
      available: false,
      mechanism: 'bubblewrap',
      reason: 'probe_failed',
      detail: 'probe ran as root: root bypasses the userns restriction, so the result would be a false positive',
      remedy: 'run this check as the service user that will run the runtime',
    };
  }

  let contained: boolean;
  let denial = '';
  try {
    execFileSync('bwrap', DENY_ARGV, { timeout: PROBE_TIMEOUT_MS, stdio: 'pipe' });
    contained = false; // the read succeeded: nothing was contained
  } catch (error) {
    const detail = message(error);
    if (/ENOENT|not found/i.test(detail)) {
      return {
        available: false,
        mechanism: 'bubblewrap',
        reason: 'binary_missing',
        detail,
        remedy: 'install bubblewrap and socat',
      };
    }
    if (isUsernsDenied(detail)) {
      return { available: false, mechanism: 'bubblewrap', reason: 'userns_denied', detail, remedy: APPARMOR_REMEDY };
    }
    // The expected outcome: /etc was shadowed, so cat found nothing to read.
    denial = detail;
    contained = true;
  }

  if (!contained) {
    return {
      available: false,
      mechanism: 'bubblewrap',
      reason: 'probe_failed',
      detail: 'a deny-configured bwrap still let a process read /etc/hosts: the sandbox is not containing anything',
      remedy: 'check whether /etc is actually being shadowed — bwrap may lack --tmpfs support, or be intercepted',
    };
  }

  // A non-zero exit is not yet evidence (see DENY_ARGV/ALLOW_ARGV above). The
  // control: the same read, sandboxed but without the deny, must succeed.
  try {
    execFileSync('bwrap', ALLOW_ARGV, { timeout: PROBE_TIMEOUT_MS, stdio: 'pipe' });
  } catch (error) {
    const detail = message(error);
    if (isUsernsDenied(detail)) {
      return { available: false, mechanism: 'bubblewrap', reason: 'userns_denied', detail, remedy: APPARMOR_REMEDY };
    }
    return {
      available: false,
      mechanism: 'bubblewrap',
      reason: 'probe_failed',
      detail:
        `bwrap failed on an unrestricted read too (${detail}), so its failure on ` +
        `the deny-configured read (${denial}) is not evidence of containment`,
      remedy: 'bwrap itself is failing outside any deny — check the invocation against this kernel/bwrap version',
    };
  }

  return { available: true, mechanism: 'bubblewrap' };
}

function message(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    if (stderr) return stderr;
    if (e.message) return e.message;
  }
  return String(error);
}
