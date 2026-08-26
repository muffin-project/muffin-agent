import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { LAUNCHD_LABEL, planUnit, SERVICE_NAME } from './unit.js';

/**
 * "Is the supervisor actually holding this up" — `doctor`'s missing half.
 *
 * `readGateway` (lock.ts) answers "is a gateway process alive right now",
 * which a bare `muffin gateway run` typed into a terminal also makes true.
 * ADR-0035's own words, owner, A1: continuity belongs to Muffin, not to that
 * pid. A gateway with no supervisor behind it dies the moment the terminal
 * does, does not come back at boot, and does not survive a Linux logout
 * without linger — and before this file `doctor` had no way to tell that
 * gateway from a properly supervised one; both read "attivo · pid …".
 *
 * Pure core, injected probes — the same split `unit.ts` already uses for
 * `planUnit`/`resolveLauncher`: `doctor` runs on the owner's real machine and
 * has to reach a real `systemctl`/`loginctl`/`launchctl`, a test must reach
 * none of them. Every probe is optional so a test only supplies the one it is
 * exercising — a Linux-shaped test has no business stubbing `launchdLoaded`,
 * and an absent probe degrades to "not confirmed" rather than throwing.
 *
 * **Never `fail`.** A missing supervisor is a real gap the owner should close
 * before trusting Muffin to survive a reboot, but it is not the class of
 * broken `doctor` reserves `fail` for (config missing, root of trust
 * refusing) — the gateway, if one happens to be running, still works today.
 */

export type SupervisorProbes = {
  /** Is the unit/plist file where `planUnit` would write it? */
  unitFileExists: (path: string) => boolean;
  /** Linux: `systemctl --user is-enabled <service>` exited 0. */
  systemdEnabled?: () => boolean;
  /**
   * Linux: `systemctl --user is-failed <service>` exited 0 — note the polarity,
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
  /** Linux: `loginctl show-user <user> -p Linger` says `Linger=yes` — without it the user unit dies at logout. */
  lingerEnabled?: () => boolean;
  /** macOS: `launchctl print gui/$(id -u)/<label>` exited 0. */
  launchdLoaded?: () => boolean;
};

export type SupervisorStatus =
  | { engaged: true; detail: string }
  | { engaged: false; detail: string; remedy: string };

/**
 * The pure check. `home`/`homeDir`/`configHome` feed `planUnit` for the exact
 * path `muffin gateway install` would use — the same computation, not a
 * second one that could drift from it.
 */
export function checkSupervisor(
  platform: NodeJS.Platform,
  home: string,
  gatewayRunning: boolean,
  probes: SupervisorProbes,
  homeDir: string = homedir(),
  configHome: string | undefined = process.env['XDG_CONFIG_HOME'],
): SupervisorStatus {
  // `exec`'s content never reaches `.path` (systemdPlan/launchdPlan in
  // unit.ts compute it from platform/home/homeDir/configHome alone) — a
  // placeholder here cannot make this check look at the wrong file.
  const plan = planUnit({
    platform,
    home,
    exec: ['muffin', 'gateway', 'run'],
    homeDir,
    ...(configHome ? { configHome } : {}),
  });

  if (!probes.unitFileExists(plan.path)) {
    return gatewayRunning
      ? {
          engaged: false,
          detail: `nessuna unit/plist in ${plan.path}: questo gateway vive finché il terminale che l'ha lanciato vive`,
          remedy: '`muffin gateway install --write`, poi i comandi che stampa per attivarla',
        }
      : {
          engaged: false,
          detail: `nessuna unit/plist in ${plan.path}: il gateway non riparte da solo al boot`,
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
      remedy: `systemctl --user enable --now ${SERVICE_NAME}.service`,
    };
  }
  // Prima del linger, di proposito: «è giù adesso e non torna» batte «morirà
  // al prossimo logout». Un servizio failed è già il guasto che l'altro
  // controllo si limita a prevedere.
  if (probes.systemdFailed?.() ?? false) {
    return {
      engaged: false,
      detail:
        `${plan.path} è enabled ma il servizio è in stato failed — ` +
        `su questa unit non riparte da solo (RestartPreventExitStatus), quindi resta giù finché non lo si guarda`,
      remedy: `systemctl --user status ${SERVICE_NAME}.service, e journalctl --user -u ${SERVICE_NAME}.service -n 50 per il perché`,
    };
  }
  if (!(probes.lingerEnabled?.() ?? false)) {
    return {
      engaged: false,
      detail: `${plan.path} enabled, ma senza linger muore al logout`,
      remedy: 'loginctl enable-linger "$USER"',
    };
  }
  return { engaged: true, detail: `${plan.path} — enabled, linger attivo` };
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
  return {
    unitFileExists: (path) => existsSync(path),
    systemdEnabled: () => ok('systemctl', ['--user', 'is-enabled', '--quiet', `${SERVICE_NAME}.service`]),
    // Polarità invertita rispetto a tutte le altre sonde: `is-failed` esce 0
    // **quando è fallito**. Quindi qui `ok(...) === true` significa "rotto", e
    // il collasso a `false` di una sonda che non parte resta la lettura
    // prudente giusta — non confermato, non "sicuramente sano".
    systemdFailed: () => ok('systemctl', ['--user', 'is-failed', '--quiet', `${SERVICE_NAME}.service`]),
    lingerEnabled: () => {
      try {
        // `userInfo().username` e non `process.env['USER']`: sotto il gestore
        // systemd `USER` può non esserci affatto — la unit esporta solo
        // MUFFIN_HOME e PATH (unit.ts) — e `loginctl show-user ""` fallisce,
        // che questa sonda leggeva come "linger assente". Cioè `doctor`
        // lanciato da un job diceva all'owner di abilitare il linger su una
        // macchina dove era già attivo.
        const result = spawnSync('loginctl', ['show-user', process.env['USER'] || userInfo().username, '-p', 'Linger'], {
          timeout: 2000,
        });
        return result.error === undefined && result.status === 0 && /Linger=yes/.test(result.stdout?.toString() ?? '');
      } catch {
        return false;
      }
    },
    launchdLoaded: () => ok('launchctl', ['print', `gui/${process.getuid?.() ?? ''}/${LAUNCHD_LABEL}`]),
  };
}
