import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateRotHome } from './migrate.js';

const SHIPPED = {
  _comment: 'shipped',
  schemaVersion: 1,
  monthlyUsd: 80,
  perTenantDailyUsd: 2,
  quietHours: { from: '23:00', to: '08:00', timezone: 'UTC' },
  unmetered: [],
};

function homeWith(budgets: unknown, identity = '# patto owner\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-rot-mig-'));
  mkdirSync(join(dir, 'rot'), { recursive: true });
  writeFileSync(join(dir, 'rot', 'budgets.json'), `${JSON.stringify(budgets, null, 2)}\n`);
  writeFileSync(join(dir, 'rot', 'identity.md'), identity);
  writeFileSync(join(dir, 'rot', 'policy.json'), '{"schemaVersion":1,"paramsMaxTaint":2}\n');
  return dir;
}

describe('migrateRotHome', () => {
  it('adds unmetered and keeps a local timezone and caps', () => {
    const dir = homeWith({
      schemaVersion: 1,
      monthlyUsd: 80,
      perTenantDailyUsd: 2,
      quietHours: { from: '23:00', to: '08:00', timezone: 'Europe/Rome' },
    });
    const beforeIdentity = readFileSync(join(dir, 'rot', 'identity.md'), 'utf8');
    const report = migrateRotHome(dir, SHIPPED, new Date('2026-11-25T14:20:00Z'));
    expect(report.writable).toBe(true);
    expect(report.written).toEqual(['rot/budgets.json']);
    expect(report.backedUp).toHaveLength(1);
    const budgets = JSON.parse(readFileSync(join(dir, 'rot', 'budgets.json'), 'utf8'));
    expect(budgets.quietHours.timezone).toBe('Europe/Rome');
    expect(budgets.monthlyUsd).toBe(80);
    expect(budgets.unmetered).toEqual([]);
    expect(readFileSync(join(dir, 'rot', 'identity.md'), 'utf8')).toBe(beforeIdentity);
    expect(readFileSync(join(dir, 'rot', 'policy.json'), 'utf8')).toContain('paramsMaxTaint":2');
  });

  it('does not overwrite an identity file even when it differs from shipped text', () => {
    const dir = homeWith(
      { schemaVersion: 1, monthlyUsd: 40, unmetered: [] },
      '# testo approvato, non toccare\n',
    );
    migrateRotHome(dir, SHIPPED);
    expect(readFileSync(join(dir, 'rot', 'identity.md'), 'utf8')).toBe(
      '# testo approvato, non toccare\n',
    );
  });

  it('refuses to write when rot/ is not writable and names the owner command', () => {
    const dir = homeWith({ schemaVersion: 1, monthlyUsd: 80 });
    chmodSync(join(dir, 'rot'), 0o555);
    const report = migrateRotHome(dir, SHIPPED);
    expect(report.writable).toBe(false);
    expect(report.written).toEqual([]);
    expect(report.ownershipCommand).toContain('sudo chown -R');
    expect(report.ownershipCommand).toContain(join(dir, 'rot'));
    expect(report.notes.join('\n')).toContain('Non eseguo io il cambio di proprietà');
    chmodSync(join(dir, 'rot'), 0o755);
  });
});
