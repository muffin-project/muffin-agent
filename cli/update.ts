import DatabaseCtor from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { makeStatusLine } from './status-line.js';
import { styleFor } from './ui.js';
import { backupNow } from './backup.js';
import { realishPath } from './init.js';
import { promptLine } from './prompt.js';
import { paths } from '../core/config/config.js';
import { readGateway } from '../core/gateway/lock.js';
import { checkSupervisor, realSupervisorProbes, type SupervisorProbes } from '../core/gateway/supervisor.js';
import { LAUNCHD_LABEL, SERVICE_NAME } from '../core/gateway/unit.js';
import { schemaVersionOf } from '../core/db/migrate.js';

/**
 * `muffin update` — releases built alongside, never in place.
 *
 * The install this repo ships (`install.sh`) is a symlink in `~/.local/bin`
 * pointing at `dist/cli/main.js` inside a git checkout, and the supervisor unit
 * points at that same symlink (`core/gateway/unit.ts`'s `resolveLauncher`
 * docstring: re-pointing the symlink is *already* the sanctioned way to move
 * what a running unit executes without touching the unit itself). This slice
 * is that fact, used on purpose: an update never edits the tree a live
 * gateway is running from. It fetches `origin/main`, checks out that commit
 * into its own `git worktree` under `.releases/<sha>` (sharing the object
 * store, not a second clone), builds and smoke-tests *that* directory, takes a
 * backup, and only then swings the launcher symlink(s) over — one `rename(2)`
 * per link, so a reader never sees a half-written target. A `npm ci` that
 * deletes `node_modules` and fails leaves the release directory broken; it
 * never leaves the running tree broken, because the running tree was never
 * touched. That is the property the old "pull in place, then repair on
 * failure" design could not get by trying harder — this one gets it by
 * construction (owner directive, 2026-08-26, after exploring the space).
 *
 * `main` is deliberately the channel this reads from — `dev` stays where
 * development happens; the two are not the same question `muffin update`
 * exists to answer.
 *
 * ## The one update this command cannot perform
 *
 * Its own arrival. An installation older than this file answers `comando
 * sconosciuto: update`, because the command ships *in the version being
 * updated to* — measured on the owner's own machine, 26/08/2026, which was
 * installed the day before. That first hop is manual and looks exactly like
 * what this command automates, minus the release directory: stop the
 * supervised gateway (`launchctl bootout` / `systemctl --user stop`, because
 * `npm ci` deletes `node_modules` under a live process), fast-forward the
 * checkout to `origin/main`, `npm ci && npm run compile`, bring the gateway
 * back. From then on the launcher points at a checkout this command
 * recognises (`currentOrBootstrap` below reads exactly that state as the
 * bootstrap marker), and every later update is one command.
 */

export type UpdateStep = { name: string; done: boolean; detail: string };
export type UpdateResult = { steps: UpdateStep[]; code: number };

type SpawnResult = { status: number; stdout: string; stderr: string };
type GitRunner = (args: string[], cwd: string) => SpawnResult;

export type UpdateDeps = {
  /** Where the running module lives. Tests point this at a fake checkout. */
  moduleDir?: string;
  home?: string;
  dryRun?: boolean;
  rollback?: boolean;
  /** Real `spawnSync('git', …)` by default; overridden only for the pure unit tests below. */
  git?: GitRunner;
  /** Real `npm ci` inside the release by default — the one step tests fake, per the injection pattern already used for `npmCi`/probes elsewhere in this CLI. */
  npmCi?: (releaseDir: string) => SpawnResult;
  /** `node <release>/dist/cli/main.js --help`, side-effect-free, by default. */
  smokeTest?: (releaseDir: string) => SpawnResult;
  /** `currentSchemaVersion()` read out of the *release's own* freshly compiled `dist` — never the version this already-running process loaded at start. */
  readNewSchemaVersion?: (releaseDir: string) => number | null;
  backup?: typeof backupNow;
  /** Where launcher symlinks are looked for. Real bindirs by default; tests point this at a throwaway directory. */
  bindirs?: string[];
  /**
   * Cosa sta per succedere, prima che succeda.
   *
   * `runUpdate` accumulava i passi in un array e non stampava **niente** fino
   * alla fine: `npm ci` dentro la release nuova prende decine di secondi, e per
   * tutto quel tempo il terminale era vuoto. Un aggiornamento che sembra
   * bloccato e' un aggiornamento che qualcuno interrompe a meta' — e questo
   * comando scambia un symlink.
   *
   * Due callback e non una perche' sono due momenti diversi: `onBegin` apre
   * un'attesa (la riga di stato viva), `onStep` la chiude con un esito che
   * resta nello scrollback. E' la stessa coppia `statusFor`/`formatProgressLine`
   * del REPL, sulla stessa `StatusLine`.
   */
  onBegin?: (name: string) => void;
  /** Un passo finito — con il suo esito. Fired man mano, non alla fine. */
  onStep?: (step: UpdateStep) => void;
};

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): SpawnResult {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
}

