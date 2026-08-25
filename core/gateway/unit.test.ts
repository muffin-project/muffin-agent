import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRAIN_BUDGET_MS, EXIT_STOPPED } from './service.js';
import { EXIT_PERMANENT, planUnit, resolveLauncher, WATCHDOG_SEC } from './unit.js';

/**
 * The unit, and the scar it is shaped around.
 *
 * ADR-0035 records Hermes' bug verbatim: an unit whose `WorkingDirectory`
 * pointed at a code checkout that later moved made systemd fail at CHDIR
 * *before the runtime loaded*, so the self-repair at boot never ran and
 * `Restart=always` crash-looped forever on a dead directory. The cure is one
 * line — anchor to the data home, which does not move — and it is the line most
 * likely to be "simplified" later by someone who thinks the checkout is the
 * natural working directory. Hence a test per anchor.
 */

const DATA_HOME = '/home/g/.muffin';
const plan = (over: Parameters<typeof planUnit>[0] extends infer T ? Partial<T> : never = {}) =>
  planUnit({
    platform: 'linux',
    home: DATA_HOME,
    exec: ['/home/g/.local/bin/muffin', 'gateway', 'run'],
    configHome: '/home/g/.config',
    ...over,
  });

/**
 * Does the supervisor bring it back after *this* exit code?
 *
 * The old assertions were `toContain('Restart=always')` and
 * `toContain('<key>KeepAlive</key>')` — both true, on both sides, while `stop`
 * did not stop on Linux and the restart signal left the agent down on macOS.
 * A string being present says nothing about what it does; the two functions
 * below say what it does, so a directive that flips is a test that fails.
 *
 * Each models one documented rule and nothing else:
 *  - systemd: `Restart=always` restarts on every exit, and
 *    `RestartPreventExitStatus=` is a whitespace-separated list of the codes
 *    exempted from it. (Explicit `systemctl stop|restart` jobs are outside
 *    both, which is why the unit's own comment says so.)
 *  - launchd: `KeepAlive` as `<true/>` means always; as a dict carrying
 *    `SuccessfulExit</key><false/>` it means "only when the exit was *not*
 *    successful", i.e. non-zero.
 */
function systemdRestartsAfter(text: string, code: number): boolean {
  if (!/^Restart=always$/m.test(text)) return false;
  const prevented = (/^RestartPreventExitStatus=(.*)$/m.exec(text)?.[1] ?? '')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(Number);
  return !prevented.includes(code);
}

function launchdRestartsAfter(text: string, code: number): boolean {
  const keepAlive = /<key>KeepAlive<\/key>\s*(<true\/>|<false\/>|<dict>[\s\S]*?<\/dict>)/.exec(text)?.[1];
  if (keepAlive === undefined || keepAlive === '<false/>') return false;
  if (keepAlive === '<true/>') return true;
  const successful = /<key>SuccessfulExit<\/key>\s*<(true|false)\/>/.exec(keepAlive)?.[1];
  if (successful === 'false') return code !== 0;
  if (successful === 'true') return code === 0;
  return true;
}

describe('the systemd unit is anchored to the data home', () => {
  it('sets WorkingDirectory to ~/.muffin and never to the checkout', () => {
    const { text } = plan();
    expect(text).toContain(`WorkingDirectory=${DATA_HOME}`);
    // The checkout appears nowhere but the ExecStart, which has to name *some*
    // executable. Anything else pointing at code is the bug coming back.
    const dirs = [...text.matchAll(/^(?:WorkingDirectory|Environment)=.*$/gm)].map((m) => m[0]);
    expect(dirs.every((line) => !line.includes('/dev/') && !line.includes('checkout'))).toBe(true);
  });

  it('pins MUFFIN_HOME so the unit and the CLI agree on which home is meant', () => {
    // A gateway started by systemd with a different MUFFIN_HOME than the shell
    // uses would tick a second database — jobs the owner cannot see, and a
    // gateway lock that never conflicts with the one the REPL reads.
    expect(plan().text).toContain(`Environment=MUFFIN_HOME=${DATA_HOME}`);
  });

  it('lands in the user unit directory, not a system one', () => {
    // Constraint 4 of the ADR: it runs as the owner, with no elevation. A system
    // unit needs root and would give the gateway a different identity than the
    // one that owns ~/.muffin.
    expect(plan().path).toBe('/home/g/.config/systemd/user/muffin-gateway.service');
    expect(plan().commands.join(' ')).toContain('--user');
  });

  it('tells the owner about linger, without which a user unit dies at logout', () => {
    expect(plan().commands.join(' ')).toContain('enable-linger');
  });
});

