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
const SERVICE_USER = 'owner';

function probes(over: Partial<SupervisorProbes>): SupervisorProbes {
  return { unitFileExists: () => false, ...over };
}

/** Linux check with the dedicated user plumbed, like doctor does. */
function linux(home: string, running: boolean, over: Partial<SupervisorProbes>) {
  return checkSupervisor('linux', home, running, probes(over), HOME_DIR, undefined, SERVICE_USER);
}

describe('checkSupervisor — never fail, always ok or a named remedy', () => {
  it('says so plainly when nothing is installed and no gateway is running', () => {
    const status = linux(HOME, false, {});
    expect(status.engaged).toBe(false);
    if (!status.engaged) {
      expect(status.detail).toContain('non riparte da solo');
      expect(status.remedy).toContain('gateway install --write');
    }
  });

  it('names the live-but-unsupervised case when a gateway is up with no unit installed', () => {
    // The exact case the brief names: `muffin gateway run` by hand — alive,
    // reachable, and gone the moment this terminal closes.
    const status = linux(HOME, true, {});
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
    it('is ok when the system unit is enabled and runs as the dedicated user', () => {
      const status = linux(
        HOME,
        false,
        { unitFileExists: () => true, systemdEnabled: () => true, serviceUser: () => SERVICE_USER },
      );
      expect(status).toMatchObject({ engaged: true });
    });

    it('warns with the sudo enable command when the unit exists but is not enabled', () => {
      const status = linux(HOME, false, { unitFileExists: () => true, systemdEnabled: () => false });
      expect(status.engaged).toBe(false);
      if (!status.engaged) expect(status.remedy).toBe(`sudo systemctl enable --now ${SERVICE_NAME}.service`);
    });

    it('names a unit running as the wrong user — and an empty User= never passes', () => {
      // Empty string is what `systemctl show -p User` reports for a unit with
      // no User= at all, i.e. running as root. It must mismatch every
      // dedicated user rather than collapse into "not confirmed".
      for (const runsAs of ['root', 'someone-else', '']) {
        const status = linux(
          HOME,
          false,
          { unitFileExists: () => true, systemdEnabled: () => true, serviceUser: () => runsAs },
        );
        expect(status.engaged).toBe(false);
        if (!status.engaged) expect(status.detail).toContain(SERVICE_USER);
      }
    });

    it('an unanswered serviceUser probe is "not confirmed", never a false red', () => {
      const status = linux(HOME, false, { unitFileExists: () => true, systemdEnabled: () => true });
      expect(status).toMatchObject({ engaged: true });
    });

    it('names the retired user unit when only it exists', () => {
      const status = linux(HOME, false, { userUnitShadow: () => true });
      expect(status.engaged).toBe(false);
      if (!status.engaged) {
        expect(status.detail).toContain('user unit');
        expect(status.remedy).toContain('gateway install --write');
      }
    });

    it('warns while a user-unit corpse shadows a healthy system unit', () => {
      const status = linux(
        HOME,
        false,
        {
          unitFileExists: () => true,
          systemdEnabled: () => true,
          serviceUser: () => SERVICE_USER,
          userUnitShadow: () => true,
        },
      );
      expect(status.engaged).toBe(false);
      if (!status.engaged) expect(status.detail).toContain('user unit');
    });

    it('a failed unit is named even when enabled — enabled parla del futuro, failed del presente', () => {
      // Lo stato che `doctor` esisteva per vedere e riportava verde: enabled
      // (partirà al boot) ma failed adesso — e su questa unit failed significa
      // «non torna da solo», perché RestartPreventExitStatus tiene giù le
      // uscite permanenti di proposito. Il rimedio deve portare al journal,
      // che è dove sta scritto il perché.
      const status = linux(
        HOME,
        false,
        {
          unitFileExists: () => true,
          systemdEnabled: () => true,
          systemdFailed: () => true,
          serviceUser: () => SERVICE_USER,
        },
      );
      expect(status.engaged).toBe(false);
      if (!status.engaged) {
        expect(status.detail).toContain('failed');
        expect(status.remedy).toContain('journalctl');
        expect(status.remedy).not.toContain('--user');
      }
    });

    it('failed vince su tutto il resto: «è giù adesso» prima di ogni altra considerazione', () => {
      // Entrambi i difetti presenti: il messaggio deve nominare quello che è
      // già successo, non quello previsto.
      const status = linux(
        HOME,
        false,
        {
          unitFileExists: () => true,
          systemdEnabled: () => true,
          systemdFailed: () => true,
          serviceUser: () => 'root',
          userUnitShadow: () => true,
        },
      );
      expect(status.engaged).toBe(false);
      if (!status.engaged) expect(status.detail).toContain('failed');
    });

    it('una sonda is-failed assente non inventa un guasto', () => {
      // La sonda è opzionale come le altre: un test Linux-shaped che non la
      // fornisce, o una macchina dove `systemctl` non parte, degradano a «non
      // confermato» — mai a un falso rosso.
      const status = linux(
        HOME,
        false,
        { unitFileExists: () => true, systemdEnabled: () => true, serviceUser: () => SERVICE_USER },
      );
      expect(status).toMatchObject({ engaged: true });
    });
  });

  it('reads the same path planUnit would write', () => {
    // Regression guard for the one way this check could silently look at the
    // wrong file: a divergent path computation between `install` and `doctor`.
    const seen: string[] = [];
    checkSupervisor(
      'linux',
      HOME,
      false,
      probes({ unitFileExists: (p) => { seen.push(p); return true; }, systemdEnabled: () => true }),
      HOME_DIR,
      undefined,
      SERVICE_USER,
      '/tmp/fake-system',
    );
    const expected = planUnit({
      platform: 'linux',
      home: HOME,
      exec: ['x'],
      homeDir: HOME_DIR,
      serviceUser: SERVICE_USER,
      systemDir: '/tmp/fake-system',
    });
    expect(seen).toEqual([expected.path]);
  });
});

// "Never `fail`" is not tested at runtime because it does not need to be:
// `SupervisorStatus` is a two-arm union (`engaged: true | engaged: false`),
// so a third, fail-shaped outcome is not representable — a structural
// guarantee `tsc` already enforces on every branch above, stronger than a
// test that could only ever pass.