function git(args: string[], cwd: string): SpawnResult {
  return run('git', args, cwd);
}

function tail(text: string, maxLines = 25): string {
  const lines = text.trim().split('\n');
  return lines.length <= maxLines ? lines.join('\n') : `…\n${lines.slice(-maxLines).join('\n')}`;
}

/**
 * The one direction of the running-process/new-code split that has no test:
 * a git auth failure on the owner's VPS (the remote there is private) must
 * name the fix, not print git's own paragraph. Matched on git's own wording,
 * which is stable across the HTTPS and SSH transports.
 */
export function fetchFailureRemedy(stderr: string): string {
  if (
    /authentication failed|permission denied|could not read from remote|invalid username or password|repository .* not found|could not resolve host/i.test(
      stderr,
    )
  ) {
    return (
      'sembra un problema di accesso al remote: verifica la deploy key o il token ' +
      '(`git remote -v` per vedere l\'URL, poi controlla che la chiave/il token configurati abbiano accesso al repository).'
    );
  }
  return 'controlla la connessione e la configurazione del remote (`git remote -v`), poi riprova.';
}

/**
 * The git root of whatever checkout is running THIS code — never a path
 * assumed from `install.sh` or from `MUFFIN_HOME`, which is the data home and
 * a different directory on purpose. `null` means "not a git checkout at all",
 * which is an honest stop, not a guess at one.
 */
/** Quale commit è questa build, e se qualcuno l'ha toccata dopo. */
export type BuildStamp = { sha: string; date: string; dirty: boolean };

/**
 * L'identità di una build, che qui è un commit e non un numero di versione.
 *
 * `package.json` dice `0.0.0` e non è sbagliato: è vuoto. Questo progetto non
 * si distribuisce per release numerate — `muffin update` costruisce
 * `.releases/<sha>` e scambia il launcher, quindi **la cosa che identifica una
 * build è il suo commit**, ed è già quello che l'aggiornamento maneggia.
 *
 * Misurato il 27/08: per capire quale build fosse installata sulla macchina
 * dell'owner ho dovuto interrogare i sottocomandi — `muffin trace --help` non
 * aveva `turn`, `doctor` non aveva la riga `defaults` — e dedurre da lì che
 * fosse anteriore a #133 e #142. Una domanda a cui il binario dovrebbe
 * rispondere da solo.
 *
 * `dirty` non è un dettaglio: un checkout modificato **non è** quel commit, e
 * dire il suo SHA senza dirlo è la stessa classe di bugia di tutto il resto di
 * questa settimana — precisa, verificabile e falsa.
 *
 * `null` quando non c'è un checkout Git (un'installazione da tarball): non
 * sappiamo, e si dice.
 */
export function describeBuild(moduleDir: string, gitRunner: GitRunner = git): BuildStamp | null {
  const head = gitRunner(['log', '-1', '--format=%H %cs'], moduleDir);
  if (head.status !== 0) return null;
  const [sha, date] = head.stdout.trim().split(' ');
  if (sha === undefined || date === undefined || sha.length < 7) return null;
  const status = gitRunner(['status', '--porcelain'], moduleDir);
  // Uno `status` che fallisce non rende la build pulita: nel dubbio si dichiara
  // toccata, perché l'errore che costa è il contrario.
  return { sha, date, dirty: status.status !== 0 || status.stdout.trim() !== '' };
}

