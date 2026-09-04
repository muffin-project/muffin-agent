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
import { reconcileDefaults, rigaRiconciliazione } from './adopt.js';
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
 * gateway is running from. It fetches the channel's branch, checks out that
 * commit into its own `git worktree` under `.releases/<sha>` (sharing the object
 * store, not a second clone), builds and smoke-tests *that* directory, takes a
 * backup, and only then swings the launcher symlink(s) over — one `rename(2)`
 * per link, so a reader never sees a half-written target. A `npm ci` that
 * deletes `node_modules` and fails leaves the release directory broken; it
 * never leaves the running tree broken, because the running tree was never
 * touched. That is the property the old "pull in place, then repair on
 * failure" design could not get by trying harder — this one gets it by
 * construction (owner directive, 2026-08-26, after exploring the space).
 *
 * ## Il canale, e perché il comando non può più tacerlo
 *
 * `main` resta il canale **predefinito**, e per la ragione di sempre: è la
 * linea promossa, e la PR di promozione `dev → main` fa girare l'intera CI
 * esattamente sull'albero che sta per diventare `main`. È la verifica più
 * forte che questo repository produca.
 *
 * Ma `main` avanza **solo** quando un umano apre e mergia quella PR, e fino al
 * 03/09/2026 questo comando non sapeva distinguere due situazioni opposte che
 * stampava identiche: «non c'è niente di nuovo» e «c'è parecchio, nessuno
 * l'ha promosso». Misurato quel giorno sulla macchina dell'owner: il launcher
 * puntava a `5c49f1e`, che *era* la testa di `origin/main`, quindi `muffin
 * update` diceva «già aggiornato» ed era vero — mentre `origin/dev` era
 * avanti di sette commit non-merge, compresa la correzione che aspettava.
 *
 * Da ADR-0057 (`docs/decisions/0057-il-canale-si-dichiara.md`) il canale è
 * **una scelta dichiarata, non un default silenzioso**:
 *
 *  - `--channel <main|dev>` sceglie da dove leggere, per invocazione. Non è
 *    persistibile di proposito: un canale salvato in configurazione tornerebbe
 *    a essere un default invisibile, che è esattamente il difetto di partenza.
 *  - qualunque canale si legga, il comando **nomina sempre la distanza
 *    dell'altro** (`channelLagNote`): quanti commit ci sono su `origin/dev`
 *    che non sono su `origin/main`, e come installarli sapendo che non sono
 *    promossi. È la riga che mancava il 03/09.
 *  - dopo un aggiornamento riuscito dice **cosa è arrivato**
 *    (`arrivalsSummary`): i soggetti dei commit fra il marker vecchio e quello
 *    nuovo, non solo che è andato bene.
 *
 * La promozione automatica è stata valutata e **rifiutata** in quell'ADR, su
 * due fatti misurati e non su gusto: nessun workflow parte sul push a `dev`
 * (`.github/workflows/` — i trigger sono `pull_request` e il push a `main`),
 * quindi la testa di `dev` non ha **nessuna** check run da cui un cancello
 * possa leggere una conclusion; e la protezione di ramo su questo piano
 * risponde 403, quindi l'auto-merge di GitHub — l'unico cancello a conclusion
 * che non costerebbe CI in più — non è disponibile.
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

/**
 * I canali che questo comando sa leggere, e chi sta davanti a chi.
 *
 * Non è un elenco di rami: è la scala di promozione. `dev` è dove il lavoro
 * atterra, `main` è dove viene promosso, quindi `main` può essere indietro
 * rispetto a `dev` e mai il contrario. `UPSTREAM_OF` è esattamente quella
 * asimmetria, ed è ciò che rende la riga di ritardo una domanda con una
 * risposta sola invece di un confronto fra pari.
 */
export const CHANNELS = ['main', 'dev'] as const;
export type Channel = (typeof CHANNELS)[number];
export const DEFAULT_CHANNEL: Channel = 'main';
const UPSTREAM_OF: Readonly<Record<Channel, Channel | null>> = { main: 'dev', dev: null };

