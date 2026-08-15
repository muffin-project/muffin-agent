import { execFileSync } from 'node:child_process';
import { platform, userInfo } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeSandbox } from './probe.js';

/**
 * The probe had no test at all until 2026-08-15 — the module whose entire
 * reason for existing is that a check which is never exercised reports green
 * forever. On Linux it is the code that decides whether a containment exists,
 * and `agent/runtime.ts` registers `shell_run` **only** when it says yes, so
 * both a false green (an unsandboxed tool offered to the model) and a false red
 * (a capability silently missing on the production VPS) start here.
 *
 * Two kinds of test, and the split is deliberate:
 *
 * - **On this host, unmocked**: the probe's answer must be the same answer an
 *   independently executed containment gives. That is the only test that can
 *   catch the probe lying about the machine it is actually running on.
 * - **Every branch, mocked**: `node:os` and `node:child_process` are replaced
 *   so the Linux branch is exercised on macOS and the macOS branch on Linux.
 *   The development machine is macOS and production is a Linux VPS; without
 *   this, half of this file's logic would be reviewed and never executed —
 *   which is the same defect one level up.
 */

const actual = vi.hoisted(
  () => ({}) as { os: typeof import('node:os'); cp: typeof import('node:child_process') },
);

vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>();
  actual.os = mod;
  return { ...mod, platform: vi.fn(mod.platform), userInfo: vi.fn(mod.userInfo) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  actual.cp = mod;
  return { ...mod, execFileSync: vi.fn(mod.execFileSync) };
});

const mockedPlatform = vi.mocked(platform);
const mockedUserInfo = vi.mocked(userInfo);
const mockedExec = vi.mocked(execFileSync);

/**
 * Default: the real thing. Each test overrides only what it is about.
 *
 * The `mockClear` matters more than it looks: several assertions below read
 * `mockedExec.mock.calls[0]` to pin the argv the probe actually ran, and
 * without clearing they read a call left over from an earlier test — which is
 * how three of these tests passed against the wrong recording on the first run.
 */
beforeEach(() => {
  mockedPlatform.mockClear().mockImplementation(actual.os.platform);
  mockedUserInfo.mockClear().mockImplementation(actual.os.userInfo);
  mockedExec.mockClear().mockImplementation(actual.cp.execFileSync);
});

/** What `execFileSync` throws when the child ran and exited non-zero. */
function exitedNonZero(stderr: string): Error {
  const e = new Error('Command failed') as Error & { stderr: Buffer; status: number };
  e.stderr = Buffer.from(stderr);
  e.status = 1;
  return e;
}

/** What `execFileSync` throws when the binary is not there at all. */
function missingBinary(name: string): Error {
  const e = new Error(`spawnSync ${name} ENOENT`) as Error & { code: string };
  e.code = 'ENOENT';
  return e;
}

/** uid is what the Linux branch keys on; the rest of userInfo is scenery. */
function asUid(uid: number): ReturnType<typeof userInfo> {
  return { ...actual.os.userInfo(), uid } as ReturnType<typeof userInfo>;
}