/**
 * Il checkout che possiede `.releases/` — che è il **worktree principale**, non
 * quello da cui questo processo sta girando.
 *
 * `rev-parse --show-toplevel` risponde con il worktree *corrente*, e una release
 * È un worktree collegato (`git worktree add`). Quindi dopo il primo update il
 * processo in esecuzione vive dentro `.releases/<sha>`, `--show-toplevel` da lì
 * risponde con quella directory, e la release successiva viene creata **dentro**
 * la precedente. Misurato sulla macchina dell'owner il 27/08 dopo tre update:
 *
 *     .releases/9a98bbe/.releases/2c35425/.releases/9e1b5af/dist/cli/main.js
 *
 * cioè il percorso a cui puntava davvero il launcher. Non è cosmetico e non si
 * ferma da solo:
 *
 *  - il percorso cresce di un livello a ogni aggiornamento, per sempre;
 *  - `pruneOldReleases` guarda nel `.releases` della radice che ha trovato,
 *    quindi pota i fratelli dentro l'ultimo nido e **non** i gusci esterni: il
 *    disco cresce e nessuno lo rivendica;
 *  - `--rollback` legge il `current` del nido corrente, quindi si può tornare
 *    indietro di un passo solo, e i passi precedenti diventano irraggiungibili;
 *  - `doctor` costruisce i suoi rimedi da questa radice, ed è così che è uscito
 *    un `cp .releases/…/.releases/…/.releases/…/defaults/voice.md` — la riga che
 *    ha reso il difetto visibile.
 *
 * `git worktree list --porcelain` mette il worktree principale **per primo**, ed
 * è documentato che lo faccia: è la domanda giusta da fare, invece di dedurre da
 * dove si sta girando. Il fallback su `--show-toplevel` resta per il caso in cui
 * `worktree list` non risponda — su un checkout normale le due risposte
 * coincidono, quindi il fallback non cambia niente per chi non ha mai aggiornato.
 */
export function findCheckoutRoot(moduleDir: string, gitRunner: GitRunner = git): string | null {
  const wt = gitRunner(['worktree', 'list', '--porcelain'], moduleDir);
  if (wt.status === 0) {
    const prima = wt.stdout.split('\n').find((l) => l.startsWith('worktree '));
    const principale = prima?.slice('worktree '.length).trim();
    if (principale !== undefined && principale !== '') {
      try {
        return realpathSync(principale);
      } catch {
        return principale;
      }
    }
  }
  const r = gitRunner(['rev-parse', '--show-toplevel'], moduleDir);
  if (r.status !== 0) return null;
  const top = r.stdout.trim();
  if (top === '') return null;
  try {
    return realpathSync(top);
  } catch {
    return top;
  }
}

const LAUNCHER_NAMES = ['muffin', 'muffin-agent'] as const;

/** Same bindirs `install.sh` and `cli/gateway.ts`'s `currentLauncher()` check, in the same order. */
function defaultBindirs(): string[] {
  return [process.env['MUFFIN_BINDIR'], join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  );
}

/**
 * Where a launcher symlink points, resolved as far as the filesystem actually
 * lets it — never `ENOENT` on a target that is not fully there. `realpathSync`
 * alone requires the WHOLE chain to exist, which fails exactly the case that
 * matters here: right after the flip to a release whose `dist/` a real build
 * is still writing, or in this file's own tests, where `npm ci`/the smoke
 * test are faked and never write one at all. `readlinkSync` never resolves
 * anything (`ENOENT`/`EINVAL` only if `link` itself is absent or not a
 * symlink — a foreign binary, correctly treated as "not ours"); `realishPath`
 * (`cli/init.ts`, built for `--local`'s not-yet-created directory) then
 * resolves whatever prefix of that target does exist and re-attaches the
 * rest untouched.
 */
function resolvedLauncherTarget(link: string): string | null {
  let raw: string;
  try {
    raw = readlinkSync(link);
  } catch {
    return null; // absent, or not a symlink at all (a foreign real binary).
  }
  return realishPath(isAbsolute(raw) ? raw : join(dirname(link), raw));
}

/**
 * Every launcher symlink under the known bindirs that resolves INTO this
 * checkout — the main worktree or any `.releases/<sha>` beneath it — never a
 * foreign `muffin` (ADR-0012: Linux Mint's Cinnamon window manager owns that
 * name too). Identity by realpath prefix, the same test `resolveLauncher`
 * uses for the same reason.
 */
export function findOwnedLaunchers(checkoutRoot: string, bindirs: string[] = defaultBindirs()): string[] {
  const found: string[] = [];
  for (const dir of bindirs) {
    for (const name of LAUNCHER_NAMES) {
      const link = join(dir, name);
      const real = resolvedLauncherTarget(link);
      if (real !== null && (real === checkoutRoot || real.startsWith(`${checkoutRoot}/`))) found.push(link);
    }
  }
  return found;
}

