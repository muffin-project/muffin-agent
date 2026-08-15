import DatabaseCtor from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { attachMcp, buildRuntime } from '../agent/runtime.js';
import { makeJobRunner } from '../agent/scheduler-run.js';
import { ConfigError, paths } from '../core/config/config.js';
import { GatewayLock, readGateway, type GatewayInfo } from '../core/gateway/lock.js';
import { createNotifier } from '../core/gateway/notify.js';
import { Gateway, EXIT_ALREADY_RUNNING } from '../core/gateway/service.js';
import { consolidationBootLine, CONSOLIDATION_TENANT } from '../core/memory/consolidator.js';
import { reviewBootLine } from '../core/memory/maintenance.js';
import {
  planUnit,
  resolveLauncher,
  EXIT_PERMANENT,
  LAUNCHD_LABEL,
  RESTART_SEC,
  STOP_TIMEOUT_SEC,
} from '../core/gateway/unit.js';
import { Scheduler, type Deliver } from '../core/scheduler/scheduler.js';
import { connectSurfaces } from './surface.js';

/**
 * `muffin gateway` — the process that lives, and the three verbs around it.
 *
 * `run` is not a verb for a human: it is the `ExecStart` line. The owner reads
 * the command list and reasonably asks whether they have to type it to keep
 * Muffin alive — they do not, and the USAGE in `main.ts` says so where it is
 * listed. What the owner types is `install` (offered by `muffin init`), then
 * `status` and `stop`.
 *
 * ## Exit codes, and why they are the supervisor's business
 *
 * ADR-0035 refuses `StartLimitIntervalSec=0`: a Muffin that dies on a bad API
 * key has to stay down and say so. That requires the process to distinguish
 * *transient* from *will not fix itself by retrying*, so the codes here are
 * load-bearing, not decoration:
 *
 *  - **78** (EX_CONFIG): no config, no key, a root of trust that refuses. The
 *    unit's `RestartPreventExitStatus` names this one, so systemd leaves it down.
 *  - **75** (EX_TEMPFAIL): another gateway holds the lock. Retrying is correct.
 *  - **2**: anything else that stopped the boot — restarted, because we do not
 *    know that it is permanent.
 */

export const GATEWAY_USAGE = `usage:
  muffin gateway status         attivo? da quando? cosa sta facendo?
  muffin gateway stop           drena i turni in volo e lo ferma
  muffin gateway install        genera la unit del supervisore (stdout)
                                [--write] scrivila al suo posto [--force]
  muffin gateway run            il processo stesso — lo lancia il supervisore,
                                non tu (vedi \`muffin gateway install\`)
`;

/**
 * Where `gateway install` would have put the LaunchAgent — the same path the
 * planner computes, derived here rather than passed, because `stop` has no plan.
 * Its existence is the only local evidence that launchd, and not a terminal, is
 * what will decide whether the gateway comes back.
 */
function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/**
 * What `stop` still has to admit after it succeeded, or null when nothing.
 *
 * On Linux the verb is true end to end: the drain exits `EXIT_STOPPED` and the
 * unit names that code in `RestartPreventExitStatus`. launchd has no per-code
 * exemption and the plist must keep `KeepAlive: true` — otherwise the SIGUSR1
 * drain-restart, which exits 0, would leave the agent down. So on macOS
 * "fermato" means *this process*, and launchd starts another one.
 *
 * A pure function because the branch it guards cannot be reached from the
 * suite: driving a real `gateway stop` means SIGTERMing the pid on the claim,
 * and the only pid a fixture can honestly put there is the test runner's.
 */
export function stopCaveat(platform: NodeJS.Platform, agentInstalled: boolean): string | null {
  if (platform !== 'darwin' || !agentInstalled) return null;
  return `! su macOS launchd lo riavvia entro ${RESTART_SEC * 2}s. Per tenerlo giù: \`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}\`\n`;
}

/** Read-only view of the gateway, for the three commands that only look. */
function inspect(home: string): GatewayInfo | null {
  const file = paths(home).db;
  if (!existsSync(file)) return null;
  // Readonly: looking at the gateway must never create a database, and must
  // work while the gateway itself is writing to it (WAL allows the reader).
  const db = new DatabaseCtor(file, { readonly: true });
  try {
    return readGateway(db);
  } finally {
    db.close();
  }
}

