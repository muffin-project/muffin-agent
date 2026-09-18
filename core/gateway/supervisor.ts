import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LAUNCHD_LABEL, planUnit, SERVICE_NAME } from './unit.js';

/**
 * "Is the supervisor actually holding this up" — `doctor`'s missing half.
 *
 * `readGateway` (lock.ts) answers "is a gateway process alive right now",
 * which a bare `muffin gateway run` typed into a terminal also makes true.
 * ADR-0035's own words, owner, A1: continuity belongs to Muffin, not to that
 * pid. A gateway with no supervisor behind it dies the moment the terminal
 * does and does not come back at boot — and before this file `doctor` had no
 * way to tell that gateway from a properly supervised one; both read
 * "attivo · pid …".
 *
 * Pure core, injected probes — the same split `unit.ts` already uses for
 * `planUnit`/`resolveLauncher`: `doctor` runs on the owner's real machine and
 * has to reach a real `systemctl`/`launchctl`, a test must reach none of
 * them. Every probe is optional so a test only supplies the one it is
 * exercising — a Linux-shaped test has no business stubbing `launchdLoaded`,
 * and an absent probe degrades to "not confirmed" rather than throwing.
 *
 * **Never `fail`.** A missing supervisor is a real gap the owner should close
 * before trusting Muffin to survive a reboot, but it is not the class of
 * broken `doctor` reserves `fail` for (config missing, root of trust
 * refusing) — the gateway, if one happens to be running, still works today.
 *
 * Linux is a SYSTEM service since D2 (`User=` + no linger + no user bus).
 * There is deliberately no linger probe anymore: nothing on this path dies
 * at logout, so there is nothing to warn about — and a stale linger warning
 * would teach the owner to maintain a mechanism that no longer exists.
 */

export type SupervisorProbes = {
  /** Is the unit/plist file where `planUnit` would write it? */
  unitFileExists: (path: string) => boolean;
  /** Linux: `systemctl is-enabled <service>` exited 0 (system bus, no --user). */
  systemdEnabled?: () => boolean;
  /**
   * Linux: `systemctl is-failed <service>` exited 0 — note the polarity,
   * that command answers *yes it is failed* with a zero exit.
   *
   * `is-enabled` answers a question about the **future** (will systemd start
   * this at boot), and until this probe existed it was the only question asked.
   * A unit can be enabled and dead at the same time, and on this unit that is
   * not a transient: `RestartPreventExitStatus` (unit.ts) deliberately keeps
   * systemd from restarting a permanent failure, so `failed` means *nothing is
   * coming back on its own*. That is exactly the state `doctor` existed to
   * catch, and it was reporting it green.
   */
  systemdFailed?: () => boolean;
  /**
   * Linux: who the system service runs as (`systemctl show -p User`), or
   * `null` when the unit is not loaded enough to answer. Empty string means
   * the unit sets no `User=` — i.e. it runs as root — which is a mismatch
   * against any dedicated user, never a pass.
   */
  serviceUser?: () => string | null;
  /**
   * Linux: the retired `--user` unit still exists under this home's user
   * systemd directory. It shadows nothing mechanically (different bus), but
   * an owner who maintains it maintains a corpse — and a future `--user`
   * start would split the Home in two.
   */
  userUnitShadow?: () => boolean;
  /** macOS: `launchctl print gui/$(id -u)/<label>` exited 0. */
  launchdLoaded?: () => boolean;
};

export type SupervisorStatus =
  | { engaged: true; detail: string }
  | { engaged: false; detail: string; remedy: string };

/**
 * The pure check. `home`/`homeDir`/`systemDir` feed `planUnit` for the exact
 * path `muffin gateway install` would use — the same computation, not a
 * second one that could drift from it.
 *
 * `serviceUser` is the dedicated user the Linux system service must run as
 * (D1/D2). `doctor` passes the current user; tests pass an explicit name.
 * It is required on Linux because `planUnit` refuses to guess it — and a
 * check that guessed it would bless whatever the file says.
 */