/**
 * tmp-symlink then `rename(2)`: the destination is always either the old
 * target or the new one, in full, for every reader — never a link caught
 * half-written. `renameSync` replaces unconditionally, so this works whether
 * or not `linkPath` already exists.
 */
export function atomicSymlink(target: string, linkPath: string): void {
  const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  symlinkSync(target, tmp);
  renameSync(tmp, linkPath);
}

type ReleaseMarker = { sha: string; entry: string };

function releasesDir(checkoutRoot: string): string {
  return join(checkoutRoot, '.releases');
}

function markerPath(checkoutRoot: string, name: 'current' | 'previous'): string {
  return join(releasesDir(checkoutRoot), name);
}

function readMarker(checkoutRoot: string, name: 'current' | 'previous'): ReleaseMarker | null {
  try {
    const raw = JSON.parse(readFileSync(markerPath(checkoutRoot, name), 'utf8')) as Partial<ReleaseMarker>;
    return typeof raw.sha === 'string' && typeof raw.entry === 'string' ? (raw as ReleaseMarker) : null;
  } catch {
    return null;
  }
}

/** Same tmp-then-rename idiom as `atomicSymlink`, for the plain bookkeeping file. */
function writeMarker(checkoutRoot: string, name: 'current' | 'previous', marker: ReleaseMarker): void {
  const dir = releasesDir(checkoutRoot);
  mkdirSync(dir, { recursive: true });
  const link = markerPath(checkoutRoot, name);
  const tmp = `${link}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, link);
}

/** `<release>/dist/cli/main.js` → the release directory, however deep the entry lives. */
function releaseRootOf(entry: string): string {
  return dirname(dirname(dirname(entry)));
}

/**
 * What "current" means, including on a checkout that has never run `muffin
 * update` before: no marker yet is not a broken state, it is the bootstrap
 * one — the release IS the main worktree, exactly as `install.sh` left it.
 */
function currentOrBootstrap(checkoutRoot: string, gitRunner: GitRunner): { marker: ReleaseMarker; bootstrap: boolean } {
  const existing = readMarker(checkoutRoot, 'current');
  if (existing) return { marker: existing, bootstrap: false };
  const sha = gitRunner(['rev-parse', 'HEAD'], checkoutRoot).stdout.trim();
  return { marker: { sha, entry: join(checkoutRoot, 'dist', 'cli', 'main.js') }, bootstrap: true };
}

function releaseDirNameOf(checkoutRoot: string, marker: ReleaseMarker): string | null {
  const dir = releasesDir(checkoutRoot);
  if (!marker.entry.startsWith(`${dir}/`)) return null; // the bootstrap/main-worktree marker
  return marker.entry.slice(dir.length + 1).split('/')[0] ?? null;
}

/** Every `.releases/<name>` directory not in `keep` — a straight `git worktree remove`, belt-and-suspenders `rm -rf` after. */
function pruneOldReleases(checkoutRoot: string, keep: ReadonlySet<string>, gitRunner: GitRunner): string[] {
  const dir = releasesDir(checkoutRoot);
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    const full = join(dir, entry.name);
    gitRunner(['worktree', 'remove', '--force', full], checkoutRoot);
    rmSync(full, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

function defaultNpmCi(releaseDir: string): SpawnResult {
  return run('npm', ['ci'], releaseDir, 600_000);
}

function defaultSmokeTest(releaseDir: string): SpawnResult {
  return run(process.execPath, [join(releaseDir, 'dist', 'cli', 'main.js'), '--help'], releaseDir, 15_000);
}

/**
 * `currentSchemaVersion()` out of the release's OWN compiled `dist` —
 * spawned, never imported in-process. This process already loaded
 * `core/db/migrate.js` at start, and Node's ESM cache keys by resolved URL: a
 * second `import()` of the same path returns the SAME module, not whatever
 * the release just compiled. A child process is the only way to read what
 * the new code actually says.
 */
function defaultReadNewSchemaVersion(releaseDir: string): number | null {
  const migrateJs = join(releaseDir, 'dist', 'core', 'db', 'migrate.js');
  if (!existsSync(migrateJs)) return null;
  const url = pathToFileURL(migrateJs).href;
  const r = run(
    process.execPath,
    ['--input-type=module', '-e', `import(${JSON.stringify(url)}).then(m=>process.stdout.write(String(m.currentSchemaVersion())))`],
    releaseDir,
    15_000,
  );
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

function migrationsDetail(dbPath: string, newVersion: number | null): string {
  if (!existsSync(dbPath)) return 'nessun database ancora — la prima `muffin init` lo crea già alla forma corrente';
  if (newVersion === null) return 'non riesco a leggere lo schema del codice nuovo (dist/core/db/migrate.js mancante, o il subprocess è fallito)';
  const db = new DatabaseCtor(dbPath, { readonly: true });
  let have: number | null;
  try {
    have = schemaVersionOf(db);
  } finally {
    db.close();
  }
  if (have === null) return 'database senza schema_version — verrà stampata al primo avvio';
  if (have === newVersion) return `schema già alla versione corrente (v${have}) — nessuna migrazione in sospeso`;
  if (have < newVersion) {
    return `database a v${have}, il codice nuovo arriva a v${newVersion} — ${newVersion - have} migrazione/i in sospeso: partirà al prossimo avvio (repl o gateway)`;
  }
  return `database a v${have}, il codice nuovo arriva solo a v${newVersion} — non dovrebbe succedere dopo un aggiornamento: non avviarlo finché non controlli`;
}

function restartCommand(platform: NodeJS.Platform): { printable: string; argv: string[] } {
  if (platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const target = `gui/${uid}/${LAUNCHD_LABEL}`;
    return { argv: ['launchctl', 'kickstart', '-k', target], printable: `launchctl kickstart -k ${target}` };
  }
  const unit = `${SERVICE_NAME}.service`;
  return { argv: ['systemctl', '--user', 'restart', unit], printable: `systemctl --user restart ${unit}` };
}

function isGatewayRunning(home: string): boolean {
  const file = paths(home).db;
  if (!existsSync(file)) return false;
  const db = new DatabaseCtor(file, { readonly: true });
  try {
    return readGateway(db) !== null;
  } finally {
    db.close();
  }
}

/**
 * Step 7 of the mandate, and the honesty the coordinator asked for on top of
 * it: declining the restart (or having nothing to restart) does not mean the
 * new code sits idle. It is already live on disk after the flip — the next
 * process start picks it up regardless, including one nobody asked for (a
 * crash under a supervisor that restarts on its own), and that is also when a
 * pending migration runs. Said once, every time an immediate restart did not
 * happen.
 */
export async function offerGatewayRestart(
  home: string,
  opts: {
    yes: boolean;
    platform: NodeJS.Platform;
    promptFn?: typeof promptLine;
    restart?: (argv: string[]) => SpawnResult;
    /** Same injection seam `cli/doctor.ts` uses for `checkSupervisor` — real OS probes by default, overridden so a test never shells out to a real systemctl/launchctl. */
    supervisorProbes?: Partial<SupervisorProbes>;
    gatewayRunning?: boolean;
  },
): Promise<void> {
  const promptFn = opts.promptFn ?? promptLine;
  const restart = opts.restart ?? ((argv: string[]) => run(argv[0]!, argv.slice(1), home, 30_000));
  const status = checkSupervisor(opts.platform, home, opts.gatewayRunning ?? isGatewayRunning(home), {
    ...realSupervisorProbes(),
    ...opts.supervisorProbes,
  });

  const carryOn = (): void => {
    process.stderr.write(
      `Il codice nuovo entra comunque al prossimo riavvio del processo` +
        (status.engaged ? ' — anche un crash: il supervisore lo fa ripartire da solo' : ' (repl o gateway, quando lo rilanci tu)') +
        ` — le migrazioni pendenti, se ce ne sono, girano a quel riavvio.\n`,
    );
  };

  if (!status.engaged) {
    process.stderr.write(`nessun gateway supervisionato: ${status.detail}\n  → ${status.remedy}\n`);
    carryOn();
    return;
  }

  const { printable, argv } = restartCommand(opts.platform);
  const doRestart = (): void => {
    process.stderr.write(`\n${printable}\n`);
    const r = restart(argv);
    if (r.status === 0) {
      process.stderr.write('gateway riavviato.\n');
    } else {
      process.stderr.write(`il riavvio non è uscito 0: ${(r.stderr || r.stdout).trim()}\n`);
      carryOn();
    }
  };

  if (opts.yes) {
    doRestart();
    return;
  }

  const answer = await promptFn('\nGateway supervisionato trovato. Riavvio ora così gira il codice nuovo? [Y/n] ');
  if (answer === undefined) {
    process.stderr.write(`\nPer far girare il codice nuovo ora:\n  ${printable}\n`);
    carryOn();
    return;
  }
  if (answer !== '' && !/^(y(es)?|s(i|ì)?)$/i.test(answer)) {
    process.stderr.write(`Va bene. Quando vuoi:\n  ${printable}\n`);
    carryOn();
    return;
  }
  doRestart();
}

function rollback(checkoutRoot: string, home: string, deps: UpdateDeps, steps: UpdateStep[]): UpdateResult {
  const push = (name: string, detail: string, done = true): void => {
    steps.push({ name, done, detail });
  };
  const previous = readMarker(checkoutRoot, 'previous');
  if (!previous) {
    push('rollback', 'nessuna release precedente registrata — niente da cui tornare indietro', false);
    return { steps, code: 1 };
  }
  const current = readMarker(checkoutRoot, 'current');

  const dbPath = paths(home).db;
  if (existsSync(dbPath)) {
    const readNewSchemaVersion = deps.readNewSchemaVersion ?? defaultReadNewSchemaVersion;
    const targetVersion = readNewSchemaVersion(releaseRootOf(previous.entry));
    if (targetVersion !== null) {
      const db = new DatabaseCtor(dbPath, { readonly: true });
      let have: number | null;
      try {
        have = schemaVersionOf(db);
      } finally {
        db.close();
      }
      if (have !== null && have > targetVersion) {
        push(
          'rollback',
          `il database è già a schema v${have}; il codice a cui torneresti (release ${previous.sha.slice(0, 7)}) arriva solo a v${targetVersion} ` +
            `e si rifiuterà di avviarsi (SchemaAheadError, guardia esistente in core/db/migrate.ts). ` +
            `Ripristina un backup preso PRIMA di quella migrazione (\`muffin restore <file> --yes\`), poi riprova il rollback.`,
          false,
        );
        return { steps, code: 1 };
      }
    }
  }

  const bindirs = deps.bindirs ?? defaultBindirs();
  const owned = findOwnedLaunchers(checkoutRoot, bindirs);
  for (const link of owned) atomicSymlink(previous.entry, link);
  if (current) writeMarker(checkoutRoot, 'previous', current); // toggle: a rollback of a rollback un-does itself
  writeMarker(checkoutRoot, 'current', previous);
  push(
    'rollback',
    `tornato a ${previous.sha.slice(0, 7)} (${previous.entry})` + (owned.length > 0 ? ` — launcher: ${owned.join(', ')}` : ' — nessun launcher trovato da flippare'),
  );
  return { steps, code: 0 };
}

