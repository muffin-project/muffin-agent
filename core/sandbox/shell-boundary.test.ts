import { describe, expect, it } from 'vitest';
import type { SandboxProbe } from './probe.js';
import { assessShellBoundary, SHELL_BOUNDARY_REMEDY } from './shell-boundary.js';

/**
 * #642 — shell usable ⇔ behavioral pass AND trusted patch posture.
 *
 * The defect this pins: before `assessShellBoundary`, runtime exposed the
 * shell lanes from `probe.available` alone while doctor graded the version
 * separately, so a host with bwrap 0.11.1 (probe green, upstream-vulnerable)
 * could register `shell_run` while doctor only warned. Every branch below is
 * a shape that must not be able to disagree with its caller again.
 */

const seatbelt: SandboxProbe = { available: true, mechanism: 'seatbelt' };
const bubblewrapGreen: SandboxProbe = { available: true, mechanism: 'bubblewrap' };
const probeFails: SandboxProbe = {
  available: false,
  mechanism: 'bubblewrap',
  reason: 'userns_denied',
  detail: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
  remedy: 'add an AppArmor profile for bwrap',
};

function spyVersion(value: string | null): { reader: () => string | null; calls: () => number } {
  let n = 0;
  return {
    reader: () => {
      n += 1;
      return value;
    },
    calls: () => n,
  };
}

describe('assessShellBoundary — the shared shell gate (#642)', () => {
  it('probe unavailable → not usable, patch not-applicable, version never read', () => {
    const v = spyVersion('bubblewrap 0.12.0');
    const b = assessShellBoundary(probeFails, v.reader);
    expect(b.usable).toBe(false);
    expect(b.patch).toBe('not-applicable');
    expect(v.calls()).toBe(0);
    expect(b.reason).toContain('userns_denied');
    expect(b.reason).toContain('non disponibile');
    expect(b.remedy).toContain('AppArmor');
  });

  it('seatbelt (macOS) usable with no version floor — reader never called', () => {
    const v = spyVersion(null);
    const b = assessShellBoundary(seatbelt, v.reader);
    expect(b.usable).toBe(true);
    expect(b.patch).toBe('not-applicable');
    expect(v.calls()).toBe(0);
  });

  it('bubblewrap ≥ 0.12.0 (declared fixture, not a host claim) → usable, patch trusted', () => {
    const v = spyVersion('bubblewrap 0.12.0');
    const b = assessShellBoundary(bubblewrapGreen, v.reader);
    expect(b.usable).toBe(true);
    expect(b.patch).toBe('trusted');
    expect(b.behavioral.available).toBe(true);
    expect(v.calls()).toBe(1);
  });

  it('bubblewrap 0.11.1 (centria-zero’s real version) → probe green but NOT usable', () => {
    const b = assessShellBoundary(bubblewrapGreen, () => 'bubblewrap 0.11.1');
    expect(b.behavioral.available).toBe(true);
    expect(b.usable).toBe(false);
    expect(b.patch).toBe('unverified');
    expect(b.reason).toMatch(/CVE-2026-87766/);
    expect(b.reason).toMatch(/unverified/);
    expect(b.remedy).toBe(SHELL_BOUNDARY_REMEDY);
    expect(b.remedy).not.toMatch(/keeps working/i);
  });

  it('unreadable version → unverified, not usable — fail-closed, not fail-open', () => {
    const b = assessShellBoundary(bubblewrapGreen, () => null);
    expect(b.usable).toBe(false);
    expect(b.patch).toBe('unverified');
    expect(b.reason).toMatch(/unreadable|CVE-2026-87766/);
  });
});
