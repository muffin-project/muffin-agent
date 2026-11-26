import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveIdentityLayers, USER_OVERLAY_TOKEN_BUDGET } from '../agent/context/identity.js';
import { migrateRotHome, readShippedBudgets } from '../core/rot/migrate.js';
import { findCheckoutRoot } from './git-root.js';
import {
  applyIdentityMigration,
  type IdentityMigrationPlan,
  planIdentityMigration,
} from './identity-migrate.js';
import { promptLine } from './prompt.js';

export const ROT_MIGRATE_USAGE = `  muffin rot migrate            porta in rot/ i campi additivi nuovi (fuso e identità restano tuoi)
                                e mostra cosa sposterebbe da rot/identity.md a ~/.muffin/user.md
  muffin rot migrate --apply    in più crea ~/.muffin/user.md con le righe tue, dopo un backup
                                (su un terminale lo chiede comunque prima di scrivere)`;

function shippedRotDir(moduleDir: string): string | null {
  const packaged = join(moduleDir, '..', 'defaults', 'rot');
  if (existsSync(join(packaged, 'budgets.json'))) return packaged;
  const checkout = findCheckoutRoot(moduleDir);
  if (checkout !== null) {
    const fromCheckout = join(checkout, 'defaults', 'rot');
    if (existsSync(join(fromCheckout, 'budgets.json'))) return fromCheckout;
  }
  return null;
}

/** At most this many past foundations are read from Git: enough for all of history today, bounded forever. */
const HISTORY_CAP = 200;

/**
 * Every version `defaults/rot/identity.md` has had on this checkout, so the
 * lines of an *older* foundation (what an old `init` copied) are recognised as
 * the product's, not the owner's. No checkout (a tarball install) → none, and
 * only the current foundation is compared — the preview still shows every
 * line before anything is written.
 */