/**
 * The whole command, minus the interactive restart offer (kept separate in
 * `offerGatewayRestart` because it is the one genuinely async, human-facing
 * part — everything here is synchronous `spawnSync`/sqlite calls, which is
 * what makes it straightforward to test step by step).
 */
export function runUpdate(deps: UpdateDeps = {}): UpdateResult {
  const gitRunner = deps.git ?? git;
  const home = deps.home ?? paths().home;
  const moduleDir = deps.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const steps: UpdateStep[] = [];
  const step = (name: string, detail: string, done = true): void => {
    const s = { name, done, detail };
    steps.push(s);
    // Emesso **e** accumulato: `cmdUpdate` lo mostra mentre succede, e
    // `UpdateResult.steps` resta il riepilogo che i test leggono. Due consumatori
    // dello stesso evento, non due elenchi che possono divergere.
    deps.onStep?.(s);
  };
  const begin = (name: string): void => deps.onBegin?.(name);

  const checkoutRoot = findCheckoutRoot(moduleDir, gitRunner);
  if (checkoutRoot === null) {
    step(
      'checkout',
      `questa installazione non sembra un checkout git (${moduleDir}) — l'aggiornamento automatico non è possibile così. ` +
        `Aggiorna a mano, o reinstalla da un checkout git.`,
      false,
    );
    return { steps, code: 1 };
  }
  step('checkout', checkoutRoot);

  if (deps.rollback) return rollback(checkoutRoot, home, deps, steps);

  begin('fetch');
  const fetchRes = gitRunner(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], checkoutRoot);
  if (fetchRes.status !== 0) {
    step('fetch', `${fetchRes.stderr.trim() || 'git fetch fallito'}\n  → ${fetchFailureRemedy(fetchRes.stderr)}`, false);
    return { steps, code: 1 };
  }
  const newSha = gitRunner(['rev-parse', 'refs/remotes/origin/main'], checkoutRoot).stdout.trim();
  const newShort = gitRunner(['rev-parse', '--short', 'refs/remotes/origin/main'], checkoutRoot).stdout.trim();
  const baseline = currentOrBootstrap(checkoutRoot, gitRunner);
  const behindRes = gitRunner(['rev-list', '--count', `${baseline.marker.sha}..${newSha}`], checkoutRoot);
  const behind = Number(behindRes.stdout.trim() || '0');

  const bootstrapNote = baseline.bootstrap ? ' (nessuna release registrata ancora — confronto con l\'HEAD di questo checkout)' : '';

  if (deps.dryRun) {
    step(
      'dry-run',
      behind === 0
        ? `già aggiornato: origin/main è a ${newShort}, nessun commit di distanza${bootstrapNote}`
        : `dietro di ${behind} commit rispetto a origin/main (${baseline.marker.sha.slice(0, 7)} → ${newShort})${bootstrapNote}`,
    );
    return { steps, code: 0 };
  }

  step('fetch', `origin/main a ${newShort}${bootstrapNote}`);

  if (behind === 0) {
    step('aggiornamento', 'già aggiornato: nessun commit di distanza da origin/main');
    return { steps, code: 0 };
  }

  const releaseDir = join(releasesDir(checkoutRoot), newShort);
  if (existsSync(releaseDir)) {
    // A stale attempt at the same sha (e.g. a prior run that died mid-build).
    gitRunner(['worktree', 'remove', '--force', releaseDir], checkoutRoot);
    rmSync(releaseDir, { recursive: true, force: true });
    gitRunner(['worktree', 'prune'], checkoutRoot);
  }
  mkdirSync(releasesDir(checkoutRoot), { recursive: true });
  begin('release');
  const addRes = gitRunner(['worktree', 'add', releaseDir, newSha], checkoutRoot);
  if (addRes.status !== 0) {
    step('release', `\`git worktree add\` fallito: ${addRes.stderr.trim()}`, false);
    return { steps, code: 1 };
  }
  step('release', `worktree creato in ${releaseDir} — il codice in esecuzione non è toccato`);

  const npmCi = deps.npmCi ?? defaultNpmCi;
  begin('npm ci');
  const ciRes = npmCi(releaseDir);
  if (ciRes.status !== 0) {
    gitRunner(['worktree', 'remove', '--force', releaseDir], checkoutRoot);
    rmSync(releaseDir, { recursive: true, force: true });
    step(
      'npm ci',
      `fallito nella release nuova — release cancellata, il codice in esecuzione NON è stato toccato.\n${tail(ciRes.stderr || ciRes.stdout)}`,
      false,
    );
    return { steps, code: 1 };
  }
  step('npm ci', 'compilato nella release nuova');

  const entry = join(releaseDir, 'dist', 'cli', 'main.js');
  try {
    chmodSync(entry, 0o755);
  } catch {
    // Se manca del tutto lo scoprirà lo smoke test giusto sotto.
  }
  const smokeTest = deps.smokeTest ?? defaultSmokeTest;
  begin('smoke test');
  const smokeRes = smokeTest(releaseDir);
  if (smokeRes.status !== 0) {
    gitRunner(['worktree', 'remove', '--force', releaseDir], checkoutRoot);
    rmSync(releaseDir, { recursive: true, force: true });
    step(
      'smoke test',
      `\`node dist/cli/main.js --help\` non è uscito 0 nella release nuova — release cancellata, niente toccato.\n${tail(smokeRes.stderr || smokeRes.stdout)}`,
      false,
    );
    return { steps, code: 1 };
  }
  step('smoke test', '`--help` risponde nella release nuova, prima di toccare qualunque cosa viva');

  const p = paths(home);
  const backup = deps.backup ?? backupNow;
  if (!existsSync(p.db)) {
    step('backup', `nessun database in ${p.db} — niente da salvare, procedo`);
  } else {
    try {
      const { file, bytes } = backup(p.db, join(home, 'backups'));
      step(
        'backup',
        `${file} (${(bytes / 1e6).toFixed(1)} MB) — copre il database (memoria/episodi, job, budget, l'indice del vault): ` +
          `NON copre i file sorgente del vault (${p.vault}), config.json, i segreti (${p.secrets}), né il root of trust (${p.rot})`,
      );
    } catch (e) {
      step('backup', e instanceof Error ? e.message : String(e), false);
      return { steps, code: 1 }; // niente rete sotto, niente flip
    }
  }

  const bindirs = deps.bindirs ?? defaultBindirs();
  const owned = findOwnedLaunchers(checkoutRoot, bindirs);
  for (const link of owned) atomicSymlink(entry, link);
  const previousForMarker = currentOrBootstrap(checkoutRoot, gitRunner).marker;
  writeMarker(checkoutRoot, 'previous', previousForMarker);
  writeMarker(checkoutRoot, 'current', { sha: newSha, entry });
  step(
    'flip',
    owned.length > 0
      ? `launcher aggiornati verso ${entry}: ${owned.join(', ')}`
      : `nessun launcher in PATH punta a questo checkout — .releases/current aggiornato comunque (${entry}); se lanci muffin da un altro punto, ripunta il link a mano`,
  );

  const keepNames = new Set(
    [newShort, releaseDirNameOf(checkoutRoot, previousForMarker)].filter((x): x is string => x !== null),
  );
  const pruned = pruneOldReleases(checkoutRoot, keepNames, gitRunner);
  step('pulizia', pruned.length > 0 ? `release precedenti rimosse: ${pruned.join(', ')}` : 'niente da rimuovere');

  const readNewSchemaVersion = deps.readNewSchemaVersion ?? defaultReadNewSchemaVersion;
  step('schema', migrationsDetail(p.db, readNewSchemaVersion(releaseDir)));

  return { steps, code: 0 };
}

