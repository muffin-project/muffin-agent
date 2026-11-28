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
                                e mostra le preferenze trasferibili da rot/identity.md a ${user}
  muffin rot migrate --apply    applica subito: backup, poi crea ${user}
                                se il patto richiede una scelta, lo lascia attivo
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

export type RotMigrateDeps = {
  out?: (line: string) => void;
  /** A yes/no question on a real terminal; absent = no terminal, never ask. */
  confirm?: (question: string) => Promise<string | undefined>;
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
  const identity = planIdentityMigration(home);
  if (identity.kind === 'ready') {
    printPreview(identity, out, user);
  } else {
    out(`identità: ${identity.reason}`);
  }

  const needsIdentity = identity.kind === 'ready';
  const needsBudgets = preview.pendingWrite.length > 0;
  const identityExitCode = identity.kind === 'needs-review' && apply ? 1 : 0;
  if (!needsIdentity && !needsBudgets) return identityExitCode;

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
      const done = applyIdentityMigration(home, identity);
      out(`scritto: ${done.userFile} (0600)`);
      if (done.backup !== null) out(`backup: ${done.backup}`);
    } catch (error) {
      out(`identità: non ho scritto user.md — ${(error as Error).message}`);
      return 1;
    }
    out(identityMigrateNote(home));
    out(`Vale dal prossimo turno. Rileggi ${user} quando vuoi: è tuo.`);
  }
  return identityExitCode;
}

function confirmQuestion(user: string, needsIdentity: boolean, pendingWrite: string[]): string {
  if (needsIdentity && pendingWrite.length > 0) {
    return `Salvo le preferenze già attive in ${user}, aggiorno ${pendingWrite.join(', ')}? Faccio prima un backup. [s/N] `;
  }
  if (needsIdentity) {
    return `Salvo le preferenze già attive in ${user}? Faccio prima un backup. [s/N] `;
  }
  return `Aggiorno ${pendingWrite.join(', ')}? Faccio prima un backup. [s/N] `;
}

function printPreview(
  plan: Extract<IdentityMigrationPlan, { kind: 'ready' }>,
  out: (line: string) => void,
  user: string,
): void {
  out(
    `Preferenze già attive che verrebbero salvate in ${user} (${String(plan.tokens)} token stimati su ${String(USER_OVERLAY_TOKEN_BUDGET)}):`,
  );
  for (const line of plan.text.split('\n')) out(`  │ ${line}`);
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
    case 'foundation+legacy-preferences':
      return 'identità: fondazione aggiornata e preferenze personali già attive. Niente da migrare.';
    case 'legacy-home':
      return layers.foundationMissing
        ? 'identità: questa build non contiene la fondazione del prodotto.'
        : 'identità: il patto personalizzato resta attivo. Puoi mantenerlo oppure scegliere le preferenze da portare nella nuova identità.';
  }
}
