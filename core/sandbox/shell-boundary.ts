import { assessBubblewrapVersionString, readBubblewrapVersion } from './bubblewrap-version.js';
import { LINUX_ALLOW_ALL_UNIX_SOCKETS } from './executor.js';
import type { SandboxProbe } from './probe.js';

/**
 * The one gate that decides whether `shell_run`/`shell_run_write` exist (#642).
 *
 * A behavioral probe alone is not the claim: it proves a deny/allow split on
 * the probe's own invocation, and it says nothing about the September 2026
 * symlink setup class (CVE-2026-87766), which happens before anything runs.
 * Before this module, `agent/runtime.ts` exposed the shell tools from
 * `executor.status().available` alone while `cli/doctor.ts` graded the patch
 * posture separately — behavioral PASS and "shell enabled" could disagree on
 * the same host. Both now read this function: shell usable ⇔ behavioral pass
 * AND (macOS seatbelt) OR (bubblewrap with a trusted patch posture, upstream
 * ≥ 0.12.0, and AF_UNIX filtering enabled). Unverified ⇒ no tools, no executor
 * for jobs, a doctor warn — never a silent unsandboxed run and never a green
 * line the probe cannot prove.
 */

export type ShellBoundaryPatch = 'trusted' | 'unverified' | 'not-applicable';

export type ShellBoundary = {
  /** Expose the shell lanes (and the job executor) on this host. */
  usable: boolean;
  /** The behavioral verdict, unchanged — for callers that still report it. */
  behavioral: SandboxProbe;
  /**
   * `not-applicable` when no bubblewrap version was consulted (probe failed,
   * or the mechanism is seatbelt — macOS has no CVE-2026-87766 class here and
   * gets no version floor).
   */
  patch: ShellBoundaryPatch;
  /** Why `usable` is what it is — phrased for a capability/doctor line. */
  reason: string;
  remedy: string;
};

/** Shared by runtime capabilityGaps and both doctor lines. */
export const SHELL_BOUNDARY_REMEDY =
  'apply OS security updates and prefer bubblewrap >= 0.12.0 where your distro ships it; ' +
  'until then shell_run/shell_run_write stay disabled — see docs/evidence/shell-containment-2026-09-21.md';

export const LINUX_AF_UNIX_REMEDY =
  'Linux execution stays disabled while Muffin permits all AF_UNIX sockets; use macOS Seatbelt or a Muffin build with verified Linux socket filtering — see docs/architecture/SECURITY.md, "Filesystem, process and worker containment"';

export function assessShellBoundary(
  probe: SandboxProbe,
  readVersion: () => string | null = readBubblewrapVersion,
): ShellBoundary {
  if (!probe.available) {
    return {
      usable: false,
      behavioral: probe,
      patch: 'not-applicable',
      reason: `${probe.mechanism} non disponibile (${probe.reason}): ${probe.detail}`,
      remedy: probe.remedy,
    };
  }
  if (probe.mechanism === 'seatbelt') {
    return {
      usable: true,
      behavioral: probe,
      patch: 'not-applicable',
      reason: '',
      remedy: '',
    };
  }
  const assessment = assessBubblewrapVersionString(readVersion());
  if (LINUX_ALLOW_ALL_UNIX_SOCKETS) {
    return {
      usable: false,
      behavioral: probe,
      patch: assessment.status === 'patched' ? 'trusted' : 'unverified',
      reason: [
        'Linux AF_UNIX sockets are unfiltered because allowAllUnixSockets is enabled',
        ...(assessment.status === 'patched' ? [] : [assessment.detail]),
      ].join('; '),
      remedy: [
        LINUX_AF_UNIX_REMEDY,
        ...(assessment.status === 'patched' ? [] : [SHELL_BOUNDARY_REMEDY]),
      ].join(' '),
    };
  }
  if (assessment.status === 'patched') {
    return {
      usable: true,
      behavioral: probe,
      patch: 'trusted',
      reason: '',
      remedy: '',
    };
  }
  return {
    usable: false,
    behavioral: probe,
    patch: 'unverified',
    reason: assessment.detail,
    remedy: SHELL_BOUNDARY_REMEDY,
  };
}