describe('the probe agrees with a containment executed independently of it', () => {
  /**
   * The probe says "the sandbox contains". This runs the containment again, by
   * hand, and requires the two answers to match. A probe that is wrong about
   * the machine it is running on is the whole incident, and no amount of
   * branch coverage would catch it.
   */
  it.runIf(platform() === 'darwin')('macOS: deny-all denies, and the probe knows it', () => {
    // Control arm first: the target must be readable *without* the sandbox,
    // otherwise the denial below would prove nothing about containment.
    expect(() => actual.cp.execFileSync('/bin/cat', ['/etc/hosts'], { stdio: 'pipe' })).not.toThrow();

    const denyAll = '(version 1)(deny default)(allow process-fork)(allow sysctl-read)';
    let denied = false;
    try {
      actual.cp.execFileSync('/usr/bin/sandbox-exec', ['-p', denyAll, '/bin/cat', '/etc/hosts'], {
        timeout: 5_000,
        stdio: 'pipe',
      });
    } catch {
      denied = true;
    }

    expect(denied).toBe(true);
    expect(probeSandbox()).toEqual({ available: true, mechanism: 'seatbelt' });
  });

  /**
   * On Linux the expected answer is not fixed — a hardened Ubuntu 24.04 host is
   * *supposed* to say no. So the assertion is the equivalence: whatever bwrap
   * does here, the probe reports the same thing.
   */
  it.runIf(platform() === 'linux')('linux: the probe matches what bwrap actually does', () => {
    let bwrapContains = false;
    try {
      actual.cp.execFileSync(
        'bwrap',
        ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'true'],
        { timeout: 5_000, stdio: 'pipe' },
      );
      bwrapContains = true;
    } catch {
      bwrapContains = false;
    }

    const probe = probeSandbox();
    if (actual.os.userInfo().uid === 0) {
      // Root bypasses the userns restriction: whatever bwrap answered, the
      // probe must refuse to draw a conclusion from it.
      expect(probe.available).toBe(false);
      return;
    }
    expect(probe.available).toBe(bwrapContains);
    if (probe.available) expect(probe.mechanism).toBe('bubblewrap');
  });

  it('an OS with no sandbox is declared unsupported, not assumed fine', () => {
    mockedPlatform.mockReturnValue('freebsd');
    const probe = probeSandbox();
    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.reason).toBe('unsupported_platform');
    expect(probe.remedy).toMatch(/ask/i);
  });
});

describe('the Linux branch (bubblewrap)', () => {
  beforeEach(() => {
    mockedPlatform.mockReturnValue('linux');
  });

  /**
   * The root detector, verified rather than read. Its whole point is that it
   * fires *before* bwrap runs — root bypasses the userns restriction, so a
   * green from bwrap under uid 0 is a false positive about every other user on
   * the host. Asserting the message without asserting that no probe ran would
   * pass on an implementation that runs bwrap first and ignores the result.
   */
  it('as root the probe refuses to answer, and does not even run bwrap', () => {
    mockedUserInfo.mockReturnValue(asUid(0));
    mockedExec.mockImplementation(() => {
      throw new Error('bwrap must not be executed under uid 0');
    });

    const probe = probeSandbox();

    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.reason).toBe('probe_failed');
    expect(probe.detail).toMatch(/root/i);
    expect(probe.detail).toMatch(/false positive/i);
    expect(probe.remedy).toMatch(/service user/i);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('a contained bwrap is reported available — and the probe really asked for a namespace', () => {
    mockedUserInfo.mockReturnValue(asUid(1000));
    mockedExec.mockReturnValue(Buffer.from(''));

    expect(probeSandbox()).toEqual({ available: true, mechanism: 'bubblewrap' });

    // `bwrap true` without unsharing proves the binary exists and nothing else
    // — the exact mistake the seatbelt branch shipped with. Pin the argv.
    const [bin, argv] = mockedExec.mock.calls[0] ?? [];
    expect(bin).toBe('bwrap');
    expect(argv).toContain('--unshare-all');
  });

  it('a missing bwrap is binary_missing, with the install as the remedy', () => {
    mockedUserInfo.mockReturnValue(asUid(1000));
    mockedExec.mockImplementation(() => {
      throw missingBinary('bwrap');
    });

    const probe = probeSandbox();
    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.reason).toBe('binary_missing');
    expect(probe.remedy).toMatch(/install bubblewrap/i);
  });

  /**
   * The verbatim failure from the production VPS, ADR-0018 field note
   * 2026-08-04: `bwrap` and `socat` installed, `bwrap` present in PATH, and the
   * sandbox a no-op for two months because of a sysctl. This is the case that
   * a "is the binary there?" check answers wrongly every single day.
   */
  it('the Ubuntu 24.04 userns restriction is named as such, with the AppArmor remedy', () => {
    mockedUserInfo.mockReturnValue(asUid(1000));
    mockedExec.mockImplementation(() => {
      throw exitedNonZero('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted');
    });

    const probe = probeSandbox();
    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.reason).toBe('userns_denied');
    expect(probe.detail).toContain('RTM_NEWADDR');
    expect(probe.remedy).toMatch(/apparmor/i);
  });

  it('nothing reports available unless bwrap actually exited zero', () => {
    mockedUserInfo.mockReturnValue(asUid(1000));
    for (const failure of [
      missingBinary('bwrap'),
      exitedNonZero('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'),
      exitedNonZero('bwrap: Creating new namespace failed: Operation not permitted'),
      exitedNonZero(''),
    ]) {
      mockedExec.mockImplementation(() => {
        throw failure;
      });
      expect(probeSandbox().available).toBe(false);
    }
  });
});

