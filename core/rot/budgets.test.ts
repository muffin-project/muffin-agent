import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUDGET_FLOOR, QUIET_FLOOR, detectOwnerTimezone, loadSealedBudgets, seedQuietTimezone } from './budgets.js';

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

  it('reads a declared unmetered-endpoint section, normalized', () => {
    const home = rot({
      ...GOOD,
      unmetered: [
        { host: '192.168.1.10', port: 8080, note: 'GPU LAN' },
        { host: 'LLAMA-SERVER.LOCAL.' },
      ],
    });
    const b = loadSealedBudgets(home);
    expect(b.unmetered).toEqual([
      { host: '192.168.1.10', port: 8080, note: 'GPU LAN' },
      { host: 'llama-server.local' },
    ]);
    expect(b.unmeteredSource).toBe('sealed');
    expect(b.notes).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  it('treats a missing unmetered section as none declared, silently', () => {
    // Every home sealed before this section existed lacks the key: warning
    // here would nag on all of them. Absent means no exceptions, which is
    // today's behavior unchanged.
    const home = rot(GOOD);
    const b = loadSealedBudgets(home);
    expect(b.unmetered).toEqual([]);
    expect(b.notes).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  it('fails a malformed unmetered section safe: metered, with a note', () => {
    for (const bad of ['all', [{ host: 42 }], [{ host: 'x', port: 99999 }]]) {
      const home = rot({ ...GOOD, unmetered: bad });
      const b = loadSealedBudgets(home);
      expect(b.unmetered).toEqual([]);
      expect(b.unmeteredSource).toBe('fallback');
      expect(b.notes.join(' ')).toContain('unmetered');
      rmSync(home, { recursive: true, force: true });
    }
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

describe('il fuso dell\'owner al primo avvio', () => {
  it('rileva un fuso IANA vero e scarta il fallback neutro o un nome inventato', () => {
    expect(detectOwnerTimezone('Europe/Rome')).toBe('Europe/Rome');
    expect(detectOwnerTimezone('UTC')).toBeUndefined();
    expect(detectOwnerTimezone('Etc/UTC')).toBeUndefined();
    expect(detectOwnerTimezone('Europe/Roma')).toBeUndefined();
    expect(detectOwnerTimezone('')).toBeUndefined();
  });

  it('sostituisce solo il fuso, solo se è ancora quello spedito, e lascia il resto byte per byte', () => {
    const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'defaults', 'rot', 'budgets.json');
    const dir = mkdtempSync(join(tmpdir(), 'muffin-seed-tz-'));
    try {
      const file = join(dir, 'budgets.json');
      const before = readFileSync(shipped, 'utf8');
      writeFileSync(file, before);
      expect(seedQuietTimezone(file, 'Europe/Rome')).toBe(true);
      const after = readFileSync(file, 'utf8');
      expect(after).toBe(before.replace('"timezone": "UTC"', '"timezone": "Europe/Rome"'));
      expect(JSON.parse(after).quietHours).toEqual({ ...QUIET_FLOOR, timezone: 'Europe/Rome' });
      // Già scelto: non si tocca più.
      expect(seedQuietTimezone(file, 'America/New_York')).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(after);
      // Un nome che il runtime non conosce non entra mai nel file sigillato.
      writeFileSync(file, before);
      expect(seedQuietTimezone(file, 'Europe/Roma')).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