export function checkSupervisor(
  platform: NodeJS.Platform,
  home: string,
  gatewayRunning: boolean,
  probes: SupervisorProbes,
  homeDir: string = homedir(),
  configHome: string | undefined = process.env['XDG_CONFIG_HOME'],
  serviceUser?: string,
  systemDir?: string,
): SupervisorStatus {
  // `exec`'s content never reaches `.path` (systemdPlan/launchdPlan in
  // unit.ts compute it from platform/home/homeDir/configHome/systemDir
  // alone) — a placeholder here cannot make this check look at the wrong
  // file. serviceUser is plumbed because the planner fails closed without
  // it on Linux, not because the path needs it.
  const plan = planUnit({
    platform,
    home,
    exec: ['muffin', 'gateway', 'run'],
    homeDir,
    ...(configHome ? { configHome } : {}),
    ...(platform === 'linux' && serviceUser ? { serviceUser } : {}),
    ...(platform === 'linux' && systemDir ? { systemDir } : {}),
  });

  if (!probes.unitFileExists(plan.path)) {
    const shadow = platform === 'linux' && (probes.userUnitShadow?.() ?? false);
    return gatewayRunning
      ? {
          engaged: false,
          detail: shadow
            ? `nessuna unit di sistema in ${plan.path}: c'è solo la vecchia user unit, andata in pensione con D2`
            : `nessuna unit/plist in ${plan.path}: questo gateway vive finché il terminale che l'ha lanciato vive`,
          remedy: '`muffin gateway install --write`, poi i comandi che stampa per attivarla',
        }
      : {
          engaged: false,
          detail: shadow
            ? `nessuna unit di sistema in ${plan.path}: c'è solo la vecchia user unit, andata in pensione con D2`
            : `nessuna unit/plist in ${plan.path}: il gateway non riparte da solo al boot`,
          remedy: '`muffin gateway install --write`',
        };
  }

  if (platform === 'darwin') {
    if (probes.launchdLoaded?.() ?? false) {
      return { engaged: true, detail: `${plan.path} — launchd lo tiene caricato` };
    }
    return {
      engaged: false,
      detail: `${plan.path} esiste ma launchd non lo ha (ancora) caricato`,
      remedy: `launchctl bootstrap gui/$(id -u) ${plan.path}`,
    };
  }

  if (!(probes.systemdEnabled?.() ?? false)) {
    return {
      engaged: false,
      detail: `${plan.path} esiste ma il servizio non è enabled`,
      remedy: `sudo systemctl enable --now ${SERVICE_NAME}.service`,
    };
  }
  // Prima di tutto il resto, di proposito: «è giù adesso e non torna» batte
  // ogni altra considerazione. Un servizio failed è già il guasto, gli altri
  // controlli prevedono guasti.
  if (probes.systemdFailed?.() ?? false) {
    return {
      engaged: false,
      detail:
        `${plan.path} è enabled ma il servizio è in stato failed — ` +
        `su questa unit non riparte da solo (RestartPreventExitStatus), quindi resta giù finché non lo si guarda`,
      remedy: `systemctl status ${SERVICE_NAME}.service, e journalctl -u ${SERVICE_NAME}.service -n 50 per il perché`,
    };
  }
  const runsAs = probes.serviceUser?.() ?? null;
  if (serviceUser !== undefined && runsAs !== null && runsAs !== serviceUser) {
    const seen = runsAs === '' ? '(root — nessuno User=)' : `'${runsAs}'`;
    return {
      engaged: false,
      detail:
        `${plan.path} gira come ${seen}, non come '${serviceUser}': ` +
        `il processo Muffin deve girare come utente dedicato, mai come root (D1)`,
      remedy: '`muffin gateway install --write --force`, poi i comandi che stampa per attivarla',
    };
  }
  if (probes.userUnitShadow?.() ?? false) {
    return {
      engaged: false,
      detail: `${plan.path} è a posto, ma esiste ancora la vecchia user unit: mantenerla significa mantenere un secondo supervisore morto`,
      remedy: "'systemctl --user disable --now muffin-gateway.service' (se esiste ancora un bus utente), poi cancella il file della user unit",
    };
  }
  return { engaged: true, detail: `${plan.path} — enabled, gira come ${serviceUser ?? runsAs ?? 'utente dedicato'}` };
}