export function isChannel(x: string): x is Channel {
  return (CHANNELS as readonly string[]).includes(x);
}

/**
 * La riga che mancava il 03/09/2026.
 *
 * «già aggiornato» era vero e inutile: diceva che il canale letto non ha
 * commit nuovi, non che il lavoro esiste altrove e nessuno l'ha promosso. Le
 * due situazioni stampavano gli stessi byte, e l'owner ne ha concluso quella
 * sbagliata.
 *
 * Tre esiti, tre frasi diverse, e nessuna delle tre è il silenzio:
 *
 *  - il canale non ha niente sopra di sé (`dev`) → si dice, così chi legge sa
 *    che l'assenza di una distanza è una proprietà del canale e non un dato
 *    mancante;
 *  - la distanza non si è potuta misurare (`origin/<upstream>` non risponde) →
 *    si dichiara di non saperlo. Un numero non misurato non si inventa, e
 *    tacere qui sarebbe tornare al difetto;
 *  - la distanza c'è → **il numero e il ramo**, più il comando che li installa
 *    adesso sapendo che non sono promossi.
 *
 * Funzione pura: decide la riga, non la stampa.
 */
export function channelLagNote(args: {
  channel: Channel;
  upstream: Channel | null;
  /** `null` quando `origin/<upstream>` non si è potuto leggere: non si sa, e si dice. */
  ahead: number | null;
}): string {
  if (args.upstream === null) {
    return `stai leggendo ${args.channel}: è il ramo dove il lavoro atterra per primo, non c'è nessun canale più avanti.`;
  }
  const ref = `origin/${args.upstream}`;
  const qui = `origin/${args.channel}`;
  if (args.ahead === null) {
    return `non riesco a leggere ${ref}: non posso dire se ci sia lavoro non ancora arrivato su ${args.channel}.`;
  }
  if (args.ahead === 0) return `niente in attesa: ${ref} non ha commit oltre ${qui}.`;
  return (
    `su ${ref} ci sono ${args.ahead} commit che NON sono su ${qui}: questo aggiornamento non li contiene. ` +
    `Arrivano quando ${args.upstream} viene promosso su ${args.channel}; per installarli adesso, sapendo che non sono promossi:\n` +
    `  → muffin update --channel ${args.upstream}`
  );
}

/**
 * Cosa è arrivato, non solo che è andato bene.
 *
 * Prima l'aggiornamento riusciva e l'owner non imparava niente su ciò che
 * aveva appena installato: un `✓ flip` e un percorso. I soggetti dei commit
 * fra il marker vecchio e quello nuovo sono l'unica risposta che il comando
 * ha già in mano e non dava.
 *
 * `subjects === null` è il caso che conta per la robustezza: `git log` può non
 * rispondere (marker che punta a un commit potato, `.releases/current`
 * scritto da una release più vecchia, oggetto assente dopo un `gc`). Un
 * elenco mancante **non** è un aggiornamento fallito — la release è già viva
 * sul disco — quindi si degrada al conteggio, che si conosce comunque, invece
 * di far saltare il passo.
 */
export function arrivalsSummary(args: {
  /** I soggetti, dal più recente. `null` quando `git log` non ha risposto. */
  subjects: string[] | null;
  /** La distanza già misurata: nota anche quando i soggetti non lo sono. */
  fallbackCount: number;
  max?: number;
}): string {
  const max = args.max ?? 10;
  if (args.subjects === null) {
    return `${args.fallbackCount} commit installati — non riesco a elencarli (\`git log\` non ha risposto): \`git log\` nel checkout, quando vuoi vederli.`;
  }
  if (args.subjects.length === 0) {
    return `${args.fallbackCount} commit installati — nessuno di lavoro: solo merge.`;
  }
  const mostrati = args.subjects.slice(0, max);
  const resto = args.subjects.length - mostrati.length;
  return (
    `${args.subjects.length} commit installati:\n` +
    mostrati.map((s) => `  · ${s}`).join('\n') +
    (resto > 0 ? `\n  … e altri ${resto}` : '')
  );
}

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
  /** Da quale ramo leggere. `main` (promosso) di default; `dev` è una scelta esplicita, mai un default salvato — vedi la testa di questo file. */
  channel?: Channel;
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

