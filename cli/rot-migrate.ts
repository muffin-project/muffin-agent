import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  if (report.written.length > 0) {
    process.stdout.write(`scritti: ${report.written.join(', ')}\n`);
  }
  if (report.backedUp.length > 0) {
    process.stdout.write(`backup: ${report.backedUp.join(', ')}\n`);
  }
  if (!report.writable) return 77;
  return 0;
}
