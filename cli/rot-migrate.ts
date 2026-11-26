import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIdentityLayers } from '../agent/context/identity.js';
import { migrateRotHome, readShippedBudgets } from '../core/rot/migrate.js';
import { findCheckoutRoot } from './git-root.js';

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

/** Owner-facing `muffin rot migrate`. Never chowns, never overwrites identity. */
export function runRotMigrate(home: string): number {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const shippedDir = shippedRotDir(moduleDir);
  if (shippedDir === null) {
    process.stderr.write(
      'non trovo i default spediti (defaults/rot/budgets.json) né nel pacchetto né in un checkout.\n',
    );
    return 78;
  }
  const report = migrateRotHome(home, readShippedBudgets(shippedDir));
  for (const line of report.notes) process.stdout.write(`${line}\n`);
  process.stdout.write(`${identityMigrateNote(home)}\n`);
  if (report.written.length > 0) {
    process.stdout.write(`scritti: ${report.written.join(', ')}\n`);
  }
  if (report.backedUp.length > 0) {
    process.stdout.write(`backup: ${report.backedUp.join(', ')}\n`);
  }
  if (!report.writable) return 77;
  return 0;
}

/**
 * Where the identity stands, said by the command an owner runs after an
 * update (ADR-0112). It writes nothing: migrating identity is the owner
 * creating `~/.muffin/user.md`, never a copy over the home pact.
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
        'Per ricevere la fondazione aggiornata sposta le righe tue in ~/.muffin/user.md (vedi `muffin doctor`).'
      );
  }
}