/**
 * What `doctor` actually asks the OS. Never a hard failure of its own: every
 * probe is wrapped so a missing binary, a non-zero exit or a hang (`timeout`,
 * short — this runs inside a command an owner is waiting on) all collapse to
 * "not confirmed" rather than taking `doctor` down or making it wait. Not
 * `spawnSync('which', …)` for existence — `unitFileExists` is a plain
 * `existsSync`, the same PATH-free check `cli/gateway.ts`'s own
 * `hasSystemdNotify` uses and for the same reason.
 */
export function realSupervisorProbes(): SupervisorProbes {
  const ok = (cmd: string, args: string[]): boolean => {
    try {
      const result = spawnSync(cmd, args, { stdio: 'ignore', timeout: 2000 });
      return result.error === undefined && result.status === 0;
    } catch {
      return false;
    }
  };
  // The user systemd directory is where the RETIRED user unit would shadow
  // from. XDG_CONFIG_HOME is honoured the same way unit.ts honoured it for
  // user units — same computation, not a second one.
  const userShadowPath = (): string => {
    const base = process.env['XDG_CONFIG_HOME'] && process.env['XDG_CONFIG_HOME'].length > 0
      ? process.env['XDG_CONFIG_HOME']
      : join(homedir(), '.config');
    return join(base, 'systemd', 'user', `${SERVICE_NAME}.service`);
  };
  return {
    unitFileExists: (path) => existsSync(path),
    systemdEnabled: () => ok('systemctl', ['is-enabled', '--quiet', `${SERVICE_NAME}.service`]),
    // Polarità invertita rispetto a tutte le altre sonde: `is-failed` esce 0
    // **quando è fallito**. Quindi qui `ok(...) === true` significa "rotto", e
    // il collasso a `false` di una sonda che non parte resta la lettura
    // prudente giusta — non confermato, non "sicuramente sano".
    systemdFailed: () => ok('systemctl', ['is-failed', '--quiet', `${SERVICE_NAME}.service`]),
    // `systemctl show` esce 0 anche per una unit mai caricata, con valori
    // vuoti: vuoto qui significa "non confermato", NON "gira come root" —
    // quella lettura spetta al confronto in checkSupervisor, dove uno User=
    // assente su una unit caricata arriva come stringa vuota e non passa mai
    // il confronto con l'utente dedicato.
    serviceUser: () => {
      try {
        const result = spawnSync('systemctl', ['show', `${SERVICE_NAME}.service`, '-p', 'User', '--value'], {
          encoding: 'utf8',
          timeout: 2000,
        });
        if (result.error !== undefined || result.status !== 0) return null;
        const out = (result.stdout ?? '').trim();
        // Distingue "unit mai vista" (LoadState assente → null) da "vista ma
        // senza User=" (stringa vuota → mismatch voluto). Una seconda chiamata
        // costa 2s nel caso peggiore ed evita un falso rosso su ogni macchina
        // senza unit installata.
        const loaded = spawnSync('systemctl', ['show', `${SERVICE_NAME}.service`, '-p', 'LoadState', '--value'], {
          encoding: 'utf8',
          timeout: 2000,
        });
        if (loaded.error !== undefined || loaded.status !== 0) return null;
        return (loaded.stdout ?? '').trim() === 'not-found' ? null : out;
      } catch {
        return null;
      }
    },
    userUnitShadow: () => {
      try {
        return existsSync(userShadowPath());
      } catch {
        return false;
      }
    },
    launchdLoaded: () => ok('launchctl', ['print', `gui/${process.getuid?.() ?? ''}/${LAUNCHD_LABEL}`]),
  };
}
