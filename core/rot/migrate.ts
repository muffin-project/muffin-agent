import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupOwnerConfigFile } from './backup.js';

export const ROT_OWNERSHIP_COMMAND = (home: string): string => {
  const rot = join(home, 'rot');
  const anchor = join(home, '.rot-anchor');
  const targets = existsSync(anchor) ? `'${rot}' '${anchor}'` : `'${rot}'`;
  return `sudo chown -R "$(id -un):$(id -gn)" ${targets}`;
};

export type RotMigrateReport = {
  writable: boolean;
  ownershipCommand: string | null;
  written: string[];
  backedUp: string[];
  preserved: string[];
  notes: string[];
};

type BudgetsFile = {
  _comment?: unknown;
  schemaVersion?: unknown;
  monthlyUsd?: unknown;
  perTenantDailyUsd?: unknown;
  quietHours?: unknown;
  unmetered?: unknown;
  [key: string]: unknown;
};

function rotWritable(home: string): boolean {
  const rot = join(home, 'rot');
  if (!existsSync(rot)) return false;
  try {
    accessSync(rot, constants.W_OK);
    for (const name of ['budgets.json', 'policy.json', 'identity.md']) {
      const file = join(rot, name);
      if (existsSync(file)) accessSync(file, constants.W_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge additive shipped budget fields into an existing owner file.
 * Caps and quiet hours (including timezone) already on disk are kept.
 * `identity.md` is never written.
 */
export function migrateRotHome(
  home: string,
  shippedBudgets: BudgetsFile | null,
  now: Date = new Date(),
): RotMigrateReport {
  const notes: string[] = [];
  const written: string[] = [];
  const backedUp: string[] = [];
  const preserved: string[] = ['rot/identity.md'];
  const ownershipCommand = ROT_OWNERSHIP_COMMAND(home);

  if (!existsSync(join(home, 'rot'))) {
    return {
      writable: false,
      ownershipCommand: null,
      written,
      backedUp,
      preserved: [],
      notes: [`${join(home, 'rot')} non esiste`],
    };
  }

  if (!rotWritable(home)) {
    return {
      writable: false,
      ownershipCommand,
      written,
      backedUp,
      preserved,
      notes: [
        `rot/ non è scrivibile da questo utente. Non eseguo io il cambio di proprietà.`,
        `Lancia tu, in un terminale: ${ownershipCommand}`,
        'Poi ripeti `muffin rot migrate`.',
      ],
    };
  }

  const budgetsPath = join(home, 'rot', 'budgets.json');
  if (existsSync(budgetsPath) && shippedBudgets !== null) {
    const current = JSON.parse(readFileSync(budgetsPath, 'utf8')) as BudgetsFile;
    const next: BudgetsFile = { ...shippedBudgets, ...current };
    // Re-assert owner operational fields so a spread of shipped defaults cannot
    // overwrite them even if key order changes later.
    if (current.monthlyUsd !== undefined) next.monthlyUsd = current.monthlyUsd;
    if (current.perTenantDailyUsd !== undefined) next.perTenantDailyUsd = current.perTenantDailyUsd;
    if (current.quietHours !== undefined) next.quietHours = current.quietHours;
    if (current._comment !== undefined) next._comment = current._comment;
    if (current.unmetered !== undefined) {
      next.unmetered = current.unmetered;
    } else if (shippedBudgets.unmetered !== undefined && next.unmetered === undefined) {
      next.unmetered = shippedBudgets.unmetered;
    }
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    const already = readFileSync(budgetsPath, 'utf8');
    if (already !== serialized) {
      const dest = backupOwnerConfigFile(home, budgetsPath, now);
      if (dest !== null) backedUp.push(dest);
      writeFileSync(budgetsPath, serialized, { encoding: 'utf8' });
      written.push('rot/budgets.json');
      if (current.quietHours !== undefined) preserved.push('rot/budgets.json quietHours');
      if (current.monthlyUsd !== undefined) preserved.push('rot/budgets.json caps');
      if (current.unmetered === undefined && next.unmetered !== undefined) {
        notes.push('aggiunto unmetered ai budget, conservati fuso e tetti già impostati');
      } else {
        notes.push(
          'budget già completi dei campi additivi, o solo riformattati; fuso e tetti conservati',
        );
      }
    } else {
      preserved.push('rot/budgets.json');
      notes.push('rot/budgets.json già allineato nei campi operativi');
    }
  } else if (!existsSync(budgetsPath)) {
    notes.push(
      'rot/budgets.json assente: non lo creo io; `muffin init` o un restore lo ripristinano',
    );
  }

  notes.push(
    'rot/identity.md non è stato toccato: un cambio di identità è una tua scelta, non una copia dai default',
  );
  notes.push(
    'rot/policy.json non è stato riscritto: il kernel già applica i pavimenti di policy sul file esistente',
  );

  return { writable: true, ownershipCommand: null, written, backedUp, preserved, notes };
}

export function readShippedBudgets(defaultsRotDir: string): BudgetsFile | null {
  const file = join(defaultsRotDir, 'budgets.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as BudgetsFile;
}