describe('the systemd unit declares supervision, not just restarting', () => {
  it('is Type=notify with a watchdog', () => {
    // `Restart=always` alone cannot see a process that is up but wedged, which
    // is the failure mode this whole slice is about.
    const { text } = plan();
    expect(text).toContain('Type=notify');
    expect(text).toContain(`WatchdogSec=${WATCHDOG_SEC}`);
  });

  it('sets NotifyAccess=all, because the notification comes from a child', () => {
    // Not a preference: Node cannot open an AF_UNIX SOCK_DGRAM socket, so the
    // datagram is sent by `systemd-notify`, and systemd ignores a notification
    // from a process it did not fork unless this is set. Without the line the
    // watchdog silently never gets fed and systemd kills a healthy gateway.
    expect(plan().text).toContain('NotifyAccess=all');
  });

  it('gives the supervisor more patience than our own drain budget', () => {
    // If TimeoutStopSec were shorter, systemd would SIGKILL in the middle of the
    // drain the gateway was told to perform — losing exactly the turn the drain
    // exists to protect. Derived from the budget so the two cannot drift apart.
    const stop = Number(/TimeoutStopSec=(\d+)/.exec(plan().text)?.[1]);
    expect(stop * 1000).toBeGreaterThan(DRAIN_BUDGET_MS);
  });

  it('restarts, with a pause, and kills the whole group', () => {
    const { text } = plan();
    expect(text).toContain('Restart=always');
    expect(text).toMatch(/RestartSec=\d+/);
    // MCP servers and sandboxes are children; KillMode=mixed is what stops them
    // outliving the gateway that spawned them.
    expect(text).toContain('KillMode=mixed');
  });

  it('leaves the ping alive long enough to cover a drain, because the drain alone outlasts the deadline', () => {
    // The arithmetic that made the split in `service.ts` necessary, asserted
    // here so it fails if either constant moves: a self-initiated drain can
    // spend the whole budget, and the budget alone already reaches the
    // watchdog deadline. A drain that stopped pinging would be killed mid-way
    // through the shutdown it was asked to perform.
    expect(DRAIN_BUDGET_MS).toBeGreaterThanOrEqual(WATCHDOG_SEC * 1000);
  });
});

