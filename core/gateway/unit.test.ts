import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRAIN_BUDGET_MS, EXIT_STOPPED } from './service.js';
import { EXIT_PERMANENT, planUnit, resolveLauncher, SERVICE_NAME, WATCHDOG_SEC,
  resolveInterpreterDir,
  type InterpreterProbes,
} from './unit.js';

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
    homeDir: '/home/g',
    // The Linux Home is a system service: the planner refuses to guess the
    // user, so every linux plan in this file names it explicitly.
    serviceUser: 'g',
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

/**
 * Se launchd riavvia dopo un'uscita con questo codice, **e con questo
 * semaforo**.
 *
 * Il secondo parametro è la parte nuova: da quando il KeepAlive è condizionato
 * a un `PathState`, «riavvia?» non è più una domanda sul solo codice di uscita.
 * `stopped: true` significa che il file semaforo esiste, cioè che qualcuno ha
 * chiesto uno stop.
 */
function launchdRestartsAfter(text: string, code: number, stopped = false): boolean {
  const keepAlive = /<key>KeepAlive<\/key>\s*(<true\/>|<false\/>|<dict>[\s\S]*?<\/dict>)/.exec(text)?.[1];
  if (keepAlive === undefined || keepAlive === '<false/>') return false;
  if (keepAlive === '<true/>') return true;
  const successful = /<key>SuccessfulExit<\/key>\s*<(true|false)\/>/.exec(keepAlive)?.[1];
  if (successful === 'false') return code !== 0;
  if (successful === 'true') return code === 0;
  // `PathState` con `<false/>`: vivo finché quel file NON esiste
  // (launchd.plist(5)). È l'unico modo di dire a launchd «questo stop è voluto»
  // che launchd sappia leggere.
  const pathState = /<key>PathState<\/key>\s*<dict>\s*<key>([^<]*)<\/key>\s*<(true|false)\/>/.exec(keepAlive);
  if (pathState) {
    const vivoSeEsiste = pathState[2] === 'true';
    return vivoSeEsiste ? stopped : !stopped;
  }
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

  it('lands in the system unit directory, with User= and no linger anywhere', () => {
    // D2: the Linux Home is a system service under a dedicated unprivileged
    // user — the `--user` + linger model is retired, not deprecated. A path
    // under `systemd/user`, a linger command, or a missing User= is the old
    // architecture coming back.
    const p = plan();
    expect(p.path).toBe('/etc/systemd/system/muffin-gateway.service');
    expect(p.text).toMatch(/^User=g$/m);
    expect(p.text).toContain('WantedBy=multi-user.target');
    expect(p.text).not.toContain('--user');
    expect(p.text).not.toContain('linger');
    expect(p.commands.join(' ')).not.toContain('linger');
    expect(p.needsRoot).toBe(true);
  });

  it('refuses to guess the user, and refuses root most of all', () => {
    // A unit without User= runs as root. The planner fails closed instead of
    // emitting it: this is falsifier 3 wearing a unit test.
    expect(() => plan({ serviceUser: undefined })).toThrow(/serviceUser/);
    expect(() => plan({ serviceUser: '' })).toThrow(/serviceUser/);
    expect(() => plan({ serviceUser: 'root' })).toThrow(/root/);
  });

  it('names encrypted credentials explicitly, or names none at all', () => {
    // One LoadCredentialEncrypted line per provisioned name; zero lines when
    // the backend is the file store — a unit that names no secret it was
    // never given is honest, and a file-backend service reads its 0600 files
    // exactly as before.
    expect(plan().text).not.toContain('LoadCredentialEncrypted');
    const p = plan({ credentials: ['provider_api_key', 'telegram_token'] });
    expect(p.text).toContain('LoadCredentialEncrypted=provider_api_key:/etc/credstore.encrypted/provider_api_key.cred');
    expect(p.text).toContain('LoadCredentialEncrypted=telegram_token:/etc/credstore.encrypted/telegram_token.cred');
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

  it('systemd: uno stop voluto non lascia la unit in `failed`, un guasto permanente sì', () => {
    // `RestartPreventExitStatus` dice solo di non riavviare — non dice che
    // l'uscita andava bene. Senza `SuccessExitStatus=143` ogni `muffin gateway
    // stop` lasciava la unit in stato failed: `systemctl --failed` la
    // elencava, e la sonda is-failed di doctor avrebbe allarmato a ogni arresto
    // voluto — il modo più rapido per insegnare a ignorarla. Il guasto
    // permanente invece DEVE restare failed: è il rosso che qualcuno deve
    // guardare, e la stessa riga che assolve il 143 non deve assolvere lui.
    const codes = (/^SuccessExitStatus=(.*)$/m.exec(plan().text)?.[1] ?? '')
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map(Number);
    expect(codes).toContain(EXIT_STOPPED);
    expect(codes).not.toContain(EXIT_PERMANENT);
  });

  /**
   * launchd non ha `RestartPreventExitStatus`, quindi non sa distinguere i
   * codici di uscita — ma sa leggere il filesystem. Il semaforo è la
   * traduzione: ciò che systemd dice per codice, qui si dice per file.
   *
   * Misurato sulla macchina dell'owner il 28/08/2026: «ho buttato giù il
   * gateway e lo ha riportato su da solo, questo non va bene». Prima, ogni
   * riga qui sotto era `true`.
   */
  it('launchd: rialza un crash, e NON rialza uno stop chiesto', () => {
    const { text, warnings } = planUnit({
      platform: 'darwin',
      home: '/Users/g/.muffin',
      exec: ['/usr/local/bin/muffin', 'gateway', 'run'],
    });
    // Senza semaforo si comporta come prima, e deve: un crash torna su, e il
    // drenaggio da SIGUSR1 — che esce 0 — pure. È il caso che
    // `{SuccessfulExit: false}` sbagliava.
    expect(launchdRestartsAfter(text, 0)).toBe(true);
    expect(launchdRestartsAfter(text, 1)).toBe(true);
    expect(launchdRestartsAfter(text, EXIT_PERMANENT)).toBe(true);
    // Col semaforo, no. È la riga che l'owner ha chiesto.
    expect(launchdRestartsAfter(text, EXIT_STOPPED, true)).toBe(false);
    expect(launchdRestartsAfter(text, 1, true)).toBe(false);
    // Il semaforo è quello di `paths(home).gatewayStopped`, non un percorso
    // inventato qui: se i due divergono, launchd guarda un file che nessuno
    // scrive e il difetto torna, muto.
    expect(text).toContain('/Users/g/.muffin/gateway.stopped');
    // Resta una cosa che launchd non sa esprimere, e va ancora detta.
    expect(warnings.join(' ')).toMatch(new RegExp(`${EXIT_PERMANENT}`));
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

describe('la unit systemd passa il parser di systemd', () => {
  /**
   * La controparte Linux di `plutil -lint`, e per due anni non c'è stata.
   *
   * Il plist aveva un test che lo dà in pasto al parser vero; la unit systemd —
   * cioè il file di **produzione**, perché Muffin vive su una VPS Linux — era
   * verificata solo da `toContain` su stringhe. Una direttiva scritta male non
   * degrada: `systemctl enable --now` fallisce, oppure la unit carica e
   * `Restart=always` cicla. Ed è lo stesso difetto che questa slice ha già
   * trovato altrove: la prova esisteva per la piattaforma di sviluppo.
   *
   * Aggravante che rendeva la cosa invisibile: in CI **non c'è nessun runner
   * macOS**, quindi il test del plist esce dal `return` qui sotto a ogni giro e
   * si conta come passato. L'unica prova "il sistema accetta questo file" che
   * il repo aveva girava solo sul portatile dell'owner.
   *
   * `ExecStart`, `WorkingDirectory` e la home puntano a file e directory che
   * esistono davvero: `systemd-analyze verify` si lamenta di un eseguibile
   * assente, e una lamentela legittima su un finto path renderebbe il test
   * rumoroso invece che informativo.
   */
  it('produces a systemd unit the system itself accepts', () => {
    const required = process.env['MUFFIN_REQUIRE_SYSTEMD'] === '1';
    if (process.platform !== 'linux' && !required) return;

    const probe = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
    const haveParser = probe.error === undefined && probe.status === 0;
    if (!haveParser) {
      // Su Linux con MUFFIN_REQUIRE_SYSTEMD=1 (la CI, che sta al posto della
      // VPS) un parser assente è un difetto della macchina di prova, non una
      // proprietà da assecondare in silenzio — stessa disciplina di
      // MUFFIN_REQUIRE_SANDBOX in `core/sandbox/executor.test.ts`.
      if (required) {
        throw new Error(
          `MUFFIN_REQUIRE_SYSTEMD=1 ma systemd-analyze non è eseguibile qui ` +
            `(${probe.error?.message ?? `exit ${String(probe.status)}`}): la unit di produzione resterebbe non verificata`,
        );
      }
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), 'muffin-unit-'));
    const launcher = join(dir, 'muffin');
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const file = join(dir, 'muffin-gateway.service');
    writeFileSync(
      file,
      plan({ home: dir, exec: [launcher, 'gateway', 'run'], serviceUser: 'g', credentials: ['provider_api_key'] }).text,
    );

    const verify = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
    // L'output intero nel messaggio: un fallimento qui deve dire *quale*
    // direttiva, non solo che il file non va bene.
    expect(`${verify.stdout ?? ''}${verify.stderr ?? ''}`.trim()).toBe('');
    expect(verify.status).toBe(0);
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

  it('resta vivo finché nessuno ha chiesto il contrario, e throttla', () => {
    const p = mac();
    // `PathState`, non `<true/>` e non `{SuccessfulExit: …}` — la tabella dei
    // codici qui sopra dice cosa fa ognuna delle tre. Asserito sul valore e non
    // sulla chiave: `toContain('<key>KeepAlive</key>')` è rimasto verde per
    // tutto il periodo in cui SIGUSR1 lasciava l'agente giù, e sarebbe rimasto
    // verde anche adesso.
    expect(p.text).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>PathState<\/key>/);
    expect(p.text).toMatch(/gateway\.stopped<\/key>\s*<false\/>/);
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
    serviceUser: 'x',
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

/**
 * Il path dell'interprete non deve scadere.
 *
 * `dirname(process.execPath)` è la risposta ovvia ed è quella che scade: Node
 * risolve `execPath` attraverso i symlink, quindi sulla macchina dell'owner è
 * `/opt/homebrew/Cellar/node@22/22.22.2_2/bin` — una directory con dentro una
 * versione **e una revisione**, che Homebrew cancella al prossimo upgrade.
 *
 * È esattamente il guasto per cui `interpreterDir` esiste (`env: node: No such
 * file or directory`, exit 127, ogni dieci secondi): la riparazione aveva
 * sostituito «nessun node sul PATH» con «un path con una data di scadenza», e
 * `gateway.err` su quella macchina porta tutti e due gli episodi.
 */
describe("l'interprete della unit non deve scadere", () => {
  const HOMEBREW_REAL = '/opt/homebrew/Cellar/node@22/22.22.2_2/bin/node';

  /** `resolves`: dove porta ogni percorso. Assente = non risolve (non esiste). */
  const probes = (spec: { path: string[]; resolves?: Record<string, string> }): InterpreterProbes => ({
    pathEntries: () => spec.path,
    realpath: (p) => (spec.resolves ?? {})[p] ?? null,
  });

  it('preferisce il link stabile di Homebrew alla directory Cellar che verrà cancellata', () => {
    const dir = resolveInterpreterDir(
      HOMEBREW_REAL,
      probes({
        path: ['/opt/homebrew/bin', '/usr/bin', '/bin'],
        resolves: { '/opt/homebrew/bin/node': HOMEBREW_REAL },
      }),
    );
    expect(dir).toBe('/opt/homebrew/bin');
  });

  it('su una distro dove `node` è un file vero non cambia niente', () => {
    // Nessun link da preferire: `/usr/bin` è già stabile di suo, e inventare
    // un altro percorso sarebbe una supposizione, non una riparazione.
    const dir = resolveInterpreterDir('/usr/bin/node', probes({ path: ['/usr/local/bin', '/usr/bin', '/bin'] }));
    expect(dir).toBe('/usr/bin');
  });

  it('ignora un link che porta a un altro interprete', () => {
    // Sarebbe il guasto peggiore dei due: la unit partirebbe sotto un Node su
    // cui questa installazione non è mai stata provata, e partirebbe zitta.
    const dir = resolveInterpreterDir(
      HOMEBREW_REAL,
      probes({
        path: ['/usr/local/bin', '/opt/homebrew/bin'],
        resolves: { '/usr/local/bin/node': '/opt/homebrew/Cellar/node@20/20.1.0/bin/node' },
      }),
    );
    expect(dir).toBe('/opt/homebrew/Cellar/node@22/22.22.2_2/bin');
  });

  it('vale anche quando è la **directory** a essere linkata, non il file', () => {
    // Il caso che la prima stesura sbagliava: dove `/usr/local/bin` è una
    // directory-symlink, il `node` dentro è un file ordinario. Chiedere che il
    // file fosse un symlink rifiutava proprio il percorso stabile da trovare.
    const dir = resolveInterpreterDir(
      HOMEBREW_REAL,
      probes({ path: ['/usr/local/bin'], resolves: { '/usr/local/bin/node': HOMEBREW_REAL } }),
    );
    expect(dir).toBe('/usr/local/bin');
  });

  it('una directory del PATH senza node non conta', () => {
    const dir = resolveInterpreterDir(HOMEBREW_REAL, probes({ path: ['/opt/homebrew/bin'] }));
    expect(dir).toBe('/opt/homebrew/Cellar/node@22/22.22.2_2/bin');
  });

  it('con un PATH vuoto resta la directory dell interprete, come prima', () => {
    expect(resolveInterpreterDir(HOMEBREW_REAL, probes({ path: [] }))).toBe(
      '/opt/homebrew/Cellar/node@22/22.22.2_2/bin',
    );
  });

  it('la directory stabile finisce davvero nel PATH della unit, su entrambe le piattaforme', () => {
    // La cucitura: risolvere bene e poi non scriverlo sarebbe lo stesso guasto.
    const stable = resolveInterpreterDir(
      HOMEBREW_REAL,
      probes({ path: ['/opt/homebrew/bin'], resolves: { '/opt/homebrew/bin/node': HOMEBREW_REAL } }),
    );
    for (const platform of ['linux', 'darwin'] as const) {
      const plan = planUnit({
        platform,
        home: '/tmp/muffin-home',
        exec: ['/tmp/muffin-home/bin/muffin', 'gateway', 'run'],
        homeDir: '/tmp/fakehome',
        serviceUser: 't',
        interpreterDir: stable,
      });
      expect(plan.text).toContain('/opt/homebrew/bin');
      expect(plan.text).not.toContain('Cellar');
    }
  });
});

/**
 * La lista stampata e quella eseguita non sono la stessa cosa.
 *
 * `commands` è prosa per un terminale: contiene una riga di commento, un
 * `$(id -u)` che espande la shell, un `"$USER"` e un `# perché` in coda proprio
 * sul passo che la gente salta. Eseguirla verbatim è il modo in cui una lista
 * da leggere diventa in silenzio un programma sbagliato — e i due campi nascono
 * accanto perché non possano divergere.
 */
describe('activation — la forma eseguibile, accanto a quella da leggere', () => {
  const base = {
    home: '/home/o/.muffin',
    exec: ['/home/o/.local/bin/muffin', 'gateway', 'run'],
    homeDir: '/home/o',
    serviceUser: 'o',
  };

  it('senza sapere chi installa non indovina: la lista resta da leggere', () => {
    // `gui/$(id -u)` va benissimo stampato. Qui no: sbagliare uid vuol dire
    // registrare l'agent di qualcun altro.
    expect(planUnit({ ...base, platform: 'linux' }).activation).toEqual([]);
    expect(planUnit({ ...base, platform: 'darwin' }).activation).toEqual([]);
  });

  it('systemd: rilegge e abilita sul bus di sistema, con sudo, senza linger', () => {
    const plan = planUnit({ ...base, platform: 'linux', identity: { user: 'owner', uid: 1000 } });
    expect(plan.activation.map((s) => s.argv)).toEqual([
      ['sudo', 'systemctl', 'daemon-reload'],
      ['sudo', 'systemctl', 'enable', '--now', `${SERVICE_NAME}.service`],
    ]);
    // La user unit è andata in pensione con D2: nessun --user, nessun linger.
    // Se tornano, è la vecchia architettura che rientra dalla finestra.
    for (const s of plan.activation) {
      expect(s.argv).not.toContain('--user');
      expect(s.argv).not.toContain('enable-linger');
      for (const a of s.argv) expect(a).not.toMatch(/[$#"]/);
    }
  });

  it("launchd: solo il bootstrap — `print` è per gli occhi e `bootout` spegnerebbe", () => {
    const plan = planUnit({ ...base, platform: 'darwin', homeDir: '/Users/o', identity: { user: 'o', uid: 501 } });
    expect(plan.activation).toHaveLength(1);
    expect(plan.activation[0]?.argv.slice(0, 3)).toEqual(['launchctl', 'bootstrap', 'gui/501']);
    expect(plan.activation[0]?.argv[3]).toBe(plan.path);
  });

  it('ogni passo dice perché esiste, perché viene stampato prima di partire', () => {
    const plan = planUnit({ ...base, platform: 'linux', identity: { user: 'owner', uid: 1000 } });
    for (const s of plan.activation) expect(s.why.length).toBeGreaterThan(10);
  });
});
