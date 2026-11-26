import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveIdentityLayers, USER_OVERLAY_TOKEN_BUDGET } from '../agent/context/identity.js';
import { migrateRotHome, readShippedBudgets } from '../core/rot/migrate.js';
import { findCheckoutRoot } from './git-root.js';
import { displayInHome } from './home-display.js';
import {
  applyIdentityMigration,
  type IdentityMigrationPlan,
  planIdentityMigration,
} from './identity-migrate.js';
import { promptLine } from './prompt.js';

export function rotMigrateUsage(home: string): string {
  const user = displayInHome(home, 'user.md');
  return `  muffin rot migrate            porta in rot/ i campi additivi nuovi (fuso e identità restano tuoi)
                                e mostra cosa sposterebbe da rot/identity.md a ${user}
  muffin rot migrate --apply    applica subito: backup, poi crea ${user}
                                senza --apply, su un terminale chiede prima di scrivere`;
}

/** Default-home wording, for call sites that have no install home yet. */
export const ROT_MIGRATE_USAGE = rotMigrateUsage(join(homedir(), '.muffin'));

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
 * them into a new user.md (ADR-0112, amendment of 26/11/2026). Preview never
 * writes rot/budgets.json.
 */
export async function runRotMigrate(
  home: string,
  argv: string[] = [],
  deps: RotMigrateDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const user = displayInHome(home, 'user.md');
  let apply = false;
  try {
    apply =
      parseArgs({ args: argv, options: { apply: { type: 'boolean' } }, allowPositionals: false })
        .values.apply === true;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nuso:\n${rotMigrateUsage(home)}\n`);
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
  const preview = migrateRotHome(home, readShippedBudgets(shippedDir), new Date(), {
    apply: false,
  });
  for (const line of preview.notes) out(line);
  if (preview.pendingWrite.length > 0) out(`da scrivere: ${preview.pendingWrite.join(', ')}`);
  if (!preview.writable) return 77;

  const confirm = deps.confirm ?? (isatty(0) ? (q: string) => promptLine(q) : undefined);
  const history = deps.history ?? (() => shippedIdentityHistory(moduleDir));
  const identity = previewIdentity(home, history, out, user);
  if (identity.kind === 'over-budget') return apply ? 1 : 0;

  const needsIdentity = identity.kind === 'ready';
  const needsBudgets = preview.pendingWrite.length > 0;
  if (!needsIdentity && !needsBudgets) return 0;

  let go = apply;
  if (!go && confirm !== undefined) {
    const answer = await confirm(confirmQuestion(user, needsIdentity, preview.pendingWrite));
    go = answer !== undefined && YES.has(answer.trim().toLowerCase());
  }
  if (!go) {
    out(
      needsIdentity
        ? `Niente scritto. Per applicare: \`muffin rot migrate --apply\` (backup di rot/identity.md, poi crea ${user}).`
        : 'Niente scritto. Per applicare: `muffin rot migrate --apply`.',
    );
    return 0;
  }

  if (needsBudgets) {
    const report = migrateRotHome(home, readShippedBudgets(shippedDir), new Date(), {
      apply: true,
    });
    for (const line of report.notes) {
      if (!preview.notes.includes(line)) out(line);
    }
    if (report.written.length > 0) out(`scritti: ${report.written.join(', ')}`);
    if (report.backedUp.length > 0) out(`backup: ${report.backedUp.join(', ')}`);
    if (!report.writable) return 77;
  }

  if (needsIdentity) {
    try {
      const done = applyIdentityMigration(home, identity.plan);
      out(`scritto: ${done.userFile} (0600)`);
      if (done.backup !== null) out(`backup: ${done.backup}`);
    } catch (error) {
      out(`identità: non ho scritto user.md — ${(error as Error).message}`);
      return 1;
    }
    out(identityMigrateNote(home));
    out(`Vale dal prossimo turno. Rileggi ${user} quando vuoi: è tuo.`);
  }
  return 0;
}

type IdentityPreview =
  | { kind: 'none' }
  | { kind: 'ready'; plan: Extract<IdentityMigrationPlan, { kind: 'ready' }> }
  | { kind: 'over-budget' };

function previewIdentity(
  home: string,
  history: () => string[],
  out: (line: string) => void,
  user: string,
): IdentityPreview {
  if (resolveIdentityLayers(home).mode !== 'legacy-home') {
    out(identityMigrateNote(home));
    return { kind: 'none' };
  }
  const plan = planIdentityMigration(home, { history: history() });
  if (plan.kind !== 'ready') {
    out(`identità: ${plan.reason}.`);
    return { kind: 'none' };
  }
  printPreview(plan, out, user);
  if (plan.overBudget) {
    out(
      `Troppo lungo per user.md (${String(plan.tokens)} token stimati su ${String(USER_OVERLAY_TOKEN_BUDGET)}): non scrivo niente. ` +
        `Accorcia le righe in rot/identity.md e rilancia, oppure crea tu ${user} con le sole righe che contano.`,
    );
    return { kind: 'over-budget' };
  }
  return { kind: 'ready', plan };
}

function confirmQuestion(user: string, needsIdentity: boolean, pendingWrite: string[]): string {
  if (needsIdentity && pendingWrite.length > 0) {
    return `Sposto queste righe in ${user}, aggiorno ${pendingWrite.join(', ')} e attivo la fondazione aggiornata? Faccio prima un backup. [s/N] `;
  }
  if (needsIdentity) {
    return `Sposto queste righe in ${user} e attivo la fondazione aggiornata? Faccio prima un backup. [s/N] `;
  }
  return `Aggiorno ${pendingWrite.join(', ')}? Faccio prima un backup. [s/N] `;
}

function printPreview(
  plan: Extract<IdentityMigrationPlan, { kind: 'ready' }>,
  out: (line: string) => void,
  user: string,
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
    `Righe tue da spostare in ${user} (${String(plan.tokens)} token stimati su ${String(USER_OVERLAY_TOKEN_BUDGET)}):`,
  );
  for (const line of plan.lines) out(`  │ ${line}`);
}

/**
 * Where the identity stands, said by the command an owner runs after an
 * update (ADR-0112).
 */
export function identityMigrateNote(home: string): string {
  const user = displayInHome(home, 'user.md');
  const layers = resolveIdentityLayers(home);
  switch (layers.mode) {
    case 'foundation':
      return 'identità: la fondazione arriva dal prodotto; nessun user.md. Niente da migrare.';
    case 'foundation+user':
      return `identità: fondazione dal prodotto + ${user}. rot/identity.md in home, se c'è, non è più letto e non lo tocco.`;
    case 'legacy-home':
      return (
        'identità: rot/identity.md in home è modificato e sostituisce ancora la fondazione. Non lo riscrivo. ' +
        `\`muffin rot migrate\` mostra le righe tue da spostare in ${user}; \`--apply\` le sposta dopo un backup.`
      );
  }
}