export const UPDATE_USAGE = `uso:
  muffin update [--dry-run] [--yes]     fetch origin/main, costruisce una release
                                         affiancata (git worktree + npm ci),
                                         backup, poi scambio atomico del/i
                                         launcher — il gateway vivo resta sul
                                         codice vecchio finché non riparte
                                         --dry-run  quanto sei indietro, non tocca niente
                                         --yes      salta la domanda «riavvio ora?»
  muffin update --rollback [--yes]      torna alla release precedente (flip inverso)
`;

/**
 * Il nome del passo → cosa sta facendo, in italiano.
 *
 * Stessa distinzione di `toolPhrase` nel REPL: `npm ci` e' il nome di un
 * comando, «installo e compilo la release nuova» e' quello che sta succedendo —
 * ed e' il passo che da solo vale questa slice, perche' e' quello lungo.
 * Il nome grezzo resta il fallback: un passo senza frase e' un passo che si
 * legge lo stesso, non un errore.
 */
const UPDATE_PHRASE: Readonly<Record<string, string>> = {
  fetch: 'guardo se c\'e\' qualcosa di nuovo',
  release: 'preparo la release nuova, senza toccare quella in esecuzione',
  'npm ci': 'installo e compilo la release nuova',
  'smoke test': 'provo che la release nuova risponda, prima di toccare qualunque cosa viva',
};