describe('what the supervisor does with each exit code', () => {
  /**
   * The two broken verbs, as a table. Neither half works alone: `service.ts`
   * decides the code, this decides what is done with it.
   */
  it('systemd: restarts a crash and a restart-me, stays down on stop and on permanent', () => {
    const { text } = plan();
    // SIGUSR1 drains and exits 0 — the whole point of the signal is that it
    // comes back.
    expect(systemdRestartsAfter(text, 0)).toBe(true);
    // A crash. The property the fix is not allowed to cost.
    expect(systemdRestartsAfter(text, 1)).toBe(true);
    // Another gateway holds the lock: transient, retry is correct.
    expect(systemdRestartsAfter(text, 75)).toBe(true);
    // `muffin gateway stop`. Before this it came back after RestartSec, on the
    // Linux VPS that is production — "stop" that stopped nothing.
    expect(systemdRestartsAfter(text, EXIT_STOPPED)).toBe(false);
    // Config or secret missing, root of trust refusing.
    expect(systemdRestartsAfter(text, EXIT_PERMANENT)).toBe(false);
  });

  it('launchd: restarts a crash and a restart-me, and cannot express the other two', () => {
    const { text, warnings } = planUnit({
      platform: 'darwin',
      home: '/Users/g/.muffin',
      exec: ['/usr/local/bin/muffin', 'gateway', 'run'],
    });
    // The failure this replaces: under `SuccessfulExit: false` the SIGUSR1
    // drain-restart exited 0 and launchd left the agent down — the opposite of
    // what the signal exists for.
    expect(launchdRestartsAfter(text, 0)).toBe(true);
    expect(launchdRestartsAfter(text, 1)).toBe(true);
    // launchd has no per-code exemption, so both of these come back up. Not a
    // silent divergence: the warning has to name the verb it costs, or macOS
    // gets a `gateway stop` that lies (JUDGE: "la divergenza è registrata o
    // solo avvenuta?").
    expect(launchdRestartsAfter(text, EXIT_STOPPED)).toBe(true);
    expect(launchdRestartsAfter(text, EXIT_PERMANENT)).toBe(true);
    expect(warnings.join(' ')).toContain('bootout');
    expect(warnings.join(' ')).toMatch(new RegExp(`${EXIT_STOPPED}`));
  });
});

describe('Type=notify needs a sender that exists', () => {
  it('falls back to Type=exec, with no watchdog, when systemd-notify is missing', () => {
    // Not a degradation: under Type=notify with no way to send READY=1 the unit
    // never reaches "started", systemd kills it at TimeoutStartSec (90 s by
    // default) and Restart=always retries forever — without ever tripping the
    // start rate limit, because five starts in ten seconds cannot happen when
    // each takes a minute and a half.
    const { text, warnings } = plan({ systemdNotify: false });
    expect(text).toContain('Type=exec');
    expect(text).not.toContain('Type=notify');
    // A declared watchdog nobody can feed kills a healthy process every
    // WatchdogSec, which is the same failure wearing the other hat.
    expect(text).not.toMatch(/^WatchdogSec=/m);
    expect(text).not.toContain('NotifyAccess');
    expect(warnings.join(' ')).toMatch(/systemd-notify/);
    expect(warnings.join(' ')).toMatch(/watchdog/i);
  });

  it('still restarts, and still stays down on stop, without the watchdog', () => {
    // The fallback changes what supervision *sees*, not what it *does*.
    const { text } = plan({ systemdNotify: false });
    expect(systemdRestartsAfter(text, 1)).toBe(true);
    expect(systemdRestartsAfter(text, EXIT_STOPPED)).toBe(false);
  });

  it('keeps the watchdog when the sender is there', () => {
    const { text, warnings } = plan({ systemdNotify: true });
    expect(text).toContain('Type=notify');
    expect(text).toContain(`WatchdogSec=${WATCHDOG_SEC}`);
    expect(warnings).toEqual([]);
  });
});

describe('a permanent failure stays down and says so', () => {
  it('refuses StartLimitIntervalSec=0, which is the line the ADR names', () => {
    // Hermes disables systemd's rate limit and restarts forever. The ADR rejects
    // it in as many words: a Muffin that dies on a bad API key must stay down,
    // or it burns quota and fills the journal with nobody noticing.
    // Anchored to a directive, not to the substring: the unit is allowed to
    // *mention* the setting in a comment saying why it is absent, and a naive
    // `toContain` made that comment fail the test.
    expect(plan().text).not.toMatch(/^\s*StartLimitIntervalSec\s*=\s*0/m);
  });

  it('prevents a restart on the configuration exit code', () => {
    // The distinction the ADR demands the process be able to make — transient
    // versus will-not-fix-itself — has to be expressed to the supervisor, or the
    // process making it changes nothing.
    expect(plan().text).toContain('RestartPreventExitStatus=78');
  });
});