function describe(info: GatewayInfo): string {
  const since = info.since.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'medium' });
  const beat = Math.round((Date.now() - info.lastBeat.getTime()) / 1000);
  return `attivo · pid ${info.pid} · dal ${since} · ${info.status} · ultimo battito ${beat}s fa`;
}

export function cmdGatewayStatus(home: string): number {
  const info = inspect(home);
  if (!info) {
    process.stdout.write(`nessun gateway attivo\n`);
    process.stderr.write(`→ \`muffin gateway install\` per farlo partire da solo all'avvio\n`);
    // 1 and not 0: `muffin gateway status` is the scriptable "is it up", the
    // shape `systemctl is-active` has. Zero would make a dead gateway succeed.
    return 1;
  }
  process.stdout.write(`${describe(info)}\n`);
  return 0;
}

export async function cmdGatewayStop(home: string): Promise<number> {
  const info = inspect(home);
  if (!info) {
    process.stderr.write(`nessun gateway attivo\n`);
    return 1;
  }

  try {
    // SIGTERM, which the gateway turns into a drain — not SIGKILL. The whole
    // point of the drain is that a turn in flight finishes.
    //
    // The residual risk, named rather than papered over: this signals a pid read
    // from a row, and a pid can be reused. `readGateway` has already required
    // the claim to be live *and* refreshed within ten heartbeats, so the window
    // is "the gateway died and the OS handed its pid to something else, inside
    // five minutes" — the same hazard sendlock.ts documents, with a horizon 12×
    // tighter because a gateway beats and a send does not. It is not zero. What
    // keeps it small enough to accept is that the only escalation here is
    // SIGTERM: we never SIGKILL, so the worst case is a polite signal to an
    // unrelated process of this same user.
    process.kill(info.pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // It died between the read and the signal. The claim goes stale on its
      // own, so there is nothing to repair and nothing to apologise for.
      process.stderr.write(`il gateway (pid ${info.pid}) era già uscito\n`);
      return 1;
    }
    process.stderr.write(`non posso fermare il pid ${info.pid}: ${code ?? String(error)}\n`);
    return 2;
  }

  process.stderr.write(`SIGTERM al pid ${info.pid} — sto aspettando che dreni…\n`);
  const deadline = Date.now() + STOP_TIMEOUT_SEC * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!inspect(home)) {
      process.stdout.write(`gateway fermato\n`);
      // Said at the moment it stops being true, and only when a LaunchAgent is
      // really installed: a gateway started by hand in a terminal has nothing
      // watching it, and would get a false alarm.
      const caveat = stopCaveat(process.platform, existsSync(launchAgentPath()));
      if (caveat) process.stderr.write(caveat);
      return 0;
    }
  }
  // Reported, never escalated to SIGKILL: killing a turn mid-write is the thing
  // the drain exists to avoid, and the supervisor's TimeoutStopSec is the layer
  // that owns that decision.
  process.stderr.write(
    `il gateway (pid ${info.pid}) non è uscito entro ${STOP_TIMEOUT_SEC}s — sta ancora drenando, oppure è piantato\n`,
  );
  return 1;
}