/**
 * Exported for one reason: a `spawnSync` **timeout** is a case its own test
 * has to reach directly, because nothing about it is visible through
 * `offerGatewayRestart`'s injected `restart` — that seam replaces this whole
 * function, so a bug inside it can only be seen by calling it.
 *
 * The bug, measured on the owner's machine 03/09/2026: `launchctl kickstart -k`
 * printed «il riavvio non è uscito 0:» followed by nothing. `spawnSync` on a
 * timeout kills the child and sets `r.error` to the one clue that survives
 * (`spawnSync <cmd> ETIMEDOUT`) — but it leaves `r.stdout`/`r.stderr` as empty
 * **strings**, not `undefined` (verified: `spawnSync('sleep', ['2'], {timeout:
 * 200})` → `{status:null, stdout:'', stderr:'', error: Error(...ETIMEDOUT)}`).
 * The old `r.stderr ?? (r.error ? r.error.message : '')` only falls back on
 * `null`/`undefined`, so on a timeout it never fires and `r.error.message`
 * — the only sentence that says why — is built and then thrown away.
 */
export function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): SpawnResult {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  const stderr = r.stderr && r.stderr.trim() !== '' ? r.stderr : r.error ? r.error.message : (r.stderr ?? '');
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr };
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

/**
 * Le due conseguenze di un aggiornamento riuscito che il comando non diceva.
 *
 * Misurato sulla macchina dell'owner il 03/09/2026: `muffin update` è uscito 0,
 * il launcher puntava alla release nuova, e l'owner ha concluso che non avesse
 * funzionato. Aveva ragione a metà, per due fatti che il comando taceva:
 *
 *  1. **il checkout resta dov'era.** È la proprietà per cui questo comando
 *     esiste (`origin/main` finisce in `refs/remotes/origin/main`, la release
 *     si costruisce da lì, l'albero vivo non si tocca) e non deve cambiare —
 *     ma la conseguenza è che tutto ciò che si lancia *dal repository* è
 *     ancora il commit del checkout. Concretamente: `npm run e2e:telegram`
 *     falliva perché a quel commit lo script non esisteva ancora.
 *  2. **un processo già avviato continua col vecchio.** Node risolve il
 *     symlink all'avvio del processo, quindi una REPL lasciata aperta in tmux
 *     da giorni esegue ancora la release precedente. È la cosa che *sembrava*
 *     «non aggiornato».
 *
 * Il gateway supervisionato non entra in questa nota: `offerGatewayRestart`,
 * subito dopo, propone (o esegue, con `--yes`) il suo riavvio. Dirlo qui
 * sarebbe falso.
 *
 * Funzione pura — decide le righe, non le stampa: l'unità che il test legge
 * senza dover arrivare in fondo a un aggiornamento vero.
 */
export function noteDopoLoSwing(args: {
  releaseSha: string;
  /** `null` quando `rev-parse HEAD` nel checkout non risponde: non si sa, e non si inventa. */
  checkoutSha: string | null;
  /** Quanti commit separano l'HEAD del checkout dalla release. */
  behind: number;
  checkoutRoot: string;
}): string[] {
  const righe: string[] = [];
  if (args.checkoutSha !== null && args.checkoutSha !== args.releaseSha) {
    const quanto = args.behind > 0 ? `indietro di ${args.behind} commit` : 'su un commit diverso';
    righe.push(
      `il checkout resta a ${args.checkoutSha.slice(0, 7)}, ${quanto} dalla release ${args.releaseSha.slice(0, 7)}: ` +
        `quello che lanci dal repository (npm run …, i test) è ancora il codice vecchio.\n` +
        `  → git -C ${args.checkoutRoot} pull`,
    );
  }
  righe.push(
    'quello che era già in esecuzione continua sul codice vecchio: il symlink si risolve all\'avvio del processo. ' +
      'Una REPL aperta (anche in un tmux di giorni fa) va chiusa e rilanciata.',
  );
  return righe;
}

