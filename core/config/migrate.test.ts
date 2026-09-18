import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { secretsBackend, writeSecret } from './config.js';
import { listLegacySecretNames } from './systemd.js';
import { runSecretMigrate, type MigrateRunner } from './migrate.js';

/**
 * Migration order is the guarantee (Phase 6): read → provision all → prove
 * by decrypt round-trip → flip → prove the service → ONLY then delete.
 * Stubbed runner throughout, so the FULL flow — including legacy deletion —
 * runs anywhere. The disposable VM proves the same flow against real
 * `systemd-creds` and a real reboot; these pin the order that makes that
 * proof meaningful.
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-migrate-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  runInit({ home: dir, apiKey: 'sk-ant-fixture' });
  return dir;
}

/** Stub: mkdir/chmod succeed, encrypt records, decrypt echoes the recorded value. */
function stubRunner(values: Map<string, string>, failOn?: 'encrypt' | 'decrypt'): MigrateRunner {
  return (argv, input) => {
    if (argv.includes('encrypt')) {
      if (failOn === 'encrypt') return { status: 1, stderr: 'boom', stdout: '' };
      const name = (argv.find((a) => a.startsWith('--name=')) ?? '=').slice('--name='.length);
      values.set(`blob:${name}`, input);
      return { status: 0, stderr: '', stdout: '' };
    }
    if (argv.includes('decrypt')) {
      if (failOn === 'decrypt') return { status: 1, stderr: 'bad blob', stdout: '' };
      const blob = argv[argv.length - 2] ?? '';
      const name = blob.slice(blob.lastIndexOf('/') + 1, -'.cred'.length);
      return { status: 0, stderr: '', stdout: values.get(`blob:${name}`) ?? '' };
    }
    return { status: 0, stderr: '', stdout: '' };
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('runSecretMigrate', () => {
  it('migrates everything, proves, flips, deletes files AND emptied dirs', async () => {
    const dir = home();
    const values = new Map<string, string>();
    const out: string[] = [];
    const result = await runSecretMigrate(dir, {
      runner: stubRunner(values),
      useSudo: false,
      unitInstalled: false,
      out: (l) => out.push(l),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated.length).toBeGreaterThan(0);
    expect(result.serviceProven).toBe(false);
    expect(secretsBackend(dir)).toBe('systemd');
    // No legacy files anywhere…
    expect(listLegacy(dir)).toEqual([]);
    // …and no emptied store directories left behind either.
    expect(existsSync(join(dir, 'secrets'))).toBe(false);
    expect(existsSync(join(dir, 'xdg', 'muffin', 'secrets'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('empty store migrates vacuously without touching the flag', async () => {
    const dir = home();
    for (const f of listLegacy(dir)) rmSync(f, { force: true });
    const result = await runSecretMigrate(dir, { runner: stubRunner(new Map()), useSudo: false });
    expect(result).toMatchObject({ ok: true, migrated: [] });
    expect(secretsBackend(dir)).toBe('file');
    rmSync(dir, { recursive: true, force: true });
  });

  it('provision failure aborts with backend untouched and legacy intact', async () => {
    const dir = home();
    const before = listLegacy(dir);
    expect(before.length).toBeGreaterThan(0);
    const result = await runSecretMigrate(dir, { runner: stubRunner(new Map(), 'encrypt'), useSudo: false });
    expect(result.ok).toBe(false);
    expect(secretsBackend(dir)).toBe('file');
    expect(listLegacy(dir)).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('decrypt mismatch aborts with legacy intact', async () => {
    const dir = home();
    const before = listLegacy(dir);
    const values = new Map<string, string>();
    const runner: MigrateRunner = (argv, input) => {
      if (argv.includes('decrypt')) return { status: 0, stderr: '', stdout: 'WRONG-VALUE' };
      return stubRunner(values)(argv, input);
    };
    const result = await runSecretMigrate(dir, { runner, useSudo: false });
    expect(result.ok).toBe(false);
    expect(secretsBackend(dir)).toBe('file');
    expect(listLegacy(dir)).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('failed service restart rolls the flag back, legacy intact', async () => {
    const dir = home();
    const before = listLegacy(dir);
    const result = await runSecretMigrate(dir, {
      runner: stubRunner(new Map()),
      useSudo: false,
      unitInstalled: true,
      restart: async () => 1,
    });
    expect(result.ok).toBe(false);
    expect(secretsBackend(dir)).toBe('file');
    expect(listLegacy(dir)).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('successful restart proves, then deletes', async () => {
    const dir = home();
    let restarted = false;
    const result = await runSecretMigrate(dir, {
      runner: stubRunner(new Map()),
      useSudo: false,
      unitInstalled: true,
      restart: async () => {
        restarted = true;
        return 0;
      },
    });
    expect(result).toMatchObject({ ok: true, serviceProven: true });
    expect(restarted).toBe(true);
    expect(listLegacy(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to migrate emptiness', async () => {
    const dir = home();
    writeSecret('vuoto_test', '   ', dir, 'home');
    const result = await runSecretMigrate(dir, { runner: stubRunner(new Map()), useSudo: false });
    expect(result.ok).toBe(false);
    expect(secretsBackend(dir)).toBe('file');
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Legacy secret files across both file stores (names resolved to existing paths). */
function listLegacy(dir: string): string[] {
  const out: string[] = [];
  for (const n of listLegacySecretNames(dir)) {
    for (const d of [join(dir, 'secrets', n), join(dir, 'xdg', 'muffin', 'secrets', n)]) {
      if (existsSync(d)) out.push(d);
    }
  }
  return out.sort();
}