export function cmdGatewayInstall(home: string, argv: string[]): number {
  let values: { write?: boolean; force?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { write: { type: 'boolean' }, force: { type: 'boolean' } },
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(GATEWAY_USAGE);
    return 78;
  }

  const launcher = currentLauncher();
  const plan = planUnit({
    platform: process.platform,
    home,
    exec: launcher.argv,
    systemdNotify: hasSystemdNotify(),
    // Both passed explicitly rather than defaulted inside the planner. XDG is
    // where systemd genuinely looks for user units when it is set, and having
    // the destination be an argument is what lets a test target a temp home
    // instead of writing a real service into the owner's `~/Library` — which it
    // did, once, before this line existed.
    homeDir: homedir(),
    ...(process.env['XDG_CONFIG_HOME'] ? { configHome: process.env['XDG_CONFIG_HOME'] } : {}),
  });

  if (values.write) {
    if (existsSync(plan.path) && !values.force) {
      const existing = readFileSync(plan.path, 'utf8');
      if (existing !== plan.text) {
        // Never silently overwrite: the owner is expected to hand-edit these
        // (a different WatchdogSec, an extra Environment line), and a
        // regenerated unit that eats those edits is a bad trade for one saved
        // flag.
        process.stderr.write(`${plan.path} esiste già ed è diverso da quello che genererei.\n`);
        process.stderr.write(`→ guardalo, poi \`muffin gateway install --write --force\` per sovrascriverlo\n`);
        // 2 and not 1: the command did not do what it was asked. 1 below means
        // "the unit is written, with a caveat", and a script has to be able to
        // tell "I refused" from "done, but read this".
        return 2;
      }
    }
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.text, 'utf8');
    process.stderr.write(`scritto ${plan.path}\n`);
  } else {
    // stdout is the result (house rule), so `muffin gateway install > file`
    // works and everything explanatory goes to stderr.
    process.stdout.write(plan.text);
    process.stderr.write(`\n→ questa unit va in ${plan.path}\n`);
    process.stderr.write(`  \`muffin gateway install --write\` la scrive lì per te\n`);
  }

  process.stderr.write(`\npoi, per attivarla:\n`);
  for (const c of plan.commands) process.stderr.write(`  ${c}\n`);
  for (const w of plan.warnings) process.stderr.write(`\n! ${w}\n`);
  if (launcher.warning) {
    process.stderr.write(`\n! ${launcher.warning}\n`);
    // Exit 1 only for the actionable one. The platform notes above are true on
    // every macOS install and would make a healthy `install` always look broken.
    return 1;
  }
  return 0;
}

/**
 * Is the one binary the whole `Type=notify` unit depends on actually here?
 *
 * A PATH walk and not `spawnSync('which')`: `muffin gateway install` should not
 * fork a shell to answer a question `existsSync` answers, and `which` is not
 * guaranteed to exist on a minimal container image — the exact kind of host
 * where `systemd-notify` is missing in the first place.
 *
 * Only meaningful on Linux, and only consulted there (`planUnit` routes darwin
 * to launchd before this reaches anything). The honest limit is written into
 * the warning the planner emits: this is the PATH of the shell running
 * `install`, and systemd starts the service with its own.
 */
function hasSystemdNotify(): boolean {
  if (process.platform !== 'linux') return true;
  const path = process.env['PATH'] ?? '';
  return path
    .split(':')
    .filter((d) => d.length > 0)
    .some((d) => existsSync(join(d, 'systemd-notify')));
}

/**
 * What this build can ask a supervisor to execute.
 *
 * `install.sh` links `dist/cli/main.js` into `~/.local/bin`, so the launcher is
 * a symlink *into the checkout*. That is as close to ADR-0035's cure as an
 * ExecStart can get: the unit names the symlink, and re-running `install.sh`
 * after a move re-points it without touching the unit.
 *
 * The fallback `entry` is only a real file on the built path. Run under `tsx`
 * from a source checkout — which is where `muffin init` also offers to install
 * the unit — `here` is `<checkout>/cli` and `main.js` is not there at all;
 * `resolveLauncher` checks and says so, because a unit naming a file that does
 * not exist fails at exec rather than degrading.
 */