describe('the macOS branch (seatbelt)', () => {
  beforeEach(() => {
    mockedPlatform.mockReturnValue('darwin');
  });

  /**
   * The regression that is already written into the module's comment: the first
   * version ran `(allow default)` and reported "a real containment ran and
   * held" when the process merely started. The profile is asserted, not the
   * intent.
   */
  it('the profile it runs is a deny profile, not an allow one', () => {
    mockedExec.mockImplementation(() => {
      throw exitedNonZero("sandbox-exec: execvp() of '/bin/cat' failed: Operation not permitted");
    });

    probeSandbox();

    const [bin, argv] = mockedExec.mock.calls[0] ?? [];
    expect(bin).toBe('/usr/bin/sandbox-exec');
    const profile = (argv as string[])[1] ?? '';
    expect(profile).toContain('(deny default)');
    expect(profile).not.toContain('(allow default)');
  });

  it('a deny-all profile that still lets the read through is a failure, not a pass', () => {
    // The containment did not contain: sandbox-exec exited 0 having read the file.
    mockedExec.mockReturnValue(Buffer.from('##\n# Host Database\n'));

    const probe = probeSandbox();
    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.reason).toBe('probe_failed');
    expect(probe.detail).toContain('/etc/hosts');
  });

  it('a missing sandbox-exec is binary_missing, and says the platform is not as expected', () => {
    mockedExec.mockImplementation(() => {
      throw missingBinary('/usr/bin/sandbox-exec');
    });

    const probe = probeSandbox();
    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.reason).toBe('binary_missing');
    expect(probe.remedy).toMatch(/part of macOS/i);
  });

  /**
   * Measured on macOS 15, 2026-08-15:
   *
   *   $ sandbox-exec -p '(version 1)(deny default)(allow no-such-primitive)' /bin/cat /etc/hosts
   *   sandbox-exec: unbound variable: no-such-primitive at <input string>, line 1, column 33
   *   exit 65
   *
   * A profile the OS refuses to parse fails exactly the way containment fails:
   * non-zero exit, stderr that matches neither ENOENT nor "not found". The
   * branch that concludes "the profile refused the read, so the process died"
   * cannot tell the two apart — so the day a macOS release drops one of the
   * three primitives in DENY_ALL, the probe reports the sandbox as available
   * and `shell_run` is registered on a host where nothing was ever contained.
   *
   * That is this module's own incident, in the branch that runs on the
   * developer's machine. The fix is the positive control: the same binary must
   * also be seen *succeeding* under an allow-all profile before a failure is
   * read as evidence of containment.
   */
  it('a profile sandbox-exec refuses to parse is not evidence of containment', () => {
    const calls: string[][] = [];
    mockedExec.mockImplementation(((bin: string, argv: string[]) => {
      calls.push(argv);
      // Every invocation fails the way a broken sandbox-exec fails: the deny
      // profile and the allow-all control alike.
      throw exitedNonZero(
        'sandbox-exec: unbound variable: no-such-primitive at <input string>, line 1, column 33',
      );
    }) as unknown as typeof execFileSync);

    const probe = probeSandbox();

    expect(probe.available).toBe(false);
    if (probe.available) return;
    expect(probe.reason).toBe('probe_failed');
    expect(probe.detail).toMatch(/unbound variable/);
    // The control arm ran: a second invocation, with a profile that must succeed.
    expect(calls.length).toBe(2);
  });

  it('the control arm is not run when the deny profile already proved nothing was contained', () => {
    mockedExec.mockReturnValue(Buffer.from('read it fine'));
    probeSandbox();
    expect(mockedExec).toHaveBeenCalledTimes(1);
  });
});