/**
 * Exported so `cli/gateway.ts`'s `muffin gateway restart` can build the exact
 * same `launchctl kickstart -k`/`systemctl --user restart` this file's own
 * `offerGatewayRestart` runs after `muffin update` — one mechanism, not a
 * second `launchctl` string that could drift from this one on the next macOS
 * quirk.
 */
export function restartCommand(platform: NodeJS.Platform): { printable: string; argv: string[] } {
  if (platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const target = `gui/${uid}/${LAUNCHD_LABEL}`;
    return { argv: ['launchctl', 'kickstart', '-k', target], printable: `launchctl kickstart -k ${target}` };
  }
  const unit = `${SERVICE_NAME}.service`;
  return { argv: ['systemctl', '--user', 'restart', unit], printable: `systemctl --user restart ${unit}` };
}

/**
 * Il pid che sta servendo adesso, o `null` — mai un booleano. `offerGatewayRestart`
 * deve confrontare un pid PRIMA con un pid DOPO per sapere se un riavvio è
 * davvero successo; «gira qualcosa» non basta a rispondere. Stessa lettura di
 * quella che c'era già in `isGatewayRunning`, generalizzata perché la stessa
 * domanda serve anche a `cli/gateway.ts` — un meccanismo solo, non due che
 * possono divergere.
 */
export function currentGatewayPid(home: string): number | null {
  const file = paths(home).db;
  if (!existsSync(file)) return null;
  const db = new DatabaseCtor(file, { readonly: true });
  try {
    return readGateway(db)?.pid ?? null;
  } finally {
    db.close();
  }
}

function isGatewayRunning(home: string): boolean {
  return currentGatewayPid(home) !== null;
}

/**
 * «È già cambiato?», chiesto un numero limitato di volte — mai `while(true)`:
 * un processo che non arriva mai non deve appendere la CLI in eterno per
 * un'osservazione che è comunque best-effort. Di default 8 letture ogni
 * 750ms, 6s in tutto: la claim del lock avviene presto nell'avvio di un
 * gateway sano (`cmdGatewayRun` in `cli/gateway.ts` la prende subito dopo
 * `buildRuntime`, prima di qualunque tick), quindi 6s bastano per un riavvio
 * che va bene; per uno che non va, dire onestamente «non confermato entro Ns»
 * è la risposta giusta — non un'attesa più lunga a caso.
 */
export async function waitForGatewayPid(
  readPid: () => number | null,
  before: number | null,
  opts: {
    attempts?: number | undefined;
    intervalMs?: number | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
  } = {},
): Promise<number | null> {
  const attempts = opts.attempts ?? 8;
  const intervalMs = opts.intervalMs ?? 750;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let pid = readPid();
  for (let i = 0; i < attempts && (pid === null || pid === before); i++) {
    await sleep(intervalMs);
    pid = readPid();
  }
  return pid;
}

export type RestartVerdict = { restarted: boolean; line: string };

/**
 * Le tre frasi diverse per tre esiti diversi — mai la stessa consolazione per
 * casi opposti. Misurato il 03/09/2026: tutte e tre le strade stampavano
 * «entra comunque al prossimo riavvio», compreso il caso in cui il gateway
 * era appena ripartito. La regola è quella della casa: il successo lo decide
 * lo STATO (un pid diverso da prima), mai l'exit status del comando che ha
 * appena mutato il supervisore.
 *
 * Funzione pura — decide il testo, non lo stampa — cosicché ogni esito abbia
 * un test che legge esattamente la frase e non un frammento di comportamento.
 */
