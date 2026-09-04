import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { attachMcp, buildRuntime } from '../agent/runtime.js';
import { makeCommitmentLane } from '../agent/commitment-run.js';
import { makeJobRunner } from '../agent/scheduler-run.js';
import { makeLaneRunner, NO_SURFACE, type AttachStream, type LaneDeliver } from '../agent/turn-lane.js';
import { TurnLane, type LaneEvent } from '../core/turns/lane.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { ConfigError, paths } from '../core/config/config.js';
import { GatewayLock, readGateway, type GatewayInfo } from '../core/gateway/lock.js';
import { CONTROL_PROTOCOL, serveControlSocket, type ControlServer } from '../core/gateway/control-socket.js';
import { currentGatewayPid, describeBuild, restartCommand, restartVerdict, run, waitForGatewayPid } from './update.js';
import { checkSupervisor, realSupervisorProbes, type SupervisorProbes } from '../core/gateway/supervisor.js';
import { createNotifier, describeSupervision } from '../core/gateway/notify.js';
import { Gateway, EXIT_ALREADY_RUNNING, EXIT_STOPPED, type GatewayDeps } from '../core/gateway/service.js';
import { consolidationBootLine, CONSOLIDATION_TENANT } from '../core/memory/consolidator.js';
import { reviewBootLine } from '../core/memory/maintenance.js';
import {
  planUnit,
  resolveInterpreterDir,
  type InterpreterProbes,
  resolveLauncher,
  EXIT_PERMANENT,
  LAUNCHD_LABEL,
  RESTART_SEC,
  STOP_TIMEOUT_SEC,
} from '../core/gateway/unit.js';
import { Scheduler, type Deliver } from '../core/scheduler/scheduler.js';
import type { SurfaceRegistry } from '../core/surface/registry.js';
import { notDelivered } from '../core/surface/types.js';
import { attachSendFile, connectSurfaces } from './surface.js';
import { Pausa } from '../core/runtime/pausa.js';
import type { SaluteSuperfici } from '../core/surface/salute.js';

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
  muffin gateway stop           drena i turni in volo e lo ferma — e lo tiene
                                giù, anche su macOS
  muffin gateway start          lo riaccende dopo uno stop
  muffin gateway restart        kickstart/systemctl restart e verifica lo stato
                                dopo (pid cambiato), non l'exit code del comando
  muffin gateway install        genera la unit del supervisore (stdout)
                                [--write] scrivila al suo posto [--force]
                                [--start] e poi accendila davvero (implica
                                --write); esce 3 se il file c'è e il
                                servizio no
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
  // Non più un avvertimento: un promemoria. La frase che stava qui — «launchd
  // lo riavvia entro Ns» — era vera e ora non lo è più, ed è la ragione per
  // cui questa funzione esiste ancora invece di essere stata cancellata: chi
  // ha fermato il gateway deve sapere che resta fermo, altrimenti al prossimo
  // riavvio del Mac si chiede perché i job non girano.
  return `il semaforo di stop resta finché non fai \`muffin gateway start\` — anche dopo un riavvio\n`;
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

/**
 * The real answers behind `resolveInterpreterDir`. Kept here, next to the one
 * caller, for the reason the planner states: the caller probes, the planner
 * stays pure.
 *
 * Every probe degrades to "no" rather than throwing: this runs during
 * `gateway install`, and a PATH entry that cannot be read is a reason to skip
 * that entry, never a reason to fail the install.
 */
