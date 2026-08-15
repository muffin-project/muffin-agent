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
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'true'], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: 'pipe',
    });
    return { available: true, mechanism: 'bubblewrap' };
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
    return {
      available: false,
      mechanism: 'bubblewrap',
      reason: 'userns_denied',
      detail,
      remedy:
        'unprivileged user namespaces are restricted (Ubuntu 24.04+ default). ' +
        'Add an AppArmor profile for bwrap granting `userns` and reload it with apparmor_parser -r; ' +
        'lowering kernel.apparmor_restrict_unprivileged_userns works too but disarms the protection host-wide',
    };
  }
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
