import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DRAIN_BUDGET_MS } from './service.js';

/**
 * The supervisor's half, generated rather than pasted from a README.
 *
 * ADR-0035's research section is the specification, and one paragraph of it is
 * the reason this file has tests instead of being a template literal:
 *
 * > se l'unit punta `WorkingDirectory` a un checkout che poi si sposta, systemd
 * > fallisce allo CHDIR **prima che Python parta**, quindi l'auto-riparazione
 * > all'avvio non gira mai e *"`Restart=always` crash-loopa per sempre su una
 * > directory morta"*.
 *
 * So everything here is anchored to `~/.muffin`, which does not move, and the
 * one line that must name an executable — `ExecStart` — prefers the launcher
 * symlink `install.sh` creates over the file inside the build, because a
 * symlink can be re-pointed after a move and a baked path cannot.
 *
 * ## What is deliberately not here
 *
 * `StartLimitIntervalSec=0`. Hermes sets it and restarts forever; the ADR
 * refuses it by name. A Muffin that dies because the API key is wrong has to
 * stay down and say so, so the unit keeps systemd's default rate limit *and*
 * names the exit code that must never be retried.
 */

/**
 * How long systemd waits for a watchdog ping. The gateway pings at half of it
 * (`notify.ts`), so this is the ceiling on "up but wedged" going unnoticed.
 * A minute: long enough that a slow model call inside a tick cannot trip it,
 * short enough that a stuck gateway is restarted before the next hourly job.
 */
export const WATCHDOG_SEC = 60;

/** Pause between restarts. Long enough that a crash loop is visible as a loop. */
export const RESTART_SEC = 5;

/**
 * The supervisor must outlast our own drain, or it SIGKILLs in the middle of
 * the shutdown it asked for — losing exactly the turn the drain protects.
 * Derived, never typed twice.
 */
export const STOP_TIMEOUT_SEC = Math.ceil(DRAIN_BUDGET_MS / 1000) + 15;

/**
 * EX_CONFIG. The gateway exits with this when the failure will not fix itself
 * by retrying, and the unit tells systemd not to restart on it. This pair is
 * the "transitorio contro non si risolve riprovando" distinction the ADR
 * requires — either half alone does nothing.
 */
export const EXIT_PERMANENT = 78;

export const SERVICE_NAME = 'muffin-gateway';
export const LAUNCHD_LABEL = 'ai.muffin.gateway';

export type UnitPlan = {
  kind: 'systemd' | 'launchd';
  /** Where the file belongs on this platform. */
  path: string;
  text: string;
  /** What the owner runs to make it live. Never run for them. */
  commands: string[];
  /** What they need to know before trusting it. */
  warnings: string[];
};

export type UnitOptions = {
  platform: NodeJS.Platform;
  /** The **data** home (`~/.muffin`). Everything anchors here. */
  home: string;
  /** argv for ExecStart — see `resolveLauncher`. */
  exec: string[];
  configHome?: string;
  homeDir?: string;
};

export function planUnit(options: UnitOptions): UnitPlan {
  return options.platform === 'darwin' ? launchdPlan(options) : systemdPlan(options);
}

function systemdPlan({ home, exec, configHome, homeDir }: UnitOptions): UnitPlan {
  const dir = join(configHome ?? join(homeDir ?? homedir(), '.config'), 'systemd', 'user');
  const path = join(dir, `${SERVICE_NAME}.service`);
  const text = `[Unit]
Description=Muffin — runtime dell'agente personale
Documentation=https://github.com/muffin-ai/muffin
# La rete serve al primo turno, non all'avvio: Wants e non Requires, così un
# boot senza rete lascia comunque partire lo scheduler.
Wants=network-online.target
After=network-online.target

[Service]
# notify e non simple: READY=1 distingue "il processo è partito" da "sta
# servendo", e WATCHDOG=1 è l'unica cosa che vede un processo su ma piantato.
Type=notify
# Il datagram di notifica lo manda systemd-notify, cioè un figlio: senza questa
# riga systemd lo ignora "for security reasons" e il watchdog non viene mai
# alimentato — cioè uccide un gateway sano ogni WatchdogSec. Vedi notify.ts.
NotifyAccess=all
WatchdogSec=${WATCHDOG_SEC}

ExecStart=${exec.join(' ')}
# Ancorato alla home dei dati, MAI al checkout del codice: un checkout che si
# sposta fa fallire systemd allo CHDIR prima ancora che il runtime carichi, e
# Restart=always va in crash-loop su una directory morta (ADR-0035).
WorkingDirectory=${home}
Environment=MUFFIN_HOME=${home}

Restart=always
RestartSec=${RESTART_SEC}
# Un fallimento che non si risolve riprovando (chiave sbagliata, config rotta)
# esce ${EXIT_PERMANENT} e resta giù. Il rate limit di systemd NON è disabilitato,
# di proposito (ADR-0035): è l'ultima rete sotto questa riga.
RestartPreventExitStatus=${EXIT_PERMANENT}
# I figli — server MCP, sandbox — li chiude il cgroup, non il parent.
KillMode=mixed
# Più lungo del nostro budget di drenaggio (${Math.round(DRAIN_BUDGET_MS / 1000)}s), o systemd
# SIGKILLa proprio il turno che il drenaggio esisteva per salvare.
TimeoutStopSec=${STOP_TIMEOUT_SEC}

[Install]
WantedBy=default.target
`;

  return {
    kind: 'systemd',
    path,
    text,
    commands: [
      `mkdir -p ${dir}`,
      `muffin gateway install --write`,
      `systemctl --user daemon-reload`,
      `systemctl --user enable --now ${SERVICE_NAME}.service`,
      `systemctl --user status ${SERVICE_NAME}.service`,
      // Named because a user unit without it dies at logout, which presents as
      // "il gateway si ferma da solo ogni tanto" (ADR-0035).
      `loginctl enable-linger "$USER"   # senza questo la unit utente muore al logout`,
    ],
    warnings: [],
  };
}

