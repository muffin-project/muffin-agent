import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUDGET_FLOOR, QUIET_FLOOR, loadSealedBudgets } from './budgets.js';

/**
 * The sealed file, and the two halves that must not be able to break each other.
 *
 * Spend caps and quiet hours share one file and answer to two unrelated
 * features. A single parse would let a mistyped hour remove the spend ceiling
 * and a mistyped cap open the night — a coupling nobody would choose if the two
 * lived in separate files, so the shared file must not create it. Each half is
 * tested with the other one broken.
 */

function rot(contents: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-budgets-'));
  mkdirSync(join(home, 'rot'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(
      join(home, 'rot', 'budgets.json'),
      typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
    );
  }
  return home;
}

const GOOD = {
  schemaVersion: 1,
  monthlyUsd: 42,
  perTenantDailyUsd: 3,
  quietHours: { from: '22:00', to: '07:00', timezone: 'Europe/Rome' },
};

describe('rot/budgets.json', () => {
  it('reads both halves and notes nothing', () => {
    const home = rot(GOOD);
    const b = loadSealedBudgets(home);
    expect(b.caps).toEqual({ monthlyUsd: 42, perTenantDailyUsd: 3 });
    expect(b.capsSource).toBe('sealed');
    expect(b.quietHours).toEqual(GOOD.quietHours);
    expect(b.quietSource).toBe('sealed');
    expect(b.notes).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps the caps when the quiet hours are the broken half', () => {
    const home = rot({ ...GOOD, quietHours: { from: '10pm', to: '07:00', timezone: 'Europe/Rome' } });
    const b = loadSealedBudgets(home);
    expect(b.caps.monthlyUsd).toBe(42);
    expect(b.capsSource).toBe('sealed');
    expect(b.quietHours).toEqual(QUIET_FLOOR);
    expect(b.notes.join(' ')).toContain('quietHours non valide');
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps the quiet hours when the caps are the broken half', () => {
    const home = rot({ ...GOOD, monthlyUsd: 'ottanta' });
    const b = loadSealedBudgets(home);
    expect(b.caps).toEqual(BUDGET_FLOOR);
    expect(b.capsSource).toBe('fallback');
    expect(b.quietHours).toEqual(GOOD.quietHours);
    expect(b.quietSource).toBe('sealed');
    expect(b.notes.join(' ')).toContain('tetto di spesa non valido');
    rmSync(home, { recursive: true, force: true });
  });

  it('accepts zero, because zero is a cap and means stop', () => {
    // The other reading — "0 is falsy, so fall back to 80" — is how a deliberate
    // freeze silently becomes eighty dollars of headroom.
    const home = rot({ ...GOOD, monthlyUsd: 0 });
    const b = loadSealedBudgets(home);
    expect(b.caps.monthlyUsd).toBe(0);
    expect(b.capsSource).toBe('sealed');
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses a negative cap rather than treating it as unlimited', () => {
    const home = rot({ ...GOOD, perTenantDailyUsd: -1 });
    expect(loadSealedBudgets(home).caps).toEqual(BUDGET_FLOOR);
    rmSync(home, { recursive: true, force: true });
  });

  it('falls back on a version this build does not understand, and says so', () => {
    // Version before shape, like the config loader and the policy matrix. Half
    // reading a file that says how much money may be spent is worse than not
    // reading it: the fields a future schema renames would silently vanish.
    const home = rot({ ...GOOD, schemaVersion: 2 });
    const b = loadSealedBudgets(home);
    expect(b.capsSource).toBe('fallback');
    expect(b.quietSource).toBe('fallback');
    expect(b.notes.join(' ')).toContain('schemaVersion 2');
    rmSync(home, { recursive: true, force: true });
  });

  it('a missing or unreadable file falls back on both halves, loudly', () => {
    const missing = loadSealedBudgets(rot(undefined));
    expect(missing.caps).toEqual(BUDGET_FLOOR);
    expect(missing.quietHours).toEqual(QUIET_FLOOR);
    expect(missing.notes.join(' ')).toContain('assente');

    const broken = loadSealedBudgets(rot('{ "monthlyUsd": '));
    expect(broken.caps).toEqual(BUDGET_FLOOR);
    expect(broken.notes.join(' ')).toContain('illeggibile');
  });
});
