import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { hardeningHolds, type HardeningCheck } from './verify.js';

/**
 * `muffin rot harden` — the plan for making `hardened` true, never the deed.
 *
 * `hardeningHolds()` (verify.ts) already answers *whether* this machine
 * delivers what `hardened` claims. What it does not do — on purpose, it is a
 * pure check, injectable for tests — is tell the owner *what to run* to make
 * it true. This module is that second half: it reads the same facts
 * (ownership of `rot/`, `hardeningHolds`'s own verdict) and turns them into a
 * plan an owner can read and copy from, never something this process runs
 * itself. No `child_process`, no writes — see `cli/main.ts`'s `harden` verb,
 * which is the only thing allowed to touch stdout.
 */

/**
 * Mirrors the private `ANCHOR` constant in `verify.ts` — not exported there,
 * so duplicated here the same way `verify.test.ts` already does (a literal,
 * not a re-derivation): the filename is a public contract even though the
 * constant that names it is module-private.
 */
const ANCHOR_FILE = '.rot-anchor';

export type RotStat = (path: string) => { uid: number; mode: number };
export type GetUid = () => number | undefined;

/**
 * Who owns `rot/` right now — `known: false` only when `rot/` does not exist
 * yet (no `muffin init` has run). `username` is filled in only for the
 * common case (owned by this very process): there is no portable, dependency-
 * free way to resolve an *arbitrary* uid to a name without shelling out, and
 * this module never shells out.
 */
export type OwnerFact =
  | { known: false }
  | { known: true; uid: number; isSelf: boolean; username: string | null };

export function readOwner(
  rotDir: string,
  stat: RotStat,
  getuid: GetUid,
  myUsername: () => string | undefined,
): OwnerFact {
  if (!existsSync(rotDir)) return { known: false };
  const { uid } = stat(rotDir);
  const myUid = getuid();
  const isSelf = myUid !== undefined && uid === myUid;
  return { known: true, uid, isSelf, username: isSelf ? (myUsername() ?? null) : null };
}

/**
 * The commands themselves — pure, given the two real paths on this machine.
 *
 * Ownership only, never group: `chown user:group` would have to name the
 * right group on each platform (Linux's root group is `root`, macOS's is
 * `wheel`), and the check in `hardeningHolds` never looks at group identity —
 * only at uid-versus-mine and at whether *any* write bit is left open to
 * group/other. Leaving the group alone sidesteps a platform difference that
 * does not need to exist.
 *
 * `chmod go-w`, not an absolute mode like `444`: `rot/` is a directory, and a
 * directory needs its execute bit to stay traversable. An absolute `444`
 * would strip it and turn every read inside `rot/` into EACCES — the fix
 * would look identical to the bug it causes. The symbolic form touches only
 * the bit the check cares about and leaves read/execute exactly as they are.
 *
 * `root`, not a freshly `useradd`'d service account: the check only needs an
 * owner whose uid differs from the agent's own and who does not hand out
 * group/other write — root already satisfies both, on every machine, with no
 * provisioning step to get wrong. (`muffin init --hardened`'s own eventual
 * service-account story — `docs/blueprint/09-contratti-m0-m1.md` §4, the
 * "Hardened (raccomandata...)" bullet — is a different move: it relocates
 * the *runtime* to a dedicated user and keeps `rot/` with the installer.
 * That would leave the owner's own `muffin rot reseal` unaffected — the
 * opposite of what this command promises below. This command only ever
 * asked "who owns `rot/`", so it only ever changes that.)
 */
export function hardenCommands(rotDir: string, anchorPath: string): { linux: string[]; macos: string[] } {
  const chown = `sudo chown -R root ${rotDir} ${anchorPath}`;
  const chmod = `sudo chmod -R go-w ${rotDir} ${anchorPath}`;
  return {
    linux: [chown, chmod, `stat -c '%n %U %a' ${rotDir} ${anchorPath}`],
    macos: [chown, chmod, `stat -f '%N %Su %Lp' ${rotDir} ${anchorPath}`],
  };
}

export type HardenPlan = {
  rotDir: string;
  anchorPath: string;
  configPath: string;
  owner: OwnerFact;
  hardening: HardeningCheck;
  configMode: 'hardened' | 'single-user';
  /** = `hardening.holds`, named for the callers that never need the full check. */
  osHolds: boolean;
  /** True once the OS ownership *and* the declared mode both already agree. */
  done: boolean;
  linuxCommands: string[];
  macosCommands: string[];
};

