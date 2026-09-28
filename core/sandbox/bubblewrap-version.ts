import { execFileSync } from 'node:child_process';

/**
 * Bubblewrap setup-time patch posture for CVE-2026-87766 (#642).
 *
 * The behavioral probe (`probe.ts`) and the real-invocation self-test
 * (`executor.ts`) prove a deny/allow split holds. They do not exercise the
 * September 2026 symlink setup class: during sandbox setup the host is
 * mounted at `/oldroot` and a symlink in an attacker-influenced parent can
 * redirect a file `bwrap` creates in `/newroot` onto the host — before
 * anything runs, so no runtime test observes it.
 *
 * Upstream fixed the class in 0.12.0 (openat2 `RESOLVE_IN_ROOT`, GHSA-pxhw-h44j-8pfx).
 * Ubuntu's backport for older releases (0.9.0-1ubuntu0.2 via USN-8779-1) was
 * REVERTED (0.9.0-1ubuntu0.3 via USN-8779-2, Flatpak regression), and current
 * Ubuntu releases report the CVE as Vulnerable again. Two consequences:
 *
 * - a gate on `>= 0.9.0-1ubuntu0.2` is obsolete and backwards: the reverted
 *   0.9.0-1ubuntu0.3 compares greater and is still vulnerable. It is not
 *   implemented here, and the test pins that absence.
 * - `bwrap --version` prints the upstream triple only, never the distro
 *   revision, so no `--version` output below upstream 0.12.0 can prove the
 *   backport is present.
 *
 * The assessment is therefore fail-closed and binary: `patched` only for a
 * readable upstream triple >= 0.12.0, `unverified` for everything else —
 * including unreadable. Whether Muffin's exact `bwrap` invocation (workspace
 * `--bind`, host mount-point stubs for absent deny paths) is reachable
 * through this class still needs a Linux proof with attacker-controlled
 * symlinks in the write scope; until then `unverified` is a gate, not a
 * warning: `core/sandbox/shell-boundary.ts` turns it into "no shell tools,
 * doctor says disabled", the same verdict runtime and doctor both read.
 * See `docs/evidence/shell-containment-2026-09-21.md`.
 */

export type BubblewrapAssessment =
  | { status: 'patched'; detail: string }
  | { status: 'unverified'; detail: string };

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

/** Upstream release carrying the GHSA-pxhw-h44j-8pfx fix. */
const PATCHED_MAJOR = 0;
const PATCHED_MINOR = 12;
const PATCHED_PATCH = 0;

export function assessBubblewrapVersionString(raw: string | null): BubblewrapAssessment {
  if (raw === null) {
    return {
      status: 'unverified',
      detail:
        'bubblewrap version unreadable: setup-time patch level for CVE-2026-87766 is unverified ' +
        '(fixed upstream in 0.12.0; no Ubuntu revision below it counts — USN-8779-2 reverted the backport)',
    };
  }
  const m = VERSION_RE.exec(raw);
  if (m === null) {
    return {
      status: 'unverified',
      detail:
        `unparseable bubblewrap version (${JSON.stringify(raw.trim().slice(0, 40))}): setup-time patch level ` +
        'for CVE-2026-87766 is unverified (fixed upstream in 0.12.0; no Ubuntu revision below it counts — USN-8779-2 reverted the backport)',
    };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const patched =
    major > PATCHED_MAJOR ||
    (major === PATCHED_MAJOR && minor > PATCHED_MINOR) ||
    (major === PATCHED_MAJOR && minor === PATCHED_MINOR && patch >= PATCHED_PATCH);
  if (patched) {
    return {
      status: 'patched',
      detail: `bubblewrap ${major}.${minor}.${patch} carries the upstream CVE-2026-87766 setup-time fix (0.12.0+)`,
    };
  }
  return {
    status: 'unverified',
    detail:
      `bubblewrap ${major}.${minor}.${patch} predates the upstream CVE-2026-87766 setup-time fix (0.12.0): ` +
      'patch level unverified — Ubuntu reverted its backport (USN-8779-2), so no Ubuntu revision below upstream 0.12.0 counts as patched',
  };
}

/** Best effort, never throws: `null` means "could not be read", not "absent". */
export function readBubblewrapVersion(): string | null {
  try {
    const out = String(
      execFileSync('bwrap', ['--version'], { timeout: 5_000, stdio: 'pipe' }),
    ).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