function currentLauncher(): { argv: string[]; warning: string | null } {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/ when compiled, cli/ under tsx — one level up either way.
  const buildRoot = dirname(here);
  const entry = join(here, 'main.js');
  const bindirs = [process.env['MUFFIN_BINDIR'], join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const candidates = bindirs
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .flatMap((d) => [join(d, 'muffin'), join(d, 'muffin-agent')]);
  return resolveLauncher({ buildRoot, entry, candidates });
}

/**
 * The process. Invoked by the supervisor, and by `muffin gateway run` when the
 * owner wants to watch it in a terminal.
 */
export async function cmdGatewayRun(home = paths().home): Promise<number> {
  let runtime;
  try {
    runtime = buildRuntime(home);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof ConfigError) {
      process.stderr.write(`→ ${error.remedy}\n`);
      // Permanent: retrying with the same config produces the same failure, and
      // the unit's RestartPreventExitStatus is keyed to this code.
      return EXIT_PERMANENT;
    }
    // A root of trust that refuses lands here as a plain Error. It is equally
    // permanent, and equally not something a restart repairs.
    return /root of trust/i.test(error instanceof Error ? error.message : '') ? EXIT_PERMANENT : 2;
  }

  const lock = new GatewayLock(runtime.db);
  const notify = createNotifier();
  const scheduler = new Scheduler(
    runtime.jobs,
    makeJobRunner(runtime.deps),
    gatewayDeliver,
    // ALWAYS_IDLE by omission, and it is a decision: a gateway has no terminal,
    // so there is no foreground to lose the lane to. When a surface turn becomes
    // able to say "the owner is talking right now" — the `queue`/`steer` slice —
    // this is the seam it plugs into, and the gate stops being a constant.
    undefined,
    (e) => {
      if (e.kind === 'delivery_failed') {
        process.stderr.write(`job ${e.job.id.slice(0, 8)}: consegna fallita (${e.error})\n`);
      }
    },
  );

  let stopSurfaces: (() => void) | null = null;
  const gateway = new Gateway({
    lock,
    notify,
    scheduler,
    jobs: runtime.jobs,
    close: () => {
      // Surfaces first, then the runtime: the connector must stop polling
      // before the database under it goes away (the REPL's order, same reason).
      stopSurfaces?.();
      runtime.close();
    },
    log: (line) => process.stderr.write(`${line}\n`),
  });

  // The claim before the expensive half of boot: a second gateway must not
  // spawn MCP children or start polling Telegram before it finds out it lost.
  const started = gateway.start();
  if (!started.started) {
    process.stderr.write(`${started.held}\n→ ${started.remedy}\n`);
    runtime.close();
    return EXIT_ALREADY_RUNNING;
  }

  if (runtime.safeMode) {
    process.stderr.write(
      `! safe mode: root of trust diverged (${runtime.safeMode.reason}) — capability sopra il rischio basso negate\n`,
    );
  }

  const surfaces = connectSurfaces(runtime, home);
  stopSurfaces = surfaces.stop;
  let mcpLines: string[] = [];
  try {
    mcpLines = await attachMcp(runtime, home);
  } catch (error) {
    mcpLines = [`mcp: ${error instanceof Error ? error.message : String(error)}`];
  }

  // Only when there is something to decide — see `reviewBootLine`.
  const review = reviewBootLine(runtime.db, CONSOLIDATION_TENANT);

  process.stderr.write(
    `muffin gateway · pid ${process.pid} · ${runtime.config.models.main}\n` +
      surfaces.lines.map((l) => `${l}\n`).join('') +
      mcpLines.map((l) => `${l}\n`).join('') +
      runtime.bootLines.map((l) => `${l}\n`).join('') +
      // Said here too, and not only in the REPL: under a supervisor this line
      // is the journal entry that proves the memory lane exists in the process
      // that has no terminal — which is the one that was never going to be
      // watched.
      `${consolidationBootLine()}\n` +
      (review === null ? '' : `${review}\n`) +
      `supervisione: ${notify.supervised ? 'sd_notify attivo' : 'nessun supervisore (NOTIFY_SOCKET assente)'}\n`,
  );

  return gateway.serve();
}

/**
 * Where a scheduled message goes when there is no terminal.
 *
 * `cli` means stdout, which under a supervisor is the journal — visible with
 * `journalctl --user -u muffin-gateway`, and the honest place for a message
 * nobody was there to read. A remote channel is the M4 connect and is not wired
 * (the REPL and `cli/observe.ts` say the same); until it is, the text surfaces
 * here rather than vanishing.
 */
const gatewayDeliver: Deliver = async (channel, text) => {
  if (channel === 'cli') {
    process.stdout.write(`⏰ ${text}\n`);
    return;
  }
  process.stderr.write(`⏰ [job → ${channel}: consegna remota da cablare]\n${text}\n`);
};
