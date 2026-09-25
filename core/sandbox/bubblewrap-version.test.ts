import { describe, expect, it } from 'vitest';
import { assessBubblewrapVersionString } from './bubblewrap-version.js';

/**
 * #642 — Muffin trusts the host `bwrap` after a behavioral probe, but the
 * September 2026 symlink setup flaw (CVE-2026-87766) is a class the probe
 * does not exercise. Two facts pin the posture:
 *
 * - upstream fixed it in 0.12.0 (openat2 RESOLVE_IN_ROOT);
 * - Ubuntu's backport (0.9.0-1ubuntu0.2, USN-8779-1) was REVERTED
 *   (0.9.0-1ubuntu0.3, USN-8779-2, Flatpak regression), so no Ubuntu
 *   revision below upstream 0.12.0 counts as patched — and `bwrap --version`
 *   prints the upstream triple only, never the distro revision.
 *
 * The assessment is therefore fail-closed: `patched` only for upstream
 * >= 0.12.0, `unverified` for everything else, never a green version gate
 * on a reverted backport.
 */
describe('bubblewrap setup-time patch assessment (#642)', () => {
  it('treats upstream >= 0.12.0 as patched', () => {
    for (const raw of ['bubblewrap 0.12.0', 'bubblewrap 0.12.1', 'bubblewrap 0.13.0']) {
      expect(assessBubblewrapVersionString(raw).status, raw).toBe('patched');
    }
  });

  it('never treats an older upstream as patched', () => {
    for (const raw of ['bubblewrap 0.9.0', 'bubblewrap 0.11.1', 'bubblewrap 0.4.0']) {
      const a = assessBubblewrapVersionString(raw);
      expect(a.status, raw).toBe('unverified');
      expect(a.detail).toMatch(/CVE-2026-87766/);
    }
  });

  it('does not implement the reverted Ubuntu rule: 1ubuntu0.2 is NOT patched', () => {
    // USN-8779-2 reverted the USN-8779-1 backport. A gate on
    // `>= 0.9.0-1ubuntu0.2` would report the reverted-vulnerable 0.9.0-1ubuntu0.3
    // as safe (it compares greater) — exactly backwards. Both stay unverified.
    for (const raw of ['bubblewrap 0.9.0-1ubuntu0.2', 'bubblewrap 0.9.0-1ubuntu0.3']) {
      const a = assessBubblewrapVersionString(raw);
      expect(a.status, raw).toBe('unverified');
      expect(a.detail).toMatch(/USN-8779-2|revert/i);
    }
  });

  it('is unverified, not safe, when the version cannot be read', () => {
    for (const raw of [null, '', 'garbage']) {
      const a = assessBubblewrapVersionString(raw);
      expect(a.status, String(raw)).toBe('unverified');
      expect(a.detail).toMatch(/CVE-2026-87766/);
    }
  });
});
