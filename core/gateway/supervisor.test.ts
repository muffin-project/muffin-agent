import { describe, expect, it } from 'vitest';
import { planUnit, SERVICE_NAME } from './unit.js';
import { checkSupervisor, type SupervisorProbes } from './supervisor.js';

/**
 * `doctor`'s missing half, from A1: today it only asks "is a gateway process
 * alive" (`readGateway`), which a bare `muffin gateway run` in a terminal also
 * makes true. This is the check that answers the different question ADR-0035
 * actually promises — does a *supervisor* hold this up, or does it die the
 * moment the terminal does.
 *
 * `checkSupervisor` is pure and takes `platform` as an argument specifically
 * so this file can drive both branches from one host OS, matching the
 * `unit.test.ts` precedent for the same reason.
 */

const HOME = '/tmp/muffin-fake-home';
const HOME_DIR = '/tmp/fake-owner';

function probes(over: Partial<SupervisorProbes>): SupervisorProbes {
  return { unitFileExists: () => false, ...over };
}

describe('checkSupervisor — never fail, always ok or a named remedy', () => {
  it('says so plainly when nothing is installed and no gateway is running', () => {
    const status = checkSupervisor('linux', HOME, false, probes({}), HOME_DIR);
    expect(status.engaged).toBe(false);
    if (!status.engaged) {
      expect(status.detail).toContain('non riparte da solo');
      expect(status.remedy).toContain('gateway install --write');
    }
  });

  it('names the live-but-unsupervised case when a gateway is up with no unit installed', () => {
    // The exact case the brief names: `muffin gateway run` by hand — alive,
    // reachable, and gone the moment this terminal closes.
    const status = checkSupervisor('linux', HOME, true, probes({}), HOME_DIR);
    expect(status.engaged).toBe(false);
    if (!status.engaged) expect(status.detail).toContain('vive finché il terminale');
  });

  describe('macOS', () => {
    it('is ok when the plist exists and launchd has it loaded', () => {
      const status = checkSupervisor(
        'darwin',
        HOME,
        false,
        probes({ unitFileExists: () => true, launchdLoaded: () => true }),
        HOME_DIR,
      );
      expect(status).toMatchObject({ engaged: true });
    });

    it('warns with the exact bootstrap command when the plist exists but is not loaded', () => {
      const status = checkSupervisor(
        'darwin',
        HOME,
        false,
        probes({ unitFileExists: () => true, launchdLoaded: () => false }),
        HOME_DIR,
      );
      expect(status.engaged).toBe(false);
      if (!status.engaged) {
        const plan = planUnit({ platform: 'darwin', home: HOME, exec: ['x'], homeDir: HOME_DIR });
        expect(status.remedy).toBe(`launchctl bootstrap gui/$(id -u) ${plan.path}`);
      }
    });

    it('treats an unrun launchdLoaded probe the same as "not loaded" — never a silent ok', () => {
      const status = checkSupervisor('darwin', HOME, false, probes({ unitFileExists: () => true }), HOME_DIR);
      expect(status.engaged).toBe(false);
    });
  });

  describe('linux', () => {
    it('is ok when the unit is enabled and linger is on', () => {
      const status = checkSupervisor(
        'linux',
        HOME,
        false,
        probes({ unitFileExists: () => true, systemdEnabled: () => true, lingerEnabled: () => true }),
        HOME_DIR,
      );
      expect(status).toMatchObject({ engaged: true });
    });

    it('warns with the enable command when the unit exists but is not enabled', () => {
      const status = checkSupervisor(
        'linux',
        HOME,
        false,
        probes({ unitFileExists: () => true, systemdEnabled: () => false }),
        HOME_DIR,
      );
      expect(status.engaged).toBe(false);
      if (!status.engaged) expect(status.remedy).toBe(`systemctl --user enable --now ${SERVICE_NAME}.service`);
    });

    it('warns about linger specifically when enabled but the user unit would die at logout', () => {
      const status = checkSupervisor(
        'linux',
        HOME,
        false,
        probes({ unitFileExists: () => true, systemdEnabled: () => true, lingerEnabled: () => false }),
        HOME_DIR,
      );
      expect(status.engaged).toBe(false);
      if (!status.engaged) {
        expect(status.remedy).toContain('enable-linger');
        expect(status.detail).toContain('logout');
      }
    });
  });

  it('reads the same path planUnit would write, XDG_CONFIG_HOME included', () => {
    // Regression guard for the one way this check could silently look at the
    // wrong file: a divergent path computation between `install` and `doctor`.
    const seen: string[] = [];
    checkSupervisor(
      'linux',
      HOME,
      false,
      probes({ unitFileExists: (p) => { seen.push(p); return true; }, systemdEnabled: () => true, lingerEnabled: () => true }),
      HOME_DIR,
      '/tmp/fake-xdg',
    );
    const expected = planUnit({ platform: 'linux', home: HOME, exec: ['x'], homeDir: HOME_DIR, configHome: '/tmp/fake-xdg' });
    expect(seen).toEqual([expected.path]);
  });
});

// "Never `fail`" is not tested at runtime because it does not need to be:
// `SupervisorStatus` is a two-arm union (`engaged: true | engaged: false`),
// so a third, fail-shaped outcome is not representable — a structural
// guarantee `tsc` already enforces on every branch above, stronger than a
// test that could only ever pass.