export function restartVerdict(args: {
  pidBefore: number | null;
  pidAfter: number | null;
  commandOk: boolean;
  /** stderr/stdout del comando di riavvio, già scelto e già tagliato — mai vuoto quando il comando aveva qualcosa da dire (vedi `run`). */
  commandDetail: string;
}): RestartVerdict {
  const restarted = args.pidAfter !== null && args.pidAfter !== args.pidBefore;
  const chi = args.pidBefore === null ? 'nessun processo rilevato prima' : `pid ${args.pidBefore}`;
  if (restarted) {
    const base = `gateway riavviato — verificato: ${chi} → adesso serve pid ${args.pidAfter}.`;
    return {
      restarted: true,
      line: args.commandOk
        ? base
        : `${base}\n(il comando di riavvio aveva segnalato un errore, ma il gateway è comunque ripartito su un processo nuovo — probabile scontro transitorio con lo stato del supervisore appena dopo lo swing del symlink, non c'è altro da fare. Dettaglio del comando: ${args.commandDetail || '(nessuno)'})`,
    };
  }
  return {
    restarted: false,
    line:
      `il riavvio non è avvenuto: il gateway servito adesso è ancora lo stesso di prima (${chi}) — sei ancora sulla build vecchia.` +
      (args.commandOk
        ? ' Il comando è uscito 0, ma nessun processo nuovo ha preso il posto entro il tempo di attesa.'
        : `\n${args.commandDetail || '(il comando non è uscito 0 e non ha detto perché)'}`),
  };
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
    /** «Chi sta servendo, adesso?» — reale `currentGatewayPid(home)` di default, una coda in test. */
    readGatewayPid?: () => number | null;
    /** Timer reali di default; istantaneo nei test — vedi `waitForGatewayPid`. */
    sleep?: (ms: number) => Promise<void>;
    verifyAttempts?: number;
    verifyIntervalMs?: number;
  },
): Promise<void> {
  const promptFn = opts.promptFn ?? promptLine;
  const restart = opts.restart ?? ((argv: string[]) => run(argv[0]!, argv.slice(1), home, 30_000));
  const readGatewayPid = opts.readGatewayPid ?? (() => currentGatewayPid(home));
  const status = checkSupervisor(opts.platform, home, opts.gatewayRunning ?? readGatewayPid() !== null, {
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
  /**
   * Verifica lo stato dopo, non l'output (regola della casa). Il comando che
   * muta il supervisore viene comunque eseguito ed emesso — l'owner deve
   * poterlo rilanciare a mano — ma l'esito che si stampa non è più il suo
   * exit status: è se il pid che serve adesso è diverso da quello di prima.
   * Le tre frasi che ne escono sono decise in `restartVerdict`, che questa
   * funzione chiama e basta.
   */
  const doRestart = async (): Promise<void> => {
    process.stderr.write(`\n${printable}\n`);
    const pidBefore = readGatewayPid();
    const r = restart(argv);
    const commandDetail = (r.stderr || r.stdout).trim();
    const pidAfter = await waitForGatewayPid(readGatewayPid, pidBefore, {
      attempts: opts.verifyAttempts,
      intervalMs: opts.verifyIntervalMs,
      sleep: opts.sleep,
    });
    const verdict = restartVerdict({ pidBefore, pidAfter, commandOk: r.status === 0, commandDetail });
    process.stderr.write(`${verdict.line}\n`);
    if (!verdict.restarted) carryOn();
  };

  if (opts.yes) {
    await doRestart();
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
  await doRestart();
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

  const channel = deps.channel ?? DEFAULT_CHANNEL;
  const channelRef = `refs/remotes/origin/${channel}`;

  begin('fetch');
  const fetchRes = gitRunner(['fetch', 'origin', `+refs/heads/${channel}:${channelRef}`], checkoutRoot);
  if (fetchRes.status !== 0) {
    step('fetch', `${fetchRes.stderr.trim() || 'git fetch fallito'}\n  → ${fetchFailureRemedy(fetchRes.stderr)}`, false);
    return { steps, code: 1 };
  }
  const newSha = gitRunner(['rev-parse', channelRef], checkoutRoot).stdout.trim();
  const newShort = gitRunner(['rev-parse', '--short', channelRef], checkoutRoot).stdout.trim();
  const baseline = currentOrBootstrap(checkoutRoot, gitRunner);
  const behindRes = gitRunner(['rev-list', '--count', `${baseline.marker.sha}..${newSha}`], checkoutRoot);
  const behind = Number(behindRes.stdout.trim() || '0');

  /**
   * Il ramo davanti a questo canale, misurato — mai dedotto dal fatto che il
   * canale sia aggiornato. Un fetch del ramo a monte che fallisce non ferma
   * l'aggiornamento (non è il canale che si sta installando): rende la
   * distanza *ignota*, e `channelLagNote` lo dichiara invece di stampare zero.
   */
  const upstream = UPSTREAM_OF[channel];
  let ahead: number | null = null;
  if (upstream !== null) {
    const upstreamRef = `refs/remotes/origin/${upstream}`;
    if (gitRunner(['fetch', 'origin', `+refs/heads/${upstream}:${upstreamRef}`], checkoutRoot).status === 0) {
      const r = gitRunner(['rev-list', '--count', `${channelRef}..${upstreamRef}`], checkoutRoot);
      const n = Number(r.stdout.trim());
      if (r.status === 0 && Number.isFinite(n)) ahead = n;
    }
  }
  const lag = (): void => step('canale', channelLagNote({ channel, upstream, ahead }));

  const bootstrapNote = baseline.bootstrap ? ' (nessuna release registrata ancora — confronto con l\'HEAD di questo checkout)' : '';

  if (deps.dryRun) {
    step(
      'dry-run',
      behind === 0
        ? `già aggiornato: origin/${channel} è a ${newShort}, nessun commit di distanza${bootstrapNote}`
        : `dietro di ${behind} commit rispetto a origin/${channel} (${baseline.marker.sha.slice(0, 7)} → ${newShort})${bootstrapNote}`,
    );
    lag();
    return { steps, code: 0 };
  }

  step('fetch', `origin/${channel} a ${newShort}${bootstrapNote}`);

  if (behind === 0) {
    step('aggiornamento', `già aggiornato: nessun commit di distanza da origin/${channel}`);
    lag();
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

  /**
   * Cosa è appena entrato. `--no-merges` perché in questo repository i merge
   * si chiamano «Merge pull request #NNN from …»: il titolo della slice è già
   * nel commit che quel merge porta, e ripeterlo raddoppierebbe l'elenco
   * dicendo meno. Il conteggio di riserva è `behind`, che è misurato sopra e
   * resta noto anche se `git log` non risponde.
   */
  const logRes = gitRunner(['log', '--no-merges', '--format=%s', `${previousForMarker.sha}..${newSha}`], checkoutRoot);
  const subjects =
    logRes.status === 0
      ? logRes.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
      : null;
  step('novità', arrivalsSummary({ subjects, fallbackCount: behind }));
  lag();

  const keepNames = new Set(
    [newShort, releaseDirNameOf(checkoutRoot, previousForMarker)].filter((x): x is string => x !== null),
  );
  const pruned = pruneOldReleases(checkoutRoot, keepNames, gitRunner);
  step('pulizia', pruned.length > 0 ? `release precedenti rimosse: ${pruned.join(', ')}` : 'niente da rimuovere');

  const readNewSchemaVersion = deps.readNewSchemaVersion ?? defaultReadNewSchemaVersion;
  step('schema', migrationsDetail(p.db, readNewSchemaVersion(releaseDir)));

  // **I default della release nuova, portati in una casa vecchia.**
  //
  // Perche' qui e non altrove. `muffin update` e' l'unico momento in cui
  // esistono contemporaneamente le due cose che servono: una casa gia' viva, e
  // l'albero `defaults/` del codice **nuovo** — che sta in `releaseDir`, non
  // nel checkout, il quale dopo lo swing e' ancora indietro (vedi
  // `noteDopoLoSwing` due righe piu' sotto). Al boot sarebbe una scrittura in
  // un percorso che deve solo leggere, e su un verbo esplicito soltanto
  // dipenderebbe da qualcuno che si ricorda di digitarlo: e' esattamente cosi'
  // che le skill spedite non sono mai arrivate a casa dell'owner (03/09/2026,
  // il suo `defaults-manifest.json` elencava un file solo).
  //
  // Dopo lo swing e prima del riavvio, perche' il processo che riparte deve
  // gia' trovarsele: la sezione skill del prompt si assembla all'avvio.
  //
  // Sicuro per costruzione, non per attenzione: `reconcileDefaults` installa
  // **solo cio' che manca**, non scrive mai dentro `rot/` e non sostituisce
  // mai un file esistente — nemmeno uno adottabile, che resta un verbo
  // dell'owner. Un aggiornamento non deve poter riscrivere niente di suo.
  const riconciliato = reconcileDefaults(home, releaseDir);
  const rigaDefault = rigaRiconciliazione(riconciliato);
  step('default', rigaDefault ?? 'la casa ha gia\' tutti i default che questa release spedisce', riconciliato.falliti.length === 0);

  // Le due conseguenze che il comando taceva — vedi `noteDopoLoSwing`. Lo stato
  // si legge qui, dallo stesso `gitRunner` di tutto il resto; la decisione sta
  // nella funzione pura.
  const headRes = gitRunner(['rev-parse', 'HEAD'], checkoutRoot);
  const checkoutSha = headRes.status === 0 && headRes.stdout.trim() !== '' ? headRes.stdout.trim() : null;
  const dietroRes = checkoutSha === null ? null : gitRunner(['rev-list', '--count', `${checkoutSha}..${newSha}`], checkoutRoot);
  for (const riga of noteDopoLoSwing({
    releaseSha: newSha,
    checkoutSha,
    behind: Number(dietroRes?.stdout.trim() || '0'),
    checkoutRoot,
  })) {
    step('dopo', riga);
  }

  return { steps, code: 0 };
}

export const UPDATE_USAGE = `uso:
  muffin update [--dry-run] [--yes]     fetch del canale, costruisce una release
      [--channel main|dev]               affiancata (git worktree + npm ci),
                                         backup, poi scambio atomico del/i
                                         launcher — il gateway vivo resta sul
                                         codice vecchio finché non riparte
                                         --dry-run  quanto sei indietro, non tocca niente
                                         --yes      salta la domanda «riavvio ora?»
                                         --channel  da quale ramo leggere (default: main,
                                                    la linea promossa). Qualunque canale
                                                    scegli, il comando dice sempre quanti
                                                    commit ci sono sull'altro.
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
  let values: { 'dry-run'?: boolean; yes?: boolean; rollback?: boolean; channel?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
        rollback: { type: 'boolean' },
        channel: { type: 'string' },
      },
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(UPDATE_USAGE);
    return 78;
  }

  // Un canale sconosciuto si ferma qui, non a `git fetch`: `+refs/heads/<x>`
  // con una `<x>` arbitraria darebbe l'errore di git, che parla di refspec e
  // non della manopola che l'utente ha girato.
  const requested = values.channel ?? DEFAULT_CHANNEL;
  if (!isChannel(requested)) {
    process.stderr.write(`canale sconosciuto: ${requested} — i canali sono ${CHANNELS.join(', ')}\n${UPDATE_USAGE}`);
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
    channel: requested,
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