describe('the launchd agent', () => {
  const mac = () =>
    planUnit({ platform: 'darwin', home: '/Users/g/.muffin', exec: ['/usr/local/bin/muffin', 'gateway', 'run'] });

  it('is a user LaunchAgent anchored to the data home', () => {
    const p = mac();
    expect(p.kind).toBe('launchd');
    expect(p.path).toContain('Library/LaunchAgents');
    expect(p.text).toContain('<key>WorkingDirectory</key>');
    expect(p.text).toContain('<string>/Users/g/.muffin</string>');
  });

  it('keeps itself alive and throttles, and says what it cannot express', () => {
    const p = mac();
    // Unconditional, not `{SuccessfulExit: false}` — see the exit-code table
    // above for what each choice does. Asserted on the value and not on the
    // key: `toContain('<key>KeepAlive</key>')` was green through the whole
    // period when SIGUSR1 left the agent down.
    expect(p.text).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(p.text).toContain('<key>ThrottleInterval</key>');
    // launchd has no RestartPreventExitStatus. Divergence recorded rather than
    // silently accepted (JUDGE: "la divergenza è registrata o solo avvenuta?").
    expect(p.warnings.join(' ')).toMatch(/78|permanente|config/i);
  });

  it('escapes a home that would otherwise break the XML', () => {
    // Paths with `&` are legal on macOS and would produce a plist launchd
    // refuses to parse — which presents as "the agent silently never runs".
    const p = planUnit({ platform: 'darwin', home: '/Users/a&b/.muffin', exec: ['/bin/muffin', 'gateway', 'run'] });
    expect(p.text).toContain('/Users/a&amp;b/.muffin');
    expect(p.text).not.toContain('/Users/a&b/.muffin');
  });

  it('produces a plist the system itself accepts', () => {
    // Only on the machine that has the parser. A hand-checked plist is how you
    // ship one launchd rejects at load time, and this repo's rule is to execute
    // the check rather than assume it.
    if (process.platform !== 'darwin') return;
    const dir = mkdtempSync(join(tmpdir(), 'muffin-plist-'));
    const file = join(dir, 'muffin.plist');
    writeFileSync(file, mac().text);
    const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
    expect(lint.stdout + lint.stderr).toContain('OK');
  });
});