export async function cmdUpdate(argv: string[]): Promise<number> {
  let values: { 'dry-run'?: boolean; yes?: boolean; rollback?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, rollback: { type: 'boolean' } },
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(UPDATE_USAGE);
    return 78;
  }

  const home = paths().home;
  /**
   * Lo stesso oggetto del REPL, e per la stessa ragione: `npm ci` dentro la
   * release nuova prende decine di secondi durante i quali questo comando non
   * diceva niente. Senza TTY torna a essere una riga per passo, che e' esatta-
   * mente il vecchio comportamento — quindi uno script che legge questo output
   * legge gli stessi byte di prima.
   */
  const style = styleFor(process.stderr);
  process.stderr.write(`${style.header('muffin update')}\n`);
  const status = makeStatusLine((text) => process.stderr.write(text), process.stderr.isTTY === true);
  const result = runUpdate({
    home,
    dryRun: values['dry-run'] ?? false,
    rollback: values.rollback ?? false,
    onBegin: (name) => status.show(`${UPDATE_PHRASE[name] ?? name}…`),
    onStep: (s) => status.line(`${s.done ? '✓' : '!'} ${s.name.padEnd(14)} ${s.detail}`),
  });
  status.stop();

  if (result.code !== 0 || values['dry-run']) return result.code;

  await offerGatewayRestart(home, { yes: values.yes ?? false, platform: process.platform });
  return 0;
}