const REAL_INTERPRETER_PROBES: InterpreterProbes = {
  pathEntries: () => (process.env['PATH'] ?? '').split(delimiter).filter((d) => d !== ''),
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

export function cmdGatewayStatus(home: string): number {
  const info = inspect(home);
  if (!info) {
    // **Fermo di proposito non è «non c'è».** `doctor` questa distinzione la
    // faceva già da #217; qui no, e questo è il comando che uno prova per
    // primo. Il risultato, misurato sulla macchina dell'owner il 28/08/2026
    // subito dopo un `gateway stop` riuscito: «nessun gateway attivo →
    // `muffin gateway install`». Il rimedio è sbagliato due volte — è già
    // installato, e installarlo di nuovo non lo riaccende. Un rimedio
    // sbagliato è peggio di nessun rimedio: si esegue.
    if (existsSync(paths(home).gatewayStopped)) {
      process.stdout.write(`fermo di proposito (\`muffin gateway stop\`)\n`);
      process.stderr.write(`→ \`muffin gateway start\` lo riaccende — resta giù anche dopo un riavvio\n`);
      // Sempre 1: la domanda scriptabile è «è su?», e la risposta è no
      // qualunque sia la ragione. Il perché sta nel testo, non nell'exit code.
      return 1;
    }
    process.stdout.write(`nessun gateway attivo\n`);
    process.stderr.write(`→ \`muffin gateway install\` per farlo partire da solo all'avvio\n`);
    // 1 and not 0: `muffin gateway status` is the scriptable "is it up", the
    // shape `systemctl is-active` has. Zero would make a dead gateway succeed.
    return 1;
  }
  process.stdout.write(`${describe(info)}\n`);
  return 0;
}

/**
 * `muffin gateway start` — l'inverso esatto di `stop`.
 *
 * Non esisteva, e finché `stop` non teneva davvero giù niente non serviva:
 * launchd riaccendeva da solo entro dieci secondi. Ora che `stop` scrive un
 * semaforo che lo tiene giù, serve il verbo che lo toglie — altrimenti
 * l'owner si ritrova con un gateway fermo e nessun modo di rialzarlo che non
 * sia ricordarsi il nome di un file.
 *
 * Due passi, e il secondo è quello che si dimentica: togliere il semaforo non
 * riaccende niente da solo. Il supervisore va toccato — `launchctl kickstart`
 * su macOS, `systemctl --user start` su Linux — perché il PathState riarma il
 * KeepAlive per il *futuro*, non fa partire un processo adesso.
 */
export function cmdGatewayStart(home: string, deps: { run?: StepRunner } = {}): number {
  const semaforo = paths(home).gatewayStopped;
  const cera = existsSync(semaforo);
  if (cera) rmSync(semaforo, { force: true });

  const gia = inspect(home);
  if (gia) {
    process.stdout.write(`${describe(gia)}\n`);
    if (cera) process.stderr.write(`(il semaforo di stop è stato tolto)\n`);
    return 0;
  }

  // Nessun LaunchAgent/unit installato: non c'è un supervisore da svegliare, e
  // dirlo è meglio che eseguire un comando che fallirà.
  const supervisore = supervisorStart(home);
  if (supervisore === null) {
    process.stderr.write(
      `semaforo tolto, ma non c'è un supervisore installato su questa macchina\n` +
        `→ \`muffin gateway install --write --start\`\n`,
    );
    return 1;
  }

  const run = deps.run ?? REAL_RUNNER;
  const esito = run(supervisore);
  if (esito.status !== 0) {
    process.stderr.write(
      `${supervisore.join(' ')} → ${esito.status === null ? 'non eseguibile' : `uscita ${String(esito.status)}`}` +
        `${esito.stderr ? `: ${esito.stderr.trim()}` : ''}\n`,
    );
    return 2;
  }
  process.stdout.write(`gateway riacceso\n`);
  return 0;
}

/**
 * Il comando che dice al supervisore «riparti adesso», o `null` se su questa
 * macchina non ce n'è uno installato.
 *
 * Il semaforo che `start` ha appena tolto riarma il KeepAlive per il futuro;
 * non fa partire un processo ora. Sono due cose diverse e vanno fatte
 * entrambe.
 */
function supervisorStart(home: string): string[] | null {
  if (process.platform === 'darwin') {
    return existsSync(launchAgentPath()) ? ['launchctl', 'kickstart', `gui/${String(userInfo().uid)}/${LAUNCHD_LABEL}`] : null;
  }
  return existsSync(join(homedir(), '.config', 'systemd', 'user', `${LAUNCHD_LABEL}.service`))
    ? ['systemctl', '--user', 'start', `${LAUNCHD_LABEL}.service`]
    : null;
}

export async function cmdGatewayStop(home: string): Promise<number> {
  const info = inspect(home);
  if (!info) {
    process.stderr.write(`nessun gateway attivo\n`);
    return 1;
  }

  // Scritto **prima** del segnale, e l'ordine è la cosa che funziona: launchd
  // reagisce alla morte del processo, quindi il semaforo deve già esserci
  // quando quella morte arriva. Scriverlo dopo lascerebbe una finestra in cui
  // launchd vede un processo uscito e nessun file, cioè esattamente il caso
  // «riportalo su» che questo evita.
  //
  // Un crash non passa di qui e non scrive niente: è così che «fermato» e
  // «morto» restano due cose diverse per il supervisore.
  writeFileSync(paths(home).gatewayStopped, `${new Date().toISOString()}\n`, 'utf8');

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

/**
 * `muffin gateway restart` — l'owner l'ha chiesto testuale: *«mettiamo anche
 * muffin gateway restart, cosi da non dover fare due comandi ogni volta»*.
 * Prima erano due passi a mano: `launchctl kickstart -k …` (o `systemctl
 * --user restart …`) e poi guardare `muffin gateway status` per credergli.
 *
 * Non un comando nuovo che parla al supervisore a modo suo: `restartCommand`,
 * `waitForGatewayPid` e `restartVerdict` sono gli stessi tre pezzi che
 * `cli/update.ts`'s `offerGatewayRestart` usa dopo uno `swing` — importati, non
 * riscritti — così un `launchctl kickstart` scritto storto si romperebbe in un
 * solo posto, non in due che potrebbero disallinearsi. La sola differenza è la
 * cornice: `offerGatewayRestart` chiede il permesso (o lo dà per scontato con
 * `--yes`) dentro il flusso di un aggiornamento e parla di "codice nuovo";
 * questo è il comando che l'owner digita apposta per riavviare adesso, quindi
 * parte senza chiedere, come `gateway start`.
 *
 * **Verificato sullo stato, mai sull'exit code** — la regola di casa
 * ("verifica lo stato dopo, non l'output"), e il difetto che l'ha resa
 * esplicita è lo stesso `restartVerdict` già ripara: le tre frasi diverse per
 * pid-cambiato / comando-ok-ma-pid-uguale / comando-fallito, decise da un pid
 * letto DOPO e confrontato con quello di PRIMA, mai dal solo `status === 0`
 * del comando che ha toccato il supervisore.
 */
export async function cmdGatewayRestart(
  home: string,
  deps: {
    platform?: NodeJS.Platform;
    supervisorProbes?: Partial<SupervisorProbes>;
    restart?: (argv: string[]) => { status: number; stdout: string; stderr: string };
    readGatewayPid?: () => number | null;
    sleep?: (ms: number) => Promise<void>;
    verifyAttempts?: number;
    verifyIntervalMs?: number;
  } = {},
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const readGatewayPid = deps.readGatewayPid ?? (() => currentGatewayPid(home));
  const restart = deps.restart ?? ((argv: string[]) => run(argv[0]!, argv.slice(1), home, 30_000));

  const status = checkSupervisor(platform, home, readGatewayPid() !== null, {
    ...realSupervisorProbes(),
    ...deps.supervisorProbes,
  });
  if (!status.engaged) {
    process.stderr.write(`nessun gateway supervisionato: ${status.detail}\n  → ${status.remedy}\n`);
    return 1;
  }

  const { printable, argv } = restartCommand(platform);
  process.stderr.write(`${printable}\n`);
  const pidBefore = readGatewayPid();
  const r = restart(argv);
  const commandDetail = (r.stderr || r.stdout).trim();
  const pidAfter = await waitForGatewayPid(readGatewayPid, pidBefore, {
    attempts: deps.verifyAttempts,
    intervalMs: deps.verifyIntervalMs,
    sleep: deps.sleep,
  });
  const verdict = restartVerdict({ pidBefore, pidAfter, commandOk: r.status === 0, commandDetail });
  if (verdict.restarted) {
    process.stdout.write(`${verdict.line}\n`);
    return 0;
  }
  process.stderr.write(`${verdict.line}\n`);
  return 1;
}

/**
 * Come `--start` esegue un passo di attivazione.
 *
 * Iniettabile perché la cosa che fa è accendere un servizio sulla macchina di
 * chi lo chiama: un test che la esegue davvero scrive un LaunchAgent vero nel
 * `~/Library` di qualcuno — è già successo una volta a questo file, e la nota
 * su `homeDir` più sotto è la cicatrice.
 */
export type StepRunner = (argv: string[]) => { status: number | null; stderr: string };

const REAL_RUNNER: StepRunner = (argv) => {
  const [cmd, ...rest] = argv;
  const r = spawnSync(cmd ?? '', rest, { encoding: 'utf8' });
  // `spawnSync` non lancia quando il binario non c'è: mette l'errore in `error`
  // e `status` a null. Un `systemctl` assente dentro un container è esattamente
  // questo caso, e senza questa riga si legge come un successo silenzioso.
  if (r.error) return { status: null, stderr: r.error.message };
  return { status: r.status, stderr: r.stderr ?? '' };
};

/** Esce 3 quando la unit è al suo posto e il servizio no: né rifiuto (2) né avvertenza (1). */
export const EXIT_NOT_ACTIVATED = 3;

export function cmdGatewayInstall(
  home: string,
  argv: string[],
  deps: {
    run?: StepRunner;
    identity?: { user: string; uid: number };
    platform?: NodeJS.Platform;
    /**
     * Dove finisce la unit. Il commento su `homeDir` qui sotto racconta la
     * cicatrice: un test scrisse un LaunchAgent vero nel `~/Library` di
     * qualcuno. Finora l'unico modo di evitarlo era passare da un processo
     * figlio con `HOME` riscritto — il che rendeva il percorso in-process
     * impossibile da provare senza rischiare la macchina che lo prova.
     */
    homeDir?: string;
    configHome?: string;
  } = {},
): number {
  let values: { write?: boolean; force?: boolean; start?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { write: { type: 'boolean' }, force: { type: 'boolean' }, start: { type: 'boolean' } },
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(GATEWAY_USAGE);
    return 78;
  }
  // Non si accende un file che non c'è: `--start` implica `--write`, e il
  // rifiuto di sovrascrivere (uscita 2) vale identico — accendere una unit
  // diversa da quella che l'owner ha in mano sarebbe peggio, non meglio.
  const write = values.write === true || values.start === true;

  const launcher = currentLauncher();
  const plan = planUnit({
    // Sovrascrivibile per la stessa ragione per cui esiste `gate-linux.sh`: lo
    // sviluppo si fa su macOS e la produzione è Linux, quindi la sequenza
    // systemd — la sola con più di un passo, e perciò la sola dove l'ordine e
    // il fermarsi al primo errore si possano osservare — non sarebbe provabile
    // dalla macchina che la scrive.
    platform: deps.platform ?? process.platform,
    home,
    exec: launcher.argv,
    systemdNotify: hasSystemdNotify(),
    // Both passed explicitly rather than defaulted inside the planner. XDG is
    // where systemd genuinely looks for user units when it is set, and having
    // the destination be an argument is what lets a test target a temp home
    // instead of writing a real service into the owner's `~/Library` — which it
    // did, once, before this line existed.
    //
    // E di nuovo il 27/08, perché la difesa era a metà: il *planner* prendeva
    // la destinazione come argomento, questa funzione la leggeva da
    // `homedir()`. Bastava provare il percorso in-process (l'unico modo di
    // vedere la sequenza systemd da un Mac) e un `muffin-gateway.service`
    // compariva nella `~/.config` vera, con `WorkingDirectory` su una home
    // temporanea. Ora la destinazione è un argomento anche qui.
    homeDir: deps.homeDir ?? homedir(),
    // Where this install's Node lives. Without it launchd/systemd hand the
    // launcher a PATH that has no `node` in it at all — and with the *wrong*
    // one it hands it a path that expires (see `resolveInterpreterDir`).
    interpreterDir: resolveInterpreterDir(process.execPath, REAL_INTERPRETER_PROBES),
    // Solo se serve: senza `--start` la lista stampata resta quella con
    // `$(id -u)`, che è giusta per una shell e non richiede di sapere chi sia.
    ...(values.start === true ? { identity: deps.identity ?? { user: userInfo().username, uid: userInfo().uid } } : {}),
    ...(deps.configHome !== undefined
      ? { configHome: deps.configHome }
      : process.env['XDG_CONFIG_HOME']
        ? { configHome: process.env['XDG_CONFIG_HOME'] }
        : {}),
  });

  if (write) {
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

  if (values.start === true) {
    if (plan.activation.length === 0) {
      process.stderr.write(`\nnon so con quale utente attivarla, quindi non la attivo.\n`);
      for (const c of plan.commands) process.stderr.write(`  ${c}\n`);
      return EXIT_NOT_ACTIVATED;
    }
    const run = deps.run ?? REAL_RUNNER;
    process.stderr.write(`\nl'accendo:\n`);
    for (const step of plan.activation) {
      // Stampato PRIMA di eseguirlo, non dopo: se il passo si pianta (systemctl
      // che attende un bus che non c'è) l'owner vede su cosa, non un cursore.
      process.stderr.write(`  ${step.argv.join(' ')}   # ${step.why}\n`);
      const r = run(step.argv);
      if (r.status !== 0) {
        // Ci si ferma al primo: `enable --now` dopo un `daemon-reload` fallito
        // abiliterebbe una unit che systemd non ha riletto, e il risultato
        // sarebbe un servizio che c'è e non è quello scritto.
        process.stderr.write(`\n! si è fermato qui: ${step.argv.join(' ')}\n`);
        const detail = r.stderr.trim();
        if (detail !== '') process.stderr.write(`  ${detail.split('\n').join('\n  ')}\n`);
        process.stderr.write(`\nla unit è scritta in ${plan.path}; il servizio no. I passi rimasti:\n`);
        for (const c of plan.commands) process.stderr.write(`  ${c}\n`);
        for (const w of plan.warnings) process.stderr.write(`\n! ${w}\n`);
        return EXIT_NOT_ACTIVATED;
      }
    }
    process.stderr.write(`\nil gateway è un servizio adesso — \`muffin gateway status\` lo vede.\n`);
    for (const w of plan.warnings) process.stderr.write(`\n! ${w}\n`);
    if (launcher.warning) {
      process.stderr.write(`\n! ${launcher.warning}\n`);
      return 1;
    }
    return 0;
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
 * The only way to speed up `Gateway`'s beat without editing the source:
 * `gatewayOverrides.tickMs` is an in-process seam `cli/gateway.test.ts` reaches
 * by importing `cmdGatewayRun` directly, and `evals/acceptance/` cannot do that
 * — it spawns the real binary as a child process, which is the whole point of
 * that suite. Without this, an acceptance scenario waiting on a second beat
 * (a due job, then a separately-armed suspended turn) pays the real
 * `HEARTBEAT_MS` interval, thirty seconds a tick. Unset in every real
 * install — nobody sets this env var by hand — so production keeps the
 * default cadence; a non-numeric or non-positive value is ignored rather than
 * crashing a supervised process over a typo in the environment.
 */
export function tickMsFromEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The process. Invoked by the supervisor, and by `muffin gateway run` when the
 * owner wants to watch it in a terminal.
 */
export async function cmdGatewayRun(
  home = paths().home,
  /**
   * Test-only seam into the one `Gateway` this function builds for real.
   *
   * `core/gateway/service.test.ts` drives `Gateway` directly with a fake
   * `signals`/`tickMs`/`sleep`, and that is real coverage of the class — but
   * nothing exercised *this* assembly: whether `cmdGatewayRun` actually threads
   * `recordDelivery` into the `Scheduler` it builds, and the `SurfaceRegistry`
   * from `connectSurfaces` into the `deliver` the scheduler calls. A day-one
   * regression there (drop the last constructor argument, say) would compile,
   * every existing test would stay green, and a job on any real surface would
   * go back to advancing its schedule on a delivery nobody recorded — silently,
   * because nothing here called it. Verified: commenting out that argument left
   * `cli/gateway.test.ts` and `core/gateway/service.test.ts` fully green.
   */
  gatewayOverrides: Pick<
    GatewayDeps,
    'signals' | 'tickMs' | 'sleep' | 'now' | 'pid' | 'drainBudgetMs'
  > = {},
  /**
   * Test-only: called once, the moment `turnLane` and `lock` exist below,
   * before `Gateway.start` ever ticks either.
   *
   * `TurnLane`'s own `stillOwner` check (a few lines below) only ever runs on
   * a tick where `Gateway.tick`'s own `lock.beat()` — the *same* `lock` — has
   * just succeeded, moments earlier, in the same synchronous call: a `beat()`
   * failure drains the whole process (`core/gateway/service.ts`'s `tick`)
   * before `turnLane.tick()` can run again. So a black-box test that steals
   * the claim and waits for `cmdGatewayRun` to react cannot tell this
   * parameter existing from it being deleted — both drain on the gateway's
   * own heartbeat, for a reason that has nothing to do with `stillOwner`.
   * Verified: `cli/gateway.test.ts`'s own claim-heist test still passed with
   * `stillOwner` deleted from the construction below. Calling `turnLane.tick`
   * here directly, at a moment of the test's choosing, is the only way to ask
   * the *lane* the question `stillOwner` exists to answer, independent of
   * when the gateway's heartbeat would ask it (judge, round 2, R1).
   */
  onAssembled?: (parts: { turnLane: TurnLane; lock: GatewayLock }) => void,
): Promise<number> {
  // Il semaforo, prima di qualunque cosa. È la seconda delle due difese: il
  // `PathState` del plist dice a launchd di non riavviare, questo chiude la
  // finestra in cui launchd non se n'è ancora accorto (launchd.plist(5)
  // avverte che guardare il filesystem è race-prone). Su Linux non serve —
  // `RestartPreventExitStatus` c'era già — ma renderlo uguale sulle due
  // macchine costa tre righe e toglie una differenza da ricordare.
  if (existsSync(paths(home).gatewayStopped)) {
    process.stderr.write(
      `il gateway è stato fermato di proposito (${paths(home).gatewayStopped})\n` +
        `→ \`muffin gateway start\` per riaccenderlo\n`,
    );
    return EXIT_STOPPED;
  }
  let runtime;
  try {
    /**
     * No cwd argument, and that is now a decision rather than an omission.
     *
     * Under launchd/systemd `process.cwd()` **is** `~/.muffin` — the unit pins
     * `WorkingDirectory` there on purpose (ADR-0035: a unit anchored to a
     * checkout that moves fails at CHDIR before the runtime loads, and
     * `Restart=always` crash-loops on a dead directory), measured on the
     * owner's live gateway on 2026-09-03. `buildRuntime` refuses that cwd and
     * works in `muffinWorkspace(home)` instead (ADR-0059).
     *
     * An earlier draft named the workspace here, so the gateway would not
     * depend on that guard firing. It was wrong, and the acceptance suite said
     * so: `muffin gateway run` also runs in a terminal, in a directory the
     * owner chose by standing in it, and naming the workspace here overrode
     * that choice — `b-parita-superfici` and `b-una-conversazione` both went
     * red because the turn read `dati.txt` somewhere the test had not put it.
     * One door decides where a turn works, for every surface, and a second
     * spelling of the same rule is a second rule.
     */
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
  /**
   * One model lane for the two things that use the model.
   *
   * Constructed **here**, where both are built, because this is the only place
   * that knows they run on the same beat: `Gateway.tick` drives the scheduler
   * and then the turn lane, and with a private flag each they would both start
   * work in the same tick against one provider and one budget — while both
   * files documented that they could not. One token cannot be half-connected.
   */
  const modelLane = new ModelLane();

  /**
   * The registry exists only after the claim is won — `connectSurfaces` starts
   * polling Telegram, and a second gateway must not do that before it finds out
   * it lost. So the scheduler is handed an indirection rather than the registry,
   * and the window before surfaces are up reports itself as what it is.
   *
   * "Not connected yet" is a *state*, not the old lie: it comes back as
   * `{ delivered: false }`, so a job that somehow fires in that window is
   * recorded as undelivered instead of silently marked run.
   */
  let registry: SurfaceRegistry | null = null;
  /**
   * Assegnato dopo, letto pigramente dal socket: il canale di controllo si apre
   * **prima** delle superfici di proposito (vedi `serveControlSocket` qui
   * sotto), quindi la risposta deve leggere il registro nel momento in cui la
   * domanda arriva, non nel momento in cui il gestore viene costruito.
   */
  let saluteSuperfici: SaluteSuperfici | null = null;
  const deliver: Deliver = async (channel, text) =>
    registry === null ? notDelivered('le superfici non sono ancora connesse') : registry.deliver(channel, text);

  const pausa = new Pausa(runtime.db);
  /**
   * ADR-0060: la promessa datata, sulla stessa battuta dei job.
   *
   * `deliver` è la stessa indirezione che riceve lo scheduler — quindi una
   * consegna tentata prima che le superfici siano su torna `{ delivered: false }`
   * e l'ancora resta aperta, che è esattamente la regola su cui gira
   * `cli/observe.ts`: si brucia solo ciò che è arrivato all'owner.
   */
  const commitments = makeCommitmentLane(runtime, deliver, {
    /**
     * Il gateway gira in due modi e la risposta e' diversa: `muffin gateway
     * run` in un terminale ha davvero l'owner davanti; sotto launchd o systemd
     * stdout **e' il journal**. E' lo stesso segnale che `cliSurface` legge per
     * decidere se lo streaming ha un senso, letto qui perche' e' qui che si sa
     * come questo processo e' stato avviato.
     */
    hasTerminal: () => process.stdout.isTTY === true,
    onEvent: (e) => {
      if (e.kind === 'undelivered') {
        process.stderr.write(`impegno ${e.anchor}: non consegnato — ${e.why}\n`);
      } else if (e.kind === 'unreachable') {
        // Una volta per ancora, non una ogni trenta secondi (vedi
        // `CommitmentEvent`). La promessa resta dovuta: quando l'owner cambia
        // la superficie predefinita, arriva — in ritardo, e dicendolo.
        process.stderr.write(
          `impegno ${e.anchor}: scaduto, ma "${e.channel}" non arriva a nessuno da qui — ` +
            `resta in attesa\n→ ${e.remedy}\n`,
        );
      } else if (e.kind === 'failed') {
        // Il processo e' vivo: e' questo il punto della riga.
        process.stderr.write(`corsia impegni: giro fallito — ${e.error}\n`);
      }
    },
  });
  const scheduler = new Scheduler(
    runtime.jobs,
    makeJobRunner(runtime.deps, runtime.jobFires, runtime.executor, { cwd: runtime.workspace }),
    deliver,
    // ALWAYS_IDLE by omission, and it is a decision: a gateway has no terminal,
    // so there is no foreground to lose the lane to. When a surface turn becomes
    // able to say "the owner is talking right now" — the `queue`/`steer` slice —
    // this is the seam it plugs into, and the gate stops being a constant.
    undefined,
    (e) => {
      if (e.kind === 'delivery_failed') {
        process.stderr.write(`job ${e.job.id.slice(0, 8)}: consegna fallita (${e.error})\n`);
      } else if (e.kind === 'yielded') {
        // P21 (1b)/(2) MEDIUM: an aborted job retries every tick and a job
        // whose fire was declined by `stillOwner` mid-run both used to reach
        // no surface at all — under a supervisor, `journalctl` was the only
        // way to learn a job was stuck in a retry loop or lost a takeover race.
        process.stderr.write(`job ${e.job.id.slice(0, 8)}: ceduto — riproverà al prossimo giro\n`);
      } else if (e.kind === 'not_recorded') {
        // P21 (3) MEDIUM: `markRan`/`recordDelivery` threw. The fire still
        // happened and the schedule still advanced (see `settle`'s own
        // comment); this is the one place that says so.
        process.stderr.write(`job ${e.job.id.slice(0, 8)}: esito non registrato — ${e.error}\n`);
      }
    },
    undefined,
    undefined,
    // The outcome lands on the turn's row, so "did the 08:00 brief arrive" is a
    // query and not an inference from whether anyone was reading stderr.
    (turnId, state) => runtime.deps.turns.delivered(turnId, state),
    // The same token the turn lane gets below, which is the whole point of
    // building it above rather than letting each lane default to its own.
    modelLane,
    // P20: a fresh read of this gateway's own claim, re-verified before a job
    // starts and again before delivery — `standDown` alone gives this
    // scheduler no protection, since it always answers "no, I own it".
    () => lock.isCurrentClaim(),
    // B7: the last write before `markRan`, every time `markRan` is about to
    // run — never a required rewire, just the one thing this store still
    // needed to know before advancing a schedule it also gates.
    (job) => runtime.jobFires.settle(job.id, job.nextFireAt.toISOString()),
    // ADR-0054 §4: `/pause` da qualunque superficie, letta dal database che
    // tutti i processi condividono.
    () => pausa.attiva(),
    // ADR-0060: l'unico produttore di `commitment_due`. Passato allo scheduler
    // e non chiamato da `Gateway.tick`, perché le due condizioni che devono
    // zittirlo — handover e `/pause` — sono già risolte lì dentro.
    commitments,
  );

  /**
   * The turn lane, on the gateway's own beat.
   *
   * This is the process that lives, so it is the one that owes a suspended turn
   * its wake-up and an interrupted one its resume. The REPL deliberately does
   * not get one: it stands down for the gateway (ADR-0035), and two lanes over
   * one database would race for the same rows. `TurnStore.claim` makes that race
   * *safe* rather than *right* — one owner is the property worth having.
   *
   * Delivery goes through the surfaces this process actually connected, and it
   * is late-bound because they come up after the lock is taken: a resumed turn's
   * answer has no stack to return to, only the `replyTo` on its row. That
   * indirection is the seam B2's two-phase delivery attaches to.
   */
  let deliverFromLane: LaneDeliver = NO_SURFACE;
  /**
   * Late-bound for the same reason `deliverFromLane` is, immediately above:
   * the surfaces this call attaches to do not exist until `connectSurfaces`
   * runs, further down. Absent (`undefined`) until then means the same thing
   * `NO_SURFACE` means for delivery — a resumed turn in that window runs
   * silent, never throws.
   */
  let attachStreamFromLane: AttachStream | undefined;
  const laneLog = (e: LaneEvent): void => {
    if (e.kind === 'refused') {
      process.stderr.write(`turno ${e.turnId.slice(0, 8)}: ripresa rifiutata — ${e.why}\n`);
    } else if (e.kind === 'failed') {
      process.stderr.write(`turno ${e.turnId.slice(0, 8)}: ripresa fallita — ${e.error}\n`);
    } else if (e.kind === 'undeliverable') {
      // Said with the answer in it, because there is nowhere else it can go.
      // Under a supervisor this is the journal, which is the honest home for a
      // reply nobody was there to receive.
      process.stderr.write(
        `turno ${e.turnId.slice(0, 8)} su ${e.surface}: nessun indirizzo di risposta sulla riga, ` +
          `la risposta resta qui\n${e.text}\n`,
      );
    }
  };
  const turnLane = new TurnLane({
    turns: runtime.deps.turns,
    run: makeLaneRunner(
      runtime.deps,
      (turn, text) => deliverFromLane(turn, text),
      laneLog,
      (record) => attachStreamFromLane?.(record),
    ),
    onEvent: laneLog,
    // The same token the scheduler got, which is the whole point of building it
    // above rather than letting each lane default to its own.
    modelLane,
    // The same check the scheduler gets, and for the same reason (P20): this
    // lane has no `standDown` of its own here either, so without this a
    // takeover mid-resume would go uncaught until the next tick's `due()`
    // simply found nothing left to claim.
    stillOwner: () => lock.isCurrentClaim(),
    paused: () => pausa.attiva(),
  });
  onAssembled?.({ turnLane, lock });

  let stopSurfaces: ((budgetMs: number) => Promise<void>) | null = null;
  let controlSocket: ControlServer | undefined;
  const avviatoAlle = new Date().toISOString();
  const envTickMs = tickMsFromEnv(process.env['MUFFIN_GATEWAY_TICK_MS']);
  const gateway = new Gateway({
    ...(envTickMs === undefined ? {} : { tickMs: envTickMs }),
    ...gatewayOverrides,
    lock,
    notify,
    scheduler,
    turnLane,
    jobs: runtime.jobs,
    close: async (remainingMs) => {
      // Il socket per primo: da qui in poi nessuno deve poterci parlare, e il
      // file rimosto dalla chiusura pulita e' meta' del contratto — quello che
      // resta e' sempre e solo il socket di un morto (`control-socket.ts`).
      void controlSocket?.close();
      // Surfaces first, then the runtime: the connector must stop polling
      // before the database under it goes away (the REPL's order, same reason).
      //
      // **Awaited, not fired and forgotten.** Until 03/09/2026 `stopSurfaces`
      // only *signalled* — synchronous, `() => void` — and `runtime.close()`
      // ran the very next line, closing the database while a `getUpdates`
      // already in flight (Telegram's long poll, up to 65s) or a turn a
      // connector's own drain was still writing (never tracked by `Gateway`'s
      // `busy()` — those run outside `turnLane`) was still going. It landed on
      // the owner's real gateway: `~/.muffin/gateway.err` showed `telegram:
      // update 99665860 fallito — The database connection is not open`
      // followed by `telegram: polling fallito (The database connection is
      // not open)`, both after `gateway: SIGTERM — drenaggio…` had already
      // printed. `remainingMs` is what is left of `Gateway.drain`'s own
      // budget after its busy-wait — not a second budget invented here, so the
      // "fino a Xs" the owner already read stays true of the whole shutdown,
      // comfortably inside `unit.ts`'s `TimeoutStopSec` margin.
      await stopSurfaces?.(remainingMs);
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

  /**
   * Il socket di controllo, aperto **dopo** il claim e prima delle surface.
   *
   * Dopo il claim perche' un secondo gateway che ha gia' perso non deve
   * nemmeno provare a servirlo; prima delle surface perche' da qui in avanti
   * ogni fallimento di boot passa da `close()`, che e' dove il socket viene
   * tolto.
   *
   * Un errore qui **non ferma il gateway**: v1 e' sola osservazione, e un
   * canale diagnostico che impedisce l'avvio del processo che deve
   * diagnosticare e' la coda che scodinzola il cane.
   */
  try {
    controlSocket = await serveControlSocket(home, (verb) => {
      if (verb === 'identify') {
        return {
          protocol: CONTROL_PROTOCOL,
          pid: process.pid,
          home,
          codeSha: describeBuild(dirname(fileURLToPath(import.meta.url)))?.sha ?? null,
          startedAt: avviatoAlle,
        };
      }
      if (verb === 'superfici') {
        // La domanda che nessuno sapeva fare: una superficie abilitata sta
        // rispondendo adesso? Il gateway e' l'unico processo che lo sa, e la
        // risposta non sopravvive a lui — per questo si chiede qui e non a una
        // riga nel database. Prima che le superfici siano su, `null` dice
        // «non ancora», che e' diverso da «nessuna».
        return saluteSuperfici === null ? null : { superfici: saluteSuperfici.stato() };
      }
      if (verb === 'status') {
        // Risposto dal processo stesso, race-free: e' la differenza fra questo
        // e leggere una riga che puo' essere sopravvissuta a chi l'ha scritta.
        const info = readGateway(runtime.db);
        return { pid: process.pid, since: info?.since ?? avviatoAlle, status: info?.status ?? 'unknown' };
      }
      return null;
    });
  } catch (error) {
    process.stderr.write(`socket di controllo non aperto: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // La spinta alla corsia: quando l'owner risponde a un'approvazione da
  // Telegram, il turno riparte subito invece che al prossimo battito.
  const surfaces = connectSurfaces(runtime, home, gatewayCliWrite, () => {
    turnLane.tick();
  });
  stopSurfaces = surfaces.stop;
  // Bound now that the surfaces exist. Before this line a resumed turn would be
  // recorded `failed:` rather than sent nowhere quietly — the window is the boot
  // sequence, and the honest direction inside it is "undelivered", not "sent".
  deliverFromLane = surfaces.deliver;
  attachStreamFromLane = surfaces.attachStream;
  // The scheduler has been holding an indirection to this since before the
  // claim; from here on a due job reaches whatever is actually connected.
  registry = surfaces.registry;
  saluteSuperfici = surfaces.salute;
  // DAY-1 requirement B14, same as runRepl: a file the model produces during a job's
  // turn can reach the owner as a real attachment.
  attachSendFile(runtime, home, surfaces.registry);
  let mcpLines: string[] = [];
  try {
    mcpLines = await attachMcp(runtime, home);
  } catch (error) {
    mcpLines = [`mcp: ${error instanceof Error ? error.message : String(error)}`];
  }
  // `runtime.bootLines` below was rendered inside `buildRuntime`, before
  // `attachSendFile`/`attachMcp` just above registered anything — the tool
  // most at risk of a silent cut (`send_file`, DAY-1 B14) is exactly the one
  // that could never appear in that frozen array. `recomputeExposure` redoes
  // `profile.maxToolsExposed`'s cut against what is registered *now* and
  // returns the lines to print alongside it, rather than trusting a snapshot
  // that predates this gateway's own two `attach*` calls.
  const exposureLines = runtime.recomputeExposure();

  // Only when there is something to decide — see `reviewBootLine`.
  const review = reviewBootLine(runtime.db, CONSOLIDATION_TENANT);

  process.stderr.write(
    `muffin gateway · pid ${process.pid} · ${runtime.config.models.main}\n` +
      surfaces.lines.map((l) => `${l}\n`).join('') +
      mcpLines.map((l) => `${l}\n`).join('') +
      runtime.bootLines.map((l) => `${l}\n`).join('') +
      exposureLines.map((l) => `! ${l}\n`).join('') +
      // Said here too, and not only in the REPL: under a supervisor this line
      // is the journal entry that proves the memory lane exists in the process
      // that has no terminal — which is the one that was never going to be
      // watched.
      `${consolidationBootLine()}\n` +
      (review === null ? '' : `${review}\n`) +
      `supervisione: ${describeSupervision(process.env, process.platform)}\n`,
  );

  return gateway.serve();
}

/**
 * Where the CLI surface writes inside a gateway.
 *
 * stdout, which under a supervisor is the journal — visible with
 * `journalctl --user -u muffin-gateway`, and the honest place for a message
 * nobody was there to read.
 *
 * **What used to be here was the bug this slice exists to remove.** A whole
 * `Deliver` lived at this spot: `cli` wrote to stdout, and every other channel
 * wrote *"consegna remota da cablare"* to stderr and **returned normally**. A
 * normal return meant "delivered", so `markRan` advanced the schedule and the
 * job reported success — model paid, next fire moved, message never sent, and
 * nothing anywhere saying so. It is riga B8 of `docs/work/day1/requirements-status.md` and
 * it survived three separate reviews because nothing about a `Promise<void>`
 * looks wrong.
 *
 * It is not replaced by a more careful version of itself. It is replaced by not
 * existing: delivery comes from `connectSurfaces`' registry, so the channels
 * that are real are the surfaces that are actually connected, and one that is
 * not returns `{ delivered: false }` — a value, from one place, that the
 * scheduler cannot read as success.
 */
const gatewayCliWrite = (text: string): void => {
  process.stdout.write(`⏰ ${text}\n`);
};