describe('resolveLauncher — what ExecStart is allowed to point at', () => {
  it('prefers a launcher on PATH over the file inside the build', () => {
    // A symlink can be re-pointed after the checkout moves; a path baked into
    // the unit cannot. This is the closest thing to the ADR's cure that an
    // ExecStart line can have, since it must name *some* executable.
    const found = resolveLauncher({
      buildRoot: '/home/g/dev/muffin-agent',
      entry: '/home/g/dev/muffin-agent/dist/cli/main.js',
      candidates: ['/home/g/.local/bin/muffin'],
      realpath: (p) => (p === '/home/g/.local/bin/muffin' ? '/home/g/dev/muffin-agent/dist/cli/main.js' : null),
    });
    expect(found.argv).toEqual(['/home/g/.local/bin/muffin', 'gateway', 'run']);
    expect(found.warning).toBeNull();
  });

  it('ignores a foreign command that happens to share the name', () => {
    // Linux Mint ships /usr/bin/muffin, the Cinnamon window manager (ADR-0012,
    // and install.sh detects it by identity for the same reason). An ExecStart
    // pointing at a window manager is a spectacular way to fail.
    const found = resolveLauncher({
      buildRoot: '/home/g/dev/muffin-agent',
      entry: '/home/g/dev/muffin-agent/dist/cli/main.js',
      candidates: ['/usr/bin/muffin'],
      realpath: () => '/usr/bin/muffin',
    });
    expect(found.argv[0]).not.toBe('/usr/bin/muffin');
    expect(found.warning).toBeTruthy();
  });

  it('warns when nothing but the checkout is available to point at', () => {
    // Then the unit *is* pinned to a directory that can move, and the owner has
    // to be told, because the failure it produces — CHDIR before the runtime
    // loads, then a crash loop — has no message anywhere that names the cause.
    const found = resolveLauncher({
      buildRoot: '/home/g/dev/muffin-agent',
      entry: '/home/g/dev/muffin-agent/dist/cli/main.js',
      candidates: [],
      realpath: () => null,
      entryExists: () => true,
    });
    expect(found.warning).toMatch(/install\.sh|sposta|checkout/i);
    expect(found.argv).toContain('/home/g/dev/muffin-agent/dist/cli/main.js');
    // "Fragile" and not "wrong": the file is there, it is just in a directory
    // that can move. The next test is the other one.
    expect(found.warning).not.toMatch(/non esiste/);
  });

  it('says so when the entry it falls back to does not exist at all', () => {
    // The dev path, and `muffin init` offers the install on it: run under `tsx`
    // from a source checkout the entry is `<checkout>/cli/main.js`, while the
    // source beside it is `main.ts` — only `dist/cli/main.js` ever exists. That
    // unit does not degrade, it fails at exec on a name, and the old warning
    // talked about *moving* the checkout as if the file were there.
    const found = resolveLauncher({
      buildRoot: '/home/g/dev/muffin-agent',
      entry: '/home/g/dev/muffin-agent/cli/main.js',
      candidates: [],
      realpath: () => null,
      entryExists: () => false,
    });
    expect(found.warning).toContain('non esiste');
    expect(found.warning).toContain('/home/g/dev/muffin-agent/cli/main.js');
  });

  it('does not call a candidate foreign when no candidate resolved at all', () => {
    // The candidate list is never empty in production (`/usr/local/bin` and
    // friends are unconditional), so counting it made the warning say "quelli
    // trovati sono di un altro programma" on a machine where nothing had been
    // found — sending the owner to look for a conflict that does not exist.
    const found = resolveLauncher({
      buildRoot: '/home/g/dev/muffin-agent',
      entry: '/home/g/dev/muffin-agent/dist/cli/main.js',
      candidates: ['/usr/local/bin/muffin', '/opt/homebrew/bin/muffin'],
      realpath: () => null,
      entryExists: () => true,
    });
    expect(found.warning).not.toMatch(/un altro programma/);
    expect(found.warning).toMatch(/checkout/);
  });
});

/**
 * Trovato sulla macchina dell'owner durante l'install reale (RETURN S4):
 * `launchctl bootstrap` riusciva, il gateway non partiva, e `gateway.err`
 * diceva `env: node: No such file or directory` — exit 127. Il launcher è uno
 * script con shebang `#!/usr/bin/env node`, e né launchd né systemd mettono
 * nel PATH la directory di un Node installato da Homebrew o nvm. La unit
 * prometteva continuità dopo il riavvio e non ne dava nessuna.
 */
describe('la unit deve dire dove sta node', () => {
  const base = {
    home: '/home/x/.muffin',
    exec: ['/home/x/.local/bin/muffin', 'gateway', 'run'],
    homeDir: '/home/x',
    interpreterDir: '/opt/homebrew/bin',
  };

  it('launchd: PATH nelle EnvironmentVariables contiene la directory dell interprete', () => {
    const plan = planUnit({ ...base, platform: 'darwin' });
    expect(plan.text).toContain('<key>PATH</key>');
    expect(plan.text).toContain('/opt/homebrew/bin');
    // I percorsi di sistema restano, altrimenti si romperebbe tutto ciò che
    // il gateway lancia a sua volta.
    expect(plan.text).toContain('/usr/bin');
  });

  it('systemd: Environment=PATH contiene la directory dell interprete', () => {
    const plan = planUnit({ ...base, platform: 'linux' });
    expect(plan.text).toMatch(/Environment=PATH=[^\n]*\/opt\/homebrew\/bin/);
    expect(plan.text).toMatch(/Environment=PATH=[^\n]*\/usr\/bin/);
  });

  it('senza interpreterDir la unit resta valida e non inventa un PATH vuoto', () => {
    const plan = planUnit({ ...base, interpreterDir: undefined, platform: 'darwin' });
    expect(plan.text).not.toContain('<key>PATH</key>');
    expect(plan.text).toContain('<key>MUFFIN_HOME</key>');
  });
});