function launchdPlan({ home, exec, homeDir }: UnitOptions): UnitPlan {
  const path = join(homeDir ?? homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const args = exec.map((a) => `      <string>${xml(a)}</string>`).join('\n');
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MUFFIN_HOME</key>
    <string>${xml(home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${RESTART_SEC * 2}</integer>
  <key>ExitTimeOut</key>
  <integer>${STOP_TIMEOUT_SEC}</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(home, 'gateway.out'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(home, 'gateway.err'))}</string>
</dict>
</plist>
`;

  return {
    kind: 'launchd',
    path,
    text,
    commands: [
      `muffin gateway install --write`,
      `launchctl bootstrap gui/$(id -u) ${path}`,
      `launchctl print gui/$(id -u)/${LAUNCHD_LABEL}`,
      `# per fermarlo: launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`,
    ],
    warnings: [
      // The divergence, recorded rather than merely suffered.
      `launchd non ha un equivalente di RestartPreventExitStatus: un fallimento permanente (uscita ${EXIT_PERMANENT}, es. chiave sbagliata) verrà comunque riavviato, al più ogni ${RESTART_SEC * 2}s. Il motivo finisce in ${join(home, 'gateway.err')} — leggilo lì, poi \`launchctl bootout\`.`,
      `launchd non ha watchdog: READY=1 e WATCHDOG=1 non hanno un ascoltatore su macOS, quindi qui la supervisione è "riavvia se muore", non "riavvia se si pianta".`,
    ],
  };
}

/** The five XML predefined entities. A `&` in a path is legal and breaks a plist. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export type LauncherProbe = {
  /** Root of this build (the directory holding package.json). */
  buildRoot: string;
  /** The file the supervisor would otherwise have to name. */
  entry: string;
  candidates: string[];
  /** Injected for the test; `realpathSync` in production. */
  realpath?: (path: string) => string | null;
};

export type Launcher = { argv: string[]; warning: string | null };

/**
 * What `ExecStart` may point at.
 *
 * `ExecStart` has to name an executable, so it cannot be anchored to the data
 * home the way everything else is. The next best thing is the launcher symlink
 * `install.sh` writes into `~/.local/bin`: if the checkout moves, re-running
 * `install.sh` re-points the symlink and the unit keeps working untouched.
 *
 * A candidate counts only when it actually resolves **into this build** — the
 * same identity test `install.sh` performs, and for the same reason: Linux Mint
 * ships `/usr/bin/muffin`, the Cinnamon window manager (ADR-0012). Matching on
 * the name would hand systemd a window manager to supervise.
 */
export function resolveLauncher(probe: LauncherProbe): Launcher {
  const resolve =
    probe.realpath ??
    ((path: string): string | null => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    });

  for (const candidate of probe.candidates) {
    const target = resolve(candidate);
    if (target !== null && target.startsWith(probe.buildRoot)) {
      return { argv: [candidate, 'gateway', 'run'], warning: null };
    }
  }

  const foreign = probe.candidates.length > 0;
  return {
    // `process.execPath` is added by the caller when the entry is a script; here
    // the entry is already the executable `install.sh` chmod +x'd.
    argv: [probe.entry, 'gateway', 'run'],
    warning: foreign
      ? `nessun launcher su PATH punta a questa build (quelli trovati sono di un altro programma: su Linux Mint \`muffin\` è il window manager di Cinnamon). L'unit punta direttamente a ${probe.entry}: se sposti il checkout, il supervisore fallisce prima ancora di caricare il runtime. Esegui \`./install.sh\` e rigenera.`
      : `l'unit punta direttamente a ${probe.entry}, dentro il checkout del codice. Se lo sposti, il supervisore fallisce allo CHDIR prima che il runtime carichi e va in crash-loop su una directory morta. Esegui \`./install.sh\` e rigenera l'unit.`,
  };
}
