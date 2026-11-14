import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ConfigError, loadConfig, saveConfig } from '../core/config/config.js';
import {
  describeWorkspace,
  isSameOrNestedPath,
  muffinWorkspace,
} from '../core/config/workspace.js';

/**
 * `muffin workspace` — la cartella in cui i turni lavorano, dichiarata una
 * volta.
 *
 * Il gateway e `muffin run` non hanno un `cd` da cui leggere una scelta: il
 * primo è avviato da launchd nella home, il secondo inoltra al primo. Senza
 * una dichiarazione finivano in `~/muffin-workspace`, una cartella vera ma non
 * il progetto su cui l'owner sta lavorando. Il REPL non ne ha bisogno — chi lo
 * apre da un progetto ha già scelto con `cd` — ed è per questo che la
 * precedenza mette la cwd esplicita davanti a tutto (`requestedWorkspace`).
 *
 * **Perché un comando e non una manopola di `muffin config set`.** Quella
 * superficie scrive numeri interi e non conosce il filesystem; questa deve
 * verificare che la cartella esista, che sia una cartella e che non sia
 * l'installazione — tre risposte che un `parse` numerico non può dare. Il
 * valore compare comunque in `muffin config`, perché è un campo della config:
 * l'inventario è derivato dallo schema, non da una seconda lista.
 */
export const WORKSPACE_USAGE = `usage:
  muffin workspace              mostra la cartella dichiarata e quella effettiva
  muffin workspace set <dir>    dichiara la cartella di lavoro dei turni
  muffin workspace clear        torna al default (~/muffin-workspace)
`;

export type WorkspaceDeps = {
  out: (line: string) => void;
  err: (line: string) => void;
};

function fail(deps: WorkspaceDeps, message: string, remedy?: string): number {
  deps.err(message);
  if (remedy !== undefined) deps.err(`→ ${remedy}`);
  return 2;
}

function status(home: string, deps: WorkspaceDeps): number {
  const config = loadConfig(home);
  const workspace = describeWorkspace(home, config.workspace);
  const source =
    workspace.envRejected === null && process.env.MUFFIN_WORKSPACE?.trim()
      ? 'MUFFIN_WORKSPACE'
      : workspace.configured !== null && workspace.configRejected === null
        ? 'config.json'
        : 'default';
  deps.out(`dichiarata  ${workspace.configured ?? '(nessuna — vale il default)'}`);
  deps.out(`effettiva   ${workspace.workspace}  (${source})`);
  deps.out(`default     ${muffinWorkspace(home)}`);
  deps.out(`esiste      ${workspace.exists ? 'sì' : 'no — si crea al primo turno che ci scrive'}`);
  if (workspace.configRejected) {
    deps.out(
      `! config.json dichiara ${workspace.configRejected.requested}, dentro l'installazione: ignorata.`,
    );
  }
  if (workspace.envRejected) {
    deps.out(
      `! MUFFIN_WORKSPACE=${workspace.envRejected.requested} punta dentro l'installazione: ignorata.`,
    );
  }
  if (
    workspace.configured !== null &&
    workspace.envRejected === null &&
    process.env.MUFFIN_WORKSPACE?.trim() &&
    resolve(process.env.MUFFIN_WORKSPACE.trim()) !== workspace.configured
  ) {
    deps.out(
      '  MUFFIN_WORKSPACE è esportata e vince sulla dichiarazione finché resta nella shell.',
    );
  }
  return 0;
}

function set(home: string, argv: string[], deps: WorkspaceDeps): number {
  if (argv.length !== 1) return fail(deps, WORKSPACE_USAGE.trim());
  const raw = argv[0];
  if (raw === undefined) return fail(deps, WORKSPACE_USAGE.trim());
  const target = resolve(raw);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return fail(
      deps,
      `la cartella ${target} non esiste, o non è una cartella.`,
      'creala prima, oppure indica un progetto che c’è già',
    );
  }
  if (isSameOrNestedPath(target, home)) {
    return fail(
      deps,
      `${target} è dentro l’installazione (${home}): non è uno spazio di lavoro.`,
      'dentro ~/.muffin ci sono memoria, sessioni e il sigillo; indica un progetto fuori da lì',
    );
  }

  const config = loadConfig(home);
  if (config.workspace === target) {
    deps.out(`workspace: già ${target} — config.json non toccata`);
    return 0;
  }
  saveConfig({ ...config, workspace: target }, home);
  deps.out(`workspace: ${config.workspace ?? muffinWorkspace(home)} → ${target}`);
  deps.out('→ il gateway legge la cartella all’avvio: `muffin gateway restart` per applicarla.');
  if (process.env.MUFFIN_WORKSPACE?.trim()) {
    deps.out(
      `! MUFFIN_WORKSPACE=${process.env.MUFFIN_WORKSPACE.trim()} è esportata e vince su questa dichiarazione finché resta nella shell.`,
    );
  }
  return 0;
}

function clear(home: string, deps: WorkspaceDeps): number {
  const config = loadConfig(home);
  if (config.workspace === undefined) {
    deps.out('workspace: nessuna dichiarazione da togliere — vale già il default');
    return 0;
  }
  const previous = config.workspace;
  const { workspace: _dropped, ...rest } = config;
  saveConfig(rest, home);
  deps.out(`workspace: ${previous} → default (${muffinWorkspace(home)})`);
  deps.out('→ il gateway legge la cartella all’avvio: `muffin gateway restart` per applicarla.');
  return 0;
}

export function cmdWorkspace(home: string, argv: string[], deps?: Partial<WorkspaceDeps>): number {
  const out = deps?.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps?.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const io = { out, err };

  const [sub, ...rest] = argv;
  try {
    if (sub === undefined) return status(home, io);
    if (sub === '--help' || sub === '-h' || sub === 'help') {
      out(WORKSPACE_USAGE.trim());
      return 0;
    }
    if (sub === 'set') return set(home, rest, io);
    if (sub === 'clear') {
      if (rest.length > 0) return fail(io, WORKSPACE_USAGE.trim());
      return clear(home, io);
    }
    return fail(
      io,
      `«${sub}» non è un sottocomando di \`muffin workspace\`.\n${WORKSPACE_USAGE.trim()}`,
    );
  } catch (error) {
    const e = error as ConfigError;
    err(e.message ?? String(error));
    if (e.remedy) err(`→ ${e.remedy}`);
    return 78;
  }
}