export function buildHardenPlan(
  home: string,
  configMode: 'hardened' | 'single-user',
  deps: { stat?: RotStat; getuid?: GetUid; myUsername?: () => string | undefined } = {},
): HardenPlan {
  const stat = deps.stat ?? statSync;
  const getuid = deps.getuid ?? (() => process.getuid?.());
  const myUsername =
    deps.myUsername ??
    (() => {
      try {
        return userInfo().username;
      } catch {
        // No passwd entry for this uid (containers, some CI images) — the
        // owner still gets the uid, just not a name for it.
        return undefined;
      }
    });

  const rotDir = join(home, 'rot');
  const anchorPath = join(home, ANCHOR_FILE);
  const configPath = join(home, 'config.json');
  const owner = readOwner(rotDir, stat, getuid, myUsername);
  const hardening = hardeningHolds(home, stat, getuid);
  const osHolds = hardening.holds;
  const done = osHolds && configMode === 'hardened';
  // No commands to propose when there is nothing to `stat` yet either — an
  // uninstalled `rot/` fails `hardeningHolds` for an unrelated reason ("does
  // not exist"), which would otherwise leave chown/chmod lines sitting in the
  // plan for a directory that is not there.
  const commands = osHolds || !owner.known ? { linux: [], macos: [] } : hardenCommands(rotDir, anchorPath);

  return {
    rotDir,
    anchorPath,
    configPath,
    owner,
    hardening,
    configMode,
    osHolds,
    done,
    linuxCommands: commands.linux,
    macosCommands: commands.macos,
  };
}

/** Human prose, in Italian — see `cli/doctor.ts`'s `single-user` branch, which this is the remedy for. */
export function formatHardenPlan(plan: HardenPlan): string {
  if (!plan.owner.known) {
    return `${plan.rotDir} non esiste ancora — esegui \`muffin init\` prima di \`muffin rot harden\`.\n`;
  }

  const ownerLine = plan.owner.isSelf
    ? `${plan.rotDir} è di proprietà tua${plan.owner.username ? ` (${plan.owner.username}, uid ${plan.owner.uid})` : ` (uid ${plan.owner.uid})`} — lo stesso utente che esegue l'agente.`
    : `${plan.rotDir} è di proprietà di uid ${plan.owner.uid}, non tua.`;

  if (plan.done) {
    const holds = plan.hardening.holds; // implied by plan.done — narrows the union below
    return (
      `${ownerLine}\n` +
      `hardened è vero, verificato ora${holds && plan.hardening.caveat ? ` (${plan.hardening.caveat})` : ''}: ` +
      `questo processo non può scriverci, e config.json lo dichiara. Niente da proporre.\n`
    );
  }

  const why = plan.hardening.holds
    ? `l'appartenenza regge già a livello di file${plan.hardening.caveat ? `, ma ${plan.hardening.caveat}` : ''}`
    : plan.hardening.why;

  const lines: string[] = [
    'root of trust — hardening reale, non solo dichiarato',
    '',
    ownerLine,
    `→ ${why}`,
    '',
    'cosa cambia una volta vero — prima dei comandi, perché è la parte che decidi tu:',
    '  · sys.shell, e ogni altra capability ad alto rischio, per te owner a taint 0',
    '    diventano un allow silenzioso invece di chiederti conferma ogni volta',
    "  · da quel momento `muffin rot reseal` ti servirà un privilegio che oggi non",
    "    ti serve (es. sudo): rot/ non sarà più di tua proprietà",
    '',
  ];

  if (plan.configMode !== 'hardened') {
    lines.push(
      'prima dei comandi, dichiaralo:',
      `  ${plan.configPath} oggi dice "mode": "${plan.configMode}". Apri il file e metti`,
      '  "rot": { "mode": "hardened" } — è fuori dal root of trust: nessun',
      '  `muffin rot reseal` richiesto per questo file.',
      '',
    );
  }

  if (plan.linuxCommands.length > 0) {
    lines.push(
      'poi, i comandi — Linux prima (è dove gira Muffin in produzione):',
      ...plan.linuxCommands.map((c) => `  ${c}`),
      '',
      'macOS (questa è la macchina di sviluppo):',
      ...plan.macosCommands.map((c) => `  ${c}`),
      '',
    );
  }

  // `stop` **e poi** `start`, non `stop` da solo.
  //
  // Questa riga diceva «`muffin gateway stop`, poi il supervisore lo rialza da
  // solo», ed era vera fino a #217: da lì uno stop *chiesto* scrive un semaforo
  // e il supervisore **non** lo rialza, di proposito. Chi seguiva la vecchia
  // riga si ritrovava il gateway spento e l'hardening che sembrava averlo
  // rotto. È lo stesso difetto trovato in `gateway status` lo stesso giorno: un
  // rimedio che invecchia sotto una modifica fatta altrove, e che non fallisce
  // — si esegue, e lascia le cose peggio.
  lines.push(
    'infine:',
    '  riavvia il gateway — la modalità hardened si legge una volta sola, al suo',
    '  avvio: `muffin gateway stop`, poi `muffin gateway start` (uno stop chiesto',
    '  resta giù finché non sei tu a riaccenderlo — oppure `muffin gateway run` a',
    "  mano se non è supervisionato)",
  );

  return `${lines.join('\n')}\n`;
}