export function shippedIdentityHistory(moduleDir: string): string[] {
  const root = findCheckoutRoot(moduleDir);
  if (root === null) return [];
  const rel = 'defaults/rot/identity.md';
  const log = spawnSync('git', ['log', '--format=%H', `-n${String(HISTORY_CAP)}`, '--', rel], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (log.status !== 0) return [];
  const out: string[] = [];
  for (const sha of log.stdout.split('\n').filter((l) => /^[0-9a-f]{40}$/.test(l))) {
    const show = spawnSync('git', ['show', `${sha}:${rel}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (show.status === 0) out.push(show.stdout);
  }
  return out;
}

export type RotMigrateDeps = {
  out?: (line: string) => void;
  /** A yes/no question on a real terminal; absent = no terminal, never ask. */
  confirm?: (question: string) => Promise<string | undefined>;
  /** Older shipped foundations; default: Git history of this checkout. */
  history?: () => string[];
};

const YES = new Set(['s', 'si', 'sì', 'y', 'yes']);

/**
 * Owner-facing `muffin rot migrate`. Never chowns, never overwrites identity:
 * the budgets step merges additive shipped fields; the identity step previews
 * the owner's lines and, only with `--apply` or a yes on a terminal, moves
 * them into a new `~/.muffin/user.md` (ADR-0112, amendment of 26/11/2026).
 */
export async function runRotMigrate(
  home: string,
  argv: string[] = [],
  deps: RotMigrateDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  let apply = false;
  try {
    apply =
      parseArgs({ args: argv, options: { apply: { type: 'boolean' } }, allowPositionals: false })
        .values.apply === true;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nuso:\n${ROT_MIGRATE_USAGE}\n`);
    return 78;
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const shippedDir = shippedRotDir(moduleDir);
  if (shippedDir === null) {
    process.stderr.write(
      'non trovo i default spediti (defaults/rot/budgets.json) né nel pacchetto né in un checkout.\n',
    );
    return 78;
  }
  const report = migrateRotHome(home, readShippedBudgets(shippedDir));
  for (const line of report.notes) out(line);
  if (report.written.length > 0) out(`scritti: ${report.written.join(', ')}`);
  if (report.backedUp.length > 0) out(`backup: ${report.backedUp.join(', ')}`);

  const identityCode = await migrateIdentity(home, apply, {
    out,
    confirm: deps.confirm ?? (isatty(0) ? (q: string) => promptLine(q) : undefined),
    history: deps.history ?? (() => shippedIdentityHistory(moduleDir)),
  });
  if (!report.writable) return 77;
  return identityCode;
}

async function migrateIdentity(
  home: string,
  apply: boolean,
  deps: {
    out: (line: string) => void;
    confirm: ((question: string) => Promise<string | undefined>) | undefined;
    history: () => string[];
  },
): Promise<number> {
  const { out } = deps;
  if (resolveIdentityLayers(home).mode !== 'legacy-home') {
    out(identityMigrateNote(home));
    return 0;
  }
  const plan = planIdentityMigration(home, { history: deps.history() });
  if (plan.kind !== 'ready') {
    out(`identità: ${plan.reason}.`);
    return 0;
  }
  printPreview(plan, out);
  if (plan.overBudget) {
    out(
      `Troppo lungo per user.md (${String(plan.tokens)} token stimati su ${String(USER_OVERLAY_TOKEN_BUDGET)}): non scrivo niente. ` +
        'Accorcia le righe in rot/identity.md e rilancia, oppure crea tu ~/.muffin/user.md con le sole righe che contano.',
    );
    return apply ? 1 : 0;
  }
  let go = apply;
  if (!go && deps.confirm !== undefined) {
    const answer = await deps.confirm(
      'Sposto queste righe in ~/.muffin/user.md e attivo la fondazione aggiornata? Faccio prima un backup. [s/N] ',
    );
    go = answer !== undefined && YES.has(answer.trim().toLowerCase());
  }
  if (!go) {
    out(
      'Niente scritto. Per applicare: `muffin rot migrate --apply` (backup di rot/identity.md, poi crea ~/.muffin/user.md).',
    );
    return 0;
  }
  try {
    const done = applyIdentityMigration(home, plan);
    out(`scritto: ${done.userFile} (0600)`);
    if (done.backup !== null) out(`backup: ${done.backup}`);
  } catch (error) {
    out(`identità: non ho scritto user.md — ${(error as Error).message}`);
    return 1;
  }
  out(identityMigrateNote(home));
  out('Vale dal prossimo turno. Rileggi ~/.muffin/user.md quando vuoi: è tuo.');
  return 0;
}

function printPreview(
  plan: Extract<IdentityMigrationPlan, { kind: 'ready' }>,
  out: (line: string) => void,
): void {
  out(
    'identità: rot/identity.md in home è modificato e sostituisce ancora la fondazione aggiornata del prodotto.',
  );
  if (plan.lines.length === 0) {
    out(
      'Non trovo righe tue: tutto il testo coincide con versioni spedite della fondazione. ' +
        'user.md nascerebbe vuoto, solo per passare alla fondazione aggiornata.',
    );
    return;
  }
  out(
    `Righe tue da spostare in ~/.muffin/user.md (${String(plan.tokens)} token stimati su ${String(USER_OVERLAY_TOKEN_BUDGET)}):`,
  );
  for (const line of plan.lines) out(`  │ ${line}`);
}

/**
 * Where the identity stands, said by the command an owner runs after an
 * update (ADR-0112).
 */
export function identityMigrateNote(home: string): string {
  const layers = resolveIdentityLayers(home);
  switch (layers.mode) {
    case 'foundation':
      return 'identità: la fondazione arriva dal prodotto; nessun user.md. Niente da migrare.';
    case 'foundation+user':
      return "identità: fondazione dal prodotto + ~/.muffin/user.md. rot/identity.md in home, se c'è, non è più letto e non lo tocco.";
    case 'legacy-home':
      return (
        'identità: rot/identity.md in home è modificato e sostituisce ancora la fondazione. Non lo riscrivo. ' +
        '`muffin rot migrate` mostra le righe tue da spostare in ~/.muffin/user.md; `--apply` le sposta dopo un backup.'
      );
  }
}
